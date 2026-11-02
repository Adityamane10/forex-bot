"""
Walk-forward validation. Rolling TRAIN -> VALIDATE -> TEST windows:
  fold 1: train [Jan..Jun], validate [Jul], test [Aug]
  fold 2: train [Feb..Jul], validate [Aug], test [Sep]
  ...
Calibration is fit on the VALIDATE window and applied to TEST predictions —
never tuned against the final test period.
"""
from __future__ import annotations

import bisect
import json
import os
import time
import uuid
from typing import Any, Dict, List

import joblib
import numpy as np
import pandas as pd
from sklearn.calibration import CalibratedClassifierCV, IsotonicRegression
from sklearn.metrics import brier_score_loss, accuracy_score, roc_auc_score, precision_score, recall_score, f1_score

from .features import build_dataset, FEATURE_NAMES, FEATURE_VERSION
from .models import make_classifier, ModelRecord, ModelRegistry, ALGORITHMS, MODEL_DIR, DATASET_DIR

# Target-horizon backtest-style metrics computed on test-set trades
def _trade_metrics(y_true: np.ndarray, p_up: np.ndarray, threshold: float = 0.55) -> Dict[str, float]:
    pred = (p_up >= threshold).astype(int)
    n = len(y_true)
    if n == 0:
        return {"trades": 0}
    correct = pred == y_true
    wins = int(np.sum(correct))
    losses = n - wins
    win_rate = wins / n if n else 0.0
    profit_factor = wins / losses if losses else (float("inf") if wins else 0.0)
    return {
        "trades": n,
        "winRate": round(win_rate, 4),
        "profitFactor": float(profit_factor),
        "expectancy": round(win_rate * 1.0 - (1 - win_rate) * 1.0, 4),  # 1R proxy
        "accuracy": round(accuracy_score(y_true, pred), 4),
    }


def _purged_splits(n: int, train_end: int, val_end: int, test_end: int, horizon: int):
    """Purge horizon rows after train and val blocks to prevent label leakage (H2)."""
    train_p = max(0, train_end - horizon)
    val_p = max(train_end, val_end - horizon)
    return train_p, val_p


def _fit_calibrated(clf: Any, method: str, X_val, y_val) -> Any:
    # FIX C3: calibration must preserve X_train fit, only fit calibrator on X_val.
    # Use FrozenEstimator + cv=3 for sklearn>=1.6 (sklearn 1.9 here), fallback to cv="prefit" for older.
    try:
        from sklearn.frozen import FrozenEstimator
        cal = CalibratedClassifierCV(estimator=FrozenEstimator(clf), method=method, cv=3)
        cal.fit(X_val, y_val)
    except ImportError:
        cal = CalibratedClassifierCV(estimator=clf, method=method, cv="prefit")  # type: ignore[arg-type]
        cal.fit(X_val, y_val)
    except Exception:
        from sklearn.frozen import FrozenEstimator  # type: ignore
        cal = CalibratedClassifierCV(estimator=FrozenEstimator(clf), method=method, cv=3)
        cal.fit(X_val, y_val)
    return cal


def _probe_variability(clf: Any) -> float:
    """Abs probability spread between a strongly bullish and a strongly
    bearish synthetic row. A healthy directional model separates them; a
    degenerate one (e.g. an isotonic calibrator collapsed to one step) scores
    both ~the same. Probes are in the SAME [0,1] normalized space the live
    feature engine emits."""
    base = {
        "close": 0.5, "rsi14": 0.5, "macdHistogram": 0.5, "macdLine": 0.5,
        "adx": 0.4, "atrPct": 0.4, "bbPosition": 0.5,
        "ema9minus20": 0.5, "ema20minus50": 0.5, "ema50minus200": 0.5,
        "stochK": 0.5, "williamsR14": 0.5, "cci20": 0.5, "roc10": 0.5,
        "momentum10": 0.5, "bbWidth": 0.3, "supertrendDirection": 0.5,
        "candleBody": 0.5, "upperWick": 0.2, "lowerWick": 0.2,
        "swingHighDistance": 0.5, "swingLowDistance": 0.5,
        "spreadPips": 0.2, "session": 0.7,
        "regimeBullish": 0.0, "regimeBearish": 0.0, "regimeRange": 1.0,
        "regimeBreakout": 0.0, "eventRisk": 0.0, "newsSentiment": 0.0,
        "historicalBuyProbability": 0.5, "dataQualityScore": 0.9,
        "hourOfDaySin": 0.5, "hourOfDayCos": 0.5,
        "dayOfWeekSin": 0.5, "dayOfWeekCos": 0.5, "goldMomentum": 0.5,
    }
    bullish = dict(base)
    bearish = dict(base)
    for k in ("close", "rsi14", "macdHistogram", "macdLine", "bbPosition",
              "ema9minus20", "ema20minus50", "ema50minus200", "stochK",
              "williamsR14", "cci20", "roc10", "momentum10",
              "supertrendDirection", "historicalBuyProbability", "goldMomentum"):
        bullish[k] = 0.95
        bearish[k] = 0.05
    bullish["regimeBullish"], bullish["regimeRange"] = 1.0, 0.0
    bearish["regimeBearish"], bearish["regimeRange"] = 1.0, 0.0
    try:
        ps = []
        for probe in (bullish, bearish):
            vec = np.array([[probe.get(name, 0.0) for name in FEATURE_NAMES]], dtype=float)
            proba = clf.predict_proba(vec)[0]
            classes = getattr(clf, "classes_", None)
            idx = list(classes).index(1) if classes is not None and 1 in list(classes) else (1 if proba.shape[0] > 1 else 0)
            ps.append(float(proba[idx]))
        return abs(ps[0] - ps[1])
    except Exception:
        return 1.0  # cannot probe → cannot prove degeneracy


def _train_one(algo: str, X_train, y_train, X_val, y_val) -> Any:
    clf = make_classifier(algo)
    clf.fit(X_train, y_train)
    # Degenerate-model guard (fit time): a model that emits (nearly) the same
    # probability for EVERY training row carries no directional information —
    # at serve time it freezes the AI gate at one number forever. Reject it
    # here so the fold simply records an error instead of becoming champion.
    try:
        p_train = clf.predict_proba(X_train)
        p_up_train = p_train[:, 1] if p_train.shape[1] > 1 else p_train[:, 0]
        if float(np.std(p_up_train)) < 0.005:
            raise ValueError(
                f"degenerate {algo} model: constant probability on train "
                f"(std={float(np.std(p_up_train)):.5f}) — data is too small/skewed"
            )
    except ValueError:
        raise
    except Exception:
        pass  # probing must never break a genuinely usable model
    # Isotonic first; if the small validation set collapsed it into a
    # step function with (near-)constant output on PROBE inputs, fall back to
    # sigmoid (smooth, cannot collapse), then to the raw model. A calibrator
    # that erases all variation is worse than no calibrator.
    cal = _fit_calibrated(clf, "isotonic", X_val, y_val)
    if _probe_variability(cal) < 0.01:
        cal = _fit_calibrated(clf, "sigmoid", X_val, y_val)
        if _probe_variability(cal) < 0.01:
            return clf  # raw model beats a flattening calibrator
    return cal


def _evaluate(algo: str, clf, X_test, y_test) -> Dict[str, float]:
    y = np.asarray(y_test)
    proba = clf.predict_proba(X_test)
    # FIX H6: map via classes_ to avoid inversion when single-class model
    classes = getattr(clf, "classes_", None)
    if classes is not None and 1 in list(classes):
        idx = list(classes).index(1)
        p_up = proba[:, idx] if proba.shape[1] > idx else proba[:, 0]
    elif classes is not None and len(classes) == 1 and classes[0] == 0:
        # only down class seen -> P(up)=0
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


def run_walk_forward(data: Dict[str, List[Dict[str, Any]]], timeframe: str,
                     folds: int = 3, horizon: int = 12,
                     feature_version: str = FEATURE_VERSION,
                     feature_rows: Dict[str, List[Dict[str, Any]]] | None = None) -> Dict[str, Any]:
    """data: {symbol: [candles]} — candles must be time-ordered oldest->newest.

    feature_rows (preferred): {symbol: [prebuilt feature rows]} produced by the
    BACKEND's own live feature engine (same code as serving). When supplied,
    candles are used only for the goldMomentum context as-of join and labels;
    features come verbatim from the rows — train/serve skew is impossible by
    construction. This is the fix for the constant-probability champion that
    silently froze the AI gate at 0.4717 for every input.
    """
    symbols = list(data.keys())
    # XAU/USD 10-bar ROC context (XAUUSD-LSTM adoption): when gold candles are
    # part of the training payload, every OTHER symbol's dataset gets a
    # lookahead-free goldMomentum context — at bar i it uses gold closes up to
    # i only, mirroring the live signal-engine computation exactly. No gold
    # in the payload → the feature stays neutral 0.5 (the live fallback).
    gold = data.get("XAU/USD")
    gold_closes = [float(c["close"]) for c in gold] if gold else []
    gold_times = [int(c.get("openTime", 0) or 0) for c in gold] if gold else []

    def gold_context_fn(symbol: str):
        if not gold_closes or symbol == "XAU/USD":
            return None
        def ctx(i: int, symbol: str = symbol) -> Dict[str, float]:
            sym_times = [int(c.get("openTime", 0) or 0) for c in data[symbol]]
            # last gold bar with openTime <= this bar's openTime (as-of join)
            j = bisect.bisect_right(gold_times, sym_times[i]) - 1
            if j >= 10:
                base = gold_closes[j]
                prev = gold_closes[j - 10]
                roc = ((base - prev) / prev) * 100 if prev else 0.0
                return {"goldRoc10": roc}
            return {"goldRoc10": None}
        return ctx

    # Build per-symbol labeled frames
    frames = []
    if feature_rows:
        # Rows mode: labels are recomputed from candles (same rule as live
        # labeling: >0.05% move over `horizon` bars), features are the backend-
        # generated rows joined by timestamp. Rows carry forward_return from
        # the backend's replay; it is DROPPED here so every feature used for
        # training comes from the exact serving schema.
        for symbol in symbols:
            rows = feature_rows.get(symbol) or []
            if len(rows) < 250:
                continue
            candles = data.get(symbol) or []
            sym_times = [int(c.get("openTime", 0) or 0) for c in candles]
            closes = [float(c["close"]) for c in candles]
            symbol_rows = []
            for row in rows:
                ts = int(row.get("timestamp", 0) or 0)
                j = bisect.bisect_right(sym_times, ts) - 1
                if j < 0 or j + horizon >= len(closes):
                    continue  # no future bar → no label (no partial labels)
                ret = (closes[j + horizon] - closes[j]) / closes[j] if closes[j] else 0.0
                out = {k: row.get(k) for k in FEATURE_NAMES}
                out["target"] = 1 if ret > 0.0005 else 0
                out["forward_return"] = ret * 100
                out["timestamp"] = ts
                symbol_rows.append(out)
            if len(symbol_rows) >= 250:
                frames.extend(symbol_rows)
        if not frames:
            return {"status": "FAILED", "error": "insufficient prebuilt feature rows for training"}
    else:
        for symbol in symbols:
            candles = data[symbol]
            if len(candles) < 300:
                continue
            ctx_fn = gold_context_fn(symbol)
            df = build_dataset(candles, horizon=horizon, context_fn=ctx_fn)
            if len(df) > 200:
                frames.append(df)
        if not frames:
            return {"status": "FAILED", "error": "insufficient candle history for training"}

    if feature_rows:
        # rows mode: `frames` is a flat list of row dicts (all symbols merged)
        merged = pd.DataFrame(frames)
    else:
        merged = pd.concat(frames, ignore_index=True)
    merged = merged.sort_values("timestamp").dropna(subset=FEATURE_NAMES).reset_index(drop=True)
    if len(merged) < 250:
        return {"status": "FAILED", "error": "insufficient labeled samples"}

    dataset_version = f"dataset-{int(time.time())}"
    # FIX H7: emit featureSample for drift reference
    try:
        sample_n = min(100, len(merged))
        feature_sample = merged[FEATURE_NAMES].head(sample_n).to_dict(orient="records")
    except Exception:
        feature_sample = []
    with open(os.path.join(DATASET_DIR, f"{dataset_version}.json"), "w") as f:
        json.dump({
            "datasetVersion": dataset_version,
            "provider": "backend-market-data",
            "assets": symbols,
            "timeframes": [timeframe],
            "startDate": int(merged["timestamp"].min()),
            "endDate": int(merged["timestamp"].max()),
            "features": FEATURE_NAMES,
            "target": "FUTURE_DIRECTION",
            "preprocessingVersion": "preproc-v1",
            "rows": len(merged),
            "featureSample": feature_sample,
            "createdAt": int(time.time() * 1000),
        }, f, indent=2)

    X = merged[FEATURE_NAMES].values
    y = merged["target"].values.astype(int)
    n = len(merged)
    fold_size = n // (folds + 1)

    registry = ModelRegistry()
    best: Dict[str, Any] | None = None
    folds_out = []

    for fold in range(folds):
        train_end = fold_size * (fold + 1)
        val_end = train_end + fold_size
        test_end = min(val_end + fold_size, n)
        if test_end - val_end < 30 or val_end - train_end < 30:
            continue
        # FIX H2: purge horizon rows after each train block to prevent label leakage
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
                    modelVersion=f"{algo.lower()}-{uuid.uuid4().hex[:8]}",
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
                joblib.dump(clf, os.path.join(MODEL_DIR, f"{record.modelVersion}.joblib"))
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
            # Degenerate-model guard (selection time): a model whose test-set
            # probabilities barely move has nothing to gate on — never let it
            # become champion even when its metrics look flattering. Its
            # artifact is DELETED so a later promote/pick can never resurrect
            # a constant-probability model (the 0.4717-freeze failure mode).
            fr_degenerate = False
            try:
                fr_clf = joblib.load(os.path.join(MODEL_DIR, f"{fr['modelVersion']}.joblib"))
                fr_proba = fr_clf.predict_proba(X[val_end:test_end])
                fr_p = fr_proba[:, 1] if fr_proba.shape[1] > 1 else fr_proba[:, 0]
                fr_degenerate = float(np.std(fr_p)) < 0.01
            except Exception:
                pass  # probing must never disqualify a model we cannot load here
            if fr_degenerate or _probe_variability(fr_clf) < 0.01:
                fr["metrics"]["degenerate"] = True
                try:
                    os.remove(os.path.join(MODEL_DIR, f"{fr['modelVersion']}.joblib"))
                except OSError:
                    pass
                continue
            score = fr["metrics"].get("profitFactor", 0)
            score = score if np.isfinite(score) else 0
            if best is None or score > best.get("_score", -1):
                fr["metrics"]["_score"] = score
                best = {**fr, "_score": score, "fold": fold}

    if best is None:
        return {"status": "FAILED", "error": "no fold produced a usable model"}

    # register the best model as the new CHALLENGER (shadow)
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
        "experimentId": f"wf-{uuid.uuid4().hex[:8]}",
        "datasetVersion": dataset_version,
        "folds": folds_out,
        "averageTestMetrics": avg_metrics,
        "challenger": {"modelVersion": version, "algorithm": best["algorithm"]},
        "createdAt": int(time.time() * 1000),
    }
