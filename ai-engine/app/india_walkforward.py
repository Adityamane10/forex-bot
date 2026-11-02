"""
Walk-forward validation for the INDIAN model pipeline (spec §19).

Mirrors walkforward.py but is fully Indian: it builds features with
india_features.build_india_features and persists artifacts in models-india/ and
datasets-india/. Forex feature/model artifacts are never touched.
"""
from __future__ import annotations

import json
import os
import time
import uuid
from typing import Any, Dict, List

import joblib
import numpy as np
import pandas as pd
from sklearn.calibration import CalibratedClassifierCV
from sklearn.metrics import accuracy_score, brier_score_loss, precision_score, recall_score, roc_auc_score, f1_score

from .india_features import build_india_features, INDIA_FEATURE_NAMES, FEATURE_VERSION as INDIA_FEATURE_VERSION
from .india_models import IndiaModelRegistry, INDIA_MODEL_DIR, INDIA_DATASET_DIR
from .models import ModelRecord, make_classifier, ALGORITHMS


def _trade_metrics(y_true: np.ndarray, p_up: np.ndarray, threshold: float = 0.55) -> Dict[str, float]:
    pred = (p_up >= threshold).astype(int)
    n = len(y_true)
    if n == 0:
        return {"trades": 0}
    wins = int(np.sum(pred == y_true))
    losses = n - wins
    win_rate = wins / n if n else 0.0
    profit_factor = wins / losses if losses else (float("inf") if wins else 0.0)
    return {
        "trades": n,
        "winRate": round(win_rate, 4),
        "profitFactor": float(profit_factor),
        "expectancy": round(win_rate * 1.0 - (1 - win_rate) * 1.0, 4),
        "accuracy": round(accuracy_score(y_true, pred), 4),
    }


def _purged_splits(n: int, train_end: int, val_end: int, test_end: int, horizon: int):
    """Purge horizon rows after train and val blocks to prevent label leakage (H2)."""
    train_p = max(0, train_end - horizon)
    val_p = max(train_end, val_end - horizon)
    return train_p, val_p


def _train_one(algo: str, X_train, y_train, X_val, y_val) -> Any:
    clf = make_classifier(algo)
    clf.fit(X_train, y_train)
    try:
        from sklearn.frozen import FrozenEstimator
        cal = CalibratedClassifierCV(estimator=FrozenEstimator(clf), method="isotonic", cv=3)
        cal.fit(X_val, y_val)
    except ImportError:
        cal = CalibratedClassifierCV(estimator=clf, method="isotonic", cv="prefit")  # type: ignore[arg-type]
        cal.fit(X_val, y_val)
    except Exception:
        from sklearn.frozen import FrozenEstimator  # type: ignore
        cal = CalibratedClassifierCV(estimator=FrozenEstimator(clf), method="isotonic", cv=3)
        cal.fit(X_val, y_val)
    return cal


def _evaluate(algo: str, clf, X_test, y_test) -> Dict[str, float]:
    y = np.asarray(y_test)
    proba = clf.predict_proba(X_test)
    classes = getattr(clf, "classes_", None)
    if classes is not None and 1 in list(classes):
        idx = list(classes).index(1)
        p_up = proba[:, idx] if proba.shape[1] > idx else proba[:, 0]
    elif classes is not None and len(classes) == 1 and classes[0] == 0:
        p_up = np.zeros(len(y), dtype=float)
    else:
        p_up = proba[:, 1] if proba.shape[1] > 1 else proba[:, 0]
    pred = (p_up >= 0.5).astype(int)
    brier = float(brier_score_loss(y, p_up))
    try:
        auc = float(roc_auc_score(y, p_up))
    except Exception:
        auc = 0.5
    tm = _trade_metrics(y, p_up)
    return {
        "brier": round(brier, 5),
        "auc": round(auc, 4),
        "accuracy": round(accuracy_score(y, pred), 4),
        "precision": round(float(precision_score(y, pred, zero_division=0)), 4),
        "recall": round(float(recall_score(y, pred, zero_division=0)), 4),
        "f1": round(float(f1_score(y, pred, zero_division=0)), 4),
        "calibrationError": round(float(np.mean(np.abs(p_up - y))), 5),
        **tm,
    }


def run_india_walk_forward(data: Dict[str, List[Dict[str, Any]]], timeframe: str,
                           folds: int = 3, horizon: int = 1,
                           feature_version: str = INDIA_FEATURE_VERSION) -> Dict[str, Any]:
    """data: {symbol: [candles]} — candles must be time-ordered oldest->newest."""
    frames = []
    for symbol, candles in data.items():
        if len(candles) < 300:
            continue
        df = build_india_features(candles, horizon=horizon)
        if len(df) > 200:
            frames.append(df)
    if not frames:
        return {"status": "FAILED", "error": "insufficient Indian candle history for training"}

    merged = pd.concat(frames, ignore_index=True).sort_values("timestamp").reset_index(drop=True)
    merged = merged.dropna(subset=INDIA_FEATURE_NAMES).reset_index(drop=True)
    if len(merged) < 250:
        return {"status": "FAILED", "error": "insufficient labeled Indian samples"}

    dataset_version = f"india-dataset-{int(time.time())}"
    try:
        sample_n = min(100, len(merged))
        feature_sample = merged[INDIA_FEATURE_NAMES].head(sample_n).to_dict(orient="records")
    except Exception:
        feature_sample = []
    with open(os.path.join(INDIA_DATASET_DIR, f"{dataset_version}.json"), "w") as f:
        json.dump({
            "datasetVersion": dataset_version,
            "provider": "backend-market-data",
            "assets": list(data.keys()),
            "timeframes": [timeframe],
            "startDate": int(merged["timestamp"].min()),
            "endDate": int(merged["timestamp"].max()),
            "features": INDIA_FEATURE_NAMES,
            "target": "FUTURE_DIRECTION",
            "preprocessingVersion": "india-preproc-v1",
            "rows": len(merged),
            "featureSample": feature_sample,
            "createdAt": int(time.time() * 1000),
        }, f, indent=2)

    X = merged[INDIA_FEATURE_NAMES].values
    y = merged["target"].values.astype(int)
    n = len(merged)
    fold_size = n // (folds + 1)

    registry = IndiaModelRegistry()
    best: Dict[str, Any] | None = None
    folds_out = []

    for fold in range(folds):
        train_end = fold_size * (fold + 1)
        val_end = train_end + fold_size
        test_end = min(val_end + fold_size, n)
        if test_end - val_end < 30 or val_end - train_end < 30:
            continue
        train_p, val_p = _purged_splits(n, train_end, val_end, test_end, horizon)
        if train_p < 30 or val_p - train_end < 20 or test_end - val_end < 20:
            continue
        X_train, y_train = X[:train_p], y[:train_p]
        X_val, y_val = X[train_end:val_p], y[train_end:val_p]
        X_test, y_test = X[val_end:test_end], y[val_end:test_end]
        if len(X_train) < 30 or len(X_val) < 20 or len(X_test) < 20:
            continue

        fold_results = []
        for algo in ALGORITHMS:
            try:
                t0 = time.time()
                clf = _train_one(algo, X_train, y_train, X_val, y_val)
                metrics = _evaluate(algo, clf, X_test, y_test)
                metrics["trainTimeSec"] = round(time.time() - t0, 2)
                record = ModelRecord(
                    modelVersion=f"india-{algo.lower()}-{uuid.uuid4().hex[:8]}",
                    algorithm=algo,
                    target="FUTURE_DIRECTION",
                    datasetVersion=dataset_version,
                    featureVersion=feature_version,
                    trainingPeriod={"start": int(merged["timestamp"].iloc[0]), "end": int(merged["timestamp"].iloc[train_end - 1])},
                    validationPeriod={"start": int(merged["timestamp"].iloc[train_end]), "end": int(merged["timestamp"].iloc[val_end - 1])},
                    testPeriod={"start": int(merged["timestamp"].iloc[val_end]), "end": int(merged["timestamp"].iloc[test_end - 1])},
                    hyperparameters={"horizonBars": horizon, "fold": fold, "classWeight": "balanced"},
                    metrics=metrics,
                    createdAt=time.time() * 1000,
                )
                registry.save(record)
                joblib.dump(clf, os.path.join(INDIA_MODEL_DIR, f"{record.modelVersion}.joblib"))
                fold_results.append({"algorithm": algo, "modelVersion": record.modelVersion, "metrics": metrics})
            except Exception as exc:  # pragma: no cover
                fold_results.append({"algorithm": algo, "error": str(exc)})
        folds_out.append({
            "trainStart": int(merged["timestamp"].iloc[0]),
            "trainEnd": int(merged["timestamp"].iloc[train_end - 1]),
            "validateStart": int(merged["timestamp"].iloc[train_end]),
            "validateEnd": int(merged["timestamp"].iloc[val_end - 1]),
            "testStart": int(merged["timestamp"].iloc[val_end]),
            "testEnd": int(merged["timestamp"].iloc[test_end - 1]),
            "models": fold_results,
        })
        for fr in fold_results:
            if "metrics" not in fr:
                continue
            score = fr["metrics"].get("profitFactor", 0)
            score = score if np.isfinite(score) else 0
            if best is None or score > best.get("_score", -1):
                fr["metrics"]["_score"] = score
                best = {**fr, "_score": score, "fold": fold}

    if best is None:
        return {"status": "FAILED", "error": "no fold produced a usable India model"}

    version = best["modelVersion"]
    rec = registry.load(version)
    if rec:
        rec.status = "CHALLENGER"
        rec.shadow = True
        registry.save(rec)

    avg_metrics: Dict[str, float] = {}
    count = 0
    for fold in folds_out:
        for m in fold.get("models", []):
            if "metrics" in m:
                for k, v in m["metrics"].items():
                    if isinstance(v, (int, float)) and k != "_score":
                        avg_metrics[k] = avg_metrics.get(k, 0) + v
                count += 1
    if count:
        avg_metrics = {k: round(v / count, 4) for k, v in avg_metrics.items()}

    return {
        "status": "COMPLETED",
        "experimentId": f"india-wf-{uuid.uuid4().hex[:8]}",
        "datasetVersion": dataset_version,
        "folds": folds_out,
        "averageTestMetrics": avg_metrics,
        "challenger": {"modelVersion": version, "algorithm": best["algorithm"]},
        "createdAt": int(time.time() * 1000),
    }