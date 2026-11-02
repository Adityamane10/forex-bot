# MT5 Tick-Streaming Bridge

Feeds **real ticks** from a local MetaTrader 5 terminal into the Freebuff backend —
the zero-polling option for real-time data. No rate limits, no polling: MT5
publishes ticks and the bridge forwards them.

## How it works

```
MetaTrader 5 terminal (free broker demo account, Windows)
        │  MetaTrader5 Python package
        ▼
workers/mt5-bridge/bridge.py
        │  POST /api/internal/ticks (X-Internal-Token)
        ▼
Backend market data engine (mode=LIVE, source=MT5)
        ▼
candles → indicators → event-driven signals → UI
```

## Setup

1. Install the **MetaTrader 5 terminal** (free) and open a **demo account** at any
   broker (e.g. ICMarkets, Pepperstone, FXTM). Demo accounts need no deposit.
2. On that Windows host:
   ```bash
   pip install MetaTrader5
   ```
3. Configure the backend `.env`:
   ```
   INTERNAL_API_TOKEN=<long-random-secret>
   ```
   (Any `MARKET_DATA_PROVIDER` works; MT5 ticks arrive as LIVE source regardless.)
4. Run the bridge:
   ```bash
   py workers/mt5-bridge/bridge.py --preload --symbols EURUSD,GBPUSD,USDJPY
   ```
   `--preload` fetches history for all timeframes (1m→1D) first so indicators/
   MTF/patterns are warm and charts render instantly from MT5 data.

## Behavior

- Ticks are pushed in batches every `MT5_POLL_MS` (default 200 ms) — effectively
  continuous for charting and signal entry/SL/TP checks.
- If the terminal isn't running, credentials are wrong, or the package is missing,
  the bridge exits with a clear error. It never fabricates ticks.
- The backend validates every tick (duplicates, out-of-order, jumps) before it
  reaches candles or signals.
- Run it on the same host as the MT5 terminal; the backend can be anywhere the
  host can reach.

## Security note

The internal endpoint is disabled unless `INTERNAL_API_TOKEN` is set, and requires
the token in the `X-Internal-Token` header on every request. Bind the backend to
127.0.0.1 if the bridge runs on the same machine.
