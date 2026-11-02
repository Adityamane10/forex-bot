# Progress Log

Every successfully completed implementation step is appended here. If the session limit is reached, continue from the last `[ ]` (pending) item.

---

## 2026-08-19 — Session: margin-aware multi-position goal trading

### Request
Goal mode + auto-trade should open MULTIPLE positions while margin is available
(previously `singlePositionMode=true` hard-blocked every entry after the first).

### What was done (all verified)
- **Root cause of single-position behavior**: `evaluateEntryGate` had a hard
  `if (settings.singlePositionMode && openPositions.length > 0) → block` and goal
  signals (`plannedLots > 0`) short-circuited PAST the margin cap check — so the
  margin cap was never enforced in aggregate for goal mode.
- **Change** (`backend/src/engines/signalEngine.ts` evaluateEntryGate):
  - Removed the hard single-position block.
  - New AGGREGATE margin/leverage availability check for EVERY entry (goal +
    strict): candidate's margin/notional (plannedLots or sized lots) is summed
    with all open positions' margin/notional (account-currency converted) and
    checked against `maxMarginUsedPct` (margin/equity) and `maxLeverage`
    (notional/equity). Caps exceeded → entry deferred (signal stays alive,
    retried on the next tick).
  - Single-position mode now only ever defers when the caps are exhausted
    (i.e. margin not available); with free margin, multiple positions open.
- **Supporting edits**: `shared/src/types.ts` comment + frontend Settings.tsx
  checkbox label updated to the new semantics.
- **Test** (`lifecycle.test.ts`): new test — with singlePositionMode=true, a
  second goal signal is ALLOWED while aggregate margin < 30% cap, and BLOCKED
  (`margin ...% exceeds max 30%`) when the candidate would push past the cap.
- **Verification**: backend **203/203 green (18 files)**, typecheck clean
  (backend + frontend), shared rebuilt.
- **Live E2E**: multiple positions now open concurrently (e.g. GBP/USD +
  USD/JPY + EUR/USD at the same time); all exits via PROFIT_TARGET_REACHED with
  real exit prices (no price-0 closes, TP2 stays null); wallet 5000 → 5506 INR
  (+506 realized in ~35 min of goal mode at ₹10 target).

### Notes for continuation
- Multi-position growth is bounded by the circuit breakers first in practice:
  `maxOpenPositions` (5), `maxCorrelatedPositions` (3), currency exposure (30%)
  plus the new aggregate margin/leverage caps.
- `maxMarginUsedPct` 0 = unlimited; goal positions are small (0.01 lots ≈ 0.2%
  margin each on the ₹5,000 wallet), so the exposure/correlation breakers bind
  before the margin cap in the current config.

---

## 2026-08-19 — Session: continue MT5 verification + critical paper-exit bug fix

### Context (resumed from the MT5 bridge session)
`npm run dev:all` had been started at 19:05: backend (:4000, tsx watch), AI engine (uvicorn :8500, champion `lightgbm-add365b6`), frontend (Vite :5173). MT5 bridge (10 forex symbols + USDINR) running since 16:47.

### Verification completed (pending items from previous session — all now DONE)
- [x] Ticks source=MT5: `/api/ticks` shows all 10 forex symbols `source: MT5` with fresh timestamps (crypto stays BINANCE)
- [x] Candles fresh: built live from MT5 ticks — `GET /api/candles/EUR%2FUSD?tf=1h` returns real MT5 bars incl. OPEN bar with tick volume; route expects the normalized `EUR/USD` key (bare `EURUSD` returns empty by design — frontend uses the encoded slash form)
- [x] Champion re-sync: `POST /api/models/promote` → synced 21 models; `/api/system/status` Models component now HEALTHY (`champion lightgbm-add365b6 (LIGHTGBM)`) in both backend + AI registries (backend reload wipes its in-memory registry — re-run promote after any backend restart)
- [x] AI engine live check: `/health` ok, goal-hunt signals generated on live MT5 data (8 symbols, state ENTRY_REACHED)

### CRITICAL BUG FOUND + FIXED — disabled-TP sentinel closed positions at price 0
- **Symptom**: paper account went from 5,000 → −51,783 INR. A 0.01-lot NZD/USD trade closed `TP2` with `exitPrice: 0` → PnL −56,732.49.
- **Root cause**: goal-hunt signals carry `takeProfit.tp2: 0` as the disabled sentinel (signalEngine.ts:996). `paperTradingEngine.openPosition` stored it verbatim (`takeProfit2: 0`), and the exit loop's guard `pos.takeProfit2 !== null` lets 0 through → `ask >= 0` is ALWAYS true → instant `closeAtTakeProfit` at price 0 → catastrophic PnL.
- **Fix** (`paperTradingEngine.ts` + `shared/src/types.ts`):
  - `openPosition` normalizes `takeProfit1/2` → `> 0 ? value : null`
  - exit loop adds legacy guards (`!== null && > 0`) for any persisted pre-fix positions
  - `PaperPosition.takeProfit1` type widened to `number | null`
- **Tests**: new regression test (tp1/tp2 = 0 never fires an exit at price 0) in `paperExits.test.ts`; backend suite **202/202 green (18 files)**; typecheck clean (backend + frontend). Note: the demo feed's live signal engine can still close a position via OPPOSITE_SIGNAL/REGIME_REVERSAL — that is by design and uses a real price, so the test asserts `exitPrice > 0` + sane PnL rather than "must stay open".
- **Account reset**: `PUT /api/settings { paperStartingCapital: 5000 }` → wallet reset to 5,000 INR (matches pre-bug starting balance).
- **Live verification**: new goal-hunt fill on EUR/USD shows `takeProfit2: null`; position remained open past 60s with sane unrealized PnL (no instant price-0 close). Models re-synced after the backend hot-reload.

### Notes for continuation
- After any backend restart while the MT5 bridge is up: re-run `POST /api/models/promote` to re-sync the local registry.
- `GET /api/candles/:symbol` expects the normalized symbol (`EUR/USD`), not `EURUSD`.
- Settings currently: goal mode, 10 INR target, 5000 INR wallet.

---

## 2026-08-18 — Session: skfolio portfolio risk integration

### Goal
Add **skfolio** (portfolio optimization, sklearn-compatible) to the risk engine so the paper account's open positions get covariance-based portfolio analytics (correlation, optimized weights, portfolio volatility, CVaR) instead of hand-rolled correlation only.

### Plan
- [x] 1. Install skfolio in `ai-engine/venv` (Python 3.14.2 — verify wheel availability) → **skfolio 0.20.2 installed OK**
- [x] 2. New `ai-engine/app/portfolio.py`: skfolio-based portfolio risk analysis (Mean-Variance + HRP weights, vol, CVaR) fed by dataset returns → **works; unit-smoked with synthetic data (engine=SKFOLIO, fallback numpy path if skfolio absent)**
- [x] 3. New AI endpoint `POST /portfolio/risk` (symbols + weights → analytics JSON) → **live-verified: OK / SKFOLIO / 4 symbols**
- [x] 4. Backend `portfolioAnalytics.ts` client (best-effort, cached, advisory — fill-time gates unchanged) → **done; aligns candle closes by openTime, notional weights from open positions, 60s cache, never gates trading**
- [x] 5. Merge analytics into `/api/risk` payload + surface in UI risk panel → **done; Risk.tsx shows engine, HRP CVaR, effective N, per-symbol weights/vol/risk contribution**
- [x] 6. Regression tests (backend + ai-engine) + live E2E verification → **backend 184/184 (17 files, +3 analytics tests), frontend 10/10, ai-engine 22/22 (+4 portfolio tests); /portfolio/risk live-verified with synthetic payload; /api/risk merge pending live check with an open position**
- [x] 7. This log updated after EVERY successful step

### Status snapshot (start)
- Backend 181/181 tests, frontend 10/10, ai-engine 18/18
- Servers headless (logs in `C:\Users\Aditya\AppData\Local\Temp\opencode\`)
- Champion model: `lightgbm-add365b6` (both registries)
- Manual paper trading: DONE (previous session — `POST /api/paper/manual`)

---

## 2026-08-18 — Session: MT5 bridge (true realtime forex)

### Goal
Activate the existing `workers/mt5-bridge/bridge.py` so forex charts/signals/prediction/paper trading run on REAL broker ticks (no polling) with Yahoo as automatic failover. Crypto stays on Binance WS.

### What was done (all verified)
- [x] MetaTrader 5 terminal **installed by user** (`C:\Program Files\MetaTrader 5`) → running, logged into **MetaQuotes-Demo demo account 5054645811** (auto-login)
- [x] `pip install MetaTrader5` into `ai-engine/venv` → **5.0.6090 OK**
- [x] Backend `backend/.env` created with `INTERNAL_API_TOKEN` (48-char random); internal feed guarded: wrong token → 401, valid token → 400 on empty ticks (auth verified live)
- [x] Bridge fixes (bugs found while wiring):
  - **MT5 server-time offset**: MetaQuotes demo server is ~3h ahead of UTC → all ticks were rejected as "future timestamp" (480k rejects!). Bridge now measures the offset once at startup and subtracts it from every tick/candle timestamp
  - **timeframe casing**: `1d` → `1D` (backend enum) and TFS/tf_ms dicts normalized to uppercase
- [x] Full preload verified: 300 candles per symbol per TF (1h/4h/1D) seeded into backend; streaming loop runs (batch posts every 200ms)
- [x] `POST /api/internal/candles` + `/api/internal/ticks` both accepted live (probe: 1h/4h/1D 300-candle payloads → seeded)
- [ ] Final 10-symbol headless run started (pid 3172) — **verify ticks source=MT5 in /api/ticks + candles fresh + champion re-sync (`POST /api/models/promote`)**
- [ ] Optional: Yahoo failover already automatic (bridge down → polling resumes; nothing to change)

### Notes for continuation
- Bridge launch command: `ai-engine\venv\Scripts\python.exe -u workers\mt5-bridge\bridge.py --preload --symbols EURUSD,GBPUSD,USDJPY,USDCHF,AUDUSD,USDCAD,NZDUSD,EURGBP,EURJPY,GBPJPY` with `INTERNAL_API_TOKEN` from `backend\.env`
- MT5 must be open+logged in when servers start (else bridge exits with clear error; backend falls back to Yahoo)
- LSP noise in bridge.py (MetaTrader5 import) is pre-existing pattern (venv not on LSP path)