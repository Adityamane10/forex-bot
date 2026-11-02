# TRADING_ENGINE.md

The end-to-end decision pipeline, as implemented in `backend/src/engines/`.

## Pipeline

```
MARKET DATA (RoutingMarketDataProvider)
   forex: YAHOO | TWELVEDATA | FINNHUB | MT5 bridge
   crypto: BINANCE (bookTicker WS + REST klines)
   ──► validate ──► TICK ──► CANDLE ENGINE (1m..1D, incremental)
        └──────────────► INDICATOR ENGINE (tested math layer)
                              └──► MULTI-TIMEFRAME ─► PRICE ACTION ─► S/R ─► SESSION
                                   └──► PATTERN ENGINE (historical analogues)
NEWS ENGINE ──► SENTIMENT ──► EVENT ENGINE (economic calendar)
                                   │
                                   ▼
                              FEATURE ENGINE (versioned, timestamp-safe)
                                   ▼
                              ML ENGINE (Python: LR/RF/XGB/LightGBM, calibrated)
                                   ▼
                        REGIME ──► STRATEGY ROUTER ──► ENSEMBLE (component scores)
                                   ▼
                              EXPECTED VALUE (costs incl. spread/fees/slippage/swap/funding)
                                   ▼
              ENTRY/SL/TP ──► POSITION SIZING ──► PORTFOLIO RISK ──► CORRELATION
                                   ▼
                     CIRCUIT BREAKERS ──► UNCERTAINTY ──► RISK CLASSIFICATION
                                   ▼
              BUY / SELL / WAIT / NO_TRADE / INSUFFICIENT_CONFIDENCE
                                   ▼
              signal lifecycle + immutable snapshot + paper execution
```

## Asset classes (spec §6-7)

- **FOREX** — 10 pairs + XAU/USD; pip/point, lot, contract size, leverage,
  margin, commission, swap, sessions per pair (`shared/src/assets.ts`).
- **CRYPTO** — 7 Binance spot USDT pairs; tick size, quantity step, min/max
  order, maker/taker fees, funding metadata, margin mode. Spot only in v1;
  perpetual/futures metadata is present but funding is zero for spot.
- Both map onto one **unified `AssetSpec`** (tick = pip, contract = 1 unit) so
  every engine is asset-class aware with no duplicated logic. Position sizing
  is per-instrument: forex uses lot/pip math, crypto uses
  risk ÷ stop-distance rounded to the exchange quantity step (§30, §48).

## Strategies (spec §28)

The **strategy router** (`strategyEngine.ts`) selects a modular strategy from
the detected regime and records `strategy` / `strategyVersion` /
`strategyReason` on every signal and snapshot:

| Regime | Strategy |
|---|---|
| TRENDING_BULLISH / TRENDING_BEARISH | TREND_FOLLOWING (or PULLBACK when retracing, MOMENTUM when RSI-extended) |
| BREAKOUT / BREAKDOWN | BREAKOUT / MOMENTUM |
| REVERSAL / RANGING / LOW_VOLATILITY | MEAN_REVERSION / RANGE |
| HIGH_VOLATILITY / NEWS_DRIVEN / LIQUIDITY_STRESSED / UNCERTAIN | RISK_CONTROLLED |

The strategy shapes the setup; it never overrides the risk engine.

## Cost models (spec §44-46)

- **Forex:** spread + commission (USD/lot) + slippage (pips) + swap.
- **Crypto:** percentage taker fee on notional + spread + slippage + funding
  (per funding interval; 0 for spot).
- Execution never assumes perfect fills: paper fills use the real side of the
  spread **plus configurable slippage** (`slippageBps` — BUY above ask, SELL
  below bid); backtests apply spread/slippage/commission/swap/funding.
- One order + one position per signalId (`clientOrderId` idempotency) — a
  double-fired entry event or restart can never open the same signal twice.

## Signals stay live (spec §2, §60-61)

Signals have an entry zone and a hard expiration (`expiresAt`); the live
refresh marks `ENTRY_REACHED` / `MISSED` / `EXPIRED` / `INVALIDATED` as price
moves or time passes, then immediately re-analyzes for a fresh setup. A
re-analysis that weakens the thesis invalidates the old signal instead of
leaving it waiting (§37). Static signals never persist.

## Dynamic exits (spec §44)

Positions are not held blindly until SL/TP. The position manager also closes
when:

- a **new opposite signal** appears for the same symbol → `OPPOSITE_SIGNAL`;
- the open signal is invalidated for a structural reason (direction change /
  regime reversal / trend shift / material news) → `REGIME_REVERSAL` or
  `INVALIDATED`;
- the trailing stop activates (§63);
- TP1 / TP2 / SL are hit (checked against the real side of the spread).

Every close is recorded with its exit reason, and the signal's prediction
state (confidence, probability, expected value, model/strategy/feature
versions) is stored on the trade for prediction-vs-reality analysis (§48).
