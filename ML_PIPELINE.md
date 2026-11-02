# ML_PIPELINE.md

`ai-engine/` (Python FastAPI) is the ML service. The backend calls it over HTTP
(`backend/src/ai/aiClient.ts`) with graceful degradation: ML down → signals
WAIT (never a fake prediction).

## Pipeline (spec §37)

```
RAW DATA → VALIDATE → CLEAN → FEATURES → DATASET VERSION → TRAIN → VALIDATE
→ WALK-FORWARD → BACKTEST → CALIBRATE → COMPARE → PAPER → SHADOW → APPROVE
→ DEPLOY → MONITOR → RETRAIN
```

- **No-lookahead by construction** (`features.py`): features at bar *i* use
  bars ≤ *i*; the target uses bars *i+1..i+horizon* only; tests assert this
  (mutating bar i+1 must not change features at i; no partial labels).
- **Models**: Logistic Regression, Random Forest, XGBoost, LightGBM
  (`app/models.py`); targets: FUTURE_DIRECTION (TP_BEFORE_SL / FUTURE_RETURN
  supported).
- **Walk-forward** (`app/walkforward.py`): rolling train/validate/test folds,
  purged boundaries, out-of-sample-only evaluation. Never shuffled.
- **Calibration**: isotonic via `CalibratedClassifierCV`; Brier + calibration
  error tracked.
- **Versioning**: every dataset and model has a version record (features,
  window, hyperparameters, metrics); every prediction is traceable
  (`modelVersion`, `featureVersion`, `datasetVersion`).

## Champion / Challenger (spec §40)

Champion serves production predictions; challengers train in shadow. Promotion
only after out-of-sample + calibration + performance comparison
(`POST /api/models/promote`). Shadow-mode predictions are recorded for
comparison. Drift monitoring (`app/drift.py`) compares live feature
distributions to the training reference and can flag/disable degraded models.

## Feature set

Returns, RSI, MACD, ADX, ATR%, Bollinger position/width, EMA distances,
Stochastic, Williams %R, CCI, ROC, momentum, swing distances, spread, session,
regime one-hots, event risk, news sentiment, historical probability, data
quality — all normalized, versioned (`features-v1`).

## Sentiment

FinBERT (local, optional) with a financial-lexicon fallback labeled
`RULE_BASED`. Never affects risk controls.
