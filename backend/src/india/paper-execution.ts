/**
 * IndiaPaperExecutionEngine (spec §15, §25, §37, §48, §50). Paper fills are
 * real-market-price fills with an explicit slippage model (INDIA_SLIPPAGE_TICKS).
 * Positions are owned by exactly one engine (strategyOwner) and only that owner
 * can modify them. SL/TP are monitored intrabar on every real tick; positions
 * are closed on SL/TP, data staleness, expiry or end of session.
 */
import type {
  IndiaInstrument,
  IndiaMarketSessionInfo,
  IndiaOrder,
  IndiaOrderStatus,
  IndiaPaperAccount,
  IndiaPnL,
  IndiaPosition,
  IndiaSignal,
  IndiaTick,
  IndiaTrade,
  IndiaTradeExitReason,
} from '@fx/shared';
import {
  INDIA_CHANNELS,
  INDIA_COLLECTIONS,
  INDIA_REDIS_KEYS,
  INDIA_ORDER_STATUSES,
  INDIA_TRADE_EXIT_REASONS,
} from '@fx/shared';
import { DataStore } from '../db/store';
import { Cache } from '../db/cache';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { indiaConfig } from './config';
import { IndiaInstrumentService } from './instruments';
import { validateIndiaLotSize } from './lot-size';
import { expiryInstant } from './options-math';

export interface IndiaPnLInput {
  instrument: IndiaInstrument;
  side: 'BUY' | 'SELL';
  quantity: number;
  entryPrice: number;
  exitPrice: number;
  lotSize: number;
}

/** Indian P&L in INR with explicit charges (brokerage incl. an STT/exchange-
 *  levy allowance, plus exit-leg slippage — the ENTRY leg's slippage is already
 *  inside the filled entry price, never charged twice). */
export function computeIndiaPnL(input: IndiaPnLInput): IndiaPnL {
  const lots = input.quantity / Math.max(1, input.lotSize);
  const grossPnl = (input.exitPrice - input.entryPrice) * input.quantity * (input.side === 'BUY' ? 1 : -1);
  const brokerage = indiaConfig.commissionPerLotInr * lots;
  // Exit-leg slippage only: the entry leg was paid in the fill price.
  const slippageCost = indiaConfig.slippageTicks * input.instrument.tickSize * input.quantity;
  const charges = brokerage + slippageCost;
  return {
    entryPrice: input.entryPrice,
    exitPrice: input.exitPrice,
    quantity: input.quantity,
    lotSize: input.lotSize,
    grossPnl,
    charges,
    netPnl: grossPnl - charges,
    risk: 0,
    target: 0,
    margin: 0,
    capitalUsed: 0,
  };
}

export interface IndiaPaperExecutionOptions {
  /** Synchronous last-quote source. Used to refuse a fill when the live price
   *  has walked away from the signal's entry (spec §21 freshness). */
  ticks?: { lastTick(instrumentToken: string): IndiaTick | null };
  /** User's minimum-profit exit (§23 profit taking). When enabled, a position
   *  whose unrealized P&L reaches `targetInr` closes with reason PROFIT_TARGET.
   *  Read LIVE on every monitored tick so dashboard changes apply immediately. */
  minProfitExit?: () => { enabled: boolean; targetInr: number };
}

/** Portfolio-level concurrent exposure caps for ONE engine's book (spec §46).
 *  Sizing caps are per trade; without a book-level ceiling the universal engine
 *  stacked every fresh signal concurrently and total margin/risk grew far past
 *  the configured envelope. Each executing engine passes its own caps; they are
 *  enforced against that owner's open positions only. */
export interface IndiaPortfolioCaps {
  /** Maximum CONCURRENT open positions this engine may hold. */
  maxOpenPositions?: number;
  /** Maximum TOTAL estimated margin across this engine's open positions (INR). */
  maxConcurrentMarginInr?: number;
}

export interface IndiaExecutionRequest {
  owner: string;
  caps?: IndiaPortfolioCaps;
}

export class IndiaPaperExecutionEngine {
  private positions = new Map<string, IndiaPosition>();
  private account: IndiaPaperAccount = {
    accountId: 'india-paper-1',
    currency: 'INR',
    startingBalance: 100_000,
    balance: 100_000,
    equity: 100_000,
    margin: 0,
    freeMargin: 100_000,
    unrealizedPnl: 0,
    realizedPnl: 0,
    fees: 0,
    openPositionCount: 0,
    updatedAt: Date.now(),
  };

  constructor(
    private store: DataStore,
    private cache: Cache,
    private events: EventEmitter,
    private instruments: IndiaInstrumentService,
    private opts: IndiaPaperExecutionOptions = {},
  ) {}

  async init(): Promise<void> {
    try {
      // Load every snapshot once, then keep only the freshest row per position:
      // the pre-upsert persistence layer appended a new document on every save,
      // so one position could own several rows — an older OPEN copy next to a
      // newer CLOSED one. Loading `{status:'OPEN'}` blind resurrected closed
      // trades after every restart, and those ghosts were un-closable once
      // their contract aged out of the instrument master.
      const stored = await this.store.find<IndiaPosition>(INDIA_COLLECTIONS.positions, {});
      const freshest = new Map<string, IndiaPosition>();
      const freshness = (p: IndiaPosition): number =>
        p.closedAt ?? p.audit[p.audit.length - 1]?.timestamp ?? p.openedAt;
      for (const p of stored) {
        const prev = freshest.get(p.positionId);
        if (!prev || freshness(p) > freshness(prev)) freshest.set(p.positionId, p);
      }
      for (const p of freshest.values()) {
        if (p.status === 'OPEN') this.positions.set(p.positionId, p);
      }
      // Heal the legacy rows: anything still marked OPEN whose freshest state
      // says CLOSED is a stale append-only artifact — remove it so restarts
      // stay clean even before every old row has been rewritten.
      for (const [positionId, p] of freshest) {
        if (p.status !== 'CLOSED') continue;
        await this.store.deleteMany(INDIA_COLLECTIONS.positions, { positionId, status: 'OPEN' });
      }
    } catch {
      /* collection may not exist */
    }
    this.persistAccount();
  }

  getPosition(positionId: string): IndiaPosition | undefined {
    return this.positions.get(positionId);
  }

  openPositions(): IndiaPosition[] {
    // Closed rows stay in the map for their audit trail; only ever surface the
    // live ones — a closed position lingering in the list reads as "close
    // didn't work" in the UI.
    return [...this.positions.values()].filter((p) => p.status === 'OPEN');
  }

  accountSnapshot(): IndiaPaperAccount {
    return { ...this.account };
  }

  /** Fill a signal into a paper position (entry at real market price ± slippage). */
  async execute(signal: IndiaSignal, session: IndiaMarketSessionInfo, request: IndiaExecutionRequest): Promise<IndiaPosition | null> {
    const authority = typeof request === 'object' && request !== null ? request : { owner: String(request) };
    if (!session.marketOpen) {
      this.events.emit(INDIA_CHANNELS.reconciliation, { signalId: signal.signalId, reason: 'MARKET_CLOSED', detail: 'market closed — no execution' });
      return null;
    }
    if (authority.owner !== signal.owner) {
      this.events.emit(INDIA_CHANNELS.reconciliation, { signalId: signal.signalId, reason: 'AUTHORITY_BLOCKED', detail: `${authority.owner} owns execution, signal owner is ${signal.owner}` });
      return null;
    }
    const instrument = this.instruments.getByToken(signal.instrumentToken);
    if (!instrument || !instrument.tradable || instrument.status !== 'ACTIVE') return null;
    // An INDEX row is a price reference, not a tradable contract. It slipped
    // through every upstream gate once and paper-bought "Nifty Fin Service"
    // at ₹26,111 × 1 unit — the scan universe carries indices for chart
    // seeding, so the refusal has to live here, where money would move.
    if (instrument.contractType === 'INDEX') {
      this.events.emit(INDIA_CHANNELS.reconciliation, {
        signalId: signal.signalId,
        reason: 'INDEX_NOT_TRADABLE',
        detail: `${signal.tradingSymbol} is an index — refusing to execute`,
      });
      return null;
    }
    if (signal.quantity <= 0) return null;

    // ── Portfolio caps (spec §46) — enforced against the CALLING ENGINE's book
    // only, before anything else can admit the trade. Sizing caps are per trade;
    // these bound how many such trades may be open at once. -------------------
    const caps = authority.caps ?? {};
    const book = this.openPositions().filter((p) => p.strategyOwner === signal.owner);

    // 1) Same-instrument stacking: a re-entry on a contract already held by this
    //    engine doubles its risk on one thesis and once stacked four copies of
    //    the same NIFTY PE sell within minutes.
    if (book.some((p) => p.instrumentToken === signal.instrumentToken)) {
      this.events.emit(INDIA_CHANNELS.reconciliation, {
        signalId: signal.signalId,
        reason: 'SAME_INSTRUMENT_OPEN',
        detail: `${signal.tradingSymbol} already open for ${signal.owner} — no pyramiding`,
      });
      return null;
    }

    // 2) Concurrent position COUNT per engine.
    if (caps.maxOpenPositions !== undefined && book.length >= caps.maxOpenPositions) {
      this.events.emit(INDIA_CHANNELS.reconciliation, {
        signalId: signal.signalId,
        reason: 'PORTFOLIO_LIMIT',
        detail: `${signal.owner} holds ${book.length} open positions — cap is ${caps.maxOpenPositions}`,
      });
      return null;
    }

    // 3) TOTAL estimated margin per engine (same estimate the margin gate uses).
    // CE/PE: premium×qty on both sides for ₹5k paper trading (user request).
    if (caps.maxConcurrentMarginInr !== undefined) {
      const usedMargin = book.reduce((sum, p) => sum + this.estimateMargin(p), 0);
      const instrForCap = this.instruments.getByToken(signal.instrumentToken);
      let prospective: number;
      if (instrForCap?.contractType === 'OPT') {
        prospective = signal.quantity * signal.entry;
      } else {
        const capFactor = instrForCap?.marginRequirement ?? 0.15;
        prospective = signal.quantity * signal.entry * capFactor;
      }
      if (usedMargin + prospective > caps.maxConcurrentMarginInr) {
        this.events.emit(INDIA_CHANNELS.reconciliation, {
          signalId: signal.signalId,
          reason: 'MARGIN_BUDGET_EXHAUSTED',
          detail: `open margin ₹${Math.round(usedMargin)} + new ₹${Math.round(prospective)} > cap ₹${Math.round(caps.maxConcurrentMarginInr)}`,
        });
        return null;
      }
    }

    // Lot-size reference validation (spec §4): the broker master is
    // authoritative for calculation, but a mismatch against the configured
    // per-underlying expectation means the cached master is stale and the
    // contract must not be traded until it is refreshed.
    const lot = validateIndiaLotSize(instrument);
    if (!lot.ok) {
      this.events.emit(INDIA_CHANNELS.reconciliation, {
        signalId: signal.signalId,
        reason: 'LOT_SIZE_MISMATCH',
        detail: lot.reason ?? 'lot size mismatch',
      });
      return null;
    }

    // Signal-level sanity (spec §21): a signal whose protective levels are
    // already violated — a BUY with a stop at or above entry, or a non-positive
    // one — must never fill, whatever generated it.
    const levelsValid = signal.side === 'BUY'
      ? signal.stopLoss > 0 && signal.stopLoss < signal.entry && signal.target > signal.entry
      : signal.stopLoss > signal.entry && signal.target > 0 && signal.target < signal.entry;
    if (!levelsValid || !Number.isFinite(signal.entry) || signal.entry <= 0) {
      this.events.emit(INDIA_CHANNELS.reconciliation, {
        signalId: signal.signalId,
        reason: 'INVALID_LEVELS',
        detail: `entry=${signal.entry} sl=${signal.stopLoss} tp=${signal.target}`,
      });
      return null;
    }

    // Freshness: compare against the live quote when one exists. The analysis
    // behind a signal can be seconds old (cache TTL) or built from candles that
    // only move when the instrument is polled; an illiquid strike can sit out
    // several scans and then present a stale close as an entry. A fill that far
    // from the current price is not the trade the engine analysed.
    const liveTick = this.opts.ticks?.lastTick(signal.instrumentToken) ?? null;
    if (liveTick && Number.isFinite(liveTick.ltp) && liveTick.ltp > 0) {
      const drift = Math.abs(liveTick.ltp - signal.entry) / signal.entry;
      if (drift > indiaConfig.maxEntryDriftPct / 100) {
        this.events.emit(INDIA_CHANNELS.reconciliation, {
          signalId: signal.signalId,
          reason: 'PRICE_MOVED',
          detail: `entry ${signal.entry} vs live ${liveTick.ltp} (${(drift * 100).toFixed(1)}% > ${indiaConfig.maxEntryDriftPct}%)`,
        });
        return null;
      }
    }

    // One tick of slippage assumes the tick is small relative to price. On a
    // ₹0.85 premium with a ₹5 broker tick, "1 tick" was a 588% gap between the
    // requested and filled price. Cap the model at a fraction of the price.
    const rawSlippage = indiaConfig.slippageTicks * instrument.tickSize;
    const slippage = Math.min(rawSlippage, signal.entry * 0.002);
    // Fill at the LIVE market, not the stale signal price: a BUY that was
    // analysed at ₹100 but is now ₹101.90 (1.9% drift, inside the 2% band)
    // must not systematically book paper profits that cannot exist.
    const liveBase = liveTick && Number.isFinite(liveTick.ltp) ? liveTick.ltp : signal.entry;
    const fillPrice = signal.side === 'BUY' ? liveBase + slippage : liveBase - slippage;
    const positionId = randomUUID();
    const now = Date.now();

    const order: IndiaOrder = {
      orderId: randomUUID(),
      clientOrderId: `paper-${positionId}`,
      positionId,
      signalId: signal.signalId,
      goalId: signal.goalId ?? null,
      instrumentToken: signal.instrumentToken,
      tradingSymbol: signal.tradingSymbol,
      exchange: signal.exchange,
      segment: signal.segment,
      side: signal.side,
      quantity: signal.quantity,
      status: 'FILLED',
      requestedPrice: signal.entry,
      averagePrice: fillPrice,
      filledQuantity: signal.quantity,
      remainingQuantity: 0,
      createdAt: now,
      updatedAt: now,
      mode: 'PAPER',
      source: 'INDIA_PAPER_ENGINE',
    };

    const position: IndiaPosition = {
      positionId,
      strategyOwner: signal.owner,
      executionMode: signal.executionMode,
      goalId: signal.goalId ?? null,
      signalId: signal.signalId,
      instrumentToken: signal.instrumentToken,
      tradingSymbol: signal.tradingSymbol,
      underlying: signal.underlying,
      exchange: signal.exchange,
      segment: signal.segment,
      contractType: signal.contractType,
      side: signal.side,
      quantity: signal.quantity,
      entry: fillPrice,
      stopLoss: signal.stopLoss,
      target: signal.target,
      openedAt: now,
      closedAt: null,
      currentPrice: fillPrice,
      unrealizedPnl: 0,
      realizedPnl: 0,
      status: 'OPEN',
      exitReason: null,
      trailingStop: null,
      breakevenApplied: false,
      audit: [{ timestamp: now, action: 'OPEN', note: `paper fill ${fillPrice} (slippage ${slippage})` }],
    };

    // No capital/margin gate meant the ₹100k paper book could accumulate
    // margin many multiples of equity. Reject when the new position would
    // exceed free margin.
    const marginNeeded = this.estimateMargin(position);
    if (marginNeeded > this.account.freeMargin) {
      this.events.emit(INDIA_CHANNELS.reconciliation, {
        signalId: signal.signalId,
        reason: 'INSUFFICIENT_MARGIN',
        detail: `margin ₹${Math.round(marginNeeded)} > free ₹${Math.round(this.account.freeMargin)}`,
      });
      return null;
    }

    this.positions.set(positionId, position);
    this.account.margin += marginNeeded;
    this.account.openPositionCount += 1;
    this.updateAccount(now);

    await this.persistOrder(order);
    await this.persistPosition(position);
    this.events.emit(INDIA_CHANNELS.order, order);
    this.events.emit(INDIA_CHANNELS.position, position);
    this.events.emit(INDIA_CHANNELS.pnl, this.account);
    return position;
  }

  /** Intrabar SL/TP / trailing / breakeven monitoring on every real tick. */
  async monitor(tick: IndiaTick): Promise<Array<{ position: IndiaPosition; trade: IndiaTrade }>> {
    const closed: Array<{ position: IndiaPosition; trade: IndiaTrade }> = [];
    let updated = false;
    for (const position of this.positions.values()) {
      if (position.status !== 'OPEN' || position.instrumentToken !== tick.instrumentToken) continue;
      position.currentPrice = tick.ltp;
      position.unrealizedPnl = this.unrealized(position, tick.ltp);
      this.updateAccount(tick.receivedAt);
      updated = true;

      const exit = this.checkExits(position, tick);
      if (exit) {
        const result = await this.close(position, exit.price, exit.reason);
        if (result) closed.push(result);
        continue;
      }
      this.applyTrailing(position, tick);
      this.applyBreakeven(position);
      this.events.emit(INDIA_CHANNELS.position, { ...position });
    }
    // Push real-time account P&L on every tick that touched a position — the
    // previous code only emitted on execute/close, so the footer `Unrealized`
    // and the per-position `uPnL` (which the frontend derives from ticks) drifted
    // and the REST fallback made the UI appear ~10s behind the market.
    if (updated) {
      this.events.emit(INDIA_CHANNELS.pnl, this.accountSnapshot());
      this.persistAccount();
    }
    if (closed.length) this.persistAccount();
    return closed;
  }

  /** Close everything (end of session / stop). */
  async exitAll(reason: IndiaTradeExitReason, session?: IndiaMarketSessionInfo): Promise<Array<{ position: IndiaPosition; trade: IndiaTrade }>> {
    const closed: Array<{ position: IndiaPosition; trade: IndiaTrade }> = [];
    for (const position of this.positions.values()) {
      if (position.status !== 'OPEN') continue;
      const price = position.currentPrice ?? position.entry;
      const result = await this.close(position, price, reason);
      if (result) closed.push(result);
    }
    if (session && !session.marketOpen) {
      this.events.emit(INDIA_CHANNELS.reconciliation, { reason: 'EOD', detail: 'all positions closed at market close' });
    }
    return closed;
  }

  async close(position: IndiaPosition, exitPrice: number, reason: IndiaTradeExitReason): Promise<{ position: IndiaPosition; trade: IndiaTrade } | null> {
    if (position.status !== 'OPEN') return null;
    // The instrument master only holds ACTIVE contracts, so an expired or
    // delisted one disappears from it while its paper position may still be
    // open — and refusing to close for a missing lookup left that trade stuck
    // forever (the manual close route answered "already closed" for it). The
    // position row itself carries everything P&L needs; only tickSize / lot
    // sizing are unknown, so fall back to conservative defaults instead of
    // failing the exit.
    const instrument = this.instruments.getByToken(position.instrumentToken)
      ?? ({
        instrumentToken: position.instrumentToken,
        tradingSymbol: position.tradingSymbol,
        underlying: position.underlying,
        exchange: position.exchange,
        segment: position.segment,
        name: position.tradingSymbol,
        contractType: position.contractType,
        expiry: null,
        strike: null,
        optionType: null,
        // Treat the whole position as one lot so brokerage stays a flat charge;
        // a wrong lot split here cannot change gross P&L, only its fee model.
        lotSize: Math.max(1, position.quantity),
        tickSize: 0.05,
        freezeQuantity: null,
        status: 'ACTIVE',
        tradable: false,
      } satisfies IndiaInstrument);

    const pnl = computeIndiaPnL({
      instrument,
      side: position.side,
      quantity: position.quantity,
      entryPrice: position.entry,
      exitPrice,
      lotSize: instrument.lotSize,
    });

    const now = Date.now();
    position.status = 'CLOSED';
    position.closedAt = now;
    position.exitReason = reason;
    position.realizedPnl = pnl.netPnl;
    position.unrealizedPnl = 0;
    position.audit.push({ timestamp: now, action: 'CLOSE', note: `${reason} @ ${exitPrice} net ₹${Math.round(pnl.netPnl)}` });

    this.account.margin = Math.max(0, this.account.margin - this.estimateMargin(position));
    this.account.openPositionCount = Math.max(0, this.account.openPositionCount - 1);
    this.account.balance += pnl.netPnl;
    this.account.realizedPnl += pnl.netPnl;
    this.account.fees += pnl.charges;
    this.updateAccount(now);

    const trade: IndiaTrade = {
      tradeId: randomUUID(),
      positionId: position.positionId,
      signalId: position.signalId,
      goalId: position.goalId,
      instrumentToken: position.instrumentToken,
      tradingSymbol: position.tradingSymbol,
      underlying: position.underlying,
      side: position.side,
      quantity: position.quantity,
      lotSize: instrument.lotSize,
      entryPrice: position.entry,
      exitPrice,
      grossPnl: pnl.grossPnl,
      charges: pnl.charges,
      netPnl: pnl.netPnl,
      // Was hardcoded to 0, which threw away the only record of what the position
      // was sized to risk — so afterwards there was no way to ask whether the
      // engine's stops were where it thought they were. The position carries the
      // levels; the risk is the distance to them, in rupees.
      riskInr: Math.abs(position.entry - position.stopLoss) * position.quantity,
      targetInr: Math.abs(position.target - position.entry) * position.quantity,
      marginInr: this.estimateMargin(position),
      capitalUsedInr: position.quantity * position.entry,
      exitReason: reason,
      openedAt: position.openedAt,
      closedAt: now,
      strategy: null,
      owner: position.strategyOwner,
      // Captured now, not looked up later: the instrument master only holds
      // ACTIVE contracts, so a weekly option is gone from it within days and the
      // DTE segmentation in performance analytics would have nothing to read.
      contractType: instrument.contractType,
      optionType: instrument.optionType,
      strike: instrument.strike,
      expiry: instrument.expiry,
    };

    await this.persistPosition(position);
    await this.persistTrade(trade);
    this.persistAccount();
    this.events.emit(INDIA_CHANNELS.position, { ...position });
    this.events.emit(INDIA_CHANNELS.pnl, this.account);
    this.events.emit(INDIA_CHANNELS.order, { positionId: position.positionId, tradeId: trade.tradeId, reason });
    return { position, trade };
  }

  /**
   * Long-running position maintenance: expiry + staleness (engine timer).
   *
   * `staleThresholdMs` is provided by the driver: it must scale with the tick
   * source's effective cadence (REST-poll backoff included). The default keeps
   * the historical behaviour; a caller that knows the poll is currently waiting
   * longer than usual passes a wider window so a throttle never reads as
   * "data dead — liquidate".
   */
  async maintenance(
    now: number,
    lastTickAt: number | null,
    staleThresholdMs = indiaConfig.tickStaleMs * 2,
  ): Promise<Array<{ position: IndiaPosition; trade: IndiaTrade }>> {
    const closed: Array<{ position: IndiaPosition; trade: IndiaTrade }> = [];
    for (const position of this.positions.values()) {
      if (position.status !== 'OPEN') continue;
      const instrument = this.instruments.getByToken(position.instrumentToken);
      if (instrument?.expiry && now > expiryInstant(instrument.expiry)) {
        const c = await this.close(position, position.currentPrice ?? position.entry, 'EXPIRY');
        if (c) closed.push(c);
        continue;
      }
      if (lastTickAt !== null && now - lastTickAt > staleThresholdMs) {
        const c = await this.close(position, position.currentPrice ?? position.entry, 'DATA_STALE');
        if (c) closed.push(c);
      }
    }
    return closed;
  }

  // ---------------------------------------------------------------------------

  private checkExits(position: IndiaPosition, tick: IndiaTick): { price: number; reason: IndiaTradeExitReason } | null {
    // ── User's minimum-profit exit (§23): the dashboard's "min profit" value is
    // a live take-profit on the WHOLE position in ₹. Read per tick so changing
    // the setting applies to open positions immediately. Runs BEFORE the level
    // checks — it is the user's explicit instruction, not a strategy artifact.
    const mp = this.opts.minProfitExit?.();
    if (mp?.enabled && position.unrealizedPnl >= mp.targetInr && mp.targetInr > 0) {
      return { price: tick.ltp, reason: 'PROFIT_TARGET' };
    }
    // Gaps: a stop is a market order — if price jumped through the stop,
    // the fill is the worse side (ltp), not exactly the stop price.
    // Targets are limit orders, filled at the target (optimistic but conventional).
    if (position.side === 'BUY') {
      if (tick.ltp <= position.stopLoss) return { price: Math.min(position.stopLoss, tick.ltp), reason: 'STOP_LOSS' };
      if (tick.ltp >= position.target) return { price: position.target, reason: 'TARGET_REACHED' };
    } else {
      if (tick.ltp >= position.stopLoss) return { price: Math.max(position.stopLoss, tick.ltp), reason: 'STOP_LOSS' };
      if (tick.ltp <= position.target) return { price: position.target, reason: 'TARGET_REACHED' };
    }
    return null;
  }

  private applyTrailing(position: IndiaPosition, tick: IndiaTick): void {
    const instrument = this.instruments.getByToken(position.instrumentToken);
    if (!instrument) return;
    const riskPerUnit = Math.abs(position.entry - position.stopLoss);
    if (!(riskPerUnit > 0)) return;
    const profitPerUnit = position.side === 'BUY' ? tick.ltp - position.entry : position.entry - tick.ltp;
    if (profitPerUnit >= riskPerUnit * 1.5) {
      const trail = position.side === 'BUY' ? tick.ltp - riskPerUnit * 0.5 : tick.ltp + riskPerUnit * 0.5;
      // Ratchet only: a trailing stop must never loosen (profit oscillation
      // previously moved BUY stops DOWN and SELL stops UP).
      const nextStop = position.side === 'BUY' ? Math.max(position.stopLoss, trail) : Math.min(position.stopLoss, trail);
      if (nextStop === position.stopLoss) return;
      position.stopLoss = nextStop;
      position.trailingStop = nextStop;
      position.audit.push({ timestamp: tick.receivedAt, action: 'TRAIL', note: `trailing SL → ${nextStop}` });
    }
  }

  private applyBreakeven(position: IndiaPosition): void {
    // Breakeven at 1R would otherwise always fire before the 1.5R trailing
    // stop and then block it forever via `breakevenApplied`. Let trailing
    // supersede breakeven: once a trailing stop exists it already locks more.
    if (position.breakevenApplied || position.trailingStop !== null) return;
    const riskPerUnit = Math.abs(position.entry - position.stopLoss);
    if (!(riskPerUnit > 0)) return;
    const profitPerUnit = position.side === 'BUY'
      ? (position.currentPrice ?? position.entry) - position.entry
      : position.entry - (position.currentPrice ?? position.entry);
    // Only up to the trailing activation point — beyond 1.5R the trailing
    // stop is the intended mechanism.
    if (profitPerUnit >= riskPerUnit && profitPerUnit < riskPerUnit * 1.5) {
      position.stopLoss = position.entry;
      position.breakevenApplied = true;
      position.audit.push({ timestamp: Date.now(), action: 'BREAKEVEN', note: 'SL moved to entry' });
    }
  }

  private unrealized(position: IndiaPosition, price: number): number {
    return (price - position.entry) * position.quantity * (position.side === 'BUY' ? 1 : -1);
  }

  private estimateMargin(position: IndiaPosition): number {
    const instrument = this.instruments.getByToken(position.instrumentToken);
    const factor = instrument?.marginRequirement ?? 0.15;
    if (!instrument) return position.quantity * position.entry * factor;
    // CE/PE: premium×qty on both sides for ₹5k paper trading (user request).
    if (instrument.contractType === 'OPT') {
      return position.quantity * position.entry;
    }
    return position.quantity * position.entry * factor;
  }

  private updateAccount(now: number): void {
    let unrealized = 0;
    for (const p of this.positions.values()) {
      if (p.status === 'OPEN') unrealized += p.unrealizedPnl;
    }
    this.account.unrealizedPnl = unrealized;
    this.account.equity = this.account.balance + unrealized;
    this.account.freeMargin = this.account.equity - this.account.margin;
    this.account.updatedAt = now;
  }

  private persistAccount(): void {
    this.cache
      .set(INDIA_REDIS_KEYS.market + 'paper-account', JSON.stringify(this.account), 86_400_000)
      .catch(() => undefined);
  }

  private async persistOrder(order: IndiaOrder): Promise<void> {
    try {
      await this.store.insertOne(INDIA_COLLECTIONS.orders, order);
    } catch {
      /* best-effort */
    }
  }

  private async persistPosition(position: IndiaPosition): Promise<void> {
    try {
      // Upsert, not append: the position row is a living document whose latest
      // state is the only truth. insertOne piled up a fresh copy on every save
      // — and the stale OPEN copies resurrected the position on every restart.
      await this.store.updateOne(
        INDIA_COLLECTIONS.positions,
        { positionId: position.positionId },
        { $set: position as unknown as Record<string, unknown> },
        true,
      );
    } catch {
      /* best-effort */
    }
  }

  private async persistTrade(trade: IndiaTrade): Promise<void> {
    try {
      await this.store.insertOne(INDIA_COLLECTIONS.trades, trade);
    } catch {
      /* best-effort */
    }
  }
}

export const indiaOrderStatuses = INDIA_ORDER_STATUSES;
export const indiaTradeExitReasons = INDIA_TRADE_EXIT_REASONS;