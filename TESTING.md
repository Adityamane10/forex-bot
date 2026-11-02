# TESTING.md

## Test suites

### Backend — vitest (`backend/src/test/`, 148 tests)

- `indicators.test.ts` — known-value SMA/EMA/RSI/MACD/ATR/Bollinger/
  Stochastic/CCI/ROC/Momentum/WilliamsR/ADX/Supertrend/OBV/swings/pivots,
  bounds, alignment, NaN warm-up, empty inputs.
- `forexMath.test.ts` — pip value (EUR/USD $10/lot, USD/JPY ¥1000/lot),
  pip↔price conversions, lot rounding, position sizing (incl. JPY conversion,
  leverage rejection, min-lot, zero-capital), expected value ±, breakeven
  probability, P&L.
- `crypto.test.ts` — crypto asset model (classify, unified spec mapping),
  quantity-step rounding, percentage fees, funding, crypto position sizing
  (risk-based quantity, leverage rejection), EV with taker fee, tick-based
  entry/SL/TP, Binance symbol/interval/bookTicker/klines mapping (incl.
  malformed input rejection), execution stub (live trading refused by
  default), forex+crypto coexistence.
- `risk.test.ts` — circuit breakers (daily loss, drawdown, streaks,
  correlated cluster), correlation (perfect/anti/rolling/align/block),
  risk classification (GREEN/RED+BLOCK), portfolio exposure (USD overlap,
  max positions).
- `signal.test.ts` — state machine (valid lifecycle, invalid transitions,
  history, no resurrection), uncertainty engine, sessions (London/overlap/
  Sydney UTC windows), expected-value engine with costs, entry/SL/TP engine
  (pullback zone, SELL mirror, high-vol sanity, SL below support, TP R:R),
  backtest metrics (win rate, PF, expectancy, per-pair/session, max DD).
- `integration.test.ts` — full container boot: demo ticks flow (forex +
  crypto), candle formation + OHLC validity, indicator computation on seeded
  history, multi-timeframe consensus, signal engine decision + snapshot
  persistence, paper account init, stale-data quality score, XAU/USD with no
  data → NO_TRADE/WAIT, WebSocket channel firing.
- `paperMath.test.ts` — pure paper-execution math: slippage fills (BUY above
  ask, SELL below bid, zero/negative clamps), UTC daily/weekly window
  rollover, Monday-based weeks, signal expiry (§93) and pre-entry state checks.
- `lifecycle.test.ts` — full-container lifecycle: slippage applied to paper
  fills with the signal's prediction state recorded (§48); duplicate-order
  protection (one order + one position per signalId, `clientOrderId` = signalId);
  dynamic exits — opposite signal → `OPPOSITE_SIGNAL`, structural invalidation
  → `REGIME_REVERSAL`; real account state (daily P&L, consecutive losses) fed
  into the circuit breakers at fill; load smoke across all symbols × 7 TFs.

### AI engine — pytest (`ai-engine/tests/`, 12 tests)

- Feature vector completeness + finiteness; **no-lookahead** (mutating bar
  i+1 does not change features at bar i; targets match future closes only;
  no partial labels); indicator primitives.
- Walk-forward training produces dataset version + folds + challenger;
  prediction after training carries versions; shadow flag; promotion flow;
  calibration bounds; graceful failure on insufficient data.

### Frontend — vitest (`frontend/src/format.test.ts`)

- Number/percent/price formatting per pair precision.

## Running

```bash
npm run test:backend      # 111 tests (incl. 22 crypto)
npm run test:ai           # 12 tests (Python 3.13)
npm run test:frontend     # formatting
npm run test              # all
npm run typecheck         # backend + frontend
npm run build             # shared + backend + frontend
```

## What was verified live (this build)

- REST: register/login, market, candles, indicators, MTF, scanner refresh
  (10 symbols), system status, ready, paper account, backtest (90d/1h/3
  pairs), ML training via API (120d/3 pairs/3 folds → challenger registered),
  models/calibration/drift endpoints.
- Crypto (live, this build): Binance WS streaming (7 symbols, ~277 ticks/3 s
  for ETH), real BTC bid/ask, 199 real 1h klines, scanner rankings for all 7
  crypto symbols with real ML probabilities and honest decisions (negative-EV
  and tight-SL rejections observed live).
- Frontend dev server serves and proxies `/api` and `/socket.io` to the
  backend.

## Failure testing (documented, partially automated)

Scenario matrix in `TROUBLESHOOTING.md`. Automated coverage: stale data
blocks signals; ML-down → MODEL_BLOCKED/WAIT (integration test asserts the
XAU/USD no-data path); data-quality engine flags missing provider. Manual
checks for Mongo/Redis-down are covered by the facade design (status DOWN +
safe policy) and can be exercised by pointing MONGODB_URI/REDIS_URL at closed
ports.
