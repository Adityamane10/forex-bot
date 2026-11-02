# RISK.md

The risk layer is the highest authority in the system. **The LLM can never
override risk controls. Risk is never raised to satisfy a profit target.**

## Risk classification (per signal)

Every signal is classified **GREEN** (low) / **YELLOW** (medium) / **RED**
(high) from weighted components:

volatility, spread, news, economic events, ML uncertainty, R:R, regime,
data quality, portfolio exposure, correlation, drawdown, model health.

Any `RED:` or `BLOCK:` critical flag forces RED and can block the signal.

## Circuit breakers (hard limits)

`CircuitBreakerEngine` (per user settings):

| Breaker | Default |
|---|---|
| MAX_DAILY_LOSS | 3% |
| MAX_WEEKLY_LOSS | 6% |
| MAX_DRAWDOWN | 10% |
| MAX_CONSECUTIVE_LOSSES | 5 |
| MAX_OPEN_POSITIONS | 5 |
| MAX_CORRELATED_POSITIONS | 3 |
| MAX_LEVERAGE | 50x |
| MAX_CURRENCY_EXPOSURE | 30% |

If any trips → **no new signals** (state `RISK_BLOCKED`).

## Uncertainty engine ("I don't know")

Returns `INSUFFICIENT_CONFIDENCE` when any of: ML prediction missing, model
disagreement > 0.5, ML confidence < 0.55, regime UNCERTAIN, data quality <
0.7, news conflict > 0.7, EV uncertain, spread beyond safe limit, or
insufficient historical support. It never forces BUY/SELL.

## Position sizing & profit constraint

- Size = riskAmount / (pip distance × pip value), rounded to the lot step,
  clamped to min/max lots; margin and effective leverage are computed and
  must respect the max-leverage setting.
- If the user's requested `minimumProfit` cannot be achieved within risk /
  leverage / R:R constraints → **NO TRADE** (never increase risk).

## Portfolio & correlation

- Currency exposure is computed per pair leg (BUY EUR/USD = long EUR, short
  USD). Overlapping exposure (several long-USD pairs) is detected and can
  block.
- Rolling pair correlations (20/50/100) via aligned closes; a new position is
  blocked when it would exceed `maxCorrelatedPositions` at |ρ| ≥ 0.7.

## Failure-safe behavior

| Failure | Behavior |
|---|---|
| Market data down / stale | STOP signals (`DATA_ERROR`) |
| ML engine down | WAIT (`MODEL_BLOCKED`) |
| News down | data-quality score drops; safe policy applies |
| Calendar down | event risk unknown; news-sensitive strategies block |
| Groq down | continue without LLM |
| Redis down | real-time layer reported DOWN (never pretended healthy) |
| Mongo down | persistence-dependent workflows stop |

## Data quality

Every decision carries `dataQualityScore` (0..1) from freshness, missing
candles, duplicates, invalid OHLC, spread vs limit, provider health and
news/calendar availability. Score < 0.7 → `NO_TRADE` / `WAIT`.
