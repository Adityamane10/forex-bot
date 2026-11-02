"""
Indian v2 accuracy pipeline (spec §19) — shadow-first.

Improves on the v1 India pipeline with three proven techniques:

1. Triple-barrier labels (López de Prado) — robust profit-take / stop /
   vertical-barrier targets instead of naive next-bar direction.
2. Stacking — all four base algorithms are blended through a Logistic
   Regression meta-learner instead of picking the single best one.
3. Meta-labeling — a second model learns *when the primary signal is worth
   taking*, so only high-conviction signals survive (fewer false entries,
   higher win rate on executed trades).

Everything lives in models-india-v2/ and datasets-india-v2/ and is exposed via
/india/v2/* endpoints. The existing v1 India pipeline is never modified and keeps
serving production until a v2 model beats it in shadow.
"""
from __future__ import annotations

import json
import os
import time
import uuid
from typing import Any, Dict, List, Tuple

import joblib
import numpy as np
import pandas as pd
from sklearn.calibration import CalibratedClassifierCV
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, brier_score_loss, precision_score, recall_score, roc_auc_score, f1_score

from .india_features import build_india_features, INDIA_FEATURE_NAMES, FEATURE_VERSION as INDIA_FEATURE_VERSION
from .models import ModelRegistry, ModelRecord, make_classifier, ALGORITHMS

INDIA_V2_MODEL_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "models-india-v2")
INDIA_V2_DATASET_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "datasets-india-v2")
os.makedirs(INDIA_V2_MODEL_DIR, exist_ok=True)
os.makedirs(INDIA_V2_DATASET_DIR, exist_ok=True)

V2_ALGORITHMS = [a for a in ALGORITHMS if a != "LIGHTGBM"] or ALGORITHMS
META_THRESHOLD = 0.6


def _purge_embargo(idx: np.ndarray, start: int, end: int, embargo: int) -> np.ndarray:
    """Return the slice [start:end] of a sorted index array with `embargo`
    samples removed from each side (labels near the boundary leak otherwise)."""
    lo = max(0, start + embargo)
    hi = min(len(idx), end - embargo)
    # FIX H4: return empty (skip fold) when window too small, not unpurged slice fail-open
    if lo >= hi:
        return idx[0:0]
    return idx[lo:hi]


def _train_primary(algo: str, X_tr, y_tr, X_val, y_val):
    clf = make_classifier(algo)
    clf.fit(X_tr, y_tr)
    try:
        from sklearn.frozen import FrozenEstimator
        return CalibratedClassifierCV(estimator=FrozenEstimator(clf), method="isotonic", cv=3).fit(X_val, y_val)
    except ImportError:
        return CalibratedClassifierCV(estimator=clf, method="isotonic", cv="prefit").fit(X_val, y_val)  # type: ignore[arg-type]
    except Exception:
        from sklearn.frozen import FrozenEstimator  # type: ignore
        return CalibratedClassifierCV(estimator=FrozenEstimator(clf), method="isotonic", cv=3).fit(X_val, y_val)


def _train_stack(primaries: Dict[str, Any], X_tr, y_tr, X_val, y_val) -> Any:
    """Train the ensemble meta-learner on out-of-sample probabilities."""
    # Use classes-mapped probability extraction for safety (H6 style)
    def _proba_one(est, X):
        p = est.predict_proba(X)
        classes = getattr(est, "classes_", None)
        if classes is not None and 1 in list(classes):
            idx = list(classes).index(1)
            return p[:, idx] if p.shape[1] > idx else p[:, 0]
        return p[:, 1] if p.shape[1] > 1 else p[:, 0]
    oof_tr = np.column_stack([_proba_one(primaries[a], X_tr) for a in V2_ALGORITHMS])
    oof_val = np.column_stack([_proba_one(primaries[a], X_val) for a in V2_ALGORITHMS])
    stack = LogisticRegression(max_iter=2000, C=1.0, class_weight="balanced")
    stack.fit(oof_tr, y_tr)
    try:
        from sklearn.frozen import FrozenEstimator
        cal = CalibratedClassifierCV(estimator=FrozenEstimator(stack), method="sigmoid", cv=3)
        return cal.fit(oof_val, y_val)
    except ImportError:
        cal = CalibratedClassifierCV(estimator=stack, method="sigmoid", cv="prefit")  # type: ignore[arg-type]
        return cal.fit(oof_val, y_val)
    except Exception:
        from sklearn.frozen import FrozenEstimator  # type: ignore
        cal = CalibratedClassifierCV(estimator=FrozenEstimator(stack), method="sigmoid", cv=3)
        return cal.fit(oof_val, y_val)


def _stack_proba(stack: Any, primaries: Dict[str, Any], X) -> np.ndarray:
    def _p(est, X):
        p = est.predict_proba(X)
        classes = getattr(est, "classes_", None)
        if classes is not None and 1 in list(classes):
            idx = list(classes).index(1)
            return p[:, idx] if p.shape[1] > idx else p[:, 0]
        return p[:, 1] if p.shape[1] > 1 else p[:, 0]
    oof = np.column_stack([_p(primaries[a], X) for a in V2_ALGORITHMS])
    proba = stack.predict_proba(oof)
    classes = getattr(stack, "classes_", None)
    if classes is not None and 1 in list(classes):
        idx = list(classes).index(1)
        return proba[:, idx] if proba.shape[1] > idx else proba[:, 0]
    return proba[:, 1] if proba.shape[1] > 1 else proba[:, 0]


def _train_meta(stack: Any, primaries: Dict[str, Any], X_val, side_val: np.ndarray, outcome_val: np.ndarray) -> Any:
    """Meta-labeling: learn whether the stacked direction bet is profitable.

    The primary bet is "up" when the stacked probability >= 0.5. A trade is
    profitable when the triple-barrier outcome says the PT/vertical barrier was
    hit in that direction. The meta model maps [stacked_p, |stacked_p-0.5|,
    features] to the probability that the bet succeeds.
    """
    p = _stack_proba(stack, primaries, X_val)
    bet_up = (p >= 0.5).astype(int)
    y_meta = np.where(
        ((bet_up == 1) & (side_val == 1)) | ((bet_up == 0) & (side_val == -1)),
        1, 0,
    ).astype(int)
    meta_X = np.column_stack([p, np.abs(p - 0.5), X_val])
    meta = LogisticRegression(max_iter=2000, C=1.0, class_weight="balanced")
    return meta.fit(meta_X, y_meta)


def _v2_metrics(y_true: np.ndarray, side: np.ndarray, outcome: np.ndarray,
                p_stack: np.ndarray, p_meta: np.ndarray, threshold: float) -> Dict[str, float]:
    """Evaluate the meta-filtered signals: only entries passing the meta gate
    count as trades, and each trade wins when its direction hit the barrier."""
    filtered = (p_meta >= threshold).astype(int)
    bet_up = (p_stack >= 0.5).astype(int)
    trade = filtered == 1
    n_trade = int(trade.sum())
    if n_trade == 0:
        return {"trades": 0, "winRate": 0.0, "profitFactor": 0.0, "expectancy": 0.0,
                "brier": round(float(brier_score_loss(y_true, p_stack)), 5),
                "auc": round(float(roc_auc_score(y_true, p_stack)), 4) if len(np.unique(y_true)) > 1 else 0.5,
                "precision": 0.0, "recall": 0.0, "f1": 0.0}
    # FIX H3: direction-aware win check (short wins counted correctly)
    wins = int(np.sum(((bet_up[trade] == 1) & (side[trade] == 1)) | ((bet_up[trade] == 0) & (side[trade] == -1))))
    losses = n_trade - wins
    win_rate = wins / n_trade
    pf = wins / losses if losses else (float("inf") if wins else 0.0)
    pred = bet_up
    return {
        "trades": n_trade,
        "winRate": round(win_rate, 4),
        "profitFactor": float(pf),
        "expectancy": round(win_rate * 1.0 - (1 - win_rate) * 1.0, 4),
        "brier": round(float(brier_score_loss(y_true, p_stack)), 5),
        "auc": round(float(roc_auc_score(y_true, p_stack)), 4) if len(np.unique(y_true)) > 1 else 0.5,
        "accuracy": round(float(accuracy_score(y_true, pred)), 4),
        "precision": round(float(precision_score(y_true, pred, zero_division=0)), 4),
        "recall": round(float(recall_score(y_true, pred, zero_division=0)), 4),
        "f1": round(float(f1_score(y_true, pred, zero_division=0)), 4),
        "filterRate": round(float(trade.mean()), 4),
    }


def run_india_v2_walk_forward(data: Dict[str, List[Dict[str, Any]]], timeframe: str,
                              folds: int = 3, horizon: int = 1,
                              tbar_horizon: int = 5, tbar_pt: float = 1.0, tbar_sl: float = 1.0,
                              embargo: int = 0, meta_threshold: float = META_THRESHOLD,
                              feature_version: str = INDIA_FEATURE_VERSION) -> Dict[str, Any]:
    """data: {symbol: [candles]} — candles time-ordered oldest->newest.

    Trains primary models per fold, a stacking meta-learner, and a meta-labeling
    filter. Saves the best fold (by filtered profit factor) as a CHALLENGER in
    models-india-v2/ and a dataset manifest in datasets-india-v2/.
    """
    if embargo <= 0:
        embargo = max(1, tbar_horizon)
    frames = []
    for symbol, candles in data.items():
        if len(candles) < 300:
            continue
        df = build_india_features(candles, horizon=horizon, include_triple_barrier=True,
                                  tbar_horizon=tbar_horizon, tbar_pt=tbar_pt, tbar_sl=tbar_sl)
        if len(df) > 200:
            df["symbol"] = symbol
            frames.append(df)
    if not frames:
        return {"status": "FAILED", "error": "insufficient Indian candle history for v2 training"}

    merged = pd.concat(frames, ignore_index=True).sort_values("timestamp").reset_index(drop=True)
    merged = merged.dropna(subset=INDIA_FEATURE_NAMES + ["tbarSide"]).reset_index(drop=True)
    if len(merged) < 300:
        return {"status": "FAILED", "error": "insufficient labeled Indian samples for v2 training"}

    dataset_version = f"india-v2-dataset-{int(time.time())}"
    try:
        sample_n = min(100, len(merged))
        feature_sample = merged[INDIA_FEATURE_NAMES].head(sample_n).to_dict(orient="records")
    except Exception:
        feature_sample = []
    with open(os.path.join(INDIA_V2_DATASET_DIR, f"{dataset_version}.json"), "w") as f:
        json.dump({
            "datasetVersion": dataset_version,
            "provider": "backend-market-data",
            "assets": list(data.keys()),
            "timeframes": [timeframe],
            "startDate": int(merged["timestamp"].min()),
            "endDate": int(merged["timestamp"].max()),
            "features": INDIA_FEATURE_NAMES,
            "target": "TRIPLE_BARRIER+STACK+META",
            "preprocessingVersion": "india-v2-preproc-v1",
            "tbarHorizon": tbar_horizon,
            "rows": len(merged),
            "featureSample": feature_sample,
            "createdAt": int(time.time() * 1000),
        }, f, indent=2)

    X = merged[INDIA_FEATURE_NAMES].values
    y = merged["target"].values.astype(int)
    side = merged["tbarSide"].values.astype(int)
    outcome = merged["tbarOutcome"].values.astype(int)
    n = len(merged)
    fold_size = n // (folds + 1)

    registry = IndiaV2Registry()
    best: Dict[str, Any] | None = None
    folds_out = []

    for fold in range(folds):
        train_end = fold_size * (fold + 1)
        val_end = train_end + fold_size
        test_end = min(val_end + fold_size, n)
        if test_end - val_end < 30 or val_end - train_end < 30:
            continue

        train_idx = _purge_embargo(np.arange(n), 0, train_end, embargo)
        val_idx = _purge_embargo(np.arange(n), train_end, val_end, embargo)
        test_idx = np.arange(val_end, test_end)
        if len(train_idx) < 50 or len(val_idx) < 20 or len(test_idx) < 20:
            continue

        X_tr, y_tr = X[train_idx], y[train_idx]
        X_val, y_val = X[val_idx], y[val_idx]
        X_te, y_te = X[test_idx], y[test_idx]
        side_val, side_te = side[val_idx], side[test_idx]
        outcome_te = outcome[test_idx]

        primaries: Dict[str, Any] = {}
        fold_results = []
        for algo in V2_ALGORITHMS:
            try:
                clf = _train_primary(algo, X_tr, y_tr, X_val, y_val)
                primaries[algo] = clf
                fold_results.append({"algorithm": algo, "status": "ok"})
            except Exception as exc:  # pragma: no cover
                fold_results.append({"algorithm": algo, "error": str(exc)})
        if len(primaries) < 2:
            folds_out.append({"trainEnd": train_end, "validateEnd": val_end, "testEnd": test_end,
                              "models": fold_results, "error": "not enough primary models trained"})
            continue

        try:
            stack = _train_stack(primaries, X_tr, y_tr, X_val, y_val)
            meta = _train_meta(stack, primaries, X_val, side_val, y_val)
            p_te = _stack_proba(stack, primaries, X_te)
            meta_X_te = np.column_stack([p_te, np.abs(p_te - 0.5), X_te])
            p_meta_te = meta.predict_proba(meta_X_te)[:, 1]
            metrics = _v2_metrics(y_te, side_te, outcome_te, p_te, p_meta_te, meta_threshold)
        except Exception as exc:  # pragma: no cover
            folds_out.append({"trainEnd": train_end, "validateEnd": val_end, "testEnd": test_end,
                              "models": fold_results, "error": f"stack/meta failed: {exc}"})
            continue

        version = f"india-v2-{uuid.uuid4().hex[:8]}"
        bundle = {"primaries": primaries, "stack": stack, "meta": meta,
                  "algorithms": V2_ALGORITHMS, "threshold": meta_threshold,
                  "datasetVersion": dataset_version, "featureVersion": feature_version}
        joblib.dump(bundle, os.path.join(INDIA_V2_MODEL_DIR, f"{version}.joblib"))

        record = ModelRecord(
            modelVersion=version,
            algorithm="STACKED_META",
            target="TRIPLE_BARRIER+STACK+META",
            datasetVersion=dataset_version,
            featureVersion=feature_version,
            trainingPeriod={"start": int(merged["timestamp"].iloc[train_idx[0]]), "end": int(merged["timestamp"].iloc[train_idx[-1]])},
            validationPeriod={"start": int(merged["timestamp"].iloc[val_idx[0]]), "end": int(merged["timestamp"].iloc[val_idx[-1]])},
            testPeriod={"start": int(merged["timestamp"].iloc[test_idx[0]]), "end": int(merged["timestamp"].iloc[test_idx[-1]])},
            hyperparameters={"horizonBars": horizon, "tbarHorizon": tbar_horizon, "tbarPt": tbar_pt,
                             "tbarSl": tbar_sl, "embargo": embargo, "metaThreshold": meta_threshold, "fold": fold},
            metrics=metrics,
            createdAt=time.time() * 1000,
        )
        registry.save(record)
        fold_results.append({"algorithm": "STACKED_META", "modelVersion": version, "metrics": metrics})
        folds_out.append({"trainEnd": train_end, "validateEnd": val_end, "testEnd": test_end, "models": fold_results})

        score = metrics.get("profitFactor", 0)
        score = score if np.isfinite(score) else 0
        if best is None or score > best.get("_score", -1):
            best = {**metrics, "_score": score, "modelVersion": version, "fold": fold}

    if best is None:
        return {"status": "FAILED", "error": "no v2 fold produced a usable India model"}

    version = best["modelVersion"]
    rec = registry.load(version)
    if rec:
        rec.status = "CHALLENGER"
        rec.shadow = True
        registry.save(rec)

    return {
        "status": "COMPLETED",
        "experimentId": f"india-v2-wf-{uuid.uuid4().hex[:8]}",
        "datasetVersion": dataset_version,
        "folds": folds_out,
        "challenger": {"modelVersion": version, "algorithm": "STACKED_META",
                       "metrics": {k: v for k, v in best.items() if k != "_score"}},
        "createdAt": int(time.time() * 1000),
    }


def load_v2_bundle(version: str) -> Dict[str, Any]:
    path = os.path.join(INDIA_V2_MODEL_DIR, f"{version}.joblib")
    if not os.path.exists(path):
        raise FileNotFoundError(path)
    bundle = joblib.load(path)
    if not isinstance(bundle, dict) or "stack" not in bundle or "meta" not in bundle:
        raise ValueError(f"not a v2 bundle: {version}")
    return bundle


class IndiaV2Registry(ModelRegistry):
    """Model metadata registry isolated to models-india-v2/ (same file layout as
    ModelRegistry so champion/challenger logic and the quality gate are reused)."""

    def __init__(self):
        super().__init__(INDIA_V2_MODEL_DIR)