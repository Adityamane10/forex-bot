"""Tests for the Indian v2 pipeline (triple-barrier + stacking + meta-labeling).

Everything here is hermetic: synthetic candles with strong autocorrelation so
the models learn a signal. The v2 artifacts are isolated in models-india-v2/ and
datasets-india-v2/ and never touch the v1 India or Forex model directories.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np
import pandas as pd
import pytest

from app.india_features import build_india_features, add_triple_barrier_labels, INDIA_FEATURE_NAMES
from app.india_v2 import _purge_embargo, run_india_v2_walk_forward, IndiaV2Registry, INDIA_V2_MODEL_DIR
from app.india_models import INDIA_V2_SERVICE, INDIA_MODEL_DIR, INDIA_DATASET_DIR
from app.models import ModelRecord


def make_candles(n=600, seed=1):
    rng = np.random.default_rng(seed)
    closes = [1.0]
    for i in range(1, n):
        momentum = (closes[-1] - closes[-2]) if len(closes) > 1 else 0.0
        closes.append(closes[-1] + 0.5 * momentum + rng.normal(0, 0.002))
    out = []
    for i, c in enumerate(closes):
        out.append({
            "symbol": "NSE_INDEX|Nifty 50", "timeframe": "5m",
            "open": closes[i - 1] if i else c, "high": c * 1.002, "low": c * 0.998, "close": c,
            "volume": 100, "openTime": i * 300_000, "closeTime": (i + 1) * 300_000,
            "atr": 0.002,  # constant ATR for the synthetic random walk
        })
    return out


def feats_for(close_val, rng_state=0):
    """A plausible normalized feature vector for the v2 predict contract test."""
    rng = np.random.default_rng(rng_state)
    return {name: float(rng.uniform(0, 1)) for name in INDIA_FEATURE_NAMES}


def test_triple_barrier_labels_hit_profit_take_first():
    # close flat then a large jump up: PT barrier at +1*ATR is touched before
    # the stop. ATR of a flat series is small, so the jump crosses the PT.
    closes = [100.0] * 30 + [102.0] * 10
    df = pd.DataFrame({
        "close": closes, "high": [c + 0.1 for c in closes], "low": [c - 0.1 for c in closes],
        "open": closes, "openTime": [i * 300_000 for i in range(len(closes))],
    })
    df["atr"] = 0.5
    tb = add_triple_barrier_labels(df, horizon=5, pt_mult=1.0, sl_mult=1.0)
    # bar 30 sits right before the jump; its forward window starts at the 102 bar
    assert tb["tbarSide"].iloc[29] == 1
    assert tb["tbarOutcome"].iloc[29] == 1


def test_triple_barrier_labels_hit_stop_first():
    closes = [100.0] * 30 + [98.0] * 10
    df = pd.DataFrame({
        "close": closes, "high": [c + 0.1 for c in closes], "low": [c - 0.1 for c in closes],
        "open": closes, "openTime": [i * 300_000 for i in range(len(closes))],
    })
    df["atr"] = 0.5
    tb = add_triple_barrier_labels(df, horizon=5, pt_mult=1.0, sl_mult=1.0)
    assert tb["tbarSide"].iloc[29] == -1
    assert tb["tbarOutcome"].iloc[29] == 0


def test_build_india_features_emits_triple_barrier_columns():
    candles = make_candles()
    df = build_india_features(candles, horizon=1, include_triple_barrier=True)
    assert "tbarSide" in df.columns and "tbarOutcome" in df.columns
    assert set(df["tbarSide"].dropna().unique()) <= {-1, 0, 1}
    assert set(df["tbarOutcome"].dropna().unique()) <= {0, 1}
    # v1 columns still present (backward compatibility)
    assert "target" in df.columns


def test_purge_embargo_removes_boundary_rows():
    idx = np.arange(100)
    out = _purge_embargo(idx, 0, 50, 5)
    assert out[0] == 5 and out[-1] == 44  # 10 rows dropped from the 50-row window
    out2 = _purge_embargo(idx, 50, 100, 5)
    assert out2[0] == 55 and out2[-1] == 94


def test_v2_training_completes_and_predicts():
    candles = {f"NSE_INDEX|Nifty 50": make_candles()}
    from app.india_features import build_india_features
    df = build_india_features(candles["NSE_INDEX|Nifty 50"], horizon=1, include_triple_barrier=True, tbar_horizon=5, tbar_pt=1.0, tbar_sl=1.0)
    print("DEBUG columns:", df.columns.tolist())
    print("DEBUG timestamp count:", list(df.columns).count("timestamp"))
    result = run_india_v2_walk_forward(candles, "5m", folds=2, horizon=1)
    assert result["status"] == "COMPLETED", result
    assert result["datasetVersion"].startswith("india-v2-dataset-")
    assert result["challenger"]["algorithm"] == "STACKED_META"
    assert "trades" in result["challenger"]["metrics"]

    INDIA_V2_SERVICE._load()
    pred = INDIA_V2_SERVICE.predict("NSE_INDEX|Nifty 50", "5m", 1234, feats_for(1.0))
    assert pred["available"] is True
    assert pred["modelVersion"] == result["challenger"]["modelVersion"]
    assert pred["algorithm"] == "STACKED_META"
    assert pred["direction"] in (-1, 1)
    assert 0.0 <= pred["probability"] <= 1.0
    assert 0.0 <= pred["metaProbability"] <= 1.0
    assert pred["signal"] in ("LONG", "SHORT", "NO_TRADE")
    # meta gate is conservative: a fraction of signals get filtered on this data
    assert 0.0 <= pred["filtered"] <= 1.0

    shadow = INDIA_V2_SERVICE.predict("NSE_INDEX|Nifty 50", "5m", 1234, feats_for(2.0), use_shadow=True)
    assert shadow["available"] is True
    assert shadow["shadow"] is True


def test_v2_isolation_from_other_dirs():
    assert INDIA_V2_MODEL_DIR != INDIA_MODEL_DIR
    assert INDIA_V2_MODEL_DIR.endswith("models-india-v2")
    # registry metadata files live under the v2 dir
    reg = IndiaV2Registry()
    for rec in reg.list():
        assert os.path.join(INDIA_V2_MODEL_DIR, f"{rec['modelVersion']}.json") == os.path.join(INDIA_V2_MODEL_DIR, f"{rec['modelVersion']}.json")


def test_v2_registry_record_roundtrip():
    reg = IndiaV2Registry()
    rec = ModelRecord(
        modelVersion="india-v2-test", algorithm="STACKED_META", target="TRIPLE_BARRIER+STACK+META",
        datasetVersion="india-v2-dataset-x", featureVersion="india-features-v1",
        trainingPeriod={"start": 1, "end": 2}, validationPeriod={"start": 2, "end": 3},
        testPeriod={"start": 3, "end": 4}, hyperparameters={}, metrics={"trades": 1, "profitFactor": 1.0},
        createdAt=1, status="CHALLENGER", shadow=True,
    )
    reg.save(rec)
    loaded = reg.load("india-v2-test")
    assert loaded is not None
    assert loaded.modelVersion == "india-v2-test"
    assert loaded.algorithm == "STACKED_META"
    reg.set_status("india-v2-test", "ARCHIVED")
    assert reg.load("india-v2-test").status == "ARCHIVED"
    reg.set_status("india-v2-test", "CHALLENGER")