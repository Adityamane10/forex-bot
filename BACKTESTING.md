# BACKTESTING.md

## What it replays

The backtest engine (`backend/src/engines/backtestEngine.ts`) replays the
signal pipeline over historical candles using the **same pure math** as the
live engine: indicators, price action, S/R, regime, entry/SL/TP, R:R, EV,
position sizing, spread, slippage, commission and swap, with one position per
pair, a max-position cap and a cooldown after each closed trade.

## Realism rules

- **No lookahead**: the decision at bar *i* uses only bars `[0..i-1]`
  (closed bars). Targets and fills happen strictly afterward.
- **Frictions**: SL/TP fills include slippage; commission and swap are
  charged; spread is derived from asset metadata.
- **Conservative intrabar handling**: on each bar, SL is checked before TP
  (a bar that touches both counts as a loss).
- **Ranging/uncertain regimes are skipped**; structure and regime must agree
  on direction; entry score threshold is high — the backtest must not trade
  noise (a random-walk simulation should roughly break even minus costs,
  which is exactly what the DEMO backtest shows).
- **Real history by default**: candles come from the configured market-data
  provider — with the default `YAHOO` provider that is real 1h/4h/1D bars
  (1m/5m limited by the free feed's range caps). The requested window is
  clamped to what the provider can actually supply and any mismatch is
  reported in the result's `dataNote` and shown in the UI. Only the DEMO
  provider uses simulated history (labeled accordingly).

## Metrics

`totalReturnPct, winRate, profitFactor, expectancy, sharpe, sortino,
maxDrawdownPct, averageWin, averageLoss, maxLoss, maxWinStreak,
maxLossStreak, tradeCount, averageTradeDurationMs` plus breakdowns by
pair / session / regime / timeframe, plus the equity curve.

## API

```
POST /api/backtests   → 202 {backtestId}   (the id matches the stored result)
GET  /api/backtests   → list with results
GET  /api/backtests/:id
```

## Honest reporting

A backtest with negative expectancy is the *correct* output when there is no
edge in the tested window — costs are real. The UI shows return, profit
factor, drawdown and trade count without cherry-picking, and surfaces the
`dataNote` when the free feed could not cover the full requested window.
Backtests are not a promise of future performance.
