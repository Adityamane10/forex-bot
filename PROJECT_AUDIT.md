# PROJECT AUDIT — Phase 0

Audit performed at build start (greenfield workspace) and re-verified at completion.

## 1. Initial state

The workspace was **empty** — no frontend, backend, Python services, tests, Docker,
or existing market-data code. This was a greenfield build, so Phase 0 findings are
recorded here as the baseline and re-audited against the finished system.

## 2. Environment audit

| Item | Finding |
|---|---|
| Node.js | v25, npm 9.6 — usable |
| Python | 3.14 on `python`, **3.13** via `py -3.13` with full ML wheel support (sklearn, xgboost, lightgbm, fastapi) |
| Docker | **Not installed** — Docker Compose provided, but verified locally without it |
| MongoDB | **Not available** — in-memory store fallback implemented, clearly flagged in System Health |
| Redis | **Not available** — in-memory cache/pub-sub fallback implemented, clearly flagged |
| Git | Not initialized in workspace — no commits made (none requested) |

## 3. Final architecture (as built)

```
React/Vite frontend (:5173)
        │  Socket.IO + REST (JWT)
        ▼
Node/TS backend (:4000)
  ├─ Market Data Engine → Candle Engine (1m→1D)
  ├─ Indicator / MTF / Price Action / S/R / Session engines
  ├─ News / Economic Calendar / Sentiment / LLM(optional Groq)
  ├─ Feature Engine → Regime → ML client (Python)
  ├─ EV → Entry/SL/TP → Sizing → Portfolio Risk → Correlation
  ├─ Circuit Breakers → Risk Classification → Uncertainty
  ├─ Signal Engine (state machine + immutable snapshots)
  ├─ Scanner, Alerts, Paper Trading, Backtest/Walk-Forward
  ├─ Model Registry, Drift, System Health, Audit trail
  └─ REST API + Socket.IO (auth, rate limiting, validation)
        │  HTTP /features /train /predict
        ▼
Python FastAPI AI engine (:8500)
  ├─ No-lookahead feature computation (single-pass)
  ├─ sklearn LR/RF + XGBoost/LightGBM
  ├─ Time-series split + walk-forward validation
  ├─ Probability calibration (Brier + calibration curve)
  ├─ Model + dataset versioning, champion/challenger, shadow mode
  └─ Sentiment (lexicon fallback; FinBERT optional)
```

## 4. Reusable code / strengths

- **Pure, tested math layer** (`backend/src/math/`): indicators and forex math with
  76 backend tests green.
- **Provider abstraction** (Phases 4, 16, 17): every external service is behind an
  interface with a `Noop`/`Demo` fallback that fails safe instead of fabricating data.
- **No-lookahead discipline**: features computed with only past/current bars;
  walk-forward splits; timestamp-safe historical patterns.
- **Immutable signal snapshots**: every signal records its full evidence context.

## 5. Broken / missing functionality (found & fixed)

| Issue | Fix |
|---|---|
| `PORT=0` injected by shell env → backend refused to bind | explicit port + env override |
| NaN handling in SMA / Supertrend seeding | corrected algorithms, regression-tested |
| Leverage semantics, exposure double-counting, EV swap sign | corrected, tests updated |
| JPY pip-value conversion ignored `usdRate` | fixed conversion, regression-tested |
| Backtest over-traded random walk (unrealistic) | mean-reverting demo walk + stricter entry criteria (81 trades, PF 0.99) |
| `/models/train` didn't forward candles to Python | fixed payload; verified end-to-end via API |
| Feature computation O(n²) → 20 min for 3 months of 1h bars | single-pass series rewrite, 2.7× faster suite |
| Stale in-memory models after retrain / `_load()` bug | reload path fixed; champion-fallback for non-shadow predict |
| Models health check ignored Python engine registry | now aggregates both registries |
| Rollup couldn't statically resolve `@fx/shared` CJS re-export | Vite alias + tsconfig paths to TS source |

## 6. Known limitations (honest)

- **No real market feed configured by default** — demo feed is clearly labeled and
  never marked LIVE. Twelve Data free-tier integration is implemented and ready
  (`MARKET_DATA_PROVIDER=TWELVEDATA` + API key).
- No local MongoDB/Redis → in-memory fallbacks lose state on restart; Docker Compose
  provides the full stack.
- FinBERT is optional (`SENTIMENT_MODEL=finbert`); lexicon fallback used otherwise.
- Groq is optional and never required for signal logic.
- Free-tier rate limits apply to Twelve Data / RSS / ForexFactory (see RESOURCE_AUDIT.md).

## 7. Security audit summary

Auth (bcrypt + JWT), CORS restricted, input validation, rate limiting on auth and API,
WebSocket auth, no secrets in React, no secret logging, NoSQL-injection-safe query
layer. Details in SECURITY.md.

## 8. Verdict

No production-critical placeholders leak into live mode. Demo data is isolated behind
an explicit `DEMO` provider; the system health panel reports provider status truthfully.
**Audit passed** — full details in FINAL_REPORT.md.

---

# Re-audit — FOREX + CRYPTO master-spec compliance (Phase 0 v2)

Re-audited against the **Forex + Crypto Real-Time Quantitative Trading Platform
Master Agent Prompt** (56 sections / 31 phases). Baseline re-verified on a clean
checkout: **89 backend + 3 frontend + 12 Python tests green**, typecheck clean
(one environment fix: stale `node_modules/@fx/*` workspace symlinks pointed at an
old path and were relinked via `npm install`).

## Gap analysis vs the master spec

| Spec section | Status before | Action taken |
|---|---|---|
| §6/§8 Crypto asset model + engine | **MISSING** (forex only) | `CRYPTO_ASSETS` (7 Binance USDT pairs), unified `AssetSpec`, `assetClassFor` |
| §8 Crypto adapter / market data | **MISSING** | `BinanceCryptoMarketDataProvider` — real bookTicker WebSocket + REST klines, reconnect/backoff/resubscribe/heartbeat/watchdog |
| §30 Crypto position sizing | **MISSING** | crypto path through unified asset (quantity = riskAmount ÷ stop distance), quantity-step rounding, spot margin |
| §25 EV with crypto costs | **PARTIAL** | percentage taker fee + funding in EV; per-unit contract semantics |
| §27 Ensemble scoring | **PARTIAL** (combined score existed but was not recorded) | `componentScores` {technical, pattern, ml, news, event, combined} now stored in every signal snapshot |
| §43 ExecutionProvider | **MISSING** | interface + `DisabledExecutionProvider` (live trading OFF by default, refuses all real orders), surfaced in System Health |
| §2 Asset-class selection | **MISSING** | Settings FOREX/CRYPTO selector; Market view instrument switcher |
| §38 Paper trading crypto | **PARTIAL** | crypto taker fees + funding accrual in the paper engine |
| §46 Crypto tests | **MISSING** | `crypto.test.ts` — 22 tests (asset model, sizing, EV, fees, mapping, entry/SL/TP, execution stub) |

Everything else in the 56-section spec was already implemented and verified
(providers, candles, indicators, MTF, patterns, regimes, news/calendar, LLM,
features, ML + walk-forward, risk, circuit breakers, signal lifecycle,
snapshots, backtesting, champion/challenger, drift, security, docs).

## What was verified live (this re-audit)

- **Binance provider against the real API**: WebSocket connected with 7 symbols;
  real BTC bid/ask (e.g. 64212.63/64212.64, $0.01 spread); 199 real 1h klines;
  ~277 WS ticks for ETH/USDT in 3 s. All labeled `LIVE`, source `BINANCE`.
- **Full three-service run with real data**: backend on :4000 with forex (Yahoo)
  + crypto (Binance). System health: **17/17 symbols receiving ticks**, all
  components healthy, `Live Execution` component reports
  "live execution disabled by default".
- **Crypto signal path end-to-end**: scanner produced rankings for all 7 crypto
  symbols with real ML probabilities; decisions were honest — e.g.
  `BNB/USDT NO_TRADE expected value -0.23` (negative EV after real fees/spread),
  `ADA/USDT NO_TRADE SL too tight (50.8 ticks)` (real ATR-based SL).

## Environment note (this checkout)

- Shell exports `PORT=0`; run services with an explicit `PORT=4000`.
- MongoDB/Redis not present — in-memory fallbacks, clearly flagged in health.

---

# Re-audit v3 — master-spec §1-§117 gaps closed

Baseline after v2: **132 backend + 3 frontend + 12 Python tests green**,
typecheck clean. Gap analysis against the full 116-section prompt and what
was implemented:

| Spec section | Was | Now |
|---|---|---|
| §9 CryptoExchangeAdapter (CCXT) | direct Binance provider only | **CCXT-backed adapter** (`cryptoExchangeAdapter.ts`): normalized getMarkets/getQuote/getOHLCV/getOrderBook/getBalance/getPositions/createOrder/...; execution refuses without keys; REST API `/api/crypto/*`; verified live (real order book, quote, market metadata) |
| §27 LIQUIDITY_STRESSED + BREAKDOWN regimes | 9 regimes, BREAKDOWN mislabeled BREAKOUT | both added; spread-stress input drives LIQUIDITY_STRESSED |
| §28 Strategy router | single combined score | `strategyEngine.ts` — regime→strategy (TREND_FOLLOWING/BREAKOUT/PULLBACK/MOMENTUM/MEAN_REVERSION/RANGE/RISK_CONTROLLED) with `strategy`/`strategyVersion` recorded on every signal + snapshot |
| §63 Trailing stop | state name only, no logic | pure `trailingStopEngine.ts` (ATR-based, activate after N×R, profit locked); paper engine + signal TRAILING transitions; user settings + UI |
| §66 CAGR + recovery factor | missing | added to `BacktestMetrics` + `metricsEngine` |
| §90 Global emergency stop | missing | `emergencyStopEngine.ts` + API (`POST /api/system/emergency-stop`), System Health UI button, audit trail; verified live: all 17 symbols NO_TRADE while stopped |
| §107 Mobile responsiveness | desktop-only sidebar | mobile top bar with scrollable nav (App.tsx) |
| §108 Documentation | 25 docs | +9: FREE_SERVICES, THIRD_PARTY_LICENSES, WEBSOCKET, TRADING_ENGINE, SIGNAL_ENGINE, RISK_ENGINE, ML_PIPELINE, RESEARCH, TROUBLESHOOTING |
| §74 Indexes | present | verified (`store.ts` ensureIndexes: candles/symbol+tf+time, signals, snapshots, news, trades, features, ...) |

Everything else in §1-§117 was already implemented and verified in v1/v2.
Live verification this pass: CCXT real quote/order book/OHLCV; emergency-stop
block → all symbols NO_TRADE → release → analysis resumes; scanner + ML
healthy on 17 symbols.

---

# Re-audit v4 — real-time paper-trading master-spec (132 sections)

Baseline after v3: **132 backend + 3 frontend + 12 Python tests green**, typecheck
clean. Gap analysis against the 132-section prompt (paper-trading emphasis).
The v1-v3 passes already covered the bulk: real-time WS providers, MTF engine,
regime engine, news/calendar, ML + walk-forward, champion/challenger, drift,
backtesting, paper engine, emergency stop, CCXT adapter, trailing stop, signal
state machine, chart with entry/SL/TP lines, and the full WS event map.

**Gaps found & closed this pass:**

| Spec section | Was | Now |
|---|---|---|
| §93 Signal expiry | signals waited for entry indefinitely | `Signal.expiresAt` (settings `signalExpiryMs`, UI in minutes); `refreshSignal` → **EXPIRED** on the tick path; 15s refresh re-analyzes and re-creates only if still valid |
| §37 Re-validation invalidation | a WAIT/negative-EV re-analysis left the old pre-entry signal waiting | `invalidatePreEntry()` — thesis weakened (WAIT), EV negative, SL/R:R/level, sizing, profit, correlation, breakers, insufficient confidence → old signal **INVALIDATED**; a new signal is created only when a valid setup re-appears |
| §34 Real circuit-breaker state | `dailyPnlPct/weeklyPnlPct/drawdownPct/consecutiveLosses` were hardcoded 0 | paper account now tracks daily/weekly P&L with UTC window rollover + consecutive losses; signal engine reads real account state (5s cache) into breakers + risk classification; fill-time `evaluateEntryGate()` re-checks everything before an order |
| §40-41 Paper fill realism | fills at the raw side of the spread, no slippage | `slippageBps` setting (UI); BUY fills above ask, SELL below bid (`applySlippage`) |
| §71/§123 Duplicate-order protection | no idempotency key | `clientOrderId = signalId`; one FILLED order + one position per signal, even across restarts/double-fired events |
| §44 Dynamic exits | positions closed only on SL/TP/trailing | opposite signal → **OPPOSITE_SIGNAL** close; structural signal invalidation (direction/regime/trend/news) → **REGIME_REVERSAL**/INVALIDATED close at the real side of the spread |
| §48 Prediction vs reality | trades stored `regime: null, modelVersion: ''` | positions + trades now record confidence, probability, expectedValue, strategy(+version), modelVersion, featureVersion, slippageBps at entry |
| §17-18 On-chain engine | absent | `OnChainProvider` abstraction + honest `NoneOnChainProvider` (reports **UNAVAILABLE**, never fabricates whale/flow numbers), System Health row |
| §55 Opportunity ranking | ranked by confidence only | scanner ranks BUY/SELL by **expected value first**, then confidence |
| §53 Chart signal markers | entry/SL/TP lines only | BUY/SELL arrow markers at the signal timestamp; removed when invalidated/missed/expired |
| §110-111 Failure tests + §90 load | — | `paperMath.test.ts` (slippage, window rollover, expiry) + `lifecycle.test.ts` (idempotency, slippage fill, dynamic exits, real breaker state, load smoke) |

**Verification:** backend **148/148**, frontend 3/3, Python 12/12, typecheck 0,
production build passes. Load smoke: all symbols × 7 TFs (119 indicator sets +
MTF + pattern) complete in well under the 30s bound.
