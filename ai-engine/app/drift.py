"""Drift monitoring: compares recent feature/prediction distributions to the
training reference and reports HEALTHY / WARNING / PAUSED."""
from __future__ import annotations

import json
import os
from typing import Any, Dict, List

import numpy as np

from .features import FEATURE_NAMES
from .models import DATASET_DIR


def _zscore_drift(reference: List[Dict[str, float]], recent: List[Dict[str, float]]) -> float:
    if not reference or not recent:
        return 0.0
    keys = [k for k in FEATURE_NAMES if k in reference[0]]
    ref = np.array([[r.get(k, 0.0) for k in keys] for r in reference])
    rec = np.array([[r.get(k, 0.0) for k in keys] for r in recent])
    mean = ref.mean(axis=0)
    std = ref.std(axis=0) + 1e-9
    z = np.abs((rec - mean) / std).mean(axis=0)
    return float(np.clip(z.mean() / 3.0, 0.0, 1.0))


def assess_drift(reference: List[Dict[str, float]], recent: List[Dict[str, float]],
                 recent_probs: List[float], recent_outcomes: List[int] | None = None) -> Dict[str, Any]:
    feature_drift = _zscore_drift(reference, recent)
    pred_drift = float(np.clip(abs(float(np.mean(recent_probs or [0.5])) - 0.5) * 2, 0, 1)) if recent_probs else 0.0
    confidence_drift = float(np.clip(feature_drift * 0.6 + pred_drift * 0.4, 0, 1))

    win_rate = None
    if recent_outcomes and len(recent_outcomes) >= 10:
        probs = np.array(recent_probs)
        outs = np.array(recent_outcomes)
        preds = (probs >= 0.5).astype(int)
        win_rate = float(np.mean(preds == outs))

    if confidence_drift > 0.75:
        status = "PAUSED"
        reason = "excessive drift — model paused, signals fall back to WAIT"
    elif confidence_drift > 0.5 or (win_rate is not None and win_rate < 0.4):
        status = "WARNING"
        reason = f"elevated drift (feature {feature_drift:.2f}, win rate {win_rate})"
    else:
        status = "HEALTHY"
        reason = "model within expected drift"

    return {
        "status": status,
        "featureDrift": round(feature_drift, 3),
        "predictionDrift": round(pred_drift, 3),
        "confidenceDrift": round(confidence_drift, 3),
        "winRateRecent": win_rate,
        "reason": reason,
        "updatedAt": int(__import__("time").time() * 1000),
    }


def load_reference_features() -> List[Dict[str, float]]:
    """Load the newest dataset's rows as a drift reference."""
    try:
        names = sorted(os.listdir(DATASET_DIR), reverse=True)
        for name in names:
            if name.endswith(".json"):
                with open(os.path.join(DATASET_DIR, name)) as f:
                    data = json.load(f)
                # dataset file stores summary only; reference from a stored sample if present
                sample = data.get("featureSample", [])
                if sample:
                    return sample
                return []
    except Exception:
        return []
    return []
