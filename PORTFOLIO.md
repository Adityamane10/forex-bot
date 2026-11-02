# PORTFOLIO.md

## Account-level state

`PortfolioRiskEngine` tracks: currency exposure (long/short/net per
currency), max exposure, open-position risk, total portfolio risk,
margin used, effective leverage, drawdown vs peak, daily and weekly P&L.

### Exposure example

```
BUY EUR/USD  → long EUR  100k, short USD 110k
BUY GBP/USD  → long GBP  100k, short USD 127k
BUY AUD/USD  → long AUD  100k, short USD  66k
SELL USD/JPY → long JPY 15.4M, short USD 100k

Net USD exposure ≈ −403k  → the engine reports USD as the max-exposure
currency and blocks new trades that would exceed the limit.
```

## Correlation engine

- `pearson` on aligned candle closes (alignment by `openTime` so pair
  histories of different lengths compare correctly).
- Rolling correlations at 20/50/100 periods.
- `checkNewPosition(symbol, openSymbols, maxCorrelated, threshold=0.7)`:
  counts open positions whose |ρ| with the candidate ≥ 0.7 and blocks when
  the limit is reached.

## Circuit-breaker integration

`CircuitBreakerEngine.countCorrelated` computes the largest correlated
cluster among open positions from the correlation matrix, feeding the
`MAX_CORRELATED_POSITIONS` breaker.

## Where it runs

Live signal engine (before every decision) and the backtest engine (one
position per pair, `maxOpenPositions` cap, cooldown after a closed trade).
Unit-tested in `backend/src/test/risk.test.ts` (exposure detection,
preflight block, correlation matrix, breaker trips).
