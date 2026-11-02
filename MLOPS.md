# MLOPS.md

## Versioning (three axes)

- **Dataset**: `dataset-<ts>` with provider, assets, timeframes,
  start/end dates, features, target, preprocessing version, row count
  (`ai-engine/datasets/*.json`).
- **Features**: `features-v1` (single source of truth:
  `backend/src/engines/featureEngine.ts` ↔ `ai-engine/app/features.py`).
- **Model**: `modelVersion` with algorithm, dataset version, feature
  version, training/validation/test windows, hyperparameters, metrics,
  status (`CHAMPION | CHALLENGER | ARCHIVED | FAILED`) and shadow flag
  (`ai-engine/models/*.json` + `*.joblib`).

Model history is never overwritten — every version is a new file/collection
row.

## Champion / Challenger

```
MARKET ──┬──► CHAMPION  → can influence paper signals
         └──► CHALLENGER → shadow prediction only (useShadow=true)
```

- The signal engine requests both; `modelDisagreement` feeds the uncertainty
  engine (strong disagreement → INSUFFICIENT_CONFIDENCE).
- Promotion happens through `POST /api/models/promote` (backend registry) or
  `evaluate_challenger` (python registry) and requires the challenger to win
  on ≥ 2 of {profit factor, expectancy, max drawdown, Brier}.

## Drift monitoring

`DriftEngine` (backend) + `app/drift.py` (python): z-score feature drift,
prediction drift, confidence drift, recent win-rate. PAUSED → the signal
engine falls back to WAIT and an alert is raised.

## Traceability

- Every prediction response carries `modelVersion`, `datasetVersion`,
  `featureVersion`.
- Every signal snapshot stores all three + the full evidence state.
- The `features` collection stores the exact feature vector per prediction
  timestamp.
- Structured logs attach the same identifiers to signal events.

## Retraining cadence (recommended)

1. Collect fresh labeled data (e.g. weekly) via `POST /api/models/train`.
2. Review the challenger's test metrics vs the champion's in the Models view.
3. Promote only if criteria pass; archive the old champion.
4. Monitor drift; pause on PAUSED.
