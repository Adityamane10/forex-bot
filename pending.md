# Pending Work — Indian Markets Subsystem

Status snapshot for the India subsystem (`backend/src/india`, `/api/india`, India UI page).
The Upstox WebSocket V3 TBT (tick-by-tick) is now the primary real-time Indian data source.
The feed uses **only the configured Indian broker — never Yahoo Finance** for Indian data.

---

## 1. Blocked on credentials — do FIRST

### 1a. Provide the Upstox API Analytics Token (required to go live on real data)
- Generate it at Upstox developer dashboard → My Apps → **Analytics Access Token** → Generate Token.
- It is free, read-only, valid ~1 year, market-data + streaming only (cannot place/modify/cancel orders — the system enforces this).
- Optional: add your public IP under **Static IPs** to also unlock read-only Portfolio + Account/Funds endpoints.
- Set in `backend/.env` (or repo root `.env`):

```env
INDIA_BROKER=UPSTOX
INDIA_UPSTOX_ANALYTICS_TOKEN=<your-token-here>
INDIA_UPSTOX_FEED_MODE=ltp   # ltp = TBT (default), full = depth
```

- Restart backend (from `backend/`): `node ..\node_modules\tsx\dist\cli.mjs src/index.ts`
- Expected boot log: `upstox: authenticated readOnly:true`, `india module started` with `instruments` ≈ 237.
- Expected UI: India page badge **READ-ONLY TBT FEED**; real TBT ticks on the chart; paper P&L in INR with SL/TP.

> **Token status (updated):** token configured in `backend/.env` and **working**. Static IP
> `106.213.83.237` added + token regenerated in the dashboard. The code now uses the current **V3
> endpoints** (authorize-then-connect WebSocket `/v3/feed/market-data-feed/authorize` + `/v3/historical-candle`).
> Boot smoke test PASSED: authenticated `readOnly:true`, instrument master loaded (237), real historical
> candles seeded (NIFTY 5m bars, last close 24078.30), **V3 WebSocket connected** with the analytics token,
> health honestly reports `MARKET_CLOSED` outside NSE hours, analysis engine runs on real candles
> (regime=RANGING, structure=UPTREND). **Remaining:** confirm live TBT ticks + first candle close during
> NSE market hours (09:15–15:30 IST, next session).

### 1b. Verification checklist once the token is set
- [ ] `/api/india/status` → `health.state` reaches `CONNECTED`, `feed.ticks` increasing
- [ ] `india.price` socket events flow; candles build on the chart (primary TF `5m`)
- [ ] Instruments dropdown lists NIFTY/BANKNIFTY/FINNIFTY/MIDCPNIFTY futures + options
- [ ] `/api/india/analysis` produces snapshots; indicators appear on chart
- [ ] Signals fire during market-open hours (IST) with a valid session
- [ ] A paper position opens (goal or universal), SL/TP monitored off live ticks, INR P&L correct
- [ ] `POST /api/india/authority` owner/mode transitions work; sequential-trade rule respected
- [ ] Confirm order endpoints are REJECTED with the read-only message (expected in paper stage):
      `POST/order` style calls → "Upstox Analytics Token is read-only — cannot place orders"

---

## 2. Known pre-existing issues (independent of credentials)

### 2a. ai-engine test failure (unrelated to India feed) — FIXED
- `ai-engine/tests/test_ml.py::test_predict_after_training` previously FAILED: production `predict`
  serves the **CHAMPION** (older dataset) until a challenger beats it, while the test wrongly asserted the
  newest dataset always serves.
- Fix applied: the test now asserts the freshly trained dataset via the **shadow** prediction (which
  surfaces the newest challenger) and only checks the production path returns a real, available model.
  Full suite: `22 passed`.

### 2b. Root `test:ai` script uses the wrong Python — FIXED
- Root `test:ai`/`dev:ai` previously ran `py -3.13` (system Python) which **lacks `skfolio`**.
- Fix applied: both scripts now use `ai-engine\venv\Scripts\python.exe`. `npm run test:ai` → `22 passed`.

### 2c. MongoDB + Redis were leaking into vitest suite — FIXED
- The durable-storage session added `MONGODB_URI` + `REDIS_URL` to `backend/.env` and started the services.
- Without hardening, vitest would connect to the live Mongo/Redis (real user settings leaked, e.g.
  INR/₹5000 paper account) causing **deterministic test failures** (8 failed).
- Fix applied: `backend/vitest.config.ts` now explicitly sets `MONGODB_URI: ''` and `REDIS_URL: ''`
  in `test.env` to force in-memory store/cache. Full backend suite: **246 passed**.

---

## 3. Deferred — live trading path (ONLY after paper stage is validated)

### 3a. Wire the Upstox OAuth callback route (not yet implemented)
- Backend has `upstoxLoginUrl()` + `upstoxToken()` (code exchange) but **no HTTP callback route**.
- TODO: add `/api/india/auth/callback` handling `?code=...` from Upstox's redirect, exchange for an
  access token, store it, and redirect back to the frontend India page.
- Must match the **Redirect URL** you set in the Upstox app registration, e.g.
  `http://localhost:4000/api/india/auth/callback`.

### 3b. Live app registration (Upstox dashboard → My Apps → Create app)
- App Name (≤20 chars), e.g. `FXIntelIndia`.
- Redirect URL: as above — must exactly equal `INDIA_REDIRECT_URI`.
- Postback URL / Notifier Webhook: optional (order webhooks) — leave blank for now.
- Then set: `INDIA_API_KEY` (client_id), `INDIA_API_SECRET`, `INDIA_REDIRECT_URI`.
- Live execution stays gated behind `INDIA_LIVE_EXECUTION=true` (default false) and a
  **non-analytics** (full OAuth) access token.

### 3c. Validate real order flows before enabling live
- [ ] Full OAuth login from the India UI
- [ ] `placeOrder/modifyOrder/cancelOrder` work via adapter (read-only guard OFF for OAuth token)
- [ ] Broker positions/orders/account endpoints return real data (needs Static IP for analytics,
      or a full token)
- [ ] Paper→live parity: same signal engine drives both; confirm P&L, SL/TP, expiry exits match

---

## 4. Completed this session (major additions)

### 4a. OI / PCR / MaxPain analytics engine (spec §18) — **DONE + TESTED**
- New `backend/src/india/option-flow.ts`: computes PCR (Put/Call Ratio), Max Pain (writer-loss
  minimization), OI change vs lookback, per-strike CE/PE OI deltas — **from the same real TBT feed**
  (no external data). Exposes `IndiaOptionFlowSnapshot` with posture `BULLISH|BEARISH|NEUTRAL`.
- Wired into **signal engine** as soft confirmation: aligned posture boosts confidence by +0.15
  (capped at 1.0); never blocks a signal. Added `optionConfirmation` field to `IndiaSignal`.
- Periodic refresh timer (15s, market-open) in `IndiaModule`; persists to `IndiaOptionFlow` Mongo
  collection + `india:option-flow:` Redis cache.
- REST endpoint: `GET /api/india/option-flow?underlying=NIFTY&expiry=<ms>` (all underlyings if omitted).
- Hermetic test suite: 8 tests covering PCR, max-pain math, posture logic, OI/PCR change,
  persistence, cache, and cached-snapshot sync.

### 4b. India v2 ML pipeline (shadow-first, spec §19) — **DONE + TESTED**
- `ai-engine/app/india_features.py`: `add_triple_barrier_labels()` (PT/SL/vertical via ATR);
  `build_india_features(..., include_triple_barrier=True)` — v1 output unchanged.
- `ai-engine/app/india_v2.py`: `run_india_v2_walk_forward` (purged folds, per-fold primaries,
  stacking, meta-labeling, META_THRESHOLD=0.6), `IndiaV2Registry` (`models-india-v2/` +
  `datasets-india-v2/`), `load_v2_bundle`, circular-import free.
- `ai-engine/app/india_models.py`: `INDIA_V2_SERVICE` singleton — predict returns probability,
  direction, metaProbability, threshold, filtered, signal `LONG|SHORT|NO_TRADE`, confidence,
  shadow, fallback; champion/challenger promotion.
- `ai-engine/app/main.py`: `POST /india/v2/train`, `POST /india/v2/predict`,
  `POST /india/v2/promote`, `GET /india/v2/models`.
- Tests: 7 new hermetic tests (triple-barrier PT/SL, columns emitted, purge-embargo, training
  completes + predicts, isolation from v1 dirs, registry roundtrip). All pass.
- Fixed `build_india_features` duplicate `timestamp` column bug (was in `INDIA_FEATURE_NAMES`
  and also explicitly added).

---

## 5. Small cleanups (nice-to-have, not blocking)

- `NullBrokerAdapter.name = 'ZERODHA' as const` — cosmetic oddity (a null adapter reporting the
  Zerodha name). Consider renaming to `'NONE'`.
- `upstox-market-data.ts` `decodeFeed` still defaults segment to `'NSE_FUT'` for all WS ticks —
  enrich from the instrument map (already done in `UpstoxAdapter.openWs`); double-check non-FO
  segments (NSE_INDEX) on the wire.

---

## 6. Remaining active work (priority order from user)

| Priority | Item | Status |
|----------|------|--------|
| HIGH | OI/PCR/MaxPain connected to India signal engine | ✅ DONE |
| HIGH | Durable MongoDB persistence | ✅ DONE (service running, .env set, fallback hardened) |
| HIGH | Redis running for real-time state | ✅ DONE (portable Redis on 6379, .env set, fallback hardened) |
| HIGH | PCR / Max Pain analytics | ✅ DONE |
| MEDIUM | India V2 frontend model panel (train/predict/promote + shadow) | ⏳ Pending |
| MEDIUM | OI/PCR visualization on India UI page | ⏳ Pending |
| LOW | Drift monitoring (ai-engine) after core validated | ⏳ Pending |
| — | Live TBT tick verification during NSE hours (09:15–15:30 IST) | ⏳ Blocked on market hours |

---

## 7. Re-run the full validation after any change

```bash
# backend
cd backend
..\node_modules\.bin\tsc -p tsconfig.json --noEmit
..\node_modules\.bin\vitest run          # expect 20 files / 246 tests green

# frontend
cd frontend
..\node_modules\.bin\tsc -p tsconfig.json --noEmit

# ai-engine (use the venv — system py lacks skfolio)
cd ai-engine
venv\Scripts\python.exe -m pytest tests
```

---

## 8. Current green baseline

- Backend: typecheck clean, `vitest` **246 passed (20 files)** incl. `india.test.ts` (33 tests) + `indiaOptionFlow.test.ts` (8 tests).
- Frontend: typecheck clean, build OK.
- ai-engine: **29 passed** via venv python (`npm run test:ai` green).
- India module boots with the real analytics token: authenticated `readOnly:true`, master loaded (237 execution instruments), real V3 historical candles seeded, **V3 WebSocket connected**, INR paper account, honest `MARKET_CLOSED`/`STALE`/`DISCONNECTED` health outside NSE hours.
- OI/PCR/MaxPain analytics live on the real feed, feeding the signal engine as soft confirmation.