"""
Indian model registry + prediction service (spec §19).

Fully separate from the Forex/Crypto model layer (models.py): Indian artifacts
live in models-india/ and datasets-india/, and the India service ONLY ever
predicts with India feature names. No cross-contamination with Forex features.
"""
from __future__ import annotations

import os
import time
from typing import Any, Dict, List, Optional, Tuple

import joblib
import numpy as np

from .models import ModelRecord, ModelRegistry, make_classifier
from .india_features import FEATURE_VERSION as INDIA_FEATURE_VERSION
from .india_features import INDIA_FEATURE_NAMES

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INDIA_MODEL_DIR = os.path.join(BASE_DIR, "models-india")
INDIA_DATASET_DIR = os.path.join(BASE_DIR, "datasets-india")
INDIA_V2_MODEL_DIR = os.path.join(BASE_DIR, "models-india-v2")
os.makedirs(INDIA_MODEL_DIR, exist_ok=True)
os.makedirs(INDIA_DATASET_DIR, exist_ok=True)
os.makedirs(INDIA_V2_MODEL_DIR, exist_ok=True)


class IndiaModelRegistry(ModelRegistry):
    """Same persistence pattern as ModelRegistry but isolated to the India dir."""

    def __init__(self):
        super().__init__(INDIA_MODEL_DIR)


class IndiaAiService:
    def __init__(self):
        self.registry = IndiaModelRegistry()
        self._champion: Optional[Any] = None
        self._champion_record: Optional[ModelRecord] = None
        self._challenger: Optional[Any] = None
        self._challenger_record: Optional[ModelRecord] = None
        self._load()

    def _load(self) -> None:
        self._champion = None
        self._champion_record = None
        self._challenger = None
        self._challenger_record = None
        champ = self.registry.champion()
        if champ:
            try:
                self._champion = joblib.load(os.path.join(INDIA_MODEL_DIR, f"{champ.modelVersion}.joblib"))
                self._champion_record = champ
            except Exception:
                self._champion = None
        chal = self.registry.challenger()
        if chal:
            try:
                self._challenger = joblib.load(os.path.join(INDIA_MODEL_DIR, f"{chal.modelVersion}.joblib"))
                self._challenger_record = chal
            except Exception:
                self._challenger = None

    def _predict_one(self, clf: Any, rec: Optional[ModelRecord], features: Dict[str, float]) -> Optional[Dict[str, Any]]:
        if clf is None or rec is None:
            return None
        vec = np.array([[features.get(name, 0.0) for name in INDIA_FEATURE_NAMES]], dtype=float)
        proba = clf.predict_proba(vec)[0]
        # FIX H6: map via classes_ to handle single-class India models
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
        out.update({
            "symbol": symbol, "timeframe": timeframe, "timestamp": timestamp,
            "target": "FUTURE_DIRECTION", "probability": out.get("calibratedProbability", 0.5),
        })
        if not out["available"]:
            out["error"] = "no India model trained — train one via POST /india/train"
        return out

    def train_walk_forward(self, data: Dict[str, List[Dict[str, Any]]], timeframe: str,
                           folds: int = 3, horizon: int = 1, feature_version: str = INDIA_FEATURE_VERSION) -> Dict[str, Any]:
        from .india_walkforward import run_india_walk_forward
        result = run_india_walk_forward(data, timeframe, folds=folds, horizon=horizon, feature_version=feature_version)
        self._load()
        return result


INDIA_SERVICE = IndiaAiService()


class IndiaV2Service:
    """Champion/challenger service for the v2 pipeline (stacking + meta-labeling).

    A v2 model bundle is a dict {primaries: {algo: clf}, stack, meta, algorithms,
    threshold, ...}. Production prediction returns the primary (stacked)
    probability gated by the meta model: below the meta threshold the signal is
    filtered (no trade), above it the signal is taken with its true probability.
    """

    def __init__(self, directory: str = INDIA_V2_MODEL_DIR):
        from .india_v2 import IndiaV2Registry, load_v2_bundle
        self.registry = IndiaV2Registry()
        self._champion: Optional[Dict[str, Any]] = None
        self._champion_record: Optional[ModelRecord] = None
        self._challenger: Optional[Dict[str, Any]] = None
        self._challenger_record: Optional[ModelRecord] = None
        self._directory = directory
        self._load()

    def _load(self) -> None:
        from .india_v2 import load_v2_bundle
        self._champion = None
        self._champion_record = None
        self._challenger = None
        self._challenger_record = None
        champ = self.registry.champion()
        if champ:
            try:
                self._champion = load_v2_bundle(champ.modelVersion)
                self._champion_record = champ
            except Exception:
                self._champion = None
        chal = self.registry.challenger()
        if chal:
            try:
                self._challenger = load_v2_bundle(chal.modelVersion)
                self._challenger_record = chal
            except Exception:
                self._challenger = None

    def _bundle_proba(self, bundle: Dict[str, Any], features: Dict[str, float]) -> Tuple[float, float, int]:
        """Returns (stacked_p, meta_p, direction) for the given feature vector."""
        vec = np.array([[features.get(name, 0.0) for name in INDIA_FEATURE_NAMES]], dtype=float)
        primaries = bundle["primaries"]
        algorithms = bundle.get("algorithms", [a for a in primaries])
        def _p_one(est, X):
            proba = est.predict_proba(X)
            classes = getattr(est, "classes_", None)
            if classes is not None and 1 in list(classes):
                idx = list(classes).index(1)
                return proba[:, idx] if proba.shape[1] > idx else proba[:, 0]
            return proba[:, 1] if proba.shape[1] > 1 else proba[:, 0]
        oof = np.column_stack([_p_one(primaries[a], vec) for a in algorithms])
        stack_proba = bundle["stack"].predict_proba(oof)
        stack_classes = getattr(bundle["stack"], "classes_", None)
        if stack_classes is not None and 1 in list(stack_classes):
            idx = list(stack_classes).index(1)
            p = float(stack_proba[0, idx] if stack_proba.shape[1] > idx else stack_proba[0, 0])
        else:
            p = float(stack_proba[0, 1] if stack_proba.shape[1] > 1 else stack_proba[0, 0])
        meta_features = [p, abs(p - 0.5)] + [features.get(name, 0.0) for name in INDIA_FEATURE_NAMES]
        meta_proba = bundle["meta"].predict_proba(np.array([meta_features], dtype=float))
        meta_classes = getattr(bundle["meta"], "classes_", None)
        if meta_classes is not None and 1 in list(meta_classes):
            idxm = list(meta_classes).index(1)
            meta_p = float(meta_proba[0, idxm] if meta_proba.shape[1] > idxm else meta_proba[0, 0])
        else:
            meta_p = float(meta_proba[0, 1] if meta_proba.shape[1] > 1 else meta_proba[0, 0])
        direction = 1 if p >= 0.5 else -1
        return p, meta_p, direction

    def predict(self, symbol: str, timeframe: str, timestamp: float, features: Dict[str, float],
                use_shadow: bool = False) -> Dict[str, Any]:
        bundle = self._champion if not use_shadow else self._challenger
        rec = self._champion_record if not use_shadow else self._challenger_record
        fallback = bundle is None
        if fallback:
            bundle, rec = self._challenger, self._challenger_record
        if bundle is None or rec is None:
            out: Dict[str, Any] = {
                "symbol": symbol, "timeframe": timeframe, "timestamp": timestamp,
                "available": False, "error": "no India v2 model trained — train one via POST /india/v2/train",
            }
            return out
        p, meta_p, direction = self._bundle_proba(bundle, features)
        threshold = float(bundle.get("threshold", 0.6))
        filtered = meta_p < threshold
        out = {
            "symbol": symbol, "timeframe": timeframe, "timestamp": timestamp,
            "available": True,
            "modelVersion": rec.modelVersion,
            "datasetVersion": rec.datasetVersion,
            "featureVersion": rec.featureVersion,
            "algorithm": "STACKED_META",
            "target": "TRIPLE_BARRIER+STACK+META",
            "probability": round(p, 5),
            "direction": direction,
            "metaProbability": round(meta_p, 5),
            "threshold": threshold,
            "filtered": bool(filtered),
            "shadow": bool(use_shadow) or bool(fallback),
            "fallback": bool(fallback),
            "confidence": round(min(1.0, 0.5 + abs(p - 0.5) * 2) * (1.0 if not filtered else 0.4), 4),
            "brierScore": rec.metrics.get("brier"),
        }
        if filtered:
            out["signal"] = "NO_TRADE"
            out["note"] = "signal filtered by meta-labeling model (low conviction)"
        else:
            out["signal"] = "LONG" if direction == 1 else "SHORT"
        return out


INDIA_V2_SERVICE = IndiaV2Service()