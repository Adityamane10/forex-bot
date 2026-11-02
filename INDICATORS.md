# INDICATORS.md

All indicators are pure functions in `backend/src/math/indicators.ts`
(and mirrored in `ai-engine/app/features.py` for training features). Each
returns an array aligned with the input; values are `NaN` during warm-up.
No lookahead: the value at index *i* uses only inputs ≤ *i*.

## Implemented set

| Group | Indicators |
|---|---|
| Trend | SMA(20/50/200), EMA(9/20/50/100/200), ADX(14) +DI/-DI, Supertrend(10,3) |
| Momentum | RSI(14), MACD(12,26,9) line/signal/histogram, Stochastic(14,3), CCI(20), ROC(10), Momentum(10), Williams %R(14) |
| Volatility | ATR(14) (+ ATR% of price), Bollinger(20,2) + bandwidth, Keltner(20,10,2) |
| Price/level | swing highs/lows (zig-zag, strength 3), classic pivot points, previous day/week high-low, support/resistance clustering |
| Volume | tick volume, OBV (meaningful only when volume data is real) |

## Indicator snapshot payload

`GET /api/indicators/:symbol?timeframe=1h` returns `values` with fields such
as: `close, sma20/50/200, ema9/20/50/100/200, ema9minus20, ema20minus50,
ema50minus200, rsi14, macd, macdSignal, macdHistogram, stochK, stochD,
cci20, roc10, momentum10, williamsR14, atr14, atrPct, bbUpper/Middle/Lower,
bbWidth, bbPosition, kcUpper/Middle/Lower, adx, plusDi, minusDi,
supertrend, supertrendDirection, obv, swingHigh, swingLow, pivot,
pivotR1, pivotS1, range, body, upperWick, lowerWick`.

## Rules for signal usage

- Indicators are **evidence**, never standalone triggers.
  `RSI < 30 → BUY` is explicitly rejected as a design.
- Trend/momentum/volatility are combined per timeframe (see
  `multiTimeframeEngine`) and folded into a single technical score.
- `bbPosition`, `atrPct`, `ema` distances and price-structure distances feed
  the ML feature vector (see FEATURES.md).

## Verification

Indicator math is unit-tested (`backend/src/test/indicators.test.ts`):
known-value checks, monotonicity, bounds (RSI 0–100, Stochastic 0–100),
alignment, NaN warm-up, and empty-input safety. The Python mirror is tested
for bounds and no-lookahead in `ai-engine/tests/test_features.py`.
