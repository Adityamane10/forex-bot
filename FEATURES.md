# FEATURES.md

## Versioning

- `FEATURE_VERSION = "features-v1"` (`backend/src/engines/featureEngine.ts`,
  mirrored in `ai-engine/app/features.py`).
- Every feature vector records `featureVersion`, `symbol`, `timeframe`,
  `timestamp` and all values, and is persisted to the `features` collection
  so predictions are traceable to the exact features that produced them.

## Feature vector (32 features)

Returns/momentum: `roc10, momentum10, macdLine, macdHistogram`
EMA structure: `ema9minus20, ema20minus50, ema50minus200`
Oscillators: `rsi14, stochK, williamsR14, cci20`
Volatility: `atrPct, bbWidth, bbPosition, candleBody, upperWick, lowerWick`
Price structure: `swingHighDistance, swingLowDistance, supertrendDirection`
Context: `close, adx, spreadPips, session, regimeBullish, regimeBearish,
regimeRange, regimeBreakout, eventRisk, newsSentiment,
historicalBuyProbability, dataQualityScore`

All numeric features are normalized to [0, 1] at construction, so models see
a consistent scale regardless of pair.

## No-lookahead

- Backend: the feature vector is built from indicator snapshots and context
  available **at the evaluation timestamp** (the current open candle's
  already-seen values only).
- Python training: `build_dataset` computes features at bar *i* from bars
  `[0..i]` and labels from bars `(i..i+horizon]`. Rows without a complete
  horizon are dropped (no partial labels). This is verified by tests
  (`test_no_lookahead_features_ignore_future_bars`,
  `test_targets_use_only_future_bars`).

## Known limitation (documented)

Training features are computed by the Python mirror of the indicator engine
while live features come from the TypeScript engine. Formulas and semantics
match; minor numerical warm-up differences are possible. Mitigation: retrain
from live-computed features (the `features` collection) before promoting a
model to champion. This is tracked as a future improvement.
