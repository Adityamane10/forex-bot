# IMPLEMENTATION STATUS

Audit date: 2026-08-18. Status verified directly from source code + running tests
(typecheck, vitest backend suite) + live runtime — not inferred from documentation.

Legend: DONE = verified working (code + tests), PARTIAL = partially wired,
BROKEN = code present but fails to compile/run, MISSING = not present,
UNKNOWN = not verifiable in this environment.

## STATUS AFTER THIS CONTINUATION PASS

All items under B/C/H below were completed in this pass:

- Market condition engine wired into the container → signal generation restored
  (runtime-verified: scanner analyzes all 17 symbols with no crash).
- Partial take profit (Phase 17) implemented in the paper engine.
- Breakeven stop (Phase 19) implemented in the paper engine.
- Settings UI for partial TP + breakeven added.
- 10 new tests: 171/171 backend green, typecheck clean, frontend build passes,
  live run verified (real Yahoo + Binance data, WS fan-out).

## A. COMPLETED (verified)

| Feature | Status | Evidence |
|---|---|---|
| React frontend (Vite + TS + Tailwind + Redux + Socket.IO + lightweight-charts) | DONE | frontend/src views: Dashboard, Market, Signals, Paper, Risk, News, Backtest, Health, Settings, Login, Models; typecheck clean |
| Node.js backend (Express + TS) | DONE | backend/src; REST + Socket.IO; auth (JWT + bcrypt) |
| MongoDB store + Redis cache with in-memory fallback | DONE | db/store.ts, db/cache.ts; health-labeled fallback |
| WebSocket layer (Socket.IO, auth, rooms, events) | DONE | ws/socket.ts; live tick/candle/signal/paper/health broadcast |
| Forex providers: Yahoo (default, real, no key), TwelveData, Finnhub, DEMO | DONE | providers/yahooFinanceMarketData.ts etc.; routing provider |
| Crypto provider: Binance real bookTicker WS + REST klines | DONE | providers/binanceCryptoMarketData.ts; live-verified in earlier passes |
| CCXT adapter (metadata/quote/OHLCV/orderbook, execution refuses without keys) | DONE | providers/cryptoExchangeAdapter.ts |
| Candle engine (aggregation, seed, resync, completed events) | DONE | engines/candleEngine.ts |
| Indicator engine (SMA/EMA/ADX/ATR/RSI/MACD/Stoch/CCI/ROC/OBV/Bollinger/Keltner/Supertrend/swing/S-R/pivots/PDL/PDH/…) | DONE | math/indicators.ts + engines/indicatorEngine.ts; pure + tested |
| Multi-timeframe engine (alignment/consensus/conflict) | DONE | engines/multiTimeframeEngine.ts |
| Price action engine (HH/HL/LH/LL, breakout, engulfing, inside bars, wicks, range) | DONE | engines/priceActionEngine.ts |
| Support/resistance engine (swings, pivots, PDL/PDH, zones) | DONE | engines/supportResistanceEngine.ts |
| Regime engine (11 regimes incl. BREAKDOWN, LIQUIDITY_STRESSED) | DONE | engines/regimeEngine.ts |
| Strategy router (regime → 7 strategies, recorded on signals) | DONE | engines/strategyEngine.ts |
| News engine (RSS real feeds, dedup, cache, currency tags) | DONE | engines/newsEngine.ts + providers/newsProvider.ts |
| Economic calendar (central banks + ForexFactory JSON) | DONE | engines/eventEngine.ts + providers/centralBankCalendar.ts |
| Sentiment engine (lexicon; optional FinBERT via Python) | DONE | engines/sentimentEngine.ts |
| Signal engine (full veto pipeline, ensemble score, snapshots) | DONE* | engines/signalEngine.ts — BROKEN at runtime: `conditions` dependency not wired (see C) |
| Signal lifecycle/state machine (CANDIDATE→…→CLOSED + EXPIRED/INVALIDATED/MISSED/…) | DONE | engines/signalStateMachine.ts |
| Immutable signal snapshots (price/bid/ask/spread/indicators/MTF/regime/news/EV/entry/SL/TP/versions) | DONE | engines/signalSnapshot.ts |
| Expected value engine (win/loss/costs, fees, swap/funding) | DONE | engines/expectedValueEngine.ts |
| Position sizing (risk-based, pip value, min lot, step, leverage, margin, notional) | DONE | engines/positionSizingEngine.ts + math/forexMath.ts |
| Portfolio risk engine (exposure, currency exposure, margin, preflight) | DONE | engines/portfolioRiskEngine.ts |
| Correlation engine (20/50/100 window matrices) | DONE | engines/correlationEngine.ts |
| Circuit breakers (daily/weekly loss, drawdown, consecutive losses, positions, leverage) | DONE | engines/circuitBreakerEngine.ts |
| Risk classification (GREEN/YELLOW/RED + BLOCK) | DONE | engines/riskClassificationEngine.ts |
| Uncertainty engine | DONE | engines/uncertaintyEngine.ts |
| Paper trading engine (account, orders, positions, SL/TP, trailing, slippage, idempotency, dynamic exits, funding/swap) | DONE* | engines/paperTradingEngine.ts — typecheck BROKEN (`entryLots` missing), partial-TP/breakeven incomplete (see C/H) |
| Trailing stop (ATR-based, activate after N×R, ratchets) | DONE | engines/trailingStopEngine.ts |
| Entry / SL / TP builders | DONE | engines/entryEngine.ts, stopLossEngine.ts, takeProfitEngine.ts |
| Backtest engine + metrics (CAGR, recovery factor) | DONE | engines/backtestEngine.ts, metricsEngine.ts |
| Walk-forward (Python: time-series split, purged) | DONE | ai-engine/app/walkforward.py |
| Model registry / champion-challenger / drift / shadow | DONE | engines/modelRegistry.ts, driftEngine.ts, ai-engine/app/models.py |
| Emergency stop (global kill switch + API + UI) | DONE | engines/emergencyStopEngine.ts |
| Scanner (EV-first ranking, adaptive polling weights) | DONE | engines/scannerEngine.ts |
| Alerts engine | DONE | engines/alertEngine.ts |
| System health engine (provider/data/ML/DB/cache status) | DONE | engines/systemHealthEngine.ts |
| Audit trail, structured logs | DONE | core/audit.ts, core/logger.ts |
| Security (JWT, helmet, CORS, rate limit, no secrets in frontend, PAPER default / LIVE off) | DONE | app.ts, auth/auth.ts, .env.example |
| Charts (lightweight-charts; candles, entry/SL/TP lines, signal markers, real-time updates) | DONE | frontend/src/components/CandleChart.tsx |
| Tests: backend 160/161 currently passing (1 broken), frontend 3, Python 12 | PARTIAL | 1 integration test broken by un-wired MarketConditionEngine |
| Settings UI (risk, pairs, trailing, slippage, expiry) | DONE | frontend/src/views/Settings.tsx |

## B. PARTIALLY COMPLETED — NOW DONE (this pass)

| Feature | Status | Gap closed |
|---|---|---|
| Market condition engine (rolling spread + ATR% distributions; Phase 4-5) | DONE | engine written earlier was never wired; now instantiated in container and passed to the signal engine (spreadStatus/volatilityStatus consume live data); unit-tested |
| Partial take profit (Phase 17) | DONE | `entryLots` set at open + normalized on reload; TP1/TP2 close configured % of ORIGINAL size (stepped to asset lot step); remainder stays open and is managed by SL/trailing; 100 = full close, 0 = skip; per-close trade records; integration-tested |
| Breakeven stop (Phase 19) | DONE | SL moves to entry after N×R; single-shot (`breakevenApplied`); never loosens a ratcheted trailing stop; integration-tested |
| Settings UI for partial TP / breakeven | DONE | tp1ClosePct / tp2ClosePct / breakevenEnabled / breakevenActivateR in Settings.tsx |
| MarketConditionEngine unit tests | DONE | marketCondition.test.ts (3 tests) |

## C. BROKEN — ALL FIXED (this pass)

| Item | Failure | Fix |
|---|---|---|
| core/container.ts:199 | `SignalEngineDeps.conditions` missing → TS2345 + runtime `Cannot read properties of undefined (reading 'spreadStatus')` (crashed integration test + every scanner symbol) | MarketConditionEngine instantiated and passed to SignalEngine |
| engines/signalEngine.ts:368 | `prevRegime.regime` typed `string`, not `MarketRegime` → TS2322 | lastRegime map typed with MarketRegime |
| engines/signalEngine.ts:587 | `preflightCheck(openPositions,…)` partial object not assignable to `PaperPosition[]` → TS2345 | openPositions typed PaperPosition[] |
| engines/paperTradingEngine.ts:116 | `PaperPosition.entryLots` required but not set → TS2741 | entryLots: lots at open + reload normalization |

## D. MISSING (verified absent — all pre-existing, none blocking)

| Feature | Status |
|---|---|
| MongoDB/Redis running locally (uses in-memory fallback, clearly labeled) | environment-limited (UNKNOWN — not installed here; docker-compose provided) |
| Docker runtime verification | environment-limited (UNKNOWN — Docker not installed) |
| FinBERT (optional, downloads on demand) | optional / not required |
| Python AI engine running during this pass's live check | environment-limited — not started; system waits safely (MODEL_BLOCKED) per `ALLOW_SIGNALS_WITHOUT_ML=false` |

## E. DUPLICATED

None found. `conditions` exists exactly once (marketConditionEngine.ts); no
second signal/risk/paper engines exist.

## F. NEEDS TESTING (noted for later passes)

- Partial TP + breakeven interplay with the trailing stop when all three are
  enabled simultaneously (individually tested; combined-path test not added).
- Partial closes under extreme-volatility sizing halving.

## G. BLOCKED / DEPENDENCY ISSUE

None remaining. All four typecheck errors and the runtime crash are fixed.

## H. NEXT IMPLEMENTATION STEP (where the previous work stopped — now continued)

The previous developer completed the **market-condition + exit-management batch**
(Phases 4-5, 17, 19) up to the point of:

1. writing `MarketConditionEngine` (spread/volatility rolling regimes) and
   referencing it from `SignalEngine` — **without wiring it in the container**;
2. adding `entryLots`/`breakevenApplied` to `PaperPosition` and
   `tp1ClosePct`/`tp2ClosePct`/`breakevenEnabled`/`breakevenActivateR` to
   `UserSettings` — **without implementing the partial-TP and breakeven logic**
   in `PaperTradingEngine.onTick`, and without setting `entryLots` at open.

**All of the above is now implemented, tested (171/171), typechecked and
live-verified. The next unstarted feature candidates (see REMAINING_WORK.md):**
the combined trailing+partial-TP exit path verification, multi-exchange CCXT
venues, futures/funding-aware risk — none required for the current engine.
