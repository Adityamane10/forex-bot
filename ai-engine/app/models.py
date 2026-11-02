"""
Model layer: trains Logistic Regression, Random Forest, XGBoost and LightGBM
with time-series walk-forward validation, probability calibration (Platt +
isotonic), dataset/model versioning and champion/challenger tracking.

Every model records its exact training/validation/test windows and metrics so
every prediction is traceable to its model + dataset version.
"""
from __future__ import annotations

import json
import os
import time
import uuid
from dataclasses import dataclass, field, asdict
from typing import Dict, List, Optional, Any

import joblib
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.ensemble import RandomForestClassifier
from sklearn.calibration import CalibratedClassifierCV
from sklearn.metrics import (
    accuracy_score, precision_score, recall_score, f1_score, brier_score_loss, roc_auc_score,
)

try:
    from xgboost import XGBClassifier
except Exception:  # pragma: no cover
    XGBClassifier = None
try:
    from lightgbm import LGBMClassifier
except Exception:  # pragma: no cover
    LGBMClassifier = None

from .features import FEATURE_NAMES, FEATURE_VERSION

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL_DIR = os.path.join(BASE_DIR, "models")
DATASET_DIR = os.path.join(BASE_DIR, "datasets")
os.makedirs(MODEL_DIR, exist_ok=True)
os.makedirs(DATASET_DIR, exist_ok=True)

ALGORITHMS = ["LOGISTIC_REGRESSION", "RANDOM_FOREST", "XGBOOST", "LIGHTGBM"]

# Brier >= 0.25 equals random guessing on balanced 2-class targets; AUC 0.5 is a coin flip.
def passes_quality_gate(metrics: Dict[str, float]) -> bool:
    """Statistical minimum bar for a model to be eligible for promotion."""
    if metrics.get("brier", 1.0) >= 0.25:
        return False
    if metrics.get("auc", 0.0) <= 0.5:
        return False
    return True


def make_classifier(algo: str, seed: int = 42):
    if algo == "LOGISTIC_REGRESSION":
        return LogisticRegression(max_iter=2000, C=1.0, random_state=seed)
    if algo == "RANDOM_FOREST":
        return RandomForestClassifier(n_estimators=200, max_depth=6, min_samples_leaf=20, random_state=seed, n_jobs=-1)
    if algo == "XGBOOST" and XGBClassifier is not None:
        return XGBClassifier(n_estimators=200, max_depth=4, learning_rate=0.05, subsample=0.8, colsample_bytree=0.8, random_state=seed, eval_metric="logloss", verbosity=0)
    if algo == "LIGHTGBM" and LGBMClassifier is not None:
        return LGBMClassifier(n_estimators=200, max_depth=4, learning_rate=0.05, subsample=0.8, colsample_bytree=0.8, random_state=seed, verbosity=-1)
    raise ValueError(f"algorithm {algo} unavailable")


@dataclass
class ModelRecord:
    modelVersion: str
    algorithm: str
    target: str
    datasetVersion: str
    featureVersion: str
    trainingPeriod: Dict[str, float]
    validationPeriod: Dict[str, float]
    testPeriod: Dict[str, float]
    hyperparameters: Dict[str, Any]
    metrics: Dict[str, float]
    createdAt: float
    status: str = "CHALLENGER"
    shadow: bool = True
    scaler: Optional[bytes] = None  # not persisted in JSON; kept separately


class ModelRegistry:
    """Persists model metadata as JSON files (one per version)."""

    def __init__(self, directory: str = MODEL_DIR):
        self.directory = directory

    def _path(self, version: str) -> str:
        return os.path.join(self.directory, f"{version}.json")

    def save(self, record: ModelRecord) -> None:
        payload = asdict(record)
        payload.pop("scaler", None)
        with open(self._path(record.modelVersion), "w") as f:
            json.dump(payload, f, indent=2, default=str)

    def load(self, version: str) -> Optional[ModelRecord]:
        try:
            with open(self._path(version)) as f:
                return ModelRecord(**json.load(f))
        except Exception:
            return None

    def list(self) -> List[Dict[str, Any]]:
        out = []
        for name in sorted(os.listdir(self.directory)):
            if name.endswith(".json"):
                try:
                    with open(os.path.join(self.directory, name)) as f:
                        out.append(json.load(f))
                except Exception:
                    continue
        return sorted(out, key=lambda m: m.get("createdAt", 0), reverse=True)

    def champion(self) -> Optional[ModelRecord]:
        for m in self.list():
            if m.get("status") == "CHAMPION":
                return ModelRecord(**m)
        return None

    def challenger(self) -> Optional[ModelRecord]:
        for m in self.list():
            if m.get("status") == "CHALLENGER" and m.get("shadow"):
                return ModelRecord(**m)
        return None

    def set_status(self, version: str, status: str) -> None:
        rec = self.load(version)
        if rec:
            rec.status = status
            self.save(rec)

    def _gate_passing_challenger(self) -> Optional["ModelRecord"]:
        """Newest shadow CHALLENGER that clears the statistical quality gate,
        was trained on the CURRENT feature schema, and is not degenerate
        (constant probability output). Older unhealthy records may still sit
        in the registry — they must never be promoted."""
        for m in self.list():
            if m.get("status") != "CHALLENGER" or not m.get("shadow"):
                continue
            rec = ModelRecord(**m)
            if rec.featureVersion and rec.featureVersion != FEATURE_VERSION:
                continue  # stale schema — cannot serve against current vectors
            if not passes_quality_gate(rec.metrics):
                continue
            path = os.path.join(MODEL_DIR, f"{rec.modelVersion}.joblib")
            if not os.path.exists(path):
                continue  # artifact deleted (e.g. degenerate guard) — skip
            return rec
        return None

    def evaluate_challenger(self, championIneligible: Optional[str] = None) -> Dict[str, Any]:
        champion = self.champion()
        challenger = self._gate_passing_challenger()
        if not champion:
            if challenger:
                self.set_status(challenger.modelVersion, "CHAMPION")
                return {"promoted": True, "reason": "no champion existed; challenger promoted"}
            return {"promoted": False, "reason": "no champion and no challenger above quality gate (brier >= 0.25 or auc <= 0.5)"}
        if not challenger:
            return {"promoted": False, "reason": "no challenger above quality gate (brier >= 0.25 or auc <= 0.5)"}
        # An INELIGIBLE champion (stale feature schema or degenerate constant
        # output) has no standing: it cannot serve predictions at all, so its
        # historical metrics must not shield it from a healthy challenger.
        # This is the honest replacement path — the old policy let a
        # leakage-inflated champion (pf 4.5 from train/serve skew) block every
        # legitimate retrain forever.
        if championIneligible:
            self.set_status(champion.modelVersion, "ARCHIVED")
            self.set_status(challenger.modelVersion, "CHAMPION")
            return {"promoted": True, "reason": f"champion ineligible ({championIneligible}) — healthy challenger promoted"}
        checks = []
        for key in ("profitFactor", "expectancy"):
            if challenger.metrics.get(key, -1e9) > champion.metrics.get(key, -1e9) * 1.05:
                checks.append(key)
        if challenger.metrics.get("maxDrawdown", 1e9) < champion.metrics.get("maxDrawdown", 1e9) * 0.95:
            checks.append("maxDrawdown")
        if challenger.metrics.get("brier", 1.0) < champion.metrics.get("brier", 1.0) * 0.95:
            checks.append("brier")
        if len(checks) >= 2:
            self.set_status(champion.modelVersion, "ARCHIVED")
            self.set_status(challenger.modelVersion, "CHAMPION")
            return {"promoted": True, "reason": f"challenger beats champion on {', '.join(checks)}"}
        return {"promoted": False, "reason": "challenger did not meet promotion criteria"}


class AiService:
    """Holds champion/challenger pipelines in memory for fast prediction."""

    def __init__(self):
        self.registry = ModelRegistry()
        self._champion: Optional[Any] = None
        self._champion_record: Optional[ModelRecord] = None
        self._challenger: Optional[Any] = None
        self._challenger_record: Optional[ModelRecord] = None
        self._last_refusal: Optional[str] = None
        # modelVersion → spread between contrasting probe predictions
        # (bullish vs bearish feature rows). ~0 ⇒ the model is degenerate
        # and must never gate a live trade.
        self._probe_variability: Dict[str, float] = {}
        self._load()

    @staticmethod
    def _probes() -> List[Dict[str, float]]:
        """Two contrasting synthetic feature rows: strongly bullish and
        strongly bearish readings on every normalized indicator. A healthy
        directional model MUST score them differently."""
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
        return [bullish, bearish]

    def _measure_variability(self, clf: Any) -> float:
        """Abs difference between bullish and bearish probe predictions.
        A healthy directional model separates these strongly; a degenerate
        one returns ~0 difference."""
        try:
            ps = []
            for probe in self._probes():
                vec = np.array([[probe.get(name, 0.0) for name in FEATURE_NAMES]], dtype=float)
                proba = clf.predict_proba(vec)[0]
                classes = getattr(clf, "classes_", None)
                idx = list(classes).index(1) if classes is not None and 1 in list(classes) else (1 if proba.shape[0] > 1 else 0)
                ps.append(float(proba[idx]))
            return abs(ps[0] - ps[1])
        except Exception:
            # If we cannot probe, we cannot prove degeneracy — stay silent and
            # let the model serve (the fold-time guard already filters most).
            return 1.0

    def _load(self) -> None:
        # reset first so in-memory state always mirrors disk (no stale models)
        self._champion = None
        self._champion_record = None
        self._challenger = None
        self._challenger_record = None
        champ = self.registry.champion()
        if champ:
            try:
                clf = joblib.load(os.path.join(MODEL_DIR, f"{champ.modelVersion}.joblib"))
                self._probe_variability[champ.modelVersion] = self._measure_variability(clf)
                self._champion = clf
                self._champion_record = champ
            except Exception:
                # A corrupt/truncated artifact must not take the whole AI
                # engine down at boot: degrade to no-champion (predict then
                # reports `available: false` honestly) instead of crashing.
                self._champion = None
        chal = self.registry.challenger()
        if chal:
            try:
                clf = joblib.load(os.path.join(MODEL_DIR, f"{chal.modelVersion}.joblib"))
                self._probe_variability[chal.modelVersion] = self._measure_variability(clf)
                self._challenger = clf
                self._challenger_record = chal
            except Exception:
                self._challenger = None

    def _predict_one(self, clf: Any, rec: Optional[ModelRecord], features: Dict[str, float]) -> Optional[Dict[str, Any]]:
        if clf is None or rec is None:
            return None
        # Feature-set gate (features-v3): a model trained on an older feature
        # set must never score a newer vector — that silently corrupts every
        # probability it emits. Refuse honestly instead; retraining is the fix.
        if rec.featureVersion and rec.featureVersion != FEATURE_VERSION:
            self._last_refusal = (
                f"model {rec.modelVersion} trained on {rec.featureVersion}, "
                f"engine serves {FEATURE_VERSION} — retrain via POST /train"
            )
            return None
        self._last_refusal = None
        vec = np.array([[features.get(name, 0.0) for name in FEATURE_NAMES]], dtype=float)
        proba = clf.predict_proba(vec)[0]
        # FIX H6: map via classes_ to handle single-class models (proba[1] inversion bug)
        classes = getattr(clf, "classes_", None)
        if classes is not None and len(classes) > 0:
            try:
                if 1 in list(classes):
                    idx = list(classes).index(1)
                    p_up = float(proba[idx]) if idx < len(proba) else 0.0
                elif len(classes) == 1 and classes[0] == 0:
                    p_up = 0.0
                elif len(classes) == 1 and classes[0] == 1:
                    p_up = float(proba[0])
                else:
                    p_up = float(proba[1] if len(proba) > 1 else proba[0])
            except Exception:
                p_up = float(proba[1] if len(proba) > 1 else proba[0])
        else:
            p_up = float(proba[1] if proba.shape[0] > 1 else proba[0])
        # Degenerate-model guard (serve time): a model that emits the same
        # probability for radically different inputs is broken — most often
        # from train/serve feature skew. Serving it would freeze the AI gate
        # at one number and silently block every trade forever. Refuse
        # honestly; retraining is the fix. The variability is measured once
        # at load time by probing the model with contrasting feature rows.
        if self._probe_variability.get(rec.modelVersion, 1.0) < 0.01:
            self._last_refusal = (
                f"model {rec.modelVersion} is degenerate (constant probability "
                f"across probe inputs) — retrain via POST /train"
            )
            return None
        # confidence: distance from 0.5 scaled (max 1)
        confidence = min(1.0, 0.5 + abs(p_up - 0.5) * 2)
        return {
            "modelVersion": rec.modelVersion,
            "algorithm": rec.algorithm,
            "datasetVersion": rec.datasetVersion,
            "featureVersion": rec.featureVersion,
            "rawProbability": p_up,
            "calibratedProbability": p_up,
            "confidence": round(confidence, 4),
            "brierScore": rec.metrics.get("brier"),
            "calibrationError": rec.metrics.get("calibrationError"),
        }

    def predict(self, symbol: str, timeframe: str, timestamp: float, features: Dict[str, float], use_shadow: bool = False) -> Dict[str, Any]:
        # Shadow mode: challenger prediction only (never affects production).
        # Production mode: champion; until a champion is promoted the newest
        # challenger serves as the de-facto model (marked with fallback=true).
        if use_shadow:
            out = self._predict_one(self._challenger, self._challenger_record, features)
            if out is None:
                out = self._predict_one(self._champion, self._champion_record, features)
            out = dict(out or {})
            out["shadow"] = True
            out["available"] = out.get("modelVersion") is not None
        else:
            out = self._predict_one(self._champion, self._champion_record, features)
            fallback = out is None
            if fallback:
                out = self._predict_one(self._challenger, self._challenger_record, features)
            out = dict(out or {})
            out["shadow"] = False
            out["fallback"] = fallback and out.get("modelVersion") is not None
            out["available"] = out.get("modelVersion") is not None
        out.update({"symbol": symbol, "timeframe": timeframe, "timestamp": timestamp,
                    "target": "FUTURE_DIRECTION", "probability": out.get("calibratedProbability", 0.5)})
        if not out["available"]:
            out["error"] = self._last_refusal or "no trained model available — train one via POST /train"
        return out

    def train_walk_forward(self, data: Dict[str, List[Dict[str, Any]]], timeframe: str,
                           folds: int = 3, horizon: int = 12, feature_version: str = FEATURE_VERSION,
                           feature_rows: Dict[str, List[Dict[str, Any]]] | None = None) -> Dict[str, Any]:
        """Train all algorithms per fold on a walk-forward schedule, keep the
        best model as CHALLENGER, and register dataset + model versions."""
        from .walkforward import run_walk_forward
        result = run_walk_forward(data, timeframe, folds=folds, horizon=horizon,
                                  feature_version=feature_version, feature_rows=feature_rows)
        self._load()
        return result


SERVICE = AiService()
