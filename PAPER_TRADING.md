# PAPER_TRADING.md

## What it is

A virtual account (default $10,000) driven by **real market prices** — never
real money. It exists so the whole signal lifecycle can be exercised
end-to-end and measured honestly.

## Lifecycle

1. Signal engine creates a signal with an entry zone (state
   `WAITING_FOR_ENTRY`).
2. `refreshSignal` compares live price against the **fixed** entry zone:
   - inside zone → `ENTRY_REACHED`
   - beyond zone → `MISSED` (never re-shown as current; a fresh setup gets a
     brand-new signal)
3. On `ENTRY_REACHED` a market order is filled **on the real side of the
   spread** — BUY fills at the ask, SELL at the bid (falls back to mid when
   only mid is available, e.g. modeled spreads). Position size comes from the
   live risk-based sizing (risk % × capital / SL distance). A `PaperPosition`
   is opened (state `POSITION_ACTIVE`).
4. Every tick updates unrealized P&L, swap (per day held), duration.
5. **SL/TP checks use the real spread side too**: a BUY's SL triggers on the
   bid, its TP on the ask; a SELL's SL triggers on the ask, its TP on the
   bid. With the MT5 bridge (real bid/ask ticks) this is genuine
   bid/ask execution; with modeled spreads it is labeled `spreadModeled`.
6. Price hits SL → `SL_HIT` → close (state `CLOSED` → `PERFORMANCE_RECORDED`);
   hits TP1/TP2 → close on TP. Manual close supported via the API/UI.

Auto-execution is wired in the container: `ENTRY_REACHED` → sized fill →
`POSITION_ACTIVE`, bounded by `maxOpenPositions` (signal invalidated instead
of over-filling). It never executes real money.

## Frictions modeled

- **Spread**: fills happen on the real side of the spread when bid/ask are
  present (MT5 bridge), else at mid with the modeled spread labeled
  `spreadModeled`.
- **Commission**: `asset.commissionPerLot` (default $7 per standard lot).
- **Swap**: daily accrual using per-pair `swapLong`/`swapShort`.
- **Slippage**: applied to SL/TP exits in the backtester; live fills assume
  the current quote.

## Account state

`balance, equity, margin, freeMargin, unrealizedPnl, realizedPnl, fees,
maxDrawdownPct, dailyPnl, weeklyPnl, openPositionCount`.

## Records

- `paperOrders` (requested/fill price, status)
- `paperPositions` (entry, SL, TP1/TP2, open/close times)
- `paperTrades` (entry/exit, exit reason, P&L, fees, swap, R multiple,
  session, duration)

## API

`GET /api/paper/account`, `/orders`, `/positions`, `/trades`,
`POST /api/paper/close/:positionId`. Real-time updates via Socket.IO events
`paper.position`, `paper.trade`, `risk.update`.
