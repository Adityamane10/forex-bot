# WEBSOCKET.md

## Transport

Socket.IO (server: `backend/src/ws/socket.ts`, client: `frontend/src/socket.ts`).
All sockets are **authenticated** with the same JWT as the REST API
(`auth.token` in the handshake). Unauthorized sockets cannot join channels.

## Client → server

```
subscribe { channel }   channel ∈ market, signals, news, risk, paper, system, scanner
```

## Server → client events

| Event | Payload (shape) | Source |
|---|---|---|
| `market.price` | Tick (bid/ask/mid/spread/mode/venue) | every validated tick |
| `market.candle` | completed Candle | candle close |
| `indicator.update` | IndicatorSnapshot | indicator recompute |
| `signal.created` | Signal | new signal |
| `signal.updated` | Signal | live signal refresh |
| `signal.invalidated` | {signalId, symbol, note} | invalidation |
| `signal.missed` | {signalId, symbol, note} | entry zone missed |
| `signal.state` | {signalId, symbol, state, note} | state transition (incl. TRAILING) |
| `paper.position` | PaperPosition | position opened/updated |
| `paper.trade` | PaperTrade | position closed |
| `risk.update` | PaperAccount | account/risk change |
| `news.update` | NewsItem[] | news refresh |
| `calendar.update` | EconomicEvent[] | calendar refresh |
| `system.status` | SystemStatusReport | health check |
| `scanner.update` | OpportunityRanking[] | scan cycle |
| `alert` | Alert | in-app alert |

## Real-time data path (spec §2, §20)

Market-data streams are **event-driven**; the UI never reloads pages:

```
Tick ── validate (dup/stale/future/abnormal/bid>ask) ──► live price + chart update
   └──► candle engine (incremental; close broadcasts market.candle)
           └──► indicator recompute ──► event-driven signal re-analysis (debounced)
```

- **Candles update incrementally** (lightweight-charts `update()`), never a
  full re-render per tick.
- **ML runs on events, not ticks**: candle close / news / calendar / signal
  refresh — bounded per symbol.
- **Reconnect:** Socket.IO reconnects automatically; the Binance provider
  (the only raw WebSocket client) implements heartbeat ping/pong, exponential
  backoff reconnect, resubscription and a 60 s watchdog (§20).

## Latency

Measured on real data: full signal pipeline p50 18-57 ms; quote freshness p50
~1.2-1.5 s (Yahoo), ~ms for Binance bookTicker. See TEST_REPORT.md.
