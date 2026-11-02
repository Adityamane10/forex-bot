# ML.md

## Models

| Algorithm | Library | When used |
|---|---|---|
| Logistic Regression | scikit-learn | baseline |
| Random Forest | scikit-learn | baseline/ensemble |
| XGBoost | xgboost | challenger |
| LightGBM | lightgbm | challenger |

Target: `FUTURE_DIRECTION` — P(close[i+horizon] > close[i]) with
horizon = 12 bars by default. `TP_BEFORE_SL` and `FUTURE_RETURN` are defined
targets reserved for future variants.

## Validation methodology (no random splits)

- **Walk-forward**: rolling TRAIN → VALIDATE → TEST windows
  (see WALK_FORWARD.md). Calibration is fit on VALIDATE and applied to TEST —
  the final test period is never used for tuning.
- Out-of-sample metrics only: Brier, ROC-AUC, accuracy, precision, recall,
  win rate, profit factor, expectancy (1R proxy), calibration error.

## Probability calibration

- `CalibratedClassifierCV(method="isotonic", cv=3)` fit on the validation
  window. Every prediction returns `rawProbability` and
  `calibratedProbability`; the signal engine uses the calibrated value.
- The Models view shows Brier and calibration error. The UI always displays
  `MODEL PROBABILITY` (e.g. 55%) — never "guaranteed success".

## Prediction API

```
POST /predict {symbol, timeframe, timestamp, features, useShadow}
→ {modelVersion, datasetVersion, featureVersion, rawProbability,
   calibratedProbability, probability, confidence, shadow, available}
```

- Champion drives live signal decisions; `useShadow: true` returns the
  challenger's prediction for shadow comparison (model disagreement feeds the
  uncertainty engine).
- If the AI engine is down, the backend signal engine responds per policy:
  `WAIT` / `MODEL_BLOCKED` unless `ALLOW_SIGNALS_WITHOUT_ML=true` (default
  false — the safe value).

## News sentiment (FinBERT)

Real financial sentiment runs locally on the AI engine: `POST /sentiment`
scores headlines with `ProsusAI/finbert` (free, open-source). Install once
with `pip install -r ai-engine/requirements-finbert.txt` (CPU torch +
transformers; the model downloads once from Hugging Face, ~420 MB, then runs
fully offline). `GET /health` reports `finbert: true|false`. Without the
optional dependency the engine falls back to the financial lexicon and
labels every result `source: RULE_BASED` — sentiment is never fabricated.

## Drift

`GET /drift` compares recent features/predictions against the training
reference (z-score based). Statuses: HEALTHY / WARNING / PAUSED. PAUSED →
signals fall back to WAIT.

## Honesty requirements implemented

- Probabilities are bounded (0,1), calibrated, and never presented as
  certainty.
- Model accuracy claims come only from the metrics actually recorded during
  walk-forward evaluation.
- No model is ever "selected" by tuning against the final test period.
