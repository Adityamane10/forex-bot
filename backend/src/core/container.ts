/**
 * Dependency container. Builds the store, cache, providers and every engine,
 * wiring the event bus between them. Used by the HTTP/WS bootstrap and by
 * integration tests.
 */
import { EventEmitter } from 'events';
import { createStore, DataStore } from '../db/store';
import { createCache, Cache } from '../db/cache';
import { DemoMarketDataProvider } from '../providers/demoMarketData';
import { TwelveDataMarketDataProvider } from '../providers/twelvedataMarketData';
import { FinnhubMarketDataProvider } from '../providers/finnhubMarketData';
import { YahooFinanceMarketDataProvider } from '../providers/yahooFinanceMarketData';
import { BinanceCryptoMarketDataProvider } from '../providers/binanceCryptoMarketData';
import { RoutingMarketDataProvider } from '../providers/routingMarketData';
import { createNewsProvider } from '../providers/newsProvider';
import { createCalendarProvider } from '../providers/centralBankCalendar';
import { createLlmProvider } from '../providers/llmProvider';
import { DisabledExecutionProvider, MarketDataProvider, ProviderRegistry } from '../providers/types';
import { CcxtCryptoExchangeAdapter } from '../providers/cryptoExchangeAdapter';
import { MarketConditionEngine } from '../engines/marketConditionEngine';
import { config } from '../config';
import { AuditLogger } from './audit';
import { FxContext, CHANNELS } from './context';
import { MarketDataEngine } from '../engines/marketDataEngine';
import { CandleEngine } from '../engines/candleEngine';
import { IndicatorEngine } from '../engines/indicatorEngine';
import { MultiTimeframeEngine } from '../engines/multiTimeframeEngine';
import { PatternEngine } from '../engines/patternEngine';
import { NewsEngine } from '../engines/newsEngine';
import { EventEngine } from '../engines/eventEngine';
import { SentimentEngine } from '../engines/sentimentEngine';
import { FeatureEngine } from '../engines/featureEngine';
import { PortfolioRiskEngine } from '../engines/portfolioRiskEngine';
import { PortfolioAnalytics } from '../engines/portfolioAnalytics';
import { CorrelationEngine } from '../engines/correlationEngine';
import { CircuitBreakerEngine } from '../engines/circuitBreakerEngine';
import { SignalSnapshotEngine } from '../engines/signalSnapshot';
import { SignalStateMachine } from '../engines/signalStateMachine';
import { AlertEngine } from '../engines/alertEngine';
import { SignalEngine } from '../engines/signalEngine';
import { EmergencyStopEngine } from '../engines/emergencyStopEngine';
import { ScannerEngine } from '../engines/scannerEngine';
import { PaperTradingEngine } from '../engines/paperTradingEngine';
import { Mt5MirrorService } from '../engines/mt5Mirror';
import { AccountProfileService } from '../broker/account-profile-service';
import { BrokerPolicySource } from '../broker/policy-source';
import { setBrokerSpecOverrides, setAccountLeverage, effectiveSpec } from '../forex/symbol-spec';
import { BacktestEngine } from '../engines/backtestEngine';
import { ModelRegistry } from '../engines/modelRegistry';
import { DriftEngine } from '../engines/driftEngine';
import { SystemHealthEngine } from '../engines/systemHealthEngine';
import { AiClient } from '../ai/aiClient';
import { logger } from './logger';
import { ALL_SYMBOLS, DEFAULT_SYMBOLS, INR_RATE_SYMBOL, TIMEFRAME_MS, TIMEFRAMES, BrokerId, Candle, Mt5AccountSnapshot, Mt5TradeMode, NewsItem, EconomicEvent, Tick, Signal, SignalState, UserSettings, PaperPosition, getAsset, assetClassFor } from '@fx/shared';
import { rollWindow, dayWindowKey } from '../math/paperMath';
import { accountQuoteRate, goalFeasibility } from '../math/forexMath';
import { computeGoalProgress, GoalProgress } from '../math/paperMath';
import { NoneOnChainProvider } from '../providers/onChainProvider';
import { sizePosition } from '../engines/positionSizingEngine';
import { Mt5ReconciliationService } from '../ops/reconciliation';
import { METRICS } from '../ops/metrics';

export class Container {
  ctx!: FxContext;
  store!: DataStore;
  cache!: Cache;
  marketData!: MarketDataEngine;
  candles!: CandleEngine;
  indicators!: IndicatorEngine;
  multiTimeframe!: MultiTimeframeEngine;
  patterns!: PatternEngine;
  news!: NewsEngine;
  events!: EventEngine;
  sentiment!: SentimentEngine;
  features!: FeatureEngine;
  ai!: AiClient;
  portfolioRisk!: PortfolioRiskEngine;
  correlation!: CorrelationEngine;
  circuitBreakers!: CircuitBreakerEngine;
  snapshots!: SignalSnapshotEngine;
  stateMachine!: SignalStateMachine;
  /** Rolling spread/volatility regimes (Phases 4-5) consumed by the signal engine. */
  conditions!: MarketConditionEngine;
  alerts!: AlertEngine;
  signals!: SignalEngine;
  emergencyStop!: EmergencyStopEngine;
  scanner!: ScannerEngine;
  paper!: PaperTradingEngine;
  mt5Mirror!: Mt5MirrorService;
  /** Which broker account the platform is bound to, and its resolved terms. */
  broker!: AccountProfileService;
  /** Watches the broker's published account terms for changes. */
  policySource!: BrokerPolicySource;
  /** Wallet currency (user setting); 'USD' until settings load. */
  private brokerAccountCurrency = 'USD';
  backtest!: BacktestEngine;
  models!: ModelRegistry;
  drift!: DriftEngine;
  health!: SystemHealthEngine;
  portfolioAnalytics!: PortfolioAnalytics;
  /** Broker→dashboard position reconciliation (server-side SL/TP closures). */
  reconciliation!: Mt5ReconciliationService;

  /** Debounced per-symbol re-analysis used by the event-driven signal engine. */
  private analyzeDebounce = new Map<string, ReturnType<typeof setTimeout>>();

  /** Pending-entry attempts in flight per symbol (ticks fire often — no dupes). */
  private entryInFlight = new Set<string>();

  /**
   * Auto paper execution for a symbol: opens a position for every ENTRY_REACHED
   * signal that has no position yet, AFTER the fill-time gate. When the gate
   * blocks (single-position mode, margin cap, min profit, breakers), the signal
   * is NOT invalidated — it stays alive and this method retries on every tick,
   * so the next waiting signal trades automatically once a position closes.
   */
  private async autoTradeEntry(symbol: string): Promise<void> {
    const settings = await this.signals.loadSettings();
    if (!settings.autoTradeEnabled) return;
    // § goal: when the goal session is achieved (net P&L ≥ minimumProfit, or
    // the trade cap is exhausted) auto entries STOP — exactly what the goal
    // card reports. The doc on getGoalProgress always promised this; it was
    // never wired. Manual "trade now" stays available (user override).
    const goal = await this.getGoalProgress();
    if (goal.autoPaused) return;
    if (this.entryInFlight.has(symbol)) return;
    this.entryInFlight.add(symbol);
    try {
      for (const signal of this.signals.getActive(symbol)) {
        if (signal.state !== 'ENTRY_REACHED' || signal.positionId) continue;
        const result = await this.tryOpenForSignal(signal, settings);
        if (result.ok && result.position) {
          this.ctx.events.emit(CHANNELS.signalState, signal);
        }
      }
    } catch (err) {
      logger.warn('auto paper execution failed', { symbol, err: String(err) });
    } finally {
      this.entryInFlight.delete(symbol);
    }
  }

  /**
   * Wallet currency = the user's account-currency setting. The dashboard's
   * money display follows the BOUND MT5 account currency instead (see
   * AccountProfileService.status().displayCurrency): an XM account settles in
   * account's own currency, so showing the wallet in the wrong unit would be a
   * error. Every cross-currency figure converts over the LIVE feed only.
   */
  noteAccountCurrency(currency: string): void {
    if (!currency) return;
    this.brokerAccountCurrency = currency.toUpperCase();
  }

  /** Symbol-lock mirror for the MT5 dispatch gate (set on every settings save). */
  private symbolLockCache: string | null = null;

  /** Realtime symbol-lock update: engine cache is invalidated and the MT5
   *  dispatch gate adopts the new lock on the very next worker poll. */
  noteSymbolLock(lock: string | null | undefined): void {
    this.symbolLockCache = (lock ?? '').toUpperCase() || null;
    this.mt5Mirror?.setSymbolLock(this.symbolLockCache);
    this.paper.refreshSettingsCache();
  }

  /**
   * Live goal progress for the paper wallet: today's NET P&L (realized since
   * the UTC roll + floating, in the wallet's own currency — USD on an XM
   * account) against the user's minimumProfit target, plus the session trade
   * cap (§ goal). `autoPaused` is what autoTradeEntry obeys.
   */
  async getGoalProgress(): Promise<GoalProgress> {
    const settings = await this.signals.loadSettings();
    const account = this.paper.getAccount();
    // XM-style goal semantics: the target is TODAY's profit vs the target, not
    // lifetime P&L. Lifetime realized (account.realizedPnl) made every past
    // session count toward today's goal — one good day paused the engine
    // forever (or, worse, a big historical day gated today's fresh start).
    // account.dailyPnl rolls with the same daily window as the risk breakers,
    // so realized-since-midnight-UTC is already computed for us.
    const now = Date.now();
    const dailyPnl = rollWindow(account?.dailyPnl ?? 0, account?.dailyPnlResetAt ?? 0, now, dayWindowKey).value;
    let tradesDone: number | undefined;
    if (settings.goalMaxTrades != null && settings.goalMaxTrades > 0) {
      const baseline = settings.goalBaselineAt ?? 0;
      tradesDone = baseline > 0
        ? await this.store.count('paperTrades', { closeTime: { $gte: baseline } })
        : 0;
    }
    return computeGoalProgress({
      target: settings.minimumProfit ?? 0,
      realized: dailyPnl,
      unrealized: account?.unrealizedPnl ?? 0,
      maxTrades: settings.goalMaxTrades ?? null,
      tradesDone,
    });
  }

  /**
   * User-initiated "trade now" (spec §53): execute ONE specific signal with the
   * exact same fill-time gate, sizing and USD goal logic as automatic entry.
   * The gate still has final authority — a stale/wrong-side entry, margin cap,
   * min-profit infeasibility or a circuit breaker blocks it and tells the user why.
   */
  async executeSignal(signalId: string): Promise<{ ok: boolean; reason?: string; position?: PaperPosition }> {
    const signal = this.signals.getActive().find((s) => s.id === signalId);
    if (!signal) return { ok: false, reason: 'signal not found or no longer active' };
    if (signal.positionId) return { ok: false, reason: 'a position is already open for this signal' };
    const eligible = signal.state === 'ENTRY_REACHED' || signal.state === 'WAITING_FOR_ENTRY' || signal.state === 'SIGNAL_CREATED' || signal.state === 'QUALIFIED' || signal.state === 'CANDIDATE' || signal.state === 'ANALYZING';
    if (!eligible) return { ok: false, reason: `signal state ${signal.state} is not executable` };
    const settings = await this.signals.loadSettings();
    const result = await this.tryOpenForSignal(signal, settings);
    if (result.ok) {
      this.ctx.events.emit(CHANNELS.signalState, signal);
      await this.ctx.audit.record('SIGNAL_EXECUTED', signal.symbol, signal.id, undefined, { reason: result.reason, positionId: result.position?.id });
    } else {
      await this.ctx.audit.record('SIGNAL_EXECUTE_BLOCKED', signal.symbol, signal.id, undefined, { reason: result.reason });
    }
    return result;
  }

  /** Shared fill-time entry path used by auto execution and manual "trade now". */
  private async tryOpenForSignal(
    signal: Signal,
    settings: UserSettings,
  ): Promise<{ ok: boolean; reason?: string; position?: PaperPosition }> {
    const symbol = signal.symbol;
    // Defense at FILL time (stale-signal defense): signals created before a
    // whitelist/lock change must never trade — the scanner can't emit new ones
    // for a deselected symbol, but old WAITING signals lingered and auto-entry
    // opened them. XM behavior: if the symbol isn't tradable on this account,
    // the order is refused outright.
    const assetClassOf = assetClassFor(symbol);
    if ((settings.disabledAssetClasses ?? []).includes(assetClassOf)) {
      return { ok: false, reason: `${assetClassOf} trading is disabled in settings` };
    }
    if ((settings.disabledAssets ?? []).includes(symbol)) {
      return { ok: false, reason: `${symbol} is disabled in settings` };
    }
    const selected = settings.selectedPairs ?? [];
    if (selected.length > 0 && !selected.includes(symbol)) {
      await this.signals.cancelSignal(signal.id, `symbol left the selection — auto entry refused`).catch(() => undefined);
      return { ok: false, reason: `${symbol} is not in the selected pairs whitelist` };
    }
    const gate = await this.signals.evaluateEntryGate(symbol, signal, settings);
    if (!gate.ok) return { ok: false, reason: gate.reason };
    // ---- AI gate (NEVER bypassed — every execution, auto AND manual) -------
    // A trade may only execute with a fresh model prediction that meets the
    // user's confidence floor. The scanner re-predicts on every sweep, so a
    // missing/old probability means the AI engine is down, refused, or the
    // signal is stale — in every case the answer is NO TRADE, never fallback.
    const aiAgeMs = Date.now() - signal.updatedAt;
    if (typeof signal.probability !== 'number' || !Number.isFinite(signal.probability)) {
      return { ok: false, reason: 'AI gate: no model prediction on this signal — NO TRADE (AI unavailable)' };
    }
    if (aiAgeMs > 10 * 60_000) {
      return { ok: false, reason: `AI gate: model prediction is ${Math.round(aiAgeMs / 1000)}s old — NO TRADE (stale; a fresh analysis is required)` };
    }
    const aiDirConf = signal.direction === 'BUY' ? signal.probability : 1 - signal.probability;
    if (aiDirConf < settings.minConfidence) {
      return { ok: false, reason: `AI gate: model confidence ${(aiDirConf * 100).toFixed(0)}% is below the required ${(settings.minConfidence * 100).toFixed(0)}% — NO TRADE` };
    }
    // Goal currency = the live wallet's (setting until an MT5 account binds,
    // then the account's own). Every goal comparison below — feasibility,
    // TP-covers-goal, targetProfit — must use it, or a USD wallet would close
    // a position sized for a goal in another unit (or the reverse).
    const goalCcy = this.signals.goalCurrencyFor(settings);
    // §26: refuse entries while the quote→account conversion is stale — the
    // position would fill at a value the engine cannot honestly mark.
    if (!this.paper.conversionFresh(symbol)) {
      return { ok: false, reason: 'quote→account conversion STALE — execution paused until the conversion feed recovers' };
    }
    const tick = this.marketData.getLatest(symbol);
    if (!tick) return { ok: false, reason: `no live quote for ${symbol}` };
    const fill = signal.direction === 'BUY' ? (tick.ask ?? tick.mid) : (tick.bid ?? tick.mid);
    // Dynamic lot sizing (spec §1–§8): Forex sizes EVERY trade as the largest
    // valid lot under live free-margin, allocation × max-margin%, the risk cap
    // vs SL distance, and broker constraints — recalculated fresh per trade.
    // Goal mode then verifies the goal is still honestly reachable AT that
    // size; it never enlarges the position past the caps to chase the goal.
    let lots = 0;
    // ---- USER LOT MODE (manual): the requested size is respected EXACTLY or
    // the trade is REJECTED with the precise reason. Never silently shrunk or
    // enlarged — 0.10 stays 0.10, or nothing opens.
    const manualLot = settings.lotMode === 'manual' ? (settings.manualLot ?? 0) : 0;
    if (manualLot > 0) {
      const spec = effectiveSpec(symbol);
      const step = spec.lotStep > 0 ? spec.lotStep : 0.01;
      if (Math.abs(manualLot / step - Math.round(manualLot / step)) > 1e-9) {
        return { ok: false, reason: `lot ${manualLot} is not a valid ${symbol} volume step (${step}) — rejected, not adjusted` };
      }
      if (manualLot < spec.minLot) return { ok: false, reason: `lot ${manualLot} is below the broker minimum ${spec.minLot} for ${symbol} — rejected` };
      if (manualLot > spec.maxLot) return { ok: false, reason: `lot ${manualLot} is above the broker maximum ${spec.maxLot} for ${symbol} — rejected` };
      const acct = this.paper.getAccount();
      const equity = acct?.equity ?? settings.availableCapital;
      const marginRate = spec.marginRequirement > 0 ? spec.marginRequirement : getAsset(symbol).marginRequirement;
      const marginAcct = this.paper.fx.quoteToAccount(symbol, goalCcy, manualLot * spec.contractSize * fill * marginRate).amount;
      const usedMargin = acct?.margin ?? 0;
      if (settings.maxMarginUsedPct > 0) {
        const totalMarginPct = ((usedMargin + marginAcct) / equity) * 100;
        if (totalMarginPct > settings.maxMarginUsedPct) {
          return { ok: false, reason: `your lot ${manualLot} needs ${marginAcct.toFixed(2)} ${goalCcy} margin — total would be ${totalMarginPct.toFixed(1)}% > max ${settings.maxMarginUsedPct}% — rejected` };
        }
      }
      if (marginAcct > (acct?.freeMargin ?? equity)) {
        return { ok: false, reason: `your lot ${manualLot} needs ${marginAcct.toFixed(2)} ${goalCcy} margin — free margin is ${(acct?.freeMargin ?? equity).toFixed(2)} ${goalCcy} — rejected` };
      }
      const riskAcct = this.paper.fx.quoteToAccount(symbol, goalCcy, Math.abs(fill - signal.stopLoss.price) * manualLot * spec.contractSize).amount;
      const maxRiskAcct = equity * (settings.maxRiskPercent / 100);
      if (settings.maxRiskPercent > 0 && riskAcct > maxRiskAcct) {
        return { ok: false, reason: `your lot ${manualLot} risks ${riskAcct.toFixed(2)} ${goalCcy} at SL — above your ${(settings.maxRiskPercent).toFixed(1)}% max risk (${maxRiskAcct.toFixed(2)} ${goalCcy}) — rejected` };
      }
      // Goal feasibility at the USER'S lot (§ user-lot+goal): if the USD
      // target cannot be reached at this exact size, the trade is refused —
      // the engine never resizes the user's lot to chase the goal.
      if (settings.minimumProfit > 0 && signal.takeProfit.tp1 > 0) {
        const tpAcct = this.paper.fx.quoteToAccount(symbol, goalCcy, Math.abs(signal.takeProfit.tp1 - fill) * manualLot * spec.contractSize).amount;
        if (tpAcct < settings.minimumProfit) {
          return { ok: false, reason: `your lot ${manualLot} yields ~${tpAcct.toFixed(2)} ${goalCcy} at TP — below your ${settings.minimumProfit.toFixed(2)} ${goalCcy} minimum profit — rejected (raise the lot or lower the goal)` };
        }
      }
      lots = manualLot;
    }
    const dyn = manualLot > 0 ? null : this.paper.dynamicLotBreakdown(symbol, fill, signal.stopLoss.price);
    if (dyn) {
      if (!dyn.valid || dyn.finalLots <= 0) return { ok: false, reason: dyn.reason };
      lots = dyn.finalLots;
      const goal = settings.minimumProfit > 0 ? settings.minimumProfit : 0;
      if (goal > 0 && signal.takeProfit.tp1 > 0) {
        const asset = getAsset(symbol);
        const tpMove = Math.abs(signal.takeProfit.tp1 - fill);
        const tpQuote = tpMove * lots * asset.contractSize; // price Δ × units
        const tpAccount = this.paper.fx.quoteToAccount(symbol, goalCcy, tpQuote).amount;
        if (tpAccount < goal) {
          return {
            ok: false,
            reason: `goal ${goalCcy} ${goal} unreachable at the largest valid size ${lots} lot (expected ${tpAccount.toFixed(2)} ${goalCcy} at TP) — widen caps or pick a closer TP`,
          };
        }
      }
    } else if (signal.plannedLots && signal.plannedLots > 0) {
      const feas = goalFeasibility({
        symbol,
        accountCurrency: goalCcy,
        capital: settings.availableCapital,
        riskPercent: settings.maxRiskPercent,
        goalProfit: settings.minimumProfit,
        entryPrice: fill,
        stopLossPrice: signal.stopLoss.price,
        takeProfitPrice: signal.takeProfit.tp1,
        usdRate: accountQuoteRate(symbol, goalCcy, (s) => this.marketData.getLatest(s)?.mid),
        maxLeverage: settings.maxLeverage,
        maxMarginUsedPct: settings.maxMarginUsedPct,
        getMid: (s: string) => this.marketData.getLatest(s)?.mid,
      });
      if (!feas.achievable) return { ok: false, reason: feas.reason };
      lots = feas.lots;
    } else {
      const sizing = sizePosition({
        symbol,
        entryPrice: fill,
        stopLossPrice: signal.stopLoss.price,
        settings,
        usdRate: accountQuoteRate(symbol, goalCcy, (s) => this.marketData.getLatest(s)?.mid),
        walletCurrency: goalCcy,
      });
      if (!sizing.valid) return { ok: false, reason: sizing.reason };
      lots = sizing.lots;
    }
    // Trailing stop needs ATR at open time (spec §63).
    const atrSnap = await this.indicators.getSnapshot(symbol, '1h').catch(() => null);
    const atr = atrSnap?.values?.atr14 ?? undefined;
    // Paper fill: real side of the spread + configurable slippage (spec §40-41).
    const pos = await this.paper.openPosition(signal, lots, fill, atr, {
      slippageBps: settings.slippageBps ?? 0,
      // The profit-target exit is measured by the WALLET in its own currency;
      // the goal is DENOMINATED in that same currency (the goal card's labels
      // follow the wallet symbol), so the target passes through unchanged.
      // Sizing above already used goalCcy == wallet currency — the two can
      // never disagree.
      targetProfit: settings.minimumProfit > 0 ? settings.minimumProfit : undefined,
    });
    if (!pos) return { ok: false, reason: 'position open failed' };
    signal.positionId = pos.id;
    await this.signals.updateSignalState(signal, 'POSITION_ACTIVE', `position opened at ${fill}`);
    return { ok: true, position: pos, reason: `position opened at ${fill}` };
  }

  /** Periodic news/calendar refresh timers (free feeds are polled, not pushed). */
  private refreshTimers: ReturnType<typeof setInterval>[] = [];

  /** Polling weights: hot symbols (active signals / strong candidates) poll fastest. */
  private pollingWeights(): Record<string, number> {
    const w: Record<string, number> = {};
    for (const s of this.signals.getActive()) w[s.symbol] = 1;
    for (const r of this.scanner.getRankings()) {
      if (r.decision === 'BUY' || r.decision === 'SELL') w[r.symbol] = Math.max(w[r.symbol] ?? 0, 0.8);
      else if ((r.probability ?? 0) >= 0.6) w[r.symbol] = Math.max(w[r.symbol] ?? 0, 0.4);
    }
    return w;
  }

  private scheduleAnalyze(symbol: string, delayMs: number): void {
    const prev = this.analyzeDebounce.get(symbol);
    if (prev) clearTimeout(prev);
    this.analyzeDebounce.set(symbol, setTimeout(() => {
      this.analyzeDebounce.delete(symbol);
      void this.signals.refreshSymbol(symbol).catch((err) => {
        logger.warn('event-driven analyze failed', { symbol, err: String(err) });
      });
    }, delayMs));
  }

  private symbolsForCurrencies(currencies: Iterable<string>): string[] {
    const set = new Set<string>(currencies);
    return ALL_SYMBOLS.filter((s) => s.split('/').some((c) => set.has(c)));
  }

  async init(): Promise<void> {
    this.store = await createStore();
    this.cache = await createCache();

    // ---- Forex provider (existing) ---------------------------------------
    let forexProvider: MarketDataProvider;
    try {
      forexProvider = config.marketDataProvider === 'FINNHUB'
        ? new FinnhubMarketDataProvider()
        : config.marketDataProvider === 'TWELVEDATA'
          ? new TwelveDataMarketDataProvider()
          : config.marketDataProvider === 'YAHOO'
            ? new YahooFinanceMarketDataProvider()
            : new DemoMarketDataProvider();
      await forexProvider.connect();
    } catch (err) {
      logger.warn('live forex provider unavailable, falling back to DEMO feed', { err: String(err) });
      forexProvider = new DemoMarketDataProvider();
      await forexProvider.connect();
    }

    // ---- Crypto provider (Binance free public API, DEMO fallback) ---------
    let cryptoProvider: MarketDataProvider;
    try {
      cryptoProvider = config.cryptoMarketDataProvider === 'BINANCE'
        ? new BinanceCryptoMarketDataProvider()
        : new DemoMarketDataProvider();
      await cryptoProvider.connect();
    } catch (err) {
      logger.warn('live crypto provider unavailable, falling back to DEMO feed', { err: String(err) });
      cryptoProvider = new DemoMarketDataProvider();
      await cryptoProvider.connect();
    }

    // ---- Routing provider: one interface, two asset classes ---------------
    const marketDataProvider: MarketDataProvider = new RoutingMarketDataProvider(forexProvider, cryptoProvider);
    marketDataProvider.setSymbols?.(ALL_SYMBOLS as unknown as string[]);

    const newsProvider = createNewsProvider();
    const calendarProvider = createCalendarProvider();
    const llmProvider = createLlmProvider();
    // Execution interface: live trading is OFF by default (safety stub).
    const executionProvider = new DisabledExecutionProvider(config.enableLiveTrading);
    // On-chain data (spec §17-18): no free keyless source is configured, so the
    // honest provider reports UNAVAILABLE and crypto analysis runs WITHOUT
    // on-chain features — never fabricated whale/liquidation numbers.
    const onChainProvider = new NoneOnChainProvider();
    await onChainProvider.connect();
    // Normalized crypto exchange adapter (CCXT; metadata + read-only public data).
    const cryptoExchange = new CcxtCryptoExchangeAdapter();
    await cryptoExchange.connect().catch(() => undefined);

    await newsProvider.connect().catch(() => undefined);
    await calendarProvider.connect().catch(() => undefined);

    const events = new EventEmitter();
    this.ctx = {
      store: this.store,
      cache: this.cache,
      providers: { marketData: marketDataProvider, news: newsProvider, calendar: calendarProvider, llm: llmProvider, execution: executionProvider, cryptoExchange, onChain: onChainProvider },
      events,
      audit: new AuditLogger(this.store),
      live: new Map(),
    };

    this.marketData = new MarketDataEngine(this.ctx);
    this.candles = new CandleEngine(this.ctx);
    this.indicators = new IndicatorEngine(this.ctx, this.candles);
    this.multiTimeframe = new MultiTimeframeEngine(this.indicators);
    this.patterns = new PatternEngine(this.indicators);
    this.news = new NewsEngine(this.ctx);
    this.events = new EventEngine(this.ctx);
    this.sentiment = new SentimentEngine(this.ctx);
    this.features = new FeatureEngine(this.ctx);
    this.ai = new AiClient();
    this.portfolioRisk = new PortfolioRiskEngine({
      availableCapital: 10000, maxOpenPositions: 5, maxRiskPercent: 1,
      maxCurrencyExposurePercent: 30, maxCorrelatedPositions: 3,
    } as never);
    this.correlation = new CorrelationEngine(new Map());
    this.circuitBreakers = new CircuitBreakerEngine();
    this.snapshots = new SignalSnapshotEngine(this.ctx);
    this.stateMachine = new SignalStateMachine();
    // Rolling spread/volatility regimes (Phases 4-5). Subscribes to the tick
    // and 1h-candle channels; the signal engine reads spreadStatus() and
    // volatilityStatus() from it.
    this.conditions = new MarketConditionEngine(this.ctx);
    this.alerts = new AlertEngine(this.ctx);
    this.emergencyStop = new EmergencyStopEngine(this.ctx.audit);
    this.signals = new SignalEngine({
      ctx: this.ctx,
      marketData: this.marketData,
      candles: this.candles,
      indicators: this.indicators,
      multiTimeframe: this.multiTimeframe,
      patterns: this.patterns,
      news: this.news,
      events: this.events,
      sentiment: this.sentiment,
      features: this.features,
      ai: this.ai,
      portfolioRisk: this.portfolioRisk,
      correlation: this.correlation,
      circuitBreakers: this.circuitBreakers,
      snapshots: this.snapshots,
      stateMachine: this.stateMachine,
      conditions: this.conditions,
      alerts: this.alerts,
      emergencyStop: this.emergencyStop,
      // The goal (minimum profit) is denominated in the LIVE wallet currency:
      // the user's setting until an MT5 account binds, then the account's own
      // currency — sizing must never disagree with the wallet that measures
      // the profit target.
      walletCurrency: () => this.paper.getAccount()?.currency,
      // Fractional-Kelly risk cap source (quant-trading-bot adoption): the
      // wallet's recent closed trades. Lazy because `paper` is built below.
      kellyStats: () => this.paper.recentTrades(60),
      // § margin engine: the paper engine owns margin pricing over LIVE broker
      // specs + conversion; the gates call this instead of recomputing their
      // own version. Lazy same as kellyStats.
      marginPerLot: (symbol, direction) => {
        try {
          return this.paper.marginPerLot(symbol, direction);
        } catch {
          return null;
        }
      },
    });
    this.scanner = new ScannerEngine(this.ctx, this.signals);
    this.paper = new PaperTradingEngine(this.ctx, this.marketData, this.signals, {
      // Lazy: the broker binding is constructed further down, but provenance is
      // only ever asked for at fill/exit time.
      termsProvenance: (symbol) => {
        try {
          return this.broker?.termsProvenance(symbol) ?? null;
        } catch {
          return null;
        }
      },
    });
    // MT5 demo mirror: every paper OPEN/CLOSE is queued as a command for the
    // local trader.py worker, which executes it on the MetaTrader 5 demo
    // account. Dashboard stays source of truth; failures never block paper.
    // Broker account binding. The platform trades the account the user selects
    // (XM Ultra Low Standard by default); its real conditions come from the
    // bound MT5 account and from operator confirmations — never from constants.
    this.policySource = new BrokerPolicySource(this.ctx.store, this.ctx.events, {
      id: 'xm-account-terms',
      url: config.brokerPolicyUrl,
      refreshIntervalMs: config.brokerPolicyRefreshMs,
    });
    this.broker = new AccountProfileService(this.ctx.store, this.ctx.events, this.policySource, {
      getFx: () => {
        const t = this.marketData?.getLatest(INR_RATE_SYMBOL);
        if (!t || !Number.isFinite(t.mid)) return null;
        return { pair: INR_RATE_SYMBOL, rate: t.mid, source: t.source, at: t.receivedAt ?? t.timestamp };
      },
      platformSpec: (symbol) => {
        try {
          const a = getAsset(symbol);
          return { contractSize: a.contractSize, minLot: a.minimumLot, maxLot: a.maximumLot, lotStep: a.lotStep, pipSize: a.pipSize };
        } catch {
          return null;
        }
      },
      // account_info.leverage from the bound MT5/XM account becomes the
      // margin rate for sizing, gates and margin checks (catalog only unbound).
      setAccountLeverage,
      // Live broker lot geometry replaces the built-in assumptions, so lot
      // sizes follow the SELECTED ACCOUNT (e.g. a micro-style contract).
      applyBrokerSpecs: (specs) => {
        const applied = setBrokerSpecOverrides(specs.map((s) => ({
          symbol: s.platformSymbol,
          contractSize: s.contractSize,
          volumeMin: s.volumeMin,
          volumeMax: s.volumeMax,
          volumeStep: s.volumeStep,
          stopsLevelPoints: s.stopsLevelPoints,
        })));
        if (applied) logger.info('broker lot specs applied to sizing engine', { symbols: applied });
      },
      allowReal: () => config.allowRealTrading,
      accountCurrency: () => this.brokerAccountCurrency,
      // Per-symbol costs are priced on the tick the platform is actually
      // trading on: the broker's live spread as the price stream sees it, with
      // the terminal's own symbol_info spread as the fallback.
      liveSpread: (symbol) => {
        const t = this.marketData.getLatest(symbol);
        if (!t) return null;
        // Only the BROKER's own quote feed may define what this account pays.
        // A third-party aggregator's bid/ask is usually MODELLED (and for some
        // pairs rounded too coarsely to be price-accurate), so for those the
        // terminal's `symbol_info.spread` — the broker's own number — is used
        // instead. When the local MT5 bridge is streaming, its quotes take over
        // automatically and the cost becomes the broker's live spread.
        const brokerFeed = !t.spreadModeled && String(t.source).toUpperCase() === 'MT5';
        if (!brokerFeed) return null;
        const quoted = t.ask - t.bid;
        if (Number.isFinite(quoted) && quoted > 0) return quoted;
        return Number.isFinite(t.spread) && t.spread > 0 ? t.spread : null;
      },
      // Quote/USD → account currency over LIVE rates only (the paper engine's
      // conversion service owns the freshness rules). null = no rate, which the
      // cost model surfaces as "unknown" rather than pricing at a fixed number.
      convertQuoteToAccount: (symbol, amount) => {
        try {
          const r = this.paper.fx.quoteToAccount(symbol, this.brokerAccountCurrency, amount);
          return { amount: r.amount, source: r.source, at: r.rateTimestamp || Date.now() };
        } catch {
          return null;
        }
      },
      convertUsdToAccount: (usd) => {
        try {
          if (this.brokerAccountCurrency === 'USD') return { amount: usd, source: 'identity (USD account)', at: Date.now() };
          const r = this.paper.fx.usdToAccount(this.brokerAccountCurrency, usd);
          return { amount: r.amount, source: r.source, at: r.rateTimestamp || Date.now() };
        } catch {
          return null;
        }
      },
      maxAccountAgeMs: config.brokerAccountMaxAgeMs,
    });
    await this.broker.init(
      config.brokerAccountType
        ? { broker: config.brokerId as BrokerId, accountType: config.brokerAccountType }
        : undefined,
    );
    this.policySource.start();

    this.mt5Mirror = new Mt5MirrorService(this.ctx.store, this.ctx.events, {
      isEnabled: () => config.internalApiToken !== '',
      // No order reaches the terminal unless the bound account is verified.
      executionGate: () => this.broker.liveGate(),
      // Symbol lock (XM/MT5 pattern): dispatch only ever carries orders for
      // the locked symbol; everything else holds PENDING.
      symbolLock: () => this.symbolLockCache,
      getOpenPaperPositions: () => this.paper.getOpenPositions().map((p) => ({
        id: p.id, signalId: p.signalId, symbol: p.symbol,
        direction: p.direction, lots: p.lots,
        stopLoss: p.stopLoss ?? null,
        takeProfit1: p.takeProfit1 ?? null,
        takeProfit2: p.takeProfit2 ?? null,
      })),
      onOpenFailed: async (positionId: string, error: string) => {
        const pos = this.paper.getOpenPositions().find((p) => p.id === positionId);
        if (!pos) return;
        await this.paper.closePosition(pos, pos.currentPrice ?? pos.entryPrice, 'MT5_MIRROR_FAILED');
        logger.warn('paper position closed — mt5 mirror open failed', { positionId, symbol: pos.symbol, error });
      },
    });
    // Persisted-queue recovery: backend restarts must not orphan DISPATCHED
    // mirror commands — requeue them so the worker re-serves them.
    await this.mt5Mirror.recoverAfterRestart().catch(() => undefined);
    // Broker→dashboard reconciliation: closes paper positions the broker's
    // server-side SL/TP already closed, and surfaces volume divergences.
    this.reconciliation = new Mt5ReconciliationService(this.ctx.store, this.paper, this.alerts);
    // Advisory skfolio analytics — never gating. Needs paper engine for notional weights.
    this.portfolioAnalytics = new PortfolioAnalytics(this.ai, this.candles, this.paper);
    this.backtest = new BacktestEngine(this.ctx, this.ai);
    this.models = new ModelRegistry(this.ctx, this.ai);
    this.drift = new DriftEngine(this.ctx);
    this.health = new SystemHealthEngine(this.ctx, this.marketData, this.news, this.events, this.ai, this.store, this.cache, this.models);

    // wire live tick fan-out: paper trading + entry/SL/TP crossing checks run on
    // every tick with the FULL tick (bid/ask included when the feed provides it,
    // e.g. the MT5 bridge). Paper fills use the real side of the spread.
    this.ctx.events.on(CHANNELS.tick, (tick: Tick) => {
      METRICS.ticksReceived().inc();
      void this.paper.onTick(tick);
      // The USD/INR rate feed moves the WALLET-currency value of every open
      // position between the traded pairs' own ticks. The paper engine handles
      // the rate tick itself; re-marking here as well is the realtime belt:
      // without it a quiet pair (weekend FX, thin session) leaves P&L frozen
      // while the conversion rate is visibly moving.
      if (tick.symbol === INR_RATE_SYMBOL) void this.paper.reMarkAll();
      void this.signals.refreshSignal(tick);
      // Every tick also retries pending entries (ENTRY_REACHED signals whose
      // gate was blocked, e.g. single-position mode): the instant the open
      // position closes, the next waiting signal trades automatically.
      void this.autoTradeEntry(tick.symbol);
    });

    // ---- MT5 MIRROR (BROKER-GATED) -----------------------------------------
    // Every auto/manual paper OPEN is dispatched to the bound MT5 account's
    // real balance; every close (SL/TP/profit-target/dynamic exit/MANUAL)
    // closes there too, so the dashboard ledger and the MT5 account stay in
    // sync and trades appear in BOTH places.
    //
    // Dispatch is gated by the broker account binding (AccountProfileService):
    // an unbound/stale terminal, an unknown or contest trade mode, a currency
    // mismatch or unverified sizing terms hold every order in the queue. A
    // failed MT5 fill is surfaced as mt5Error but never blocks the paper side.
    this.ctx.events.on(CHANNELS.position, (pos: { id?: string; signalId?: string; symbol?: string; direction?: string; lots?: number; status?: string; stopLoss?: number | null; takeProfit1?: number | null; takeProfit2?: number | null }) => {
      if (!pos || typeof pos.id !== 'string') return;
      if (pos.status === 'OPEN' && pos.symbol && pos.direction && typeof pos.lots === 'number' && pos.lots > 0) {
        void this.mt5Mirror.queueOpen({
          id: pos.id,
          signalId: pos.signalId ?? '',
          symbol: pos.symbol,
          direction: pos.direction as 'BUY' | 'SELL',
          lots: pos.lots,
          stopLoss: pos.stopLoss ?? null,
          takeProfit1: pos.takeProfit1 ?? null,
          takeProfit2: pos.takeProfit2 ?? null,
        }).catch((err) => logger.warn('mt5 mirror queueOpen failed', { err: String(err) }));
      }
      if (pos.status === 'CLOSED') {
        void this.mt5Mirror.queueClose(pos.id).catch((err) =>
          logger.warn('mt5 mirror queueClose failed', { err: String(err) }));
      }
    });

    // ---- MT5 BALANCE SYNC -> PAPER WALLET ----------------------------------
    // The trader worker heartbeats the LIVE account balance/equity in the
    // account's own currency. The wallet ADOPTS that currency and mirrors the
    // figures directly (the broker-platform pattern — an XM dashboard shows
    // the account's money, never a converted version of it): sizing
    // (dynamicLotBreakdown) reads the synced free-margin, and profit-target
    // closes are measured in the same unit the account settles in.
    this.ctx.events.on('mt5:mirror-status', (status: unknown) => {
      const s = status as { accountInfo?: Partial<Mt5AccountSnapshot> | null };
      if (s?.accountInfo && Number.isFinite(s.accountInfo.balance) && s.accountInfo.currency) {
        // The bound account is the realtime broker feed: currency, leverage,
        // margin levels and per-symbol contract specs all come from it.
        const snapshot: Mt5AccountSnapshot = {
          login: Number(s.accountInfo.login ?? 0),
          server: String(s.accountInfo.server ?? ''),
          company: s.accountInfo.company,
          currency: String(s.accountInfo.currency),
          balance: Number(s.accountInfo.balance),
          equity: s.accountInfo.equity,
          profit: s.accountInfo.profit,
          margin: s.accountInfo.margin,
          freeMargin: s.accountInfo.freeMargin,
          leverage: s.accountInfo.leverage,
          tradeMode: (s.accountInfo.tradeMode ?? 'UNKNOWN') as Mt5TradeMode,
          marginCallLevelPct: s.accountInfo.marginCallLevelPct,
          stopOutLevelPct: s.accountInfo.stopOutLevelPct,
          symbolSpecs: s.accountInfo.symbolSpecs,
          observedAt: Date.now(),
        };
        void this.broker.noteMt5Account(snapshot).catch((err) =>
          logger.warn('broker account binding update failed', { err: String(err) }));
        void this.paper.syncFromMt5(snapshot).catch((err) =>
          logger.warn('mt5 balance sync failed', { err: String(err) }));
      }
      // No account info at all = the trader worker went away: the binding is
      // no longer live, so the gate must close rather than assume.
      if (s && !s.accountInfo) {
        void this.broker.noteMt5Account(null).catch(() => undefined);
        void this.alerts.emit('DATA_FAILURE', 'MT5 trader worker went offline — the broker binding is no longer live, orders are held', undefined, 'WARNING').catch(() => undefined);
      }
    });

    // ---- AUTO PAPER EXECUTION --------------------------------------------
    // When a signal's entry is reached, open a simulated position at the real
    // side of the spread (BUY fills at ask, SELL fills at bid). This is the
    // paper execution workflow from Phase 51 — never real money.
    this.ctx.events.on(CHANNELS.signalState, (u: { signalId: string; symbol: string; state: SignalState }) => {
      if (u.state !== 'ENTRY_REACHED') return;
      if (this.emergencyStop.isTriggered()) {
        const blocked = this.signals.getActive(u.symbol).find((s) => s.id === u.signalId);
        if (blocked) void this.signals.updateSignalState(blocked, 'INVALIDATED', 'emergency stop active — no new orders');
        return;
      }
      void this.autoTradeEntry(u.symbol);
    });

    // ---- DYNAMIC EXITS (spec §44) ----------------------------------------
    // An open paper position is closed when its signal is invalidated for a
    // structural reason (direction change / regime reversal / trend shift) or
    // when a NEW opposite signal appears for the same symbol. Pure TP/SL/
    // trailing management stays in PaperTradingEngine.onTick.
    this.ctx.events.on(CHANNELS.signalInvalidated, (u: { signalId: string; symbol: string; state: SignalState; note: string }) => {
      const note = u.note ?? '';
      const structural = /direction|regime|reversal|trend|news|EV|expected value/i.test(note);
      if (!structural) return;
      const reason = /regime|direction|reversal|trend/i.test(note) ? 'REGIME_REVERSAL' : 'INVALIDATED';
      void this.paper.closePositionForSignal(u.signalId, reason).catch((err) =>
        logger.warn('dynamic exit failed', { signalId: u.signalId, err: String(err) }));
    });
    this.ctx.events.on(CHANNELS.signalCreated, (sig: Signal) => {
      for (const pos of this.paper.getOpenPositions()) {
        if (pos.symbol === sig.symbol && pos.direction !== sig.direction) {
          void this.paper.closePositionForSignal(pos.signalId, 'OPPOSITE_SIGNAL').catch((err) =>
            logger.warn('opposite-signal exit failed', { signalId: pos.signalId, err: String(err) }));
        }
      }
    });

    // ---- EVENT-DRIVEN SIGNAL ENGINE --------------------------------------
    // A completed candle on an analysis timeframe triggers immediate re-analysis
    // (no waiting for the next scanner sweep). Intraday closes re-analyze hot
    // symbols only, so ML calls stay bounded.
    this.ctx.events.on(CHANNELS.candle, (candle: Candle) => {
      if (!candle.completed) return;
      if (candle.timeframe === '1h' || candle.timeframe === '4h' || candle.timeframe === '1D') {
        this.scheduleAnalyze(candle.symbol, 200);
      } else if (candle.timeframe === '5m' || candle.timeframe === '15m') {
        const weights = this.pollingWeights();
        if ((weights[candle.symbol] ?? 0) >= 0.4) this.scheduleAnalyze(candle.symbol, 500);
      }
    });
    // Fresh news → re-analyze affected pairs immediately.
    this.ctx.events.on(CHANNELS.news, (items: NewsItem[]) => {
      const currencies = new Set<string>();
      for (const n of items) for (const c of n.currencies ?? []) currencies.add(c);
      if (currencies.size === 0) return;
      for (const symbol of this.symbolsForCurrencies(currencies)) this.scheduleAnalyze(symbol, 300);
    });
    // Calendar refresh → re-analyze pairs with affected currencies.
    this.ctx.events.on(CHANNELS.calendar, (events: EconomicEvent[]) => {
      const currencies = new Set<string>();
      for (const e of events) if (e.currency) currencies.add(e.currency);
      if (currencies.size === 0) return;
      for (const symbol of this.symbolsForCurrencies(currencies)) this.scheduleAnalyze(symbol, 300);
    });
  }

  async start(): Promise<void> {
    await this.news.refresh(true).catch(() => undefined);
    await this.events.refresh(true).catch(() => undefined);
    const bootSettings = await this.signals.loadSettings();
    this.noteAccountCurrency(bootSettings.accountCurrency);
    this.noteSymbolLock(bootSettings.symbolLock);
    await this.paper.init(bootSettings);
    // The portfolio-risk engine used to enforce HARDCODED defaults after every
    // restart until the user re-saved settings — stored caps were ignored.
    this.portfolioRisk.updateSettings(bootSettings);
    // preload historical candles BEFORE polling starts so the free-tier request
    // budget is not shared with live quotes (a shared bucket would stretch the
    // preload from ~1 minute to several).
    const preloadTfs = this.ctx.providers.marketData.preloadTimeframes ?? ([...TIMEFRAMES] as const);
    const now = Date.now();
    for (const symbol of ALL_SYMBOLS) {
      try {
        for (const tf of preloadTfs) {
          const tfMs = TIMEFRAME_MS[tf];
          const bars = Math.max(60, Math.min(300, Math.floor((24 * 3600_000) / tfMs) + 120));
          const from = now - bars * tfMs;
          const history = await this.ctx.providers.marketData.getHistoricalCandles(symbol, tf, from, now);
          if (history.length) await this.candles.seed(symbol, tf, history);
        }
        const candles = this.candles.getCandles(symbol, '1h', 200);
        this.correlation.setCandles(symbol, candles.map((c) => ({ openTime: c.openTime, close: c.close })));
      } catch (err) {
        logger.warn('history preload failed', { symbol, err: String(err) });
      }
    }
    await this.marketData.start(() => this.pollingWeights());
    // Keep news and the calendar fresh in the background (the engines' own
    // min-interval gates prevent hammering the free feeds).
    this.refreshTimers.push(setInterval(() => void this.news.refresh().catch(() => undefined), 5 * 60_000));
    this.refreshTimers.push(setInterval(() => void this.events.refresh().catch(() => undefined), 15 * 60_000));
    // CANDLE RESYNC (spec §5): after a provider disconnect/restart the missed
    // history is back-filled from the provider so indicator windows never have
    // holes. Cheap per-symbol check; fetches only when a gap actually exists.
    // Skipped entirely while the MT5 bridge streams (it preloads and fills
    // history itself — provider back-fill would mix Yahoo bars into MT5 data).
    this.refreshTimers.push(setInterval(() => {
      if (this.marketData.isBridgeActive()) return;
      const tfs = this.ctx.providers.marketData.preloadTimeframes ?? ([...TIMEFRAMES] as const);
      void (async () => {
        for (const symbol of ALL_SYMBOLS) {
          for (const tf of tfs) {
            try {
              await this.candles.resyncMissing(symbol, tf);
            } catch {
              /* per-symbol resync failures are non-fatal */
            }
          }
          // Correlation matrix refresh: the matrix used to be built ONCE at
          // boot — after weeks of uptime the MAX_CORRELATED_POSITIONS breaker
          // enforced relationships frozen at startup.
          try {
            const candles = this.candles.getCompletedCandles(symbol, '1h', 200);
            if (candles.length >= 30) {
              this.correlation.setCandles(symbol, candles.map((c) => ({ openTime: c.openTime, close: c.close })));
            }
          } catch {
            /* non-fatal */
          }
        }
      })();
    }, 60_000));
    // LIVE SIGNAL REFRESH — re-run the full pipeline for every symbol with an
    // active signal so probability / EV / regime / risk / levels track the
    // market in real time instead of freezing at signal creation. The engine
    // updates the existing signal in place (same id/state, fresh analytics).
    this.refreshTimers.push(setInterval(() => {
      for (const s of this.signals.getActive()) this.scheduleAnalyze(s.symbol, 100);
    }, 15_000));
    await this.scanner.start(config.scannerIntervalMs);
    logger.info('container started');
  }

  async stop(): Promise<void> {
    this.scanner.stop();
    this.policySource?.stop();
    for (const t of this.refreshTimers) clearInterval(t);
    this.refreshTimers = [];
    // Pending analyze-debounce timeouts fire AFTER the store disconnects and
    // crash against a closed store — clear them with the rest.
    for (const t of this.analyzeDebounce.values()) clearTimeout(t);
    this.analyzeDebounce.clear();
    await this.marketData.stop();
    await this.cache.disconnect();
    await this.store.disconnect();
  }
}
