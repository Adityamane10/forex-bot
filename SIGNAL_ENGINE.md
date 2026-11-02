# SIGNAL_ENGINE.md

`backend/src/engines/signalEngine.ts` — orchestrates every stage of the
decision. Each stage can veto; the engine never forces BUY/SELL.

## Decision stages

1. **Emergency stop gate** (§90) — NO_TRADE while a global emergency stop is active.
2. **Data quality** — freshness, missing candles, duplicates, invalid OHLC,
   spread vs per-asset cap, provider health. Low score → WAIT.
3. **Candles + indicators** per timeframe → MTF, price action, S/R, session.
4. **News / events / sentiment** for the symbol's currencies.
5. **Historical patterns** — timestamp-safe analogues; win rate / avg return /
   MFE / MAE shown as *historical statistics*, never guarantees.
6. **Regime** — ADX/ATR/EMA/structure/news/spread-stress → 11 regimes incl.
   `BREAKDOWN` and `LIQUIDITY_STRESSED` (§27).
7. **Features → ML** (champion; challenger shadow disagreement measured).
   ML down → WAIT/MODEL_BLOCKED per safe policy.
8. **Ensemble** (§27/§42) — weighted technical + pattern + ML + news + event
   scores; every component recorded in the snapshot `componentScores`.
9. **Entry/SL/TP** — pullback entries, structural/ATR stops, TP1/TP2 (+TP3),
   R:R check.
10. **Expected value** — P(win)×avgWin − P(loss)×avgLoss − costs; must be positive.
11. **Sizing → portfolio risk → correlation → circuit breakers** — any veto blocks.
12. **Profit constraint** — requested minimum profit must be achievable without
    raising risk, else `NO TRADE`.
13. **Uncertainty + risk classification** — INSUFFICIENT_CONFIDENCE allowed.

## Outputs

`BUY`, `SELL`, `WAIT`, `NO_TRADE`, `INSUFFICIENT_CONFIDENCE`, plus state-level
`RISK_BLOCKED`, `MODEL_BLOCKED`, `NEWS_BLOCKED`, `DATA_ERROR`. Reasons are
always human-readable ("WHY WAIT / WHY INVALIDATED / ...", spec §58).

## Lifecycle (state machine)

```
CANDIDATE → ANALYZING → QUALIFIED → SIGNAL_CREATED → WAITING_FOR_ENTRY
  → ENTRY_REACHED → POSITION_ACTIVE → (TP1_HIT|TP2_HIT|TRAILING) → CLOSED
terminal/blocked: EXPIRED, INVALIDATED, MISSED, RISK_BLOCKED, NEWS_BLOCKED,
DATA_ERROR, MODEL_BLOCKED, INSUFFICIENT_CONFIDENCE, PERFORMANCE_RECORDED
```

Every transition is recorded on the signal and in `signalEvents`. A direction
change invalidates the old signal and creates a new one.

## Snapshot (§57)

`signalSnapshots` stores the complete evidence: price/bid/ask/spread, regime,
news, sentiment, ML probability, ensemble component scores, EV, entry/SL/TP,
sizing, model/feature/dataset/strategy versions, data quality and mode —
answerable to "why did the bot do that, using only data available then?".

## Live refresh

Every tick updates price/entry checks; completed 1h/4h/1D candles re-analyze;
hot 5m/15m closes re-analyze hot symbols; news/calendar refresh re-analyzes
affected symbols; the scanner is a periodic safety-net sweep. Symbols with an
active signal are re-analyzed every 15 s.

**A signal never remains static (§2, §93):**

- Every signal has a hard `expiresAt` (settings `signalExpiryMs`). On the tick
  path a pre-entry signal past expiry transitions to **EXPIRED** and is removed;
  the refresh loop immediately re-analyzes and re-creates only if a valid setup
  re-appears.
- A re-analysis that downgrades the thesis — WAIT (score below threshold),
  negative expected value, SL/R:R/level rejection, sizing/profit/correlation/
  breaker blocks, insufficient confidence — **INVALIDATES** the old pre-entry
  signal with the reason recorded (§37). A stale BUY is never left waiting on
  a dead setup.
- Entry-zone drift is handled by the stored zone: price beyond it → **MISSED**;
  inside it → **ENTRY_REACHED** (BUY checks the ask, SELL the bid).
