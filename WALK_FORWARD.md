# WALK_FORWARD.md

## Methodology

Rolling windows, never a random split, never tuning on the final test
period:

```
fold 1:  TRAIN [Jan..Jun] → VALIDATE [Jul] → TEST [Aug]
fold 2:  TRAIN [Feb..Jul] → VALIDATE [Aug] → TEST [Sep]
...
```

Implementation: `ai-engine/app/walkforward.py`.

1. **Dataset**: `build_dataset` (features at bar *i* from bars ≤ *i*; label
   from bars > *i*; no partial labels). One labeled frame per symbol, merged
   and sorted by timestamp.
2. **Per fold, per algorithm** (LogisticRegression, RandomForest, XGBoost,
   LightGBM):
   - train on TRAIN
   - calibrate with `CalibratedClassifierCV(..., method="isotonic")` fit on
     VALIDATE
   - evaluate on TEST (out-of-sample): Brier, AUC, accuracy, win rate,
     profit factor, expectancy, calibration error
3. **Registration**: every fold's models are saved with exact
   train/validate/test windows, dataset version, feature version and
   hyperparameters. The best model becomes the **CHALLENGER** (shadow=true).
4. **Promotion** (backend + python `evaluate_challenger`): the challenger
   replaces the champion only when it beats it by ≥5% on at least two of
   {profit factor, expectancy, max drawdown, Brier}.

## Anti-overfitting protections

- Time-series splits only (no `train_test_split(random_state=...)` anywhere).
- No hyperparameter search against the test window — fixed, conservative
  defaults (shallow trees, high `min_samples_leaf`, balanced class weights).
- Test periods never influence calibration or selection.
- The average of the **test** metrics across folds is what the Models view
  reports.

## Verified

`ai-engine/tests/test_ml.py` asserts walk-forward produces a dataset
version, at least one fold, a challenger model and test metrics; predictions
after training carry the matching dataset version; insufficient data fails
gracefully.
