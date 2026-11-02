"""
FastAPI application for the FX Intel AI engine.

Endpoints:
  GET  /health                 liveness
  GET  /models                 model versions (champion/challenger)
  GET  /datasets               dataset versions
  POST /predict                probability prediction (champion or shadow)
  POST /train                  walk-forward training from candles
  POST /sentiment              FinBERT-or-lexicon news sentiment
  GET  /drift                  drift status vs training reference
"""

from __future__ import annotations

import time
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from .features import build_dataset, compute_features_at, FEATURE_NAMES, FEATURE_VERSION
from .models import SERVICE, ModelRegistry
from .walkforward import run_walk_forward
from .drift import assess_drift, load_reference_features
from .sentiment import score_text, FINBERT_AVAILABLE
from .portfolio import analyze_portfolio
from .india_models import INDIA_SERVICE, IndiaModelRegistry
from .india_features import (
    INDIA_FEATURE_NAMES,
    FEATURE_VERSION as INDIA_FEATURE_VERSION,
)

app = FastAPI(title="FX Intel AI Engine", version="0.1.0")
STARTED_AT = time.time() * 1000

# WARM START: SERVICE (and INDIA_SERVICE) load champion/challenger pipelines
# from disk at import time — the first /predict after boot serves from memory
# with no load lag. Importing this module inside uvicorn's startup therefore
# IS the warm-start; the health report below surfaces what actually loaded.
registry = ModelRegistry()


class CandleIn(BaseModel):
    symbol: str
    timeframe: str
    open: float
    high: float
    low: float
    close: float
    volume: float = 0
    openTime: int
    closeTime: int
    completed: bool = True


class PredictIn(BaseModel):
    symbol: str
    timeframe: str
    timestamp: float
    features: Dict[str, float]
    useShadow: bool = False


class TrainIn(BaseModel):
    symbols: List[str] = Field(min_length=1)
    timeframe: str = "1h"
    featureVersion: str = FEATURE_VERSION
    folds: int = Field(default=3, gt=0)
    horizon: int = Field(default=12, gt=0)
    data: Dict[str, List[CandleIn]] = Field(description="symbol -> ordered candles")
    # Preferred: prebuilt feature rows from the BACKEND's live feature engine
    # (same code as serving — train/serve skew impossible by construction).
    # Keys mirror `data`; values are dicts with the FEATURE_NAMES keys.
    featureRows: Optional[Dict[str, List[Dict[str, Any]]]] = None


class SentimentIn(BaseModel):
    text: str


class PortfolioIn(BaseModel):
    symbols: List[str] = Field(min_length=1)
    returns: Dict[str, List[float]] = Field(
        description="symbol -> aligned simple returns"
    )
    weights: Dict[str, float] = Field(
        default_factory=dict, description="current notional weights (open positions)"
    )
    annualizationFactor: float = 6048.0


class IndiaPredictIn(BaseModel):
    symbol: str
    timeframe: str
    timestamp: float
    features: Dict[str, float]
    useShadow: bool = False


class IndiaTrainIn(BaseModel):
    symbols: List[str] = Field(min_length=1)
    timeframe: str = "5m"
    featureVersion: str = INDIA_FEATURE_VERSION
    folds: int = Field(default=3, gt=0)
    horizon: int = Field(default=1, gt=0)
    data: Dict[str, List[CandleIn]] = Field(
        description="symbol -> ordered Indian candles"
    )


@app.get("/health")
def health() -> Dict[str, Any]:
    india_champ = INDIA_SERVICE.registry.champion()
    # Warm-start truth: which pipelines are actually resident in memory right
    # now (survives a corrupt-artifact degradation, reports it honestly).
    champ_record = SERVICE._champion_record
    return {
        "status": "ok",
        "model": "sklearn/xgboost/lightgbm",
        "champion": (registry.champion().modelVersion if registry.champion() else None),
        "challenger": (
            registry.challenger().modelVersion if registry.challenger() else None
        ),
        "warm": {
            "championLoaded": SERVICE._champion is not None,
            "championVersion": champ_record.modelVersion if champ_record else None,
            "challengerLoaded": SERVICE._challenger is not None,
        },
        "finbert": FINBERT_AVAILABLE,
        "india": {
            "available": india_champ is not None,
            "modelVersion": india_champ.modelVersion if india_champ else None,
        },
        "uptimeMs": int(time.time() * 1000 - STARTED_AT),
    }


@app.get("/models")
def models() -> Dict[str, Any]:
    champion = registry.champion()
    challenger = registry.challenger()
    return {
        "local": registry.list(),
        "champion": champion.modelVersion if champion else None,
        "challenger": challenger.modelVersion if challenger else None,
    }


@app.get("/datasets")
def datasets() -> Dict[str, Any]:
    import os
    from .models import DATASET_DIR

    out = []
    for name in sorted(os.listdir(DATASET_DIR), reverse=True):
        if name.endswith(".json"):
            try:
                import json as _json

                with open(os.path.join(DATASET_DIR, name)) as f:
                    out.append(_json.load(f))
            except Exception:
                continue
    return {"datasets": out}


@app.post("/predict")
def predict(req: PredictIn) -> Dict[str, Any]:
    out = SERVICE.predict(
        req.symbol, req.timeframe, req.timestamp, req.features, use_shadow=req.useShadow
    )
    return out


@app.post("/train")
def train(req: TrainIn) -> Dict[str, Any]:
    data = {
        symbol: [c.model_dump() for c in candles]
        for symbol, candles in req.data.items()
    }
    result = run_walk_forward(
        data,
        req.timeframe,
        folds=req.folds,
        horizon=req.horizon,
        feature_version=req.featureVersion,
        feature_rows=req.featureRows,
    )
    if result.get("status") == "FAILED":
        raise HTTPException(
            status_code=400, detail=result.get("error", "training failed")
        )
    SERVICE._load()  # reload champion/challenger so predictions use the new models
    return result


@app.post("/promote")
def promote() -> Dict[str, Any]:
    """Evaluate the challenger against the champion and promote if it clears
    the quality gate and beats the champion on validation criteria. A champion
    that is ineligible to serve (stale feature schema or degenerate constant
    output) is replaced outright — its historical metrics have no standing."""
    champ = registry.champion()
    ineligible = None
    if champ:
        if champ.featureVersion and champ.featureVersion != FEATURE_VERSION:
            ineligible = f"stale feature schema {champ.featureVersion} vs {FEATURE_VERSION}"
        elif SERVICE._probe_variability.get(champ.modelVersion, 1.0) < 0.01:
            ineligible = "degenerate constant probability output"
    result = registry.evaluate_challenger(championIneligible=ineligible)
    SERVICE._load()  # refresh in-memory champion/challenger after any promotion
    return result


@app.post("/portfolio/risk")
def portfolio_risk(req: PortfolioIn) -> Dict[str, Any]:
    """skfolio portfolio analytics: covariance, min-variance + HRP weights,
    volatility, CVaR 95 and risk contribution for the given symbols/weights.
    Never throws 500 — single-asset or degenerate portfolios fall back to
    empirical estimates (advisory only)."""
    try:
        return analyze_portfolio(req.returns, req.weights, req.annualizationFactor)
    except Exception as e:
        import traceback as _tb

        print(
            f"[portfolio] unhandled error, returning INSUFFICIENT_DATA: {e}\n{_tb.format_exc()}",
            flush=True,
        )
        return {
            "status": "INSUFFICIENT_DATA",
            "detail": f"portfolio analytics unavailable: {e}",
        }


@app.post("/sentiment")
def sentiment(req: SentimentIn) -> Dict[str, Any]:
    out = score_text(req.text)
    out["timestamp"] = int(time.time() * 1000)
    return out


@app.get("/drift")
def drift() -> Dict[str, Any]:
    reference = load_reference_features()
    return {
        "status": "HEALTHY" if reference else "UNKNOWN",
        "detail": "reference features loaded"
        if reference
        else "no reference dataset — train a model first",
        "referenceSamples": len(reference),
    }


@app.post("/drift/check")
def drift_check(recent: List[Dict[str, float]]) -> Dict[str, Any]:
    reference = load_reference_features()
    if not reference:
        return {"status": "UNKNOWN", "detail": "no reference dataset"}
    return assess_drift(reference, recent, [r.get("probability", 0.5) for r in recent])


# ---------------------------------------------------------------------------
# Indian-market endpoints (spec §19) — isolated model registry, never touches
# the Forex/Crypto models or features.
# ---------------------------------------------------------------------------


@app.get("/india/features")
def india_features() -> Dict[str, Any]:
    return {"featureVersion": INDIA_FEATURE_VERSION, "features": INDIA_FEATURE_NAMES}


@app.post("/india/predict")
def india_predict(req: IndiaPredictIn) -> Dict[str, Any]:
    return INDIA_SERVICE.predict(
        req.symbol, req.timeframe, req.timestamp, req.features, use_shadow=req.useShadow
    )


@app.post("/india/train")
def india_train(req: IndiaTrainIn) -> Dict[str, Any]:
    data = {
        symbol: [c.model_dump() for c in candles]
        for symbol, candles in req.data.items()
    }
    result = INDIA_SERVICE.train_walk_forward(
        data,
        req.timeframe,
        folds=req.folds,
        horizon=req.horizon,
        feature_version=req.featureVersion,
    )
    if result.get("status") == "FAILED":
        raise HTTPException(
            status_code=400, detail=result.get("error", "India training failed")
        )
    return result


@app.post("/india/promote")
def india_promote() -> Dict[str, Any]:
    reg = IndiaModelRegistry()
    result = reg.evaluate_challenger()
    INDIA_SERVICE._load()
    return result


@app.get("/india/models")
def india_models() -> Dict[str, Any]:
    reg = IndiaModelRegistry()
    champion = reg.champion()
    challenger = reg.challenger()
    return {
        "models": reg.list(),
        "champion": champion.modelVersion if champion else None,
        "challenger": challenger.modelVersion if challenger else None,
    }


# ---------------------------------------------------------------------------
# Indian v2 pipeline (spec §19) — stacking + meta-labeling, shadow-first.
# Isolated in models-india-v2/ + datasets-india-v2/; the v1 India pipeline
# keeps serving production until a v2 model beats it in shadow.
# ---------------------------------------------------------------------------


class IndiaV2PredictIn(BaseModel):
    symbol: str
    timeframe: str
    timestamp: float
    features: Dict[str, float]
    useShadow: bool = False


class IndiaV2TrainIn(BaseModel):
    symbols: List[str] = Field(min_length=1)
    timeframe: str = "5m"
    featureVersion: str = INDIA_FEATURE_VERSION
    folds: int = Field(default=3, gt=0)
    horizon: int = Field(default=1, gt=0)
    tbarHorizon: int = Field(default=5, gt=0)
    tbarPt: float = Field(default=1.0, gt=0)
    tbarSl: float = Field(default=1.0, gt=0)
    embargo: int = Field(default=0, ge=0)
    metaThreshold: float = Field(default=0.6, gt=0, le=1)
    data: Dict[str, List[CandleIn]] = Field(
        description="symbol -> ordered Indian candles"
    )


@app.post("/india/v2/train")
def india_v2_train(req: IndiaV2TrainIn) -> Dict[str, Any]:
    from .india_v2 import run_india_v2_walk_forward
    from .india_models import INDIA_V2_SERVICE

    data = {
        symbol: [c.model_dump() for c in candles]
        for symbol, candles in req.data.items()
    }
    result = run_india_v2_walk_forward(
        data,
        req.timeframe,
        folds=req.folds,
        horizon=req.horizon,
        tbar_horizon=req.tbarHorizon,
        tbar_pt=req.tbarPt,
        tbar_sl=req.tbarSl,
        embargo=req.embargo,
        meta_threshold=req.metaThreshold,
        feature_version=req.featureVersion,
    )
    if result.get("status") == "FAILED":
        raise HTTPException(
            status_code=400, detail=result.get("error", "India v2 training failed")
        )
    INDIA_V2_SERVICE._load()
    return result


@app.post("/india/v2/predict")
def india_v2_predict(req: IndiaV2PredictIn) -> Dict[str, Any]:
    from .india_models import INDIA_V2_SERVICE

    return INDIA_V2_SERVICE.predict(
        req.symbol, req.timeframe, req.timestamp, req.features, use_shadow=req.useShadow
    )


@app.post("/india/v2/promote")
def india_v2_promote() -> Dict[str, Any]:
    from .india_v2 import IndiaV2Registry
    from .india_models import INDIA_V2_SERVICE

    reg = IndiaV2Registry()
    result = reg.evaluate_challenger()
    INDIA_V2_SERVICE._load()
    return result


@app.get("/india/v2/models")
def india_v2_models() -> Dict[str, Any]:
    from .india_v2 import IndiaV2Registry

    reg = IndiaV2Registry()
    champion = reg.champion()
    challenger = reg.challenger()
    return {
        "models": reg.list(),
        "champion": champion.modelVersion if champion else None,
        "challenger": challenger.modelVersion if challenger else None,
    }
