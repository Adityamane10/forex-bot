# API.md

Base URL: `http://localhost:4000/api` (frontend proxies `/api` in dev).

Auth: `Authorization: Bearer <token>` (JWT). Only `/auth/*`, `/health`,
`/ready` are public; WebSocket connections require the same token in
`auth.token` (socket.io handshake).

## Health & readiness

| Method | Path | Description |
|---|---|---|
| GET | `/health` | liveness |
| GET | `/ready` | 200 if signal generation is allowed, 503 otherwise |

## Auth

| Method | Path | Body |
|---|---|---|
| POST | `/auth/register` | `{email, password}` → `{token, user}` |
| POST | `/auth/login` | `{email, password}` → `{token, user}` |
| GET | `/auth/me` | current user |

## Market & analysis

| Method | Path | Notes |
|---|---|---|
| GET | `/assets` | instrument metadata for FOREX + CRYPTO (assetClass, pip/tick size, precision, venue) |
| GET | `/assets/:symbol` | full unified asset spec (forex pip/lot or crypto tick/quantity metadata) |
| GET | `/market` | provider stats (received/rejected ticks, mode) |
| GET | `/market/:symbol` | latest tick `{bid, ask, mid, spread, mode}` |
| GET | `/candles/:symbol?timeframe=1h&limit=300` | candle history (live buffer) |
| GET | `/indicators/:symbol?timeframe=1h` | full indicator snapshot |
| GET | `/analysis/:symbol` | multi-timeframe analysis |

## Signals

| Method | Path | Notes |
|---|---|---|
| GET | `/signals` | active signals |
| GET | `/signals/history` | recent signal history |
| GET | `/signals/:id` | signal + immutable snapshot |
| GET | `/scanner` | current opportunity rankings |
| POST | `/scanner/refresh` | force a full scan of all assets |

## News / calendar / sentiment

| Method | Path | Notes |
|---|---|---|
| GET | `/news?currency=EUR` | latest news (filtered by currency) |
| GET | `/events` | upcoming economic events |
| GET | `/sentiment?symbol=EUR/USD` | aggregated currency sentiment |

## Risk & settings

| Method | Path | Notes |
|---|---|---|
| GET | `/risk` | account, exposure, limits, system health |
| GET | `/settings` | user settings |
| PUT | `/settings` | update settings (validated) |

## Paper trading

| Method | Path | Notes |
|---|---|---|
| GET | `/paper/account` | balance/equity/margin/free margin |
| GET | `/paper/orders` | order history |
| GET | `/paper/positions` | open positions |
| GET | `/paper/trades` | closed trades |
| POST | `/paper/close/:positionId` | manually close a position |

## Backtesting & MLOps

| Method | Path | Notes |
|---|---|---|
| POST | `/backtests` | start a backtest (async; see schema below) |
| GET | `/backtests` | recent backtests + results |
| GET | `/backtests/:id` | one backtest with metrics/trades/equity curve |
| GET | `/models` | local (Mongo) + remote (Python) model versions |
| POST | `/models/train` | walk-forward training (120d/1h/3 folds typical) |
| POST | `/models/promote` | evaluate & promote the challenger |
| GET | `/models/calibration` | Brier / calibration error from stored predictions |
| GET | `/datasets` | dataset versions |
| GET | `/drift` | drift status (remote + local) |

## System

| Method | Path |
|---|---|
| GET | `/system/status` | per-component health + signal-generation flag |
| GET | `/system/market` | market data stats |
| GET | `/system/alerts` | recent alerts |
| GET | `/system/audit` | audit trail |

## Backtest request schema

```json
{
  "symbols": ["EUR/USD", "GBP/USD", "USD/JPY"],
  "timeframes": ["1h"],
  "start": 1710000000000, "end": 1720000000000,
  "startingCapital": 10000, "riskPercent": 1, "minRr": 1.5,
  "minConfidence": 0.55, "maxOpenPositions": 3,
  "commissionPerLot": 7, "slippagePips": 0.2, "spreadMultiplier": 1,
  "useMl": false, "includeNews": false, "includeEvents": false
}
```

Returns `202 {backtestId, status:"QUEUED"}`; poll `GET /backtests` for the
result (metrics include return, win rate, profit factor, expectancy, Sharpe,
Sortino, max drawdown, per-pair/session/regime breakdowns, equity curve).

## WebSocket events (Socket.IO)

Client → server: `subscribe {channel}` where channel ∈
`market, signals, news, risk, paper, system, scanner`.

Server → client: `market.price`, `market.candle`, `indicator.update`,
`signal.created`, `signal.updated`, `signal.invalidated`, `signal.missed`,
`signal.state`, `paper.position`, `paper.trade`, `risk.update`,
`news.update`, `calendar.update`, `system.status`, `scanner.update`, `alert`.
