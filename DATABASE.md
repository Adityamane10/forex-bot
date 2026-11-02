# DATABASE.md

## Two layers

| Layer | Purpose | Tech |
|---|---|---|
| Fast/temporary | latest price, open candles, indicator/feature caches, signal cache, pub/sub | Redis (`REDIS_URL`); in-memory fallback |
| Durable | history, snapshots, trades, models, audit | MongoDB (`MONGODB_URI`); in-memory fallback |

When no URI is configured the app uses clearly-labeled in-memory stores and
the System view reports `IN-MEMORY FALLBACK (not durable)`. The app never
pretends an absent Redis/Mongo is healthy.

## Collections (Mongo)

`users`, `userSettings`, `assets`, `candles`, `marketSnapshots`,
`indicators`, `features`, `news`, `newsSentiment`, `economicEvents`,
`patterns`, `predictions`, `signals`, `signalEvents`, `signalSnapshots`,
`paperAccounts`, `paperOrders`, `paperPositions`, `paperTrades`,
`backtests`, `backtestTrades`, `datasets`, `modelVersions`,
`modelExperiments`, `modelMetrics`, `portfolioRisk`, `auditLogs`, `alerts`.

## Indexes

Created automatically on connect:

- `candles`: `{symbol, timeframe, openTime: -1}`
- `signals`: `{timestamp: -1}`, `{symbol, state}`
- `signalEvents`: `{signalId, timestamp: -1}`; `signalSnapshots`: `{signalId}`
- `news`: `{timestamp: -1}`, `{dedupeKey}`
- `economicEvents`: `{timestamp}`
- `paperTrades`: `{closeTime: -1}`, `{symbol, closeTime: -1}`
- `modelVersions`, `datasets`, `auditLogs`, `features`, `users`, `userSettings`

## Retention

- Ticks are persisted as `marketSnapshots` throttled (every 20th tick) and
  tagged with `retentionMs` (default 7 days) for cleanup — unbounded tick
  storage is intentionally avoided.
- Live candle buffers are bounded (`MAX_CANDLES_IN_MEMORY`, default 2000).
- Complete histories should be re-fetched from the provider rather than
  accumulated forever in Mongo (documented in MARKET_DATA.md).

## Query DSL

Both backends share a small filter language (`backend/src/db/query.ts`):
equality plus `$gt/$gte/$lt/$lte/$ne/$in/$exists`, with `$set/$inc/$push/
$unset` updates and sort specs. It is deliberately small so the in-memory and
Mongo implementations behave identically.
