/**
 * Paper trading engine. Runs a virtual account on REAL market prices (never
 * executes real money). Opens positions when signal entries are reached,
 * tracks SL/TP/swap/fees, closes on SL/TP and records complete trades.
 */
import {
  ForexSession, PaperAccount, PaperOrder, PaperPosition, PaperTrade, Signal, TermsProvenance, Tick, UserSettings,
} from '@fx/shared';
import { effectiveCommissionUsdPerLot } from '../broker/cost-registry';
import { applySlippage, rollWindow, dayWindowKey, weekWindowKey } from '../math/paperMath';
import { assetClassFor, cryptoFundingPerDay, getAsset, priceToPips, roundLot, ALL_SYMBOLS, pipsToPrice, INR_RATE_SYMBOL } from '@fx/shared';
import { computeTrailingStop } from './trailingStopEngine';
import { sizePosition } from './positionSizingEngine';
import { FxContext, CHANNELS } from '../core/context';
import { logger } from '../core/logger';
import { SignalEngine } from './signalEngine';
import { MarketDataEngine } from './marketDataEngine';
import { primarySession, isWeekendGapRiskWindow } from './sessionEngine';
import { pnlForPosition, accountQuoteRate } from '../math/forexMath';
import { CurrencyConversionService } from '../forex/currency-conversion';
import { pipValueQuote, pipSize as fxPipSize, requiredMargin } from '../forex/pip-margin';
import { effectiveSpec } from '../forex/symbol-spec';
import { computeDynamicLots } from '../forex/dynamic-sizing';
import { config } from '../config';

export class PaperTradingEngine {
  private account: PaperAccount | null = null;
  private openPositions = new Map<string, PaperPosition>();
  private settings: UserSettings | null = null;
  private settingsLoadedAt = 0;
  /** Last CHANNELS.position emit per symbol — P&L updates stream to the UI at
   *  ~1 Hz instead of once per tick (thousands of socket messages/min). */
  private lastPosEmit = new Map<string, number>();
  /**
   * Synchronous idempotency guard: signal ids with an openPosition call
   * currently executing. Closes the check-then-insert TOCTOU window between
   * two concurrent entry paths (auto tick-driven + manual execute) that the
   * async store lookup alone cannot cover.
   */
  private inFlightSignals = new Set<string>();
  /** Last account persist/broadcast (1 Hz throttle — the tick loop used to
   *  write the whole account doc + socket broadcast on EVERY tick). */
  private lastAccountBroadcastAt = 0;
  /**
   * Quote→account (INR) conversion over LIVE rates only. Every money-path
   * conversion in this engine goes through it: results carry the rate and its
   * timestamp, a feed gap degrades to a flagged last-known-good value, and a
   * never-seen rate fails closed instead of mispricing by orders of magnitude.
   */
  readonly fx: CurrencyConversionService;

  constructor(
    private ctx: FxContext,
    private marketData: MarketDataEngine,
    private signalEngine: SignalEngine,
    /**
     * Supplies the broker trading terms a position/trade was executed under.
     * Wired lazily from the container (the account binding is built after this
     * engine), and optional so tests and standalone use keep working.
     */
    private providers: { termsProvenance?: (symbol: string) => TermsProvenance | null } = {},
  ) {
    this.fx = new CurrencyConversionService(
      (symbol) => {
        const t = this.marketData.getLatest(symbol);
        if (!t) return undefined;
        // Feed LIVENESS (last successful poll/receive), not the quote's own
        // timestamp: a flat rate re-polled every 10s is a fresh observation
        // of the same price, not a stale one.
        const contact = this.marketData.lastFeedContact(symbol) ?? t.receivedAt ?? t.timestamp;
        return { mid: t.mid, source: t.source, timestamp: contact, receivedAt: contact };
      },
      { maxAgeMs: Math.max(120_000, config.staleTickMs * 4) },
    );
  }

  /** True when quote→account conversion is FRESH for a symbol (§26 gate).
   *  Per-symbol: a USD account still needs a REAL JPY→USD rate for JPY-quoted
   *  pairs — declaring those "fresh" at parity let unconverted JPY P&L leak
   *  into the USD book. */
  conversionFresh(symbol: string): boolean {
    try {
      const acctCcy = this.account?.currency ?? 'USD';
      const q = getAsset(symbol).quoteCurrency;
      const identity = acctCcy === q || (q === 'USDT' && acctCcy === 'USD');
      if (identity) return true;
      return this.fx.hasFresh(q, acctCcy);
    } catch {
      return false;
    }
  }

  /**
   * Money-path conversion wrappers (§26 semantics).
   *
   * A conversion that has NEVER had a usable rate throws deep inside the fx
   * service; the tick loop must survive that. Marking degrades to the raw
   * quote amount at rate 1 with an explicit STALE flag (never presented as
   * ₹ truth), while EXECUTION is separately blocked by conversionFresh()
   * until a real rate exists. Nothing is silently faked: the position carries
   * convStale=true and entries/exits that need honest rupees are refused.
   */
  private convQuote(symbol: string, acctCcy: string, quoteAmount: number): {
    amount: number; rate: number; stale: boolean; ts: number; src: string;
  } {
    // True identity ONLY when the pair's quote currency IS the account
    // currency (e.g. EUR/USD on a USD account). The old blanket
    // `acctCcy === 'USD'` fast path skipped JPY→USD conversion entirely and
    // booked USD/JPY P&L ~157× too large on the USD book.
    try {
      const q = getAsset(symbol).quoteCurrency;
      const identity = acctCcy === q || (q === 'USDT' && acctCcy === 'USD');
      if (identity) return { amount: quoteAmount, rate: 1, stale: false, ts: Date.now(), src: 'identity' };
    } catch {
      // unknown symbol: fall through to the fx service
    }
    try {
      const r = this.fx.quoteToAccount(symbol, acctCcy, quoteAmount);
      return { amount: r.amount, rate: r.rate, stale: r.stale, ts: r.rateTimestamp, src: r.source };
    } catch {
      return { amount: quoteAmount, rate: 1, stale: true, ts: 0, src: 'UNAVAILABLE' };
    }
  }

  private convUsd(acctCcy: string, usdAmount: number): number {
    if (acctCcy === 'USD') return usdAmount;
    try {
      return this.fx.usdToAccount(acctCcy, usdAmount).amount;
    } catch {
      return usdAmount; // flagged stale upstream via conversionFresh gating
    }
  }

  /**
   * Open positions with the canonical forex view refreshed at read time
   * (§16/§28). REST consumers get exactly what the socket stream carries.
   */
  enrichedOpenPositions(): PaperPosition[] {
    if (!this.account) return [];
    const acctCcy = this.account.currency ?? 'USD';
    return [...this.openPositions.values()].map((p) => {
      this.markPosition(p, acctCcy);
      return p;
    });
  }

  /** Canonical single-amount conversion for display endpoints (§20). */
  convert(amount: number, from: string, to: string) {
    try {
      const r = this.fx.convert(amount, from, to);
      return { amount: r.amount, rate: r.rate, stale: r.stale, rateTimestamp: r.rateTimestamp, source: r.source };
    } catch {
      return null;
    }
  }

  /**
   * § margin engine: required margin in ACCOUNT currency for ONE lot of
   * `symbol` at the current price, over the live broker spec (contract size,
   * min/max/step from symbol_info) and the bound account's leverage. This is
   * the single pricing point the sizing engine and every entry gate reuse —
   * one number, one truth, never two divergent margin models. Returns null
   * when margin cannot be honestly priced (no quote, stale conversion).
   */
  marginPerLot(symbol: string, direction: 'BUY' | 'SELL' = 'BUY'): number | null {
    if (!this.account || assetClassFor(symbol) !== 'FOREX') return null;
    const tick = this.marketData.getLatest(symbol);
    if (!tick || !Number.isFinite(tick.mid) || tick.mid <= 0) return null;
    const entry = direction === 'BUY' ? (tick.ask ?? tick.mid) : (tick.bid ?? tick.mid);
    const spec = effectiveSpec(symbol);
    if (!(spec.contractSize > 0) || !(entry > 0)) return null;
    const marginRate = spec.marginRequirement > 0 ? spec.marginRequirement : (getAsset(symbol).marginRequirement || 0);
    if (!(marginRate > 0)) return null; // unknown while unbound — callers must treat as unpriceable
    const notionalQuote = spec.contractSize * entry;
    const m = this.fx.quoteToAccount(symbol, this.account.currency ?? 'USD', notionalQuote * marginRate);
    return m.amount > 0 ? m.amount : null;
  }

  /**
   * Dynamic lot sizing for one candidate trade (spec §1–§8/§11–§13) against
   * the LIVE wallet — balance/equity/freeMargin are read at call time, never
   * carried over from a previous trade. Returns null for non-forex symbols
   * (crypto keeps its own sizing model untouched).
   */
  dynamicLotBreakdown(
    symbol: string,
    entryPrice: number,
    stopLossPrice: number,
  ): import('../forex/dynamic-sizing').LotBreakdown | null {
    if (!this.account || assetClassFor(symbol) !== 'FOREX') return null;
    return computeDynamicLots({
      symbol,
      accountCurrency: this.account.currency ?? 'USD',
      balanceAccount: this.account.balance,
      equityAccount: this.account.equity,
      usedMarginAccount: this.account.margin,
      allocatedAccount: this.settings?.availableCapital ?? this.account.startingBalance,
      maxMarginPercent: this.settings?.maxMarginUsedPct ?? 0,
      // Risk cap for THIS trade = allocation × risk% (INR-native).
      maxRiskAccount: (this.settings?.availableCapital ?? 0) * ((this.settings?.maxRiskPercent ?? 0) / 100),
      entryPrice,
      stopLossPrice,
      direction: 'BUY',
      fx: this.fx,
      userMaxLots: undefined,
    });
  }

  /** Settings are cached (a tick path must stay light) and refreshed on a TTL. */
  private async loadSettingsCached(): Promise<UserSettings> {
    if (this.settings && Date.now() - this.settingsLoadedAt < 60_000) return this.settings;
    this.settings = await this.signalEngine.loadSettings();
    this.settingsLoadedAt = Date.now();
    return this.settings;
  }

  /** Refresh the cached settings NOW — the settings PUT calls this when the
   *  symbol lock changes, so the gate reacts in realtime (no 60 s TTL wait). */
  refreshSettingsCache(): void {
    this.settingsLoadedAt = 0;
  }

  async init(settings: UserSettings): Promise<PaperAccount> {
    this.settings = settings;
    this.settingsLoadedAt = Date.now();
    const stored = await this.ctx.store.findOne<PaperAccount>('paperAccounts', {});
    if (stored) {
      this.account = stored;
      // Normalize accounts created before the risk-state fields existed.
      this.account.consecutiveLosses ??= 0;
      this.account.dailyPnlResetAt ??= 0;
      this.account.weeklyPnlResetAt ??= 0;
    } else {
      this.account = {
        accountId: crypto.randomUUID(),
        userId: null,
        currency: settings.accountCurrency ?? 'USD',
        startingBalance: settings.paperStartingCapital,
        balance: settings.paperStartingCapital,
        equity: settings.paperStartingCapital,
        margin: 0,
        freeMargin: settings.paperStartingCapital,
        leverage: 0,
        unrealizedPnl: 0,
        realizedPnl: 0,
        fees: 0,
        maxDrawdownPct: 0,
        dailyPnl: 0,
        weeklyPnl: 0,
        consecutiveLosses: 0,
        dailyPnlResetAt: 0,
        weeklyPnlResetAt: 0,
        openPositionCount: 0,
        updatedAt: Date.now(),
      };
      await this.ctx.store.insertOne('paperAccounts', this.account);
    }
    // reload open positions
    const open = await this.ctx.store.find<PaperPosition>('paperPositions', { status: 'OPEN' });
    for (const p of open) {
      // Normalize positions created before partial-TP fields existed (Phase 17).
      p.entryLots ??= p.lots;
      p.breakevenApplied ??= false;
      this.openPositions.set(p.id, p);
    }
    this.account.openPositionCount = this.openPositions.size;
    return this.account;
  }

  getAccount(): PaperAccount | null {
    return this.account;
  }

  /** Re-read OPEN positions from the store into the live map (restart-orphan
   *  repair: MT5 reconciliation may close a position whose paper row is still
   *  flagged OPEN; a close call then 404s forever without this refresh). */
  async reloadOpenPositions(): Promise<void> {
    const open = await this.ctx.store.find<PaperPosition>('paperPositions', { status: 'OPEN' });
    this.openPositions.clear();
    for (const p of open) {
      p.entryLots ??= p.lots;
      p.breakevenApplied ??= false;
      this.openPositions.set(p.id, p);
    }
    if (this.account) this.account.openPositionCount = this.openPositions.size;
  }

  /**
   * Resets the paper wallet to the current settings (currency + capital) —
   * used when the user switches account currency or starting capital. Open
   * positions are closed as CANCELLED so history stays consistent.
   */
  async reinitAccount(): Promise<PaperAccount> {
    const settings = await this.signalEngine.loadSettings();
    for (const pos of this.openPositions.values()) {
      await this.closePosition(pos, pos.currentPrice ?? pos.entryPrice, 'MANUAL').catch(() => undefined);
    }
    this.account = {
      accountId: crypto.randomUUID(),
      userId: null,
      currency: settings.accountCurrency ?? 'USD',
      startingBalance: settings.paperStartingCapital,
      balance: settings.paperStartingCapital,
      equity: settings.paperStartingCapital,
      margin: 0,
      freeMargin: settings.paperStartingCapital,
      leverage: 0,
      unrealizedPnl: 0,
      realizedPnl: 0,
      fees: 0,
      maxDrawdownPct: 0,
      dailyPnl: 0,
      weeklyPnl: 0,
      consecutiveLosses: 0,
      dailyPnlResetAt: 0,
      weeklyPnlResetAt: 0,
      openPositionCount: 0,
      updatedAt: Date.now(),
    };
    await this.ctx.store.updateOne('paperAccounts', {}, { $set: { ...this.account } as never }, true);
    this.settings = settings;
    this.settingsLoadedAt = Date.now();
    this.ctx.events.emit(CHANNELS.risk, this.account);
    return this.account;
  }

  getOpenPositions(): PaperPosition[] {
    return [...this.openPositions.values()];
  }

  async openPosition(
    signal: Signal,
    lots: number,
    fillPrice: number,
    atr?: number,
    opts: { slippageBps?: number; targetProfit?: number } = {},
  ): Promise<PaperPosition | null> {
    if (!this.account) return null;
    // ---- Symbol lock (XM/MT5 pattern) -------------------------------------
    // When the user locks the platform to one symbol (e.g. XAU/USD), NO entry
    // — auto or manual, paper or MT5-mirrored — may open for any other symbol.
    // MT5 dispatch inherits this: mirror commands are only created from
    // positions that passed this gate.
    {
      const s = await this.loadSettingsCached();
      const lock = (s.symbolLock ?? '').toUpperCase() || null;
      if (lock && signal.symbol.toUpperCase() !== lock) {
        logger.info('entry refused: symbol lock', { locked: lock, symbol: signal.symbol, signalId: signal.id });
        return null;
      }
    }
    // ---- Duplicate-order protection (spec §71/§123) ----------------------
    // One FILLED order + one position per signalId — even across restarts or
    // double-fired entry events. clientOrderId = signalId is the idempotency
    // key; the same signal can never be opened twice.
    //
    // The guard is SYNCHRONOUS first (in-flight set): two concurrent callers
    // (auto entry + manual "Trade now") both used to pass the async store
    // lookup before either inserted, producing two FILLED orders / positions.
    if (this.inFlightSignals.has(signal.id)) return null;
    this.inFlightSignals.add(signal.id);
    try {
      const existingOrder = await this.ctx.store.findOne<PaperOrder>('paperOrders', { signalId: signal.id, status: 'FILLED' });
      if (existingOrder) {
        const existingPos = await this.ctx.store.findOne<PaperPosition>('paperPositions', { signalId: signal.id });
        if (existingPos) {
          this.openPositions.set(existingPos.id, existingPos);
          return existingPos;
        }
        return null;
      }
      // Re-check under the synchronous guard right before the writes: a
      // concurrent call that started before us may have finished while we
      // awaited above.
      const racedOrder = await this.ctx.store.findOne<PaperOrder>('paperOrders', { signalId: signal.id, status: 'FILLED' });
      if (racedOrder) {
        const existingPos = await this.ctx.store.findOne<PaperPosition>('paperPositions', { signalId: signal.id });
        return existingPos ?? null;
      }
      const asset = getAsset(signal.symbol);
      const bps = opts.slippageBps ?? 0;
      // Spec §40-41: never a perfect execution — BUY fills above the ask,
      // SELL below the bid by the configured slippage. XM/MT5 semantics: a
      // fill prints at the broker's price precision — slippage never creates
      // a ninth-decimal price that no terminal would display.
      const execPrice = Number(applySlippage(signal.direction, fillPrice, bps).toFixed(asset.pricePrecision));
      const id = crypto.randomUUID();
      const position: PaperPosition = {
        id,
        signalId: signal.id,
        symbol: signal.symbol,
        direction: signal.direction,
        lots,
        entryLots: lots,
        entryPrice: execPrice,
        stopLoss: signal.stopLoss.price,
        // Original risk anchor — R-multiples and trade `rr` are always measured
        // against the stop the trade was planned with, never a trailed one.
        initialStopLoss: signal.stopLoss.price,
        // 0 is the disabled sentinel across the codebase (TakeProfitPlan.tp*);
        // normalize to null so the exit loop can never fire "ask >= 0" and
        // close a position at price 0.
        takeProfit1: signal.takeProfit.tp1 > 0 ? signal.takeProfit.tp1 : null,
        takeProfit2: signal.takeProfit.tp2 > 0 ? signal.takeProfit.tp2 : null,
        openTime: Date.now(),
        currentPrice: execPrice,
        // Position-anchored Chandelier seed (CEZLSMA adoption): the swing
        // window starts at entry; onTick ratchets it with every fresh tick.
        swingExtreme: { high: execPrice, low: execPrice },
        unrealizedPnl: 0,
        fees: 0,
        swap: 0,
        durationMs: 0,
        status: 'OPEN',
        atr: atr && atr > 0 ? atr : undefined,
        // Spec §38: the configured minimum net profit (₹) — the auto-exit goal.
        targetProfit: opts.targetProfit && opts.targetProfit > 0 ? opts.targetProfit : undefined,
        // Prediction-vs-reality record (spec §48): the signal state at entry.
        confidence: signal.confidence,
        probability: signal.probability,
        expectedValue: signal.expectedValue.evPerTrade,
        strategy: signal.strategy,
        strategyVersion: signal.strategyVersion,
        modelVersion: signal.modelVersion,
        featureVersion: signal.featureVersion,
        indicatorVersion: signal.indicatorVersion,
        configurationVersion: signal.configurationVersion,
        slippageBps: bps,
        // Terms provenance at ENTRY: the account type and the exact numbers
        // (with their evidence) this position was sized and costed on.
        terms: this.providers.termsProvenance?.(signal.symbol) ?? undefined,
      };
      this.openPositions.set(id, position);
      await this.ctx.store.insertOne('paperPositions', position);
      await this.ctx.store.insertOne('paperOrders', {
        id: crypto.randomUUID(),
        clientOrderId: signal.id,
        signalId: signal.id,
        symbol: signal.symbol,
        direction: signal.direction,
        status: 'FILLED',
        requestedPrice: fillPrice,
        fillPrice: execPrice,
        lots,
        createdAt: Date.now(),
        filledAt: Date.now(),
      });
      this.account.openPositionCount = this.openPositions.size;
      await this.updateAccount({ force: true });
      this.ctx.events.emit(CHANNELS.position, position);
      return position;
    } finally {
      this.inFlightSignals.delete(signal.id);
    }
  }

  /**
   * Manual paper trade (user-initiated). Same fill, slippage, fees, risk gates
   * and SL/TP management as automatic signal entries — the position is stored
   * with the normal lifecycle and managed by onTick. No signal is created; the
   * synthetic signal id doubles as the order idempotency key.
   */
  async openManual(
    symbol: string,
    direction: 'BUY' | 'SELL',
    opts: { lots?: number; sl?: number; tp?: number; slippageBps?: number } = {},
  ): Promise<{ ok: boolean; reason: string; position?: PaperPosition }> {
    if (!ALL_SYMBOLS.includes(symbol)) return { ok: false, reason: `unknown symbol ${symbol}` };
    // Symbol lock: a manual attempt outside the locked symbol is refused with a
    // clear reason (the engine gate below would silently drop it otherwise).
    {
      const s = await this.loadSettingsCached();
      const lock = (s.symbolLock ?? '').toUpperCase() || null;
      if (lock && symbol.toUpperCase() !== lock) {
        return { ok: false, reason: `symbol lock active — trading is confined to ${lock}` };
      }
    }
    if (!this.account) return { ok: false, reason: 'paper account not initialised' };
    const settings = await this.loadSettingsCached();
    const tick = this.marketData.getLatest(symbol);
    if (!tick || !Number.isFinite(tick.mid)) return { ok: false, reason: `no live quote for ${symbol}` };
    // Never fill on an arbitrarily old quote (weekend gap, dead provider): the
    // automatic paths gate staleness via data quality; manual entries must too,
    // or a Friday-night click opens a position at Friday prices with no market.
    const feedContact = this.marketData.lastFeedContact(symbol) ?? tick.receivedAt ?? tick.timestamp;
    if (!Number.isFinite(feedContact) || Date.now() - feedContact > config.staleTickMs * 4) {
      return { ok: false, reason: `quote for ${symbol} is stale — trading paused until the feed recovers` };
    }
    // §26: a stale quote→account conversion must never price an entry. The
    // position would fill at a ₹ value the engine cannot honestly mark.
    if (!this.conversionFresh(symbol)) {
      return { ok: false, reason: 'INR conversion STALE — entries paused until the conversion feed recovers' };
    }
    const fill = direction === 'BUY' ? (tick.ask ?? tick.mid) : (tick.bid ?? tick.mid);
    const asset = getAsset(symbol);

    // Sensible defaults when the user does not specify SL/TP: 50 pips for
    // forex, 2 % for crypto, target at 2 R.
    const isCrypto = assetClassFor(symbol) === 'CRYPTO';
    const sl = opts.sl ?? (direction === 'BUY'
      ? (isCrypto ? fill * 0.98 : fill - pipsToPrice(symbol, 50))
      : (isCrypto ? fill * 1.02 : fill + pipsToPrice(symbol, 50)));
    const risk = Math.abs(fill - sl);
    const tp = opts.tp ?? (direction === 'BUY' ? fill + 2 * risk : fill - 2 * risk);
    if (direction === 'BUY' && sl >= fill) return { ok: false, reason: 'SL must be below entry for BUY' };
    if (direction === 'SELL' && sl <= fill) return { ok: false, reason: 'SL must be above entry for SELL' };
    if (direction === 'BUY' && tp <= fill) return { ok: false, reason: 'TP must be above entry for BUY' };
    if (direction === 'SELL' && tp >= fill) return { ok: false, reason: 'TP must be below entry for SELL' };

    // Sizing: explicit lots are honoured within lot/leverage constraints;
    // otherwise the account's risk % per trade is used.
    let lots = opts.lots;
    if (lots !== undefined) {
      lots = roundLot(symbol, lots);
      if (lots < asset.minimumLot) return { ok: false, reason: `lots below minimum ${asset.minimumLot}` };
      if (lots > asset.maximumLot) return { ok: false, reason: `lots above maximum ${asset.maximumLot}` };
      const leverageUsed = (lots * asset.contractSize * fill) / Math.max(1, settings.availableCapital);
      if (leverageUsed > settings.maxLeverage) return { ok: false, reason: `leverage ${leverageUsed.toFixed(1)} exceeds max ${settings.maxLeverage}` };
    } else {
      // AUTO sizing — Forex uses the dynamic engine: largest lot valid under
      // live free-margin, allocation × max-margin%, risk cap vs SL distance,
      // broker min/max/step. Crypto keeps its own model untouched.
      if (assetClassFor(symbol) === 'FOREX') {
        const dyn = this.dynamicLotBreakdown(symbol, fill, sl);
        if (!dyn || !dyn.valid) return { ok: false, reason: dyn?.reason ?? 'position could not be sized' };
        lots = dyn.finalLots;
      } else {
        const walletCcy = this.account?.currency ?? settings.accountCurrency ?? 'USD';
        const sizing = sizePosition({
          symbol, entryPrice: fill, stopLossPrice: sl, settings,
          usdRate: accountQuoteRate(symbol, walletCcy, (s) => this.marketData.getLatest(s)?.mid),
          walletCurrency: walletCcy,
        });
        if (!sizing.valid) return { ok: false, reason: sizing.reason };
        lots = sizing.lots;
      }
    }

    // Same fill-time safety gate as automatic entries (daily loss, drawdown,
    // max positions, correlated exposure, circuit breakers).
    const id = crypto.randomUUID();
    const now = Date.now();
    const synthetic: Signal = {
      id, signalId: id, symbol, direction,
      state: 'POSITION_ACTIVE', decision: direction,
      // The user's EXACT lot rides as plannedLots so the fill-time gate
      // validates THIS size (margin/risk/step against live broker specs) —
      // without it the gate re-sized the trade from the SL distance and
      // rejected manual 0.10-lot trades while proposing ~40-lot margins.
      plannedLots: lots ?? 0,
      timestamp: now, expiresAt: now + 86_400_000, updatedAt: now, price: fill,
      entry: { entryMin: fill, entryMax: fill, preferredEntry: fill, status: 'READY', reason: 'manual trade', entryType: 'MARKET' },
      stopLoss: { price: sl, pips: Math.abs(priceToPips(symbol, fill - sl)), basis: 'manual' },
      takeProfit: { tp1: tp, tp2: tp, tp3: null, rr1: 2, rr2: 2, rr3: null },
      confidence: 0.5, probability: 0.5,
      risk: { symbol, timestamp: now, level: 'YELLOW', score: 0, components: {}, critical: [], blocked: false },
      expectedValue: {
        evPerTrade: 0, evPerRisk: 0, probabilityWin: 0.5, probabilityLoss: 0.5,
        averageWin: 0, averageLoss: 0, tradingCosts: 0, positive: false,
        breakdown: { spread: 0, commission: 0, slippage: 0, swap: 0 },
      },
      regime: { symbol, timeframe: '1h', timestamp: now, regime: 'RANGING', adx: null, atrPct: null, volatility: 'MEDIUM', description: 'manual trade' },
      rr: 2,
      evidence: { technical: [], multiTimeframe: [], priceAction: [], historical: [], ml: [], news: [], risk: [], opposing: [] },
      snapshotId: 'manual', modelVersion: 'manual', featureVersion: 'manual',
      strategy: 'RISK_CONTROLLED', strategyVersion: 'manual', mode: tick.mode,
      events: [],
    };
    const gate = await this.signalEngine.evaluateEntryGate(symbol, synthetic, settings);
    if (!gate.ok) return { ok: false, reason: gate.reason };
    // The profit-target exit is measured by the WALLET in its own currency;
    // the goal is DENOMINATED in that same currency (the wallet adopts the
    // bound account's currency and the goal follows it), so the target passes
    // through unchanged — converting here would double-convert.
    const position = await this.openPosition(synthetic, lots, fill, undefined, { slippageBps: opts.slippageBps ?? settings.slippageBps ?? 0, targetProfit: settings.minimumProfit > 0 ? settings.minimumProfit : undefined });
    if (!position) return { ok: false, reason: 'position open failed' };
    return { ok: true, reason: `position opened at ${position.entryPrice}`, position };
  }

  /**
   * Modify the protective orders on an open position (SL/TP). The paper exit
   * loop reads these on the next tick; the MT5 mirror picks the new values up
   * on its next command poll (CLOSE commands always carry the position's
   * current SL/TP, and the worker's FLATTEN/CLOSE use the live position).
   * Validation keeps SL/TP on the protective side of the current price.
   */
  modifyProtection(
    positionId: string,
    patch: { sl?: number | null; tp?: number | null },
  ): { ok: boolean; reason: string; position?: PaperPosition } {
    const pos = this.openPositions.get(positionId);
    if (!pos) return { ok: false, reason: 'position not found or already closed' };
    const tick = this.marketData.getLatest(pos.symbol);
    const bid = tick?.bid ?? pos.currentPrice ?? undefined;
    const ask = tick?.ask ?? pos.currentPrice ?? undefined;
    const ref = pos.direction === 'BUY' ? (bid ?? ask) : (ask ?? bid);
    if (patch.sl !== undefined && patch.sl !== null) {
      if (pos.direction === 'BUY' && ref !== undefined && patch.sl >= ref) {
        return { ok: false, reason: `SL for a BUY must stay below the current price (${ref})` };
      }
      if (pos.direction === 'SELL' && ref !== undefined && patch.sl <= ref) {
        return { ok: false, reason: `SL for a SELL must stay above the current price (${ref})` };
      }
      pos.stopLoss = patch.sl;
    }
    if (patch.tp !== undefined && patch.tp !== null) {
      if (pos.direction === 'BUY' && ref !== undefined && patch.tp <= ref) {
        return { ok: false, reason: `TP for a BUY must stay above the current price (${ref})` };
      }
      if (pos.direction === 'SELL' && ref !== undefined && patch.tp >= ref) {
        return { ok: false, reason: `TP for a SELL must stay below the current price (${ref})` };
      }
      // TP1 is the first managed target; setting tp also clears TP2 if it is
      // now beyond TP1 (targets must stay ordered or the exit loop mis-fires).
      pos.takeProfit1 = patch.tp;
      if (pos.takeProfit2 !== null && pos.takeProfit2 !== undefined && pos.takeProfit2 < patch.tp) {
        pos.takeProfit2 = patch.tp;
      }
    }
    if (patch.sl === null) pos.stopLoss = 0; // explicit SL removal (0 = none)
    void this.ctx.store.updateOne('paperPositions', { id: pos.id }, { $set: { stopLoss: pos.stopLoss, takeProfit1: pos.takeProfit1, takeProfit2: pos.takeProfit2 } }).catch((err) =>
      logger.warn('modifyProtection persist failed', { err: String(err) }));
    this.ctx.events.emit(CHANNELS.position, pos);
    return { ok: true, reason: 'ok', position: pos };
  }

  /**
   * Close a position — fully, or partially (Phase 17). A partial close
   * (closeLots < current lots) realizes P&L on the closed portion, records a
   * trade, and keeps the position OPEN with the remainder so SL/TP/trailing
   * keep managing it. Partial amounts are stepped to the asset's lot step; a
   * remainder below the minimum lot is closed entirely.
   */
   async closePosition(position: PaperPosition, exitPrice: number, reason: PaperTrade['exitReason'], closeLots?: number): Promise<PaperTrade | null> {
    if (!this.account) return null;
    // Idempotency: a position already CLOSED or not in openPositions must not
    // generate another trade. The tick loop can fire concurrently for same symbol
    // (profit-target + SL both true on same tick, or two ticks ~10ms apart), and
    // without this guard one paper position produced 52 duplicate trades while
    // MT5 only got 1 close (queueClose is idempotent). Fixes dashboard vs MT5 drift.
    if (position.status !== 'OPEN') return null;
    if (!this.openPositions.has(position.id)) return null;
    const asset = getAsset(position.symbol);
    // XM/MT5 semantics: an exit also prints at the broker's price precision —
    // the close price (bid/ask side) never carries sub-point digits.
    exitPrice = Number(exitPrice.toFixed(asset.pricePrecision));
    const target = closeLots !== undefined && closeLots > 0 ? roundLot(position.symbol, closeLots) : position.lots;
    const remaining = Math.max(0, position.lots - target);
    // Full close: caller asked for everything, or the remainder is dust that
    // can no longer be represented at the asset's minimum quantity.
    const fullClose = target >= position.lots || remaining < asset.minimumLot;
    const closedLots = fullClose ? position.lots : target;
    if (closedLots <= 0) return null;

    const rawPnl = pnlForPosition(effectiveSpec(position.symbol), closedLots, position.direction, position.entryPrice, exitPrice);
    // Forex: flat commission per lot. Crypto: percentage taker fee per side —
    // entry side on the entry notional PLUS exit side on the EXIT notional
    // (charging both sides on the entry price mis-prices moved markets).
    const acctCcy = this.account.currency ?? 'USD';
    // FX commission follows the SELECTED ACCOUNT TYPE: a spread-only account
    // (XM Standard / Ultra Low Standard) charges nothing per lot, a Zero-style
    // account charges its published per-lot fee. With no broker account bound,
    // the platform's own assumption still applies (simulation only).
    const rawCommission = assetClassFor(position.symbol) === 'CRYPTO'
      ? (position.entryPrice + exitPrice) * closedLots * (asset.takerFee ?? 0)
      : (this.fxCommissionPerLotUsd(position.symbol) ?? asset.commissionPerLot) * closedLots;
    // §18: the quote→account rate used AT EXIT is captured with the trade —
    // history must never re-price against today's rate. A never-available
    // rate degrades to 1 with fxStale=true (and execution was already gated).
    const pnlConv = this.convQuote(position.symbol, acctCcy, rawPnl);
    const commission = assetClassFor(position.symbol) === 'CRYPTO'
      ? this.convQuote(position.symbol, acctCcy, rawCommission).amount
      : this.convUsd(acctCcy, rawCommission);
    // Swap accrued on the closed fraction is realized; the rest stays on the position.
    const swap = position.swap * (position.lots > 0 ? closedLots / position.lots : 0);
    const pnl = pnlConv.amount - commission + swap;
    // R-multiple measured against the PLANNED stop (initialStopLoss): a
    // trailed/breakeven stop must not shrink the reported risk multiple.
    const plannedStop = position.initialStopLoss ?? position.stopLoss;
    const riskPerUnit = Math.abs(position.entryPrice - plannedStop);
    const rr = riskPerUnit > 0 ? Math.abs(exitPrice - position.entryPrice) / riskPerUnit : 0;
    const now = Date.now();
    const trade: PaperTrade = {
      id: crypto.randomUUID(),
      positionId: position.id,
      signalId: position.signalId,
      symbol: position.symbol,
      direction: position.direction,
      lots: Number(closedLots.toFixed(asset.quantityPrecision)),
      entryPrice: position.entryPrice,
      exitPrice,
      exitReason: reason,
      pnl: Number(pnl.toFixed(2)),
      fees: Number(commission.toFixed(2)),
      swap: Number(swap.toFixed(2)),
      // Realized-P&L provenance (§18): what the exit actually used.
      grossQuotePnl: Number(rawPnl.toFixed(asset.pricePrecision)),
      fxRate: pnlConv.rate,
      fxRateAt: pnlConv.ts,
      fxRateSource: pnlConv.src,
      fxStale: pnlConv.stale,
      rr: Number(rr.toFixed(2)),
      openTime: position.openTime,
      closeTime: now,
      durationMs: now - position.openTime,
      session: primarySession(position.openTime),
      regime: null,
      modelVersion: position.modelVersion ?? '',
      // Prediction-vs-reality record (spec §48) — what the model expected.
      confidence: position.confidence ?? null,
      probability: position.probability ?? null,
      expectedValue: position.expectedValue ?? null,
      strategy: position.strategy,
      strategyVersion: position.strategyVersion,
      featureVersion: position.featureVersion,
      indicatorVersion: position.indicatorVersion,
      configurationVersion: position.configurationVersion,
      slippageBps: position.slippageBps,
      // Terms provenance: which account type this trade belonged to, what it was
      // priced on and where every number came from — captured at exit, when it
      // is still knowable, so the journal never re-derives it later.
      terms: this.providers.termsProvenance?.(position.symbol) ?? position.terms,
    };
    if (fullClose) {
      position.status = 'CLOSED';
      position.currentPrice = exitPrice;
      this.openPositions.delete(position.id);
      await this.ctx.store.updateOne('paperPositions', { id: position.id }, { $set: { status: 'CLOSED', currentPrice: exitPrice, lots: closedLots } });
    } else {
      // Partial close: position stays OPEN with the remaining size.
      position.lots = Number(remaining.toFixed(asset.quantityPrecision));
      position.swap = Number((position.swap - swap).toFixed(2));
      position.currentPrice = exitPrice;
      this.openPositions.set(position.id, position);
      await this.ctx.store.updateOne('paperPositions', { id: position.id }, { $set: { lots: position.lots, swap: position.swap, currentPrice: exitPrice } });
    }
    await this.ctx.store.insertOne('paperTrades', trade);

    this.account.balance += pnl;
    this.account.realizedPnl += pnl;
    this.account.fees += commission;
    this.account.openPositionCount = this.openPositions.size;
    // Daily / weekly P&L with UTC window rollover + consecutive losses
    // (spec §34) — these feed the MAX_DAILY_LOSS / MAX_WEEKLY_LOSS /
    // MAX_CONSECUTIVE_LOSSES circuit breakers from REAL account state.
    const dayRoll = rollWindow(this.account.dailyPnl, this.account.dailyPnlResetAt, now, dayWindowKey);
    this.account.dailyPnl = dayRoll.value + pnl;
    this.account.dailyPnlResetAt = dayRoll.resetAt;
    const weekRoll = rollWindow(this.account.weeklyPnl, this.account.weeklyPnlResetAt, now, weekWindowKey);
    this.account.weeklyPnl = weekRoll.value + pnl;
    this.account.weeklyPnlResetAt = weekRoll.resetAt;
    this.account.consecutiveLosses = pnl < 0 ? (this.account.consecutiveLosses ?? 0) + 1 : 0;
    await this.updateAccount({ force: true });
    this.ctx.events.emit(CHANNELS.trade, trade);
    // Emit the position too so clients drop it from the open-positions view.
    this.ctx.events.emit(CHANNELS.position, position);
    return trade;
  }

  /**
   * Dynamic exit (spec §44): close an open position when its signal is
   * invalidated or an opposite signal appears. Fills on the REAL side of the
   * spread — a BUY position closes at the bid, a SELL at the ask.
   */
  async closePositionForSignal(signalId: string, reason: PaperTrade['exitReason']): Promise<PaperTrade | null> {
    const pos = [...this.openPositions.values()].find((p) => p.signalId === signalId);
    if (!pos) return null;
    const tick = this.marketData.getLatest(pos.symbol);
    const mid = tick?.mid ?? pos.currentPrice;
    const exitPrice = pos.direction === 'BUY' ? (tick?.bid ?? mid) : (tick?.ask ?? mid);
    return this.closePosition(pos, exitPrice, reason);
  }

  /**
   * Called on every tick: update P&L, check SL/TP against the REAL side of the
   * spread when the feed provides bid/ask (e.g. the MT5 bridge):
   *   BUY  position: SL is a sell -> triggers on BID; TP is a sell-limit -> fills on BID.
   *   SELL position: SL is a buy  -> triggers on ASK; TP is a buy-limit  -> fills on ASK.
   * When only mid is available (modeled spread), mid is used for both.
   */
  async onTick(tick: Tick): Promise<void> {
    if (!this.account) return;
    const symbol = tick.symbol;
    const mid = tick.mid;
    const bid = tick.bid ?? mid;
    const ask = tick.ask ?? mid;
    const settings = await this.loadSettingsCached();
    const acctCcy = this.account.currency ?? settings.accountCurrency ?? 'USD';
    // A rate-only tick re-marks EVERY open position in the wallet currency in
    // real time (the rate moves independently of any traded pair). Only
    // relevant for a non-USD wallet: a USD wallet IS the account currency, so
    // each position re-marks on its own symbol's ticks below.
    if (tick.symbol === INR_RATE_SYMBOL && acctCcy !== 'USD') {
      const nowMs = Date.now();
      for (const pos of this.openPositions.values()) {
        this.markPosition(pos, acctCcy);
        // Backend-enforced profit-target exit — net P&L (mark + swap −
        // commission) in the WALLET currency vs the configured minimum profit.
        if (pos.targetProfit !== undefined && this.estimateNetPnl(pos) >= pos.targetProfit) {
          const q = this.marketData.getLatest(pos.symbol);
          const exit = pos.direction === 'BUY' ? (q?.bid ?? pos.currentPrice) : (q?.ask ?? pos.currentPrice);
          await this.closePosition(pos, exit, 'PROFIT_TARGET_REACHED');
          continue;
        }
        if ((this.lastPosEmit.get(pos.symbol) ?? 0) + 1000 <= nowMs) {
          this.lastPosEmit.set(pos.symbol, nowMs);
          this.ctx.events.emit(CHANNELS.position, pos);
        }
      }
      await this.updateAccount();
      return;
    }
    for (const pos of this.openPositions.values()) {
      if (pos.symbol !== symbol) continue;
      // A position whose symbol has left the asset master (delisted feed, old
      // trade) gets no per-tick management — there is no spec to price it with.
      // It stays open and marked via its last-known values; it must not be
      // able to throw here, because this loop shares a process with India
      // trading and everything else the backend runs.
      let asset: ReturnType<typeof getAsset>;
      try {
        asset = getAsset(symbol);
      } catch (err) {
        if (!this.warnedSymbols.has(symbol)) {
          this.warnedSymbols.add(symbol);
          logger.warn('paper engine: tick for unknown symbol — position management skipped', { symbol, err: String(err) });
        }
        continue;
      }
      this.markPosition(pos, acctCcy, { bid, ask });
      pos.durationMs = Date.now() - pos.openTime;
      // Track the swing extreme since entry (position-anchored Chandelier,
      // CEZLSMA adoption): highest bid / lowest ask observed while OPEN.
      const swing = pos.swingExtreme ?? { high: pos.entryPrice, low: pos.entryPrice };
      if (bid > swing.high) swing.high = bid;
      if (ask < swing.low) swing.low = ask;
      pos.swingExtreme = swing;
      // swap/funding accrual per day held (crypto: funding rate; forex: swap points)
      const daysHeld = Math.floor(pos.durationMs / 86400_000);
      if (asset.assetClass === 'CRYPTO') {
        pos.swap = Number(this.convQuote(symbol, acctCcy, cryptoFundingPerDay(symbol, pos.entryPrice, pos.lots, pos.direction) * daysHeld).amount.toFixed(2));
      } else {
        pos.swap = Number(this.convUsd(acctCcy, (pos.direction === 'BUY' ? asset.swapLong : asset.swapShort) * pos.lots * daysHeld).toFixed(2));
      }
      // Backend-enforced profit-target exit — net P&L in the WALLET currency
      // vs the configured minimum profit.
      if (pos.targetProfit !== undefined && this.estimateNetPnl(pos) >= pos.targetProfit) {
        const exit = pos.direction === 'BUY' ? bid : ask;
        await this.closePosition(pos, exit, 'PROFIT_TARGET_REACHED');
        continue;
      }
      // Real-time mark-to-market: stream the position to the UI at ~1 Hz.
      const nowMs = Date.now();
      if ((this.lastPosEmit.get(symbol) ?? 0) + 1000 <= nowMs) {
        this.lastPosEmit.set(symbol, nowMs);
        this.ctx.events.emit(CHANNELS.position, pos);
      }

      // ---- Weekend flatten (FXBot adoption) --------------------------------
      // Leveraged FX positions must not be held across the Friday close: swap
      // is charged twice, the Monday open can gap past stops. Inside the risk
      // window (Fri 20:00 UTC → Sun 22:00 UTC) open positions are closed at
      // the live side of the spread, exactly like the manual close path.
      // Uses the TICK's own timestamp — replay/backtest-correct and immune to
      // wall-clock skew; stale ticks are already rejected by validation.
      if (assetClassFor(symbol) === 'FOREX' && (settings.weekendFlattenEnabled ?? true) && isWeekendGapRiskWindow(tick.timestamp)) {
        const exit = pos.direction === 'BUY' ? bid : ask;
        await this.closePosition(pos, exit, 'WEEKEND_FLATTEN');
        continue;
      }

      // ---- Trailing stop (spec §63) ----------------------------------------
      // Pure math from trailingStopEngine: activates after `activateR` × risk,
      // ratchets behind price at `atrMultiplier` × ATR, never loosens, locks
      // profit at/above entry.
      if (settings.trailingStopEnabled && pos.atr && pos.atr > 0) {
        // Chandelier mode (geraked/metatrader5 CEZLSMA adoption): anchor the
        // trail to the swing extreme since entry instead of hugging price.
        let highestHigh: number | undefined;
        let lowestLow: number | undefined;
        if (settings.trailingStopMode === 'chandelier') {
          const swing = pos.swingExtreme;
          if (swing) {
            highestHigh = swing.high;
            lowestLow = swing.low;
          }
        }
        const trail = computeTrailingStop({
          direction: pos.direction,
          entry: pos.entryPrice,
          mid,
          currentStop: pos.stopLoss,
          atr: pos.atr,
          atrMultiplier: settings.trailingStopAtrMultiplier,
          activateR: settings.trailingStopActivateR,
          pricePrecision: asset.pricePrecision,
          highestHigh,
          lowestLow,
          mode: settings.trailingStopMode === 'chandelier' ? 'chandelier' : 'price',
        });
        if (trail.stop !== null) {
          pos.stopLoss = trail.stop;
          pos.trailingActive = true;
          void this.ctx.store.updateOne('paperPositions', { id: pos.id }, { $set: { stopLoss: pos.stopLoss, swingExtreme: pos.swingExtreme } }).catch((err) =>
            logger.warn('trailing persist failed', { err: String(err) }));
          const sig = this.signalEngine.getActive(symbol).find((s) => s.id === pos.signalId);
          if (sig && sig.state !== 'TRAILING') {
            void this.signalEngine.updateSignalState(sig, 'TRAILING', 'trailing stop activated').catch(() => undefined);
          }
        }
      }

      // ---- Breakeven stop (Phase 19) ---------------------------------------
      // After `breakevenActivateR` R of profit the stop moves to entry. Only
      // when enabled; never loosens a ratcheted trailing stop (BUY stops are
      // already >= entry, SELL <= entry), never re-applies after triggering.
      const beRisk = Math.abs(pos.entryPrice - pos.stopLoss);
      if (settings.breakevenEnabled && !pos.breakevenApplied && beRisk > 0) {
        const profitR = Math.abs(mid - pos.entryPrice) / beRisk;
        const activateR = settings.breakevenActivateR > 0 ? settings.breakevenActivateR : 1;
        if (profitR >= activateR) {
          const improves = pos.direction === 'BUY' ? pos.stopLoss < pos.entryPrice : pos.stopLoss > pos.entryPrice;
          if (improves) {
            pos.stopLoss = pos.entryPrice;
            pos.breakevenApplied = true;
          }
        }
      }

      const slReason: PaperTrade['exitReason'] = pos.trailingActive ? 'TRAILING' : 'SL';
      // Legacy guard: positions created before the tp normalization could hold
      // takeProfit1/2 = 0 (the disabled sentinel) — never let "ask >= 0" fire.
      const tp1Hit = pos.takeProfit1 !== null && pos.takeProfit1 > 0;
      const tp2Hit = pos.takeProfit2 !== null && pos.takeProfit2 > 0;
      if (pos.direction === 'BUY') {
        if (bid <= pos.stopLoss) {
          await this.closePosition(pos, pos.stopLoss, slReason);
          continue;
        }
        if (tp2Hit && ask >= pos.takeProfit2!) {
          await this.closeAtTakeProfit(pos, 2, pos.takeProfit2!);
          continue;
        }
        if (tp1Hit && ask >= pos.takeProfit1!) {
          await this.closeAtTakeProfit(pos, 1, pos.takeProfit1!);
          continue;
        }
      } else {
        if (ask >= pos.stopLoss) {
          await this.closePosition(pos, pos.stopLoss, slReason);
          continue;
        }
        if (tp2Hit && bid <= pos.takeProfit2!) {
          await this.closeAtTakeProfit(pos, 2, pos.takeProfit2!);
          continue;
        }
        if (tp1Hit && bid <= pos.takeProfit1!) {
          await this.closeAtTakeProfit(pos, 1, pos.takeProfit1!);
          continue;
        }
      }
    }
    await this.updateAccount();
  }

  /**
   * Take-profit level handling (Phase 17). Each level closes a % of the
   * ORIGINAL size (settings tp1ClosePct / tp2ClosePct):
   *   100 → full close; 0 → skip (SL/trailing keeps managing the position);
   *   otherwise → partial close, position stays OPEN.
   * closePosition converts a too-small remainder into a full close.
   */
  private async closeAtTakeProfit(pos: PaperPosition, level: 1 | 2, price: number): Promise<void> {
    const settings = await this.loadSettingsCached();
    const pct = level === 1 ? settings.tp1ClosePct : settings.tp2ClosePct;
    const fraction = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0;
    if (fraction >= 100) {
      await this.closePosition(pos, price, level === 1 ? 'TP1' : 'TP2');
      return;
    }
    if (fraction <= 0 || !pos.entryLots) return;
    await this.closePosition(pos, price, level === 1 ? 'TP1' : 'TP2', (pos.entryLots * fraction) / 100);
  }

  /**
   * Commission in USD per lot round turn for a symbol.
   *
   * One source of truth for the whole engine: the ACCOUNT TYPE's own per-lot
   * commission when its basis is in force (e.g. an XM Standard / Ultra Low
   * Standard account is spread-only → 0, while a Zero-style account charges its
   * published fee), otherwise the platform's built-in assumption. Crypto is not
   * charged per lot at all and returns null so callers use the taker-fee model.
   *
   * Used by the close path AND by both unrealized-P&L projections, so the
   * profit-target trigger can never disagree with what the close realizes.
   */
  private fxCommissionPerLotUsd(symbol: string): number | null {
    if (assetClassFor(symbol) === 'CRYPTO') return null;
    const broker = effectiveCommissionUsdPerLot();
    if (broker && broker.usdPerLotRoundTurn !== null) return broker.usdPerLotRoundTurn;
    return getAsset(symbol).commissionPerLot;
  }

  /**
   * Spec §38/§90: net P&L in account currency = mark-to-market + accrued swap
   * − projected exit commission, measured at the EXECUTABLE exit side of the
   * spread (BUY closes at bid, SELL at ask) — mirroring exactly what
   * closePosition realizes. The trigger therefore guarantees the realized net
   * profit is >= the configured target, never a mid-based phantom profit.
   */
  private estimateNetPnl(pos: PaperPosition): number {
    if (!this.account) return Number.NEGATIVE_INFINITY;
    try {
      const asset = getAsset(pos.symbol);
      const acctCcy = this.account.currency ?? 'USD';
      const q = this.marketData.getLatest(pos.symbol);
      const exitPx = pos.direction === 'BUY' ? (q?.bid ?? pos.currentPrice) : (q?.ask ?? pos.currentPrice);
      const gross = pnlForPosition(effectiveSpec(pos.symbol), pos.lots, pos.direction, pos.entryPrice, exitPx);
      const crypto = assetClassFor(pos.symbol) === 'CRYPTO';
      // Round-turn taker fees: entry side on entry notional, exit side on the
      // CURRENT exit notional (mirrors closePosition exactly).
      const rawCommission = crypto
        ? (pos.entryPrice + exitPx) * pos.lots * (asset.takerFee ?? 0)
        : (this.fxCommissionPerLotUsd(pos.symbol) ?? asset.commissionPerLot) * pos.lots;
      const commission = crypto
        ? this.convQuote(pos.symbol, acctCcy, rawCommission).amount
        : this.convUsd(acctCcy, rawCommission);
      const grossAccount = acctCcy === 'USD' ? gross : this.convQuote(pos.symbol, acctCcy, gross).amount;
      return grossAccount + pos.swap - commission;
    } catch (err) {
      // Unusable symbol/rates must never fire a profit-target exit — and must
      // never reach the tick loop as an exception. -Infinity simply never
      // clears the target.
      if (!this.warnedSymbols.has(pos.symbol)) {
        this.warnedSymbols.add(pos.symbol);
        logger.warn('paper engine: net-P&L estimate degraded for symbol', { symbol: pos.symbol, err: String(err) });
      }
      return Number.NEGATIVE_INFINITY;
    }
  }

  /**
   * Canonical per-tick position mark (§16/§17/§28).
   *
   * One place computes EVERYTHING the UI and account need from a live tick:
   * executable-side quote P&L → live INR conversion → costs → net; pip
   * movement and pip value from the symbol spec; notional/margin/leverage.
   * The position's `unrealizedPnl` is the NET figure (gross + swap −
   * projected commission), so equity = balance + Σ unrealized is honest.
   *
   * NEVER throws: this runs inside the shared tick loop, where one raised
   * error used to take down the whole backend — India trading included —
   * twice in one evening (StaleRateError, then an orphaned XRP/USDT position
   * whose symbol had left the asset master). A bad position degrades to its
   * last-known marks instead.
   */
  private markPosition(
    pos: PaperPosition,
    acctCcy: string,
    sides?: { bid: number; ask: number },
  ): void {
    try {
      this.markPositionInner(pos, acctCcy, sides);
    } catch (err) {
      if (!this.warnedSymbols.has(pos.symbol)) {
        this.warnedSymbols.add(pos.symbol);
        logger.warn('paper engine: marking degraded for symbol', { symbol: pos.symbol, err: String(err) });
      }
    }
  }
  private warnedSymbols = new Set<string>();

  private markPositionInner(
    pos: PaperPosition,
    acctCcy: string,
    sides?: { bid: number; ask: number },
  ): void {
    const asset = getAsset(pos.symbol);
    const q = this.marketData.getLatest(pos.symbol);
    const bid = sides?.bid ?? q?.bid ?? null;
    const ask = sides?.ask ?? q?.ask ?? null;
    const mid = q?.mid ?? (sides ? (sides.bid + sides.ask) / 2 : pos.currentPrice ?? pos.entryPrice);
    pos.currentPrice = mid;
    pos.currentBid = bid;
    pos.currentAsk = ask;

    // Executable EXIT side drives floating P&L (§10): BUY exits at bid,
    // SELL at ask. Fall back to mid only when the feed carries no book.
    const exitSide = pos.direction === 'BUY' ? (bid ?? mid) : (ask ?? mid);

    // Quote-currency layer — pure FX math, untouched by INR.
    const quotePnl = pnlForPosition(effectiveSpec(pos.symbol), pos.lots, pos.direction, pos.entryPrice, exitSide);
    const moved = pos.direction === 'BUY'
      ? exitSide - pos.entryPrice
      : pos.entryPrice - exitSide;

    // Account-currency layer — LIVE conversion with provenance. A rate that
    // has never been available degrades to rate 1 + STALE flag; execution is
    // gated separately by conversionFresh (§26).
    const unit = this.convQuote(pos.symbol, acctCcy, 1);
    const grossConv = this.convQuote(pos.symbol, acctCcy, quotePnl);

    const crypto = assetClassFor(pos.symbol) === 'CRYPTO';
    // Round-turn taker fees (mirrors closePosition): exit side priced at the
    // CURRENT executable side, not the entry price.
    const rawCommission = crypto
      ? (pos.entryPrice + exitSide) * pos.lots * (asset.takerFee ?? 0)
      : (this.fxCommissionPerLotUsd(pos.symbol) ?? asset.commissionPerLot) * pos.lots;
    const projectedCommission = crypto
      ? this.convQuote(pos.symbol, acctCcy, rawCommission).amount
      : this.convUsd(acctCcy, rawCommission);

    const grossInr = grossConv.amount;
    const net = grossInr + pos.swap - projectedCommission;

    // Margin/exposure + pip geometry are FOREX-spec concepts. Crypto keeps its
    // own sizing model — mixing the two is what crashed the tick loop.
    const marginB: ReturnType<typeof requiredMargin> | null = assetClassFor(pos.symbol) === 'FOREX'
      ? (() => { try { return requiredMargin(pos.symbol, pos.lots, mid, acctCcy, this.fx); } catch { return null; } })()
      : null;
    const fxSpecs = assetClassFor(pos.symbol) === 'FOREX';

    pos.baseCurrency = asset.baseCurrency;
    pos.quoteCurrency = asset.quoteCurrency;
    pos.accountCurrency = acctCcy;
    // Broker-issued contract size when the bound account reports one — P&L
    // per pip then matches MT5/XM's own math exactly, not a catalog guess.
    const effSize = effectiveSpec(pos.symbol).contractSize;
    pos.contractSize = effSize;
    pos.units = pos.lots * effSize;
    pos.pipSize = fxSpecs ? fxPipSize(pos.symbol) : undefined;
    pos.pipMovement = fxSpecs ? Number((moved / fxPipSize(pos.symbol)).toFixed(1)) : undefined;
    pos.quotePnl = Number(quotePnl.toFixed(asset.pricePrecision));
    pos.quotePipValue = fxSpecs ? Number(pipValueQuote(pos.symbol, pos.lots).toFixed(asset.pricePrecision)) : undefined;
    pos.convRate = unit.rate;
    pos.convRateTimestamp = unit.ts;
    pos.convSource = unit.src;
    pos.convStale = unit.stale || grossConv.stale;
    pos.grossPnlAccount = Number(grossInr.toFixed(2));
    pos.projectedCommission = Number(projectedCommission.toFixed(2));
    pos.unrealizedPnl = Number(net.toFixed(2));
    if (marginB) {
      pos.notionalAccount = Number(marginB.notionalAccount.toFixed(2));
      pos.marginAccount = Number(marginB.requiredMarginAccount.toFixed(2));
      pos.leverage = marginB.leverage;
    }
    // Broker minimum lot — lets the UI decide when a ½-close is meaningful.
    pos.minimumLot = asset.minimumLot;
  }

  /**
   * Account aggregation (§19). Every component is ACCOUNT-currency:
   * unrealized comes from the per-position NET marks; margin is the converted
   * required-margin sum — fixing the old unit bug where quote-currency
   * notionals were summed straight into an ₹ account.
   *
   * In-memory values are recomputed on EVERY call (the tick loop needs live
   * numbers), but persistence + socket broadcast are throttled to ~1 Hz —
   * one Mongo write + fan-out per tick per symbol saturated both. Callers
   * that mutate realized state (open/close/funds/reset) pass {force:true}.
   * Drawdown is measured on EQUITY (balance + floating P&L) against a true
   * high-water mark, so open-position disasters count before they realize.
   */
  private async updateAccount(opts: { force?: boolean } = {}): Promise<void> {
    if (!this.account) return;
    let unrealized = 0;
    let margin = 0;
    const acctCcy = this.account.currency ?? 'USD';
    for (const pos of this.openPositions.values()) {
      // markPosition is self-guarding; the try/catch keeps the SUM honest even
      // if something unexpected escapes — one toxic position degrades to its
      // last-known mark instead of aborting the aggregation mid-loop.
      if (pos.marginAccount == null) {
        try {
          this.markPosition(pos, acctCcy);
        } catch (err) {
          logger.warn('paper engine: position mark failed during account update', { symbol: pos.symbol, err: String(err) });
        }
      }
      unrealized += pos.unrealizedPnl ?? 0;
      margin += pos.marginAccount ?? 0;
    }
    this.account.unrealizedPnl = Number(unrealized.toFixed(2));
    this.account.equity = Number((this.account.balance + unrealized).toFixed(2));
    this.account.margin = Number(margin.toFixed(2));
    this.account.freeMargin = Number((this.account.equity - this.account.margin).toFixed(2));
    this.account.leverage = this.account.equity > 0 ? this.account.margin / this.account.equity : 0;
    // Drawdown vs the equity high-water mark (floating P&L included).
    const peak = Math.max(this.account.equityPeak ?? this.account.startingBalance, this.account.equity);
    this.account.equityPeak = Number(peak.toFixed(2));
    const ddPct = peak > 0 ? ((peak - this.account.equity) / peak) * 100 : 0;
    if (ddPct > (this.account.maxDrawdownPct ?? 0)) {
      this.account.maxDrawdownPct = Number(ddPct.toFixed(2));
    }
    this.account.updatedAt = Date.now();
    const now = Date.now();
    if (!opts.force && now - this.lastAccountBroadcastAt < 1000) return;
    this.lastAccountBroadcastAt = now;
    await this.ctx.store.updateOne('paperAccounts', {}, { $set: { ...this.account } as never }, true);
    this.ctx.events.emit(CHANNELS.risk, this.account);
  }

  /**
   * Re-mark every open position with the CURRENT stored quotes (no tick
   * argument) and refresh the account aggregates. Used when a feed the wallet
   * depends on moves without any traded symbol ticking — the USD/INR rate feed
   * for a non-USD wallet: positions' account-currency P&L drifts with the rate
   * between the traded pairs' own ticks, and without this re-mark that drift
   * only became visible on the next symbol tick (or never, for pairs that tick
   * slower than the rate feed).
   */
  async reMarkAll(): Promise<void> {
    if (!this.account || this.openPositions.size === 0) return;
    const acctCcy = this.account.currency ?? 'USD';
    for (const pos of this.openPositions.values()) {
      this.markPosition(pos, acctCcy);
      const nowMs = Date.now();
      if ((this.lastPosEmit.get(pos.symbol) ?? 0) + 1000 <= nowMs) {
        this.lastPosEmit.set(pos.symbol, nowMs);
        this.ctx.events.emit(CHANNELS.position, pos);
      }
    }
    await this.updateAccount();
  }

  async recentTrades(limit = 50): Promise<PaperTrade[]> {
    return this.ctx.store.find<PaperTrade>('paperTrades', {}, { closeTime: -1 }, limit);
  }

  /**
   * Add paper funds to the wallet (dashboard "Add Balance").
   *
   * Credits balance AND equity immediately, raises the starting-balance
   * baseline so drawdown statistics stay meaningful after a deposit, and
   * persists + broadcasts like any other account mutation. History and open
   * positions are untouched; the next trade sizes against the new free margin
   * through the dynamic engine automatically.
   */
  async addFunds(amountAccount: number): Promise<PaperAccount | null> {
    if (!this.account) return null;
    const amt = Number(amountAccount);
    if (!Number.isFinite(amt) || amt <= 0 || amt > 10_000_000) return null;
    this.account.balance = Number((this.account.balance + amt).toFixed(2));
    this.account.startingBalance = Number((this.account.startingBalance + amt).toFixed(2));
    await this.updateAccount();
    logger.info('paper wallet topped up', { amount: amt, currency: this.account.currency, newBalance: this.account.balance });
    return this.account;
  }

  /**
   * User-initiated reset of the risk COUNTERS (consecutive losses, daily/weekly
   * P&L windows). Balance, history and open positions are untouched.
   *
   * The circuit breakers themselves stay hard limits — this exists because the
   * consecutive-loss counter can only ever reset on a winning close, which
   * deadlocks manual trading: entries are blocked until a win happens, and no
   * trade can be opened to produce one. Acknowledging the streak by hand is
   * the paper-trading equivalent of a risk desk re-arming a trip; it is logged,
   * explicit, and never automatic.
   */
  async resetRiskCounters(): Promise<PaperAccount | null> {
    if (!this.account) return null;
    const now = Date.now();
    this.account.consecutiveLosses = 0;
    // Zero the rolling windows and stamp their reset to now, so the next
    // closed trade starts a clean daily/weekly measurement rather than
    // inheriting the streak that tripped the breaker.
    this.account.dailyPnl = 0;
    this.account.dailyPnlResetAt = now;
    this.account.weeklyPnl = 0;
    this.account.weeklyPnlResetAt = now;
    await this.updateAccount();
    // The fill gate reads a short-TTL snapshot of these counters — drop it so
    // Reset → Trade works immediately instead of for "after 5 seconds".
    this.signalEngine.invalidateAccountRiskCache();
    return this.account;
  }

  /**
   * Sync paper wallet from LIVE MT5 demo account balance.
   *
   * When the MT5 trader worker is online, its demo account is the SOURCE OF
   * TRUTH for money. Every paper trade is also placed on MT5 (always-on
   * mirror), so balance must track MT5's real demo balance converted to the
   * dashboard's account currency (INR when wallet is INR). This keeps both
   * places showing the same profit/loss and the same free-margin for sizing.
   *
   * - mt5Balance is in mt5Currency (typically USD).
   * - dashboard currency is this.account.currency (INR or USD).
   * - conversion uses the LIVE CurrencyConversionService (USD/INR rate).
   * - startingBalance is kept as the MT5 initial equivalent so drawdown stats
   *   remain meaningful after sync.
   */
  async syncFromMt5(info: { balance: number; equity?: number; margin?: number; freeMargin?: number; currency: string; login?: number; server?: string }): Promise<void> {
    if (!this.account) return;
    if (!Number.isFinite(info.balance)) return;
    const mt5Ccy = (info.currency || 'USD').toUpperCase();
    const acctCcy = (this.account.currency || 'USD').toUpperCase();

    // The dashboard follows the ACCOUNT's currency — the same pattern the
    // broker platform itself uses. A bound XM account settles in its own
    // money (USD for Standard/Ultra Low), so the ledger ADOPTS that currency
    // and mirrors the reported balance directly. Converting the account's own
    // balance into another unit (₹) would fabricate a number the broker never
    // reported — and once made the wallet read ~96× the real account.
    if (mt5Ccy !== acctCcy) {
      logger.info('paper wallet: adopting bound account currency (dashboard follows the account, as on the broker platform)', {
        from: acctCcy, to: mt5Ccy, login: info.login, server: info.server,
      });
      // Denominated SETTINGS follow the wallet too: the profit target and the
      // sizing capital were expressed in the OLD currency — keeping them raw
      // would measure a ₹ goal against $ profits (or hand the sizer an ~83×
      // capital). Rescale them over the LIVE rate and persist, so every label
      // (profit target, capital inputs) and the goal math agree with the money
      // the broker actually settles in. If no conversion path exists right now
      // (trader just attached, feed still warming), the numbers stay and the
      // next heartbeat retries — the entry gate is closed anyway until binding
      // is live, so nothing can trade on mixed units in between.
      try {
        const stored = await this.ctx.store.findOne<UserSettings>('userSettings', {});
        // Guard on the STORED SETTINGS currency, not just the wallet: after the
        // first adoption the settings are already in the account's money, and a
        // backend restart that reloads a stale INR wallet from the DB must not
        // divide the (already-rescaled) figures a second time — that bug once
        // shrank a wallet's capital by rate² before it was caught.
        if (stored && (stored.accountCurrency ?? '').toUpperCase() === acctCcy) {
          const rescale = (v: number): number | null => {
            if (v === 0) return 0;
            try {
              const r = this.fx.convert(v, acctCcy, mt5Ccy);
              return Number(r.amount.toFixed(2));
            } catch {
              return null; // no live path this heartbeat — retry later
            }
          };
          // The profit TARGET converts faithfully — it is user intent, not
          // tied to any balance. Capital figures do NOT convert: while an
          // account is bound, the sizer must work from the ACCOUNT's reported
          // balance (the wallet mirror's truth), not a converted stale paper
          // figure. The patch is written atomically — a partial write (new
          // currency, old goal) would defeat the restart guard above and mix
          // units forever.
          const rawGoal = typeof stored.minimumProfit === 'number' && Number.isFinite(stored.minimumProfit) ? stored.minimumProfit : 0;
          const scaledGoal = rescale(rawGoal);
          if (scaledGoal === null) {
            logger.warn('account-currency adoption deferred — no live conversion path for the goal yet', { from: acctCcy, to: mt5Ccy });
          } else {
            const patch = {
              accountCurrency: mt5Ccy,
              minimumProfit: scaledGoal,
              availableCapital: Number(info.balance.toFixed(2)),
              paperStartingCapital: Number(info.balance.toFixed(2)),
            };
            await this.ctx.store.updateOne('userSettings', {}, { $set: patch as never }, true);
            this.refreshSettingsCache();
            logger.info('stored settings follow the bound account currency', {
              from: acctCcy, to: mt5Ccy, patch,
            });
          }
        }
      } catch (err) {
        logger.warn('settings currency follow-up failed — will retry next heartbeat', { err: String(err) });
      }
      this.account.currency = mt5Ccy;
      // Fresh mirror baseline: the aggregates below were accumulated in the
      // old currency — keeping them would mix units. Closed-trade history in
      // the journal keeps each trade's own recorded terms, so nothing is lost.
      this.account.startingBalance = Number(info.balance.toFixed(2));
      this.account.equityPeak = Number((info.equity ?? info.balance).toFixed(2));
      this.account.realizedPnl = 0;
      this.account.fees = 0;
      this.account.dailyPnl = 0;
      this.account.weeklyPnl = 0;
      this.account.maxDrawdownPct = 0;
      this.account.consecutiveLosses = 0;
    }
    this.account.balance = Number(info.balance.toFixed(2));
    this.account.equity = Number((info.equity ?? info.balance).toFixed(2));
    // The account's own margin figures are the truth while bound.
    if (typeof info.margin === 'number' && Number.isFinite(info.margin)) this.account.margin = Number(info.margin.toFixed(2));
    if (typeof info.freeMargin === 'number' && Number.isFinite(info.freeMargin)) this.account.freeMargin = Number(info.freeMargin.toFixed(2));
    // Re-assert the broker's own margin and equity figures AFTER updateAccount,
    // which recomputes them from the paper positions — while bound, the
    // account's own numbers are the truth.
    await this.updateAccount({ force: true });
    if (typeof info.equity === 'number' && Number.isFinite(info.equity)) this.account.equity = Number(info.equity.toFixed(2));
    if (typeof info.margin === 'number' && Number.isFinite(info.margin)) this.account.margin = Number(info.margin.toFixed(2));
    if (typeof info.freeMargin === 'number' && Number.isFinite(info.freeMargin)) this.account.freeMargin = Number(info.freeMargin.toFixed(2));
    // External deposit/withdrawal re-baseline: a reported balance diverging
    // from the mirror baseline by more than half is not PnL — re-baseline so
    // drawdown stays meaningful. Small moves never touch it.
    const diff = Math.abs(this.account.balance - this.account.startingBalance);
    if (this.account.startingBalance > 0 && diff > this.account.startingBalance * 0.5) {
      this.account.startingBalance = Number(info.balance.toFixed(2));
      this.account.equityPeak = Number(Math.max(this.account.equity, this.account.equityPeak ?? 0).toFixed(2));
    }
    logger.info('paper wallet synced from bound account', {
      mt5Balance: info.balance, mt5Currency: mt5Ccy,
      accountBalance: this.account.balance, accountCurrency: this.account.currency,
      login: info.login, server: info.server,
    });
  }
}
