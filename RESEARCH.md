# RESEARCH.md

## Research vs production separation (spec §13)

Research and production use the **same signal/risk logic** (`signalEngine`,
`backtestEngine`, `metricsEngine`) — a backtest is the paper pipeline replayed
on history, so research results translate to live behavior. No separate
"research-only" indicator set diverges from production.

## Frameworks evaluated (spec §10-16)

| Framework | Verdict | Use |
|---|---|---|
| CCXT | **Integrated** | `CryptoExchangeAdapter` — normalized markets/quotes/OHLCV/order book/execution interface (execution refuses without keys) |
| VectorBT | Evaluated, not vendored | Concept: vectorized parameter sweeps; GPL-3.0 license is why it is not a runtime dep |
| Backtrader / Lumibot / Freqtrade | Evaluated, not vendored | Concepts: event-driven backtesting, dry-run, risk controls, hyperparameter optimization borrowed into `backtestEngine` |
| NautilusTrader | Evaluated, not vendored | Concepts: market/order/position/execution event model — reflected in the WS event contract (WEBSOCKET.md) |
| Hummingbot | Evaluated, not vendored | Concepts only; platform risk engine stays authoritative |
| FinRL | **Experimental only** | RL is not a prediction engine; never live. No RL code in this build — documented for future research |

## How to run research

1. **Backtest** — `POST /api/backtests` with symbols/timeframes/range/costs;
   metrics include return, CAGR, recovery factor, win rate, profit factor,
   expectancy, Sharpe, Sortino, max DD, per-pair/session/regime breakdowns.
2. **Walk-forward ML** — `POST /api/models/train` (needs ≥250 bars per symbol);
   produces dataset version + folds + challenger.
3. **Calibration / drift** — `GET /api/models/calibration`, `GET /api/drift`.
4. **Champion/challenger** — `POST /api/models/promote` after out-of-sample
   comparison; shadow predictions recorded.

## Honesty rules

- Historical win rates are statistics, never guarantees.
- No optimization on the test set: train/validation/test windows are
  separated in time (WALK_FORWARD.md).
- Overfitting guards: walk-forward degradation, small-sample and
  regime-dependence checks are documented in BACKTESTING.md.
