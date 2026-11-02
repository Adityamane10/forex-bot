# MODEL_VERSIONING.md

Every model is an immutable artifact. Fields recorded per version
(`ModelRecord`):

| Field | Meaning |
|---|---|
| `modelVersion` | unique id (`<algo>-<hex>`), never reused |
| `algorithm` | LOGISTIC_REGRESSION / RANDOM_FOREST / XGBOOST / LIGHTGBM |
| `target` | FUTURE_DIRECTION (default) |
| `datasetVersion` | the dataset the model was trained on |
| `featureVersion` | feature schema (features-v1) |
| `trainingPeriod` / `validationPeriod` / `testPeriod` | exact epoch windows |
| `hyperparameters` | horizon, fold, class weight |
| `metrics` | Brier, AUC, accuracy, win rate, profit factor, expectancy, calibration error, train time |
| `createdAt` | epoch ms |
| `status` | CHAMPION / CHALLENGER / ARCHIVED / FAILED |
| `shadow` | true while challenger runs in shadow mode |

## Storage

- Python registry: `ai-engine/models/*.json` (metadata) + `*.joblib`
  (artifact) — persisted on disk, mounted as a volume in Docker.
- Backend registry: `modelVersions` collection in Mongo (mirrors the same
  schema), used for champion/challenger bookkeeping and calibration metrics
  from stored predictions.

## Rules

1. Never overwrite a version — promotion only changes `status`.
2. A prediction always knows which model + dataset + feature version
   produced it.
3. The champion can influence paper signals; the challenger cannot.
4. Promotion requires passing the comparison criteria (see WALK_FORWARD.md).
