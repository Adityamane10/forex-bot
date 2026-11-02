"""ML pipeline tests: walk-forward training, prediction, calibration,
versioning and champion/challenger promotion."""
import sys
import os
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np
import pytest
from dataclasses import asdict
from typing import Any

from app.features import FEATURE_NAMES, FEATURE_VERSION
from app.walkforward import run_walk_forward, _evaluate
from app.models import SERVICE, ModelRegistry, ModelRecord, passes_quality_gate, MODEL_DIR


class _FakeModel:
    """Module-level (picklable) stand-in for a trained model artifact."""

    def predict_proba(self, X):
        import numpy as _np
        return _np.array([[0.4, 0.6]] * len(X))


def _make_artifact(version: str) -> str:
    """Create a tiny joblib artifact in MODEL_DIR so the promotion-time
    artifact-existence guard sees the challenger as loadable (tests do not
    train real models)."""
    import joblib

    path = os.path.join(MODEL_DIR, f"{version}.joblib")
    joblib.dump(_FakeModel(), path)
    return path


def make_candles(n=500, seed=1):
    rng = np.random.default_rng(seed)
    closes = [1.0]
    for i in range(1, n):
        # regime with strong autocorrelation so a model can learn something
        momentum = (closes[-1] - closes[-2]) if len(closes) > 1 else 0.0
        closes.append(closes[-1] + 0.5 * momentum + rng.normal(0, 0.002))
    out = []
    for i, c in enumerate(closes):
        h = c * 1.002
        l = c * 0.998
        out.append({
            "symbol": "EUR/USD", "timeframe": "1h",
            "open": closes[i - 1] if i else c, "high": h, "low": l, "close": c,
            "volume": 100, "openTime": i * 3600_000, "closeTime": (i + 1) * 3600_000,
        })
    return out


def test_walk_forward_training_produces_models():
    candles = make_candles()
    result = run_walk_forward({"EUR/USD": candles}, "1h", folds=2, horizon=6)
    assert result["status"] == "COMPLETED", result
    assert result["datasetVersion"].startswith("dataset-")
    assert len(result["folds"]) >= 1
    assert result["challenger"]["modelVersion"]
    assert "averageTestMetrics" in result


def test_predict_after_training():
    candles = make_candles()
    result = run_walk_forward({"EUR/USD": candles}, "1h", folds=2, horizon=6)
    assert result["status"] == "COMPLETED"
    SERVICE._load()  # reload so the new challenger is available
    feats = {name: 0.5 for name in FEATURE_NAMES}
    pred = SERVICE.predict("EUR/USD", "1h", 1234, feats)
    assert pred["available"] is True
    assert 0.0 <= pred["probability"] <= 1.0
    assert pred["modelVersion"]
    assert pred["datasetVersion"].startswith("dataset-")
    # shadow prediction surfaces the freshly trained challenger (production
    # keeps serving the champion until a challenger beats it)
    shadow = SERVICE.predict("EUR/USD", "1h", 1234, feats, use_shadow=True)
    assert shadow["shadow"] is True
    assert shadow["datasetVersion"] == result["datasetVersion"]


def test_champion_challenger_promotion_flow():
    registry = ModelRegistry()
    champ = registry.champion()
    candidates = [
        ModelRecord(**m) for m in registry.list()
        if m.get("status") == "CHALLENGER" and m.get("shadow") and passes_quality_gate(m.get("metrics", {}))
    ]
    promoted = registry.evaluate_challenger()
    if not champ and candidates:
        # a gate-passing challenger must be promoted when no champion exists
        assert promoted["promoted"] is True
        assert registry.champion() is not None
    else:
        assert promoted["promoted"] is False or registry.champion() is not None


def test_calibrated_probabilities_not_extreme():
    candles = make_candles()
    run_walk_forward({"EUR/USD": candles}, "1h", folds=2, horizon=6)
    feats = {name: 0.5 for name in FEATURE_NAMES}
    pred = SERVICE.predict("EUR/USD", "1h", 1, feats)
    if pred["available"]:
        assert 0.0 < pred["probability"] < 1.0
        assert pred["brierScore"] is not None


def test_insufficient_data_fails_gracefully():
    candles = make_candles(n=150)
    result = run_walk_forward({"EUR/USD": candles}, "1h", folds=2)
    assert result["status"] == "FAILED"


class FakeClf:
    """Fake classifier with a known predict_proba contract."""

    def __init__(self, probs):
        self.probs = list(probs)

    def predict_proba(self, X):
        n = len(self.probs)
        out = np.zeros((n, 2))
        out[:, 1] = np.asarray(self.probs)
        out[:, 0] = 1 - np.asarray(self.probs)
        return out


def test_evaluate_computes_real_precision_recall_f1():
    # y = [1,1,0,0], pred = [1,0,1,0] -> TP=1, FP=1, FN=1, TN=1
    metrics = _evaluate("TEST", FakeClf([0.9, 0.2, 0.8, 0.1]), np.zeros((4, 1)), np.array([1, 1, 0, 0]))
    assert metrics["precision"] == 0.5
    assert metrics["recall"] == 0.5
    assert metrics["f1"] == 0.5
    assert metrics["accuracy"] == 0.5


def test_evaluate_perfect_predictions_have_f1_of_one():
    metrics = _evaluate("TEST", FakeClf([0.9, 0.8, 0.7, 0.3, 0.2, 0.1]), np.zeros((6, 1)), np.array([1, 1, 1, 0, 0, 0]))
    assert metrics["precision"] == 1.0
    assert metrics["recall"] == 1.0
    assert metrics["f1"] == 1.0


def test_quality_gate_rejects_random_models():
    assert passes_quality_gate({"brier": 0.20, "auc": 0.60}) is True
    assert passes_quality_gate({"brier": 0.25, "auc": 0.60}) is False  # coin flip
    assert passes_quality_gate({"brier": 0.27, "auc": 0.55}) is False
    assert passes_quality_gate({"brier": 0.20, "auc": 0.50}) is False  # random auc
    assert passes_quality_gate({}) is False


def make_record(**kw: Any) -> ModelRecord:
    base: dict[str, Any] = dict(
        modelVersion="v-test", algorithm="LIGHTGBM", target="FUTURE_DIRECTION",
        datasetVersion="d", featureVersion=FEATURE_VERSION,
        trainingPeriod={"start": 1, "end": 2}, validationPeriod={"start": 2, "end": 3},
        testPeriod={"start": 3, "end": 4}, hyperparameters={}, metrics={},
        createdAt=1, status="CHALLENGER", shadow=True,
    )
    base.update(kw)
    return ModelRecord(**base)


def test_evaluate_challenger_blocks_subpar_model(monkeypatch):
    registry = ModelRegistry()
    champ = make_record(modelVersion="champ", status="CHAMPION", shadow=False,
                        metrics={"brier": 0.20, "auc": 0.60, "profitFactor": 1.0, "expectancy": 0.1, "maxDrawdown": 0.2})
    subpar = make_record(modelVersion="chal", metrics={"brier": 0.30, "auc": 0.55, "profitFactor": 5.0, "expectancy": 0.9, "maxDrawdown": 0.01})
    monkeypatch.setattr(registry, "champion", lambda: champ)
    monkeypatch.setattr(registry, "list", lambda: [asdict(subpar)])
    res = registry.evaluate_challenger()
    assert res["promoted"] is False
    assert "quality gate" in res["reason"]


def test_evaluate_challenger_promotes_quality_model(monkeypatch):
    registry = ModelRegistry()
    champ = make_record(modelVersion="champ", status="CHAMPION", shadow=False,
                        metrics={"brier": 0.20, "auc": 0.60, "profitFactor": 1.0, "expectancy": 0.1, "maxDrawdown": 0.2})
    chal = make_record(modelVersion="chal", metrics={"brier": 0.15, "auc": 0.65, "profitFactor": 2.0, "expectancy": 0.5, "maxDrawdown": 0.1})
    artifact = _make_artifact("chal")
    monkeypatch.setattr(registry, "champion", lambda: champ)
    monkeypatch.setattr(registry, "list", lambda: [asdict(chal)])
    monkeypatch.setattr(registry, "set_status", lambda v, s: None)
    res = registry.evaluate_challenger()
    os.remove(artifact)
    assert res["promoted"] is True


def test_evaluate_challenger_no_champion_still_needs_gate(monkeypatch):
    registry = ModelRegistry()
    bad = make_record(modelVersion="bad", metrics={"brier": 0.30, "auc": 0.52})
    monkeypatch.setattr(registry, "champion", lambda: None)
    monkeypatch.setattr(registry, "list", lambda: [asdict(bad)])
    res = registry.evaluate_challenger()
    assert res["promoted"] is False
    assert "quality gate" in res["reason"]
    good = make_record(modelVersion="good", metrics={"brier": 0.18, "auc": 0.62})
    artifact = _make_artifact("good")
    monkeypatch.setattr(registry, "list", lambda: [asdict(good)])
    monkeypatch.setattr(registry, "set_status", lambda v, s: None)
    res = registry.evaluate_challenger()
    os.remove(artifact)
    assert res["promoted"] is True
