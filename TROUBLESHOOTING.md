# TROUBLESHOOTING.md

## Services won't start

| Symptom | Cause / fix |
|---|---|
| Backend binds an ephemeral port | The shell exports `PORT=0` — start with an explicit `PORT=4000 npm run dev:backend` |
| `Cannot find module '@fx/shared'` | Workspace symlinks are stale after moving the repo — run `npm install` (relinks `node_modules/@fx/*`) then `npm run build:shared` |
| Python AI engine fails on `import xgboost` | Use Python 3.13 (`py -3.13`) per SETUP.md; 3.14 lacks prebuilt wheels for some ML packages |
| Port 4000/8500/5173 already in use | `netstat -ano | grep LISTENING` to find the owner; stop it or change the port |

## Market data problems

| Symptom | Cause / fix |
|---|---|
| No forex ticks / Yahoo slow | Yahoo is an unofficial endpoint; it may throttle. Set `MARKET_DATA_PROVIDER=FINNHUB|TWELVEDATA` with a key, or use the MT5 bridge for true ticks |
| Crypto shows DEMO instead of LIVE | `CRYPTO_MARKET_DATA_PROVIDER` fell back to DEMO because Binance was unreachable (network/geo-block). Check `/api/system/status` |
| "spread too high / LIQUIDITY_STRESSED" on crypto | Real wide spread or thin book — the engine is behaving correctly; check the asset's `maxSpreadTicks` |
| Data labelled DELAYED/STALE | Expected for polled REST feeds; polling cadence is budget-aware (idle 30-60 s). Real streaming: Binance WS / MT5 bridge |

## Signal engine

| Symptom | Cause / fix |
|---|---|
| Everything is WAIT/NO_TRADE | Expected — the engine is conservative. Check `reason` for the specific gate (ML down, data quality, EV, spread, circuit breaker) |
| `MODEL_BLOCKED` | Python AI engine is down — start it (`npm run dev:ai`) or set `ALLOW_SIGNALS_WITHOUT_ML=true` (unsafe, default off) |
| `RISK_BLOCKED` circuit breaker | Daily loss / drawdown / exposure limits reached — they reset with the configured windows; open Positions view |
| Signals never fire on crypto | Ensure `CRYPTO_MARKET_DATA_PROVIDER=BINANCE` and history preloaded (needs ≥100 bars on 1h) |
| Emergency stop blocks everything | Trigger it or release it from the System view (`POST /api/system/emergency-stop`) |

## Persistence

| Symptom | Cause / fix |
|---|---|
| State lost on restart | In-memory fallback (no Mongo/Redis) — set `MONGODB_URI`/`REDIS_URL` or use `docker compose up` |
| System Health shows Mongo/Redis "IN-MEMORY FALLBACK" | Same — not an error; it is the honest label |

## Backtesting / ML

| Symptom | Cause / fix |
|---|---|
| `no symbol has enough candle history (need >= 250 bars)` | Provider history is shallow for the requested range/timeframe — widen the range or use a provider with deeper history |
| Backtest trades look unrealistic | Verify costs (spread/commission/slippage) in the request; the engine never assumes perfect fills |
| Champion model missing | Train one (`POST /api/models/train`) — signals still work via technical/statistical path only if `ALLOW_SIGNALS_WITHOUT_ML=true` (not recommended) |

## Failure-simulation checklist (spec §105)

Automated: stale-data blocks signals; ML-down → WAIT/MODEL_BLOCKED; XAU/USD
no-data → NO_TRADE/WAIT. Manual: point `MONGODB_URI`/`REDIS_URL` at closed
ports to exercise the DOWN + safe-policy paths; kill the Python service and
watch signals block; disconnect the network and watch provider health degrade.
