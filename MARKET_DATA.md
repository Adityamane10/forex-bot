# MARKET_DATA.md

## Provider abstraction

`MarketDataProvider` interface (`backend/src/providers/types.ts`):
`connect/disconnect/getSymbols/getHistoricalCandles/getLatestPrice/
getBidAsk/getSpread/subscribe/unsubscribe/health`, plus capability hints:
- `streaming` — true when the provider pushes ticks itself (no polling)
- `pollBudgetPerMinute` / `minPollIntervalMs` — free-tier budget for polled feeds
- `preloadTimeframes` — which timeframes to preload from history at startup

Every provider is replaceable without touching downstream code.

## Providers

### YAHOO (default — REAL data, no key)
- Real forex mid prices from Yahoo Finance's public chart API. Verified from
  this build: real quotes with sub-minute freshness (bench p50 **1.2–1.5 s**,
  p95 ~13 s in steady state; slow pairs update on Yahoo's own ~60 s cadence).
- Requires **no API key**. REST polling with adaptive priority (hot symbols
  10 s, idle 30 s) behind a token bucket capped at 30/min — never throttled.
- **Honest caveats:** this is an UNOFFICIAL endpoint (Yahoo may throttle or
  change it); bid/ask is modeled from typical spreads and every tick carries
  `spreadModeled: true`; partial trailing bars are dropped; OHLC is clipped to
  the true range after precision rounding. Intended for personal/development
  use — the licensed free paths (FINNHUB / TWELVEDATA) and the MT5 bridge are
  the production-grade options.
- Startup preloads real 1h/4h/1D history (~60–90 s one-time warm-up).

### BINANCE (crypto — default, REAL data, no key)
- **Real streaming bid/ask** for 7 spot pairs (`BTC/USDT, ETH/USDT, BNB/USDT,
  SOL/USDT, XRP/USDT, ADA/USDT, DOGE/USDT`) via the free public bookTicker
  WebSocket — bid/ask are genuine exchange quotes, never modeled.
- REST fallback: `ticker/bookTicker` (latest quote) and `klines` (history),
  both well inside Binance's 6000 weight/min IP limit.
- Implements the spec §10 WebSocket reliability rules: heartbeat ping/pong
  every 10 s, automatic reconnect with exponential backoff (1 s→30 s),
  resubscription after reconnect (combined-stream URL re-subscribes all
  symbols), and a 60 s no-data watchdog.
- Requires **no API key**. Configure with
  `CRYPTO_MARKET_DATA_PROVIDER=BINANCE`; optional `CRYPTO_SYMBOLS=...` subset.
- Free-tier reality: Binance public market data is free and unauthenticated;
  it may be rate-limited or geo-restricted. See RESOURCE_AUDIT.md.

### DEMO (explicit opt-in, development only)
- Simulated mean-reverting random walk with per-pair spreads. **Not real
  data.** Every artifact carries `mode: "DEMO"` and the UI shows a DEMO badge.
- Streaming (pushes ticks on ~400 ms timers) — no polling, no budget.
- Free, no key, no limits. Development only. Only used when
  `MARKET_DATA_PROVIDER=DEMO` (forex) or `CRYPTO_MARKET_DATA_PROVIDER=DEMO`
  (crypto) is set explicitly.

### Routing provider (forex + crypto)
`RoutingMarketDataProvider` (`providers/routingMarketData.ts`) exposes ONE
`MarketDataProvider` to the engines and routes every symbol to the provider
that owns its asset class (`assetClassFor`). Both feeds run concurrently:
forex (Yahoo/TwelveData/Finnhub/MT5) and crypto (Binance). The routing
provider keeps polling enabled for REST-only forex feeds while Binance also
streams via WebSocket; tick `mode`/`source`/`venue` are per-provider.

### FINNHUB (free tier, REST) — best free real-time option
- **60 API calls/min free**, real-time forex mid price (10 brokers, symbols
  like `OANDA:EUR_USD`) and OHLC candles (up to 5000 bars per call).
- **No bid/ask for forex on the free tier.** The provider models bid/ask from
  typical per-pair spreads and sets `spreadModeled: true` on every tick — mid
  is real, spread is an estimate, and the flag travels through the pipeline
  so consumers/UI can label it. Never presented as a live quote.
- Requires `FINNHUB_API_KEY`. The backend polls with a **token bucket capped
  at 55/min** (headroom under the 60/min limit) and **adaptive priority**:
  symbols with active signals/strong candidates poll every 5 s, idle symbols
  every 30 s. The scheduler never exceeds the budget.
- Preloads 15m/1h/4h/1D history at startup (within budget); 1m/5m/30m fill
  live from polling within minutes.

### TWELVEDATA (free tier, REST)
- 800 credits/day free. Historical OHLC + latest price. Same adaptive polling
  as FINNHUB with a 7/min budget (idle ~60 s, hot ~15 s).
- Requires `MARKET_DATA_API_KEY`. On exhaustion the provider reports DOWN and
  the app falls back per the safe policy.
- Historical depth depends on interval (years of daily data). Commercial use
  allowed under Twelve Data terms.

### MT5 bridge (zero-polling streaming, free)
`workers/mt5-bridge/bridge.py` pushes **real ticks from a local MetaTrader 5
terminal** (free broker demo account) into the backend via
`POST /api/internal/ticks` (guarded by `INTERNAL_API_TOKEN`). No polling, no
per-minute budget — ticks arrive as MT5 publishes them. Optional `--preload`
seeds 1h/4h/1D history via `POST /api/internal/candles`. See
`workers/mt5-bridge/README.md`. The bridge never fabricates ticks and exits
with a clear error if MT5 is unavailable.

### FXCM / OANDA / Dukascopy
- Not implemented in this build but fully supported by the interface
  (streaming ticks via websocket/API). Recommended production upgrade paths.

## Adaptive polling

For REST-only providers (`streaming: false`) the market data engine assigns
each symbol an interval via `scheduleIntervals` (`providers/polling.ts`):
- Hot symbols (active signals, BUY/SELL candidates, high probability) get the
  fast interval (5 s on FINNHUB).
- Idle symbols get the slow interval.
- The aggregate request rate **never exceeds the provider's free budget**; if
  even the idle rate would exceed it, idle stretches further (honest slower
  updates instead of rate-limit violations).
- Staleness detection is interval-aware: a symbol isn't "stale" until
  `max(staleTickMs, 2.5 × its poll interval)` has passed.

## Tick validation (market data engine)

Every tick is rejected (and counted) when any of:

- non-finite price, bid ≤ 0, ask < bid
- invalid timestamp (≤ 0) or future timestamp (> now + 60 s)
- duplicate (same timestamp and price as the last tick)
- out-of-order tick (older timestamp than last)
- abnormal jump (> 5% move vs previous tick)

If ticks stop, the data-quality engine drops the score and **signal generation
stops**.

## Real-time signal updates (event-driven)

Signals no longer wait for the scanner sweep:

| Event | Action |
|---|---|
| Every tick | entry/SL/TP crossing checks (instant state changes: ENTRY_REACHED, MISSED, SL_HIT, TP_HIT) |
| 1h/4h/1D candle closes | full re-analysis of that symbol (~200 ms debounce) |
| 5m/15m closes | re-analysis only for hot symbols (ML calls stay bounded) |
| New news for a pair's currencies | immediate re-analysis of affected symbols |
| Calendar refresh | immediate re-analysis of affected currencies |
| Scanner sweep (30 s default) | safety-net full re-evaluation of all assets |

Measured on real data (`npm run bench:realtime`, YAHOO, steady state):

| Metric | Result |
|---|---|
| Data freshness (quote age at arrival) | p50 **1.2–1.5 s**, p95 ~13 s |
| Full signal pipeline (candles→ML→risk) | p50 **18–57 ms**, p95 < 65 ms |
| Tick cadence per symbol | 30 s idle, 10 s hot |
| Provider budget utilization | never exceeds 30/min (token bucket + stagger) |

## Historical data in this build

- DEMO `getHistoricalCandles` returns simulated history (honest label).
- FINNHUB / TWELVEDATA return real history within free-tier depth.
- MT5 bridge `--preload` seeds real history from the terminal.
- The backtest engine consumes provider history; DEMO-mode backtests are
  simulations and are labeled as such in the UI.
