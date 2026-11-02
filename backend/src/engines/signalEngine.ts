/**
 * Signal engine. Orchestrates the complete decision pipeline:
 *
 *   DATA VALID -> REGIME -> TECHNICAL SETUP -> HISTORICAL SUPPORT -> ML ->
 *   NEWS/EVENT CHECK -> EXPECTED VALUE -> ENTRY/SL/TP -> R:R -> SIZING ->
 *   PORTFOLIO RISK -> CORRELATION -> CIRCUIT BREAKERS -> UNCERTAINTY -> DECISION
 *
 * Every stage can veto. The engine never forces BUY/SELL; WAIT / NO_TRADE /
 * INSUFFICIENT_CONFIDENCE are always valid outputs. It also maintains the
 * live signal lifecycle (create / update / invalidate / missed).
 */
import {
  Candle, Decision, MarketRegimeSnapshot, Signal, SignalEvidence, SignalState, Timeframe, Tick,
  CurrencySentiment, EconomicEvent, NewsItem, DataQualityReport, PriceActionAnalysis, Levels,
  PaperPosition, GoalAnalysis, UserSettings, PaperTrade,
} from '@fx/shared';
import { DEFAULT_MAX_SPREAD_PIPS, assetClassFor, getAsset, priceToPips } from '@fx/shared';
import { FxContext, CHANNELS } from '../core/context';
import { config } from '../config';
import { rollWindow, dayWindowKey, weekWindowKey } from '../math/paperMath';
import { kellyRiskCap } from '../math/kelly';
import { logger } from '../core/logger';
import { MarketDataEngine } from './marketDataEngine';
import { CandleEngine } from './candleEngine';
import { IndicatorEngine } from './indicatorEngine';
import { MultiTimeframeEngine } from './multiTimeframeEngine';
import { analyzePriceAction } from './priceActionEngine';
import { computeLevels, entryTooCloseToLevel } from './supportResistanceEngine';
import { marketState, sessionSnapshot, isWeekendGapRiskWindow } from './sessionEngine';
import { MarketConditionEngine } from './marketConditionEngine';
import { PatternEngine, PatternResult } from './patternEngine';
import { NewsEngine } from './newsEngine';
import { EventEngine, EventRiskResult } from './eventEngine';
import { SentimentEngine } from './sentimentEngine';
import { detectRegime } from './regimeEngine';
import { selectStrategy, StrategySelection } from './strategyEngine';
import { FeatureEngine, FeatureContextInput, FEATURE_VERSION } from './featureEngine';
import { AiClient } from '../ai/aiClient';
import { calculateExpectedValue, EvInput } from './expectedValueEngine';
import { accountQuoteRate, goalFeasibility, quotePerUsdLive, quoteToAccountStrict, toAccountCurrency } from '../math/forexMath';
import { buildEntry } from './entryEngine';
import { buildStopLoss } from './stopLossEngine';
import { buildTakeProfit } from './takeProfitEngine';
import { sizePosition } from './positionSizingEngine';
import { PortfolioRiskEngine } from './portfolioRiskEngine';
import { CorrelationEngine } from './correlationEngine';
import { CircuitBreakerEngine } from './circuitBreakerEngine';
import { classifyRisk } from './riskClassificationEngine';
import { evaluateUncertainty } from './uncertaintyEngine';
import { assessQuality } from './dataQualityEngine';
import { SignalStateMachine, isPreEntryState, signalExpired } from './signalStateMachine';
import { SignalSnapshotEngine, SnapshotInput } from './signalSnapshot';
import { AlertEngine } from './alertEngine';
import { EmergencyStopEngine } from './emergencyStopEngine';
import { effectiveSpec } from '../forex/symbol-spec';
import {
  brokerAccountCosts,
  brokerSpreadPerLot,
  brokerSwapQuotePerLotNight,
  plannedCommissionUsdPerLot,
} from '../broker/cost-registry';
import { METRICS } from '../ops/metrics';

export interface AnalyzeResult {
  symbol: string;
  decision: Decision;
  reason: string;
  state: SignalState;
  signal?: Signal;
  dataQuality?: DataQualityReport;
  probability?: number;
  /** Market regime detected for this symbol, even when no signal is produced. */
  regime?: MarketRegimeSnapshot['regime'];
  blockedBy: string[];
  /** Portfolio-level limits (positions full, margin cap…) that defer entry to
   *  fill time instead of blocking signal creation — signals stay visible. */
  deferredBlocks?: string[];
}

export interface SignalEngineDeps {
  ctx: FxContext;
  marketData: MarketDataEngine;
  candles: CandleEngine;
  indicators: IndicatorEngine;
  multiTimeframe: MultiTimeframeEngine;
  patterns: PatternEngine;
  news: NewsEngine;
  events: EventEngine;
  sentiment: SentimentEngine;
  features: FeatureEngine;
  ai: AiClient;
  portfolioRisk: PortfolioRiskEngine;
  correlation: CorrelationEngine;
  circuitBreakers: CircuitBreakerEngine;
  snapshots: SignalSnapshotEngine;
  stateMachine: SignalStateMachine;
  alerts: AlertEngine;
  emergencyStop: EmergencyStopEngine;
  /** Rolling spread/volatility regimes (Phase 4-5). */
  conditions: MarketConditionEngine;
  /** Live wallet currency (the paper account's). The GOAL is denominated in
   *  it: the user's setting until an MT5 account binds, then the account's
   *  own currency (the wallet follows the account — XM pattern). */
  walletCurrency?: () => string | undefined;
  /** Recent CLOSED trades for the fractional-Kelly risk cap (quant-trading-bot
   *  adoption). Lazy: the paper engine may not exist when the signal engine is
   *  constructed; the closure is only invoked at decision time. */
  kellyStats?: () => Promise<PaperTrade[]>;
  /** Per-symbol margin rate in account-currency per 1 lot (§ margin engine):
   *  computed by the paper engine over LIVE broker specs (contract size,
   *  leverage, conversion). The gates reuse it so sizing, margin checks and
   *  fills can never disagree — one number, one truth. */
  marginPerLot?: (symbol: string, direction?: 'BUY' | 'SELL') => number | null;
}

export class SignalEngine {
  private activeSignals = new Map<string, Signal>();
  /** Historical-pattern cache with a TTL — without one, patternBias and the
   *  ML historical features froze at whatever existed at first boot. */
  private static PATTERN_CACHE_TTL_MS = 15 * 60_000;
  private historicalProbabilityCache = new Map<string, { pattern: PatternResult; at: number }>();
  /** Cached real account risk state (5s TTL) — feeds the circuit breakers. */
  private accountRiskCache: { at: number; dailyPnlPct: number; weeklyPnlPct: number; drawdownPct: number; consecutiveLosses: number } | null = null;

  private cachedPattern(symbol: string, force: boolean): PatternResult | undefined {
    const hit = this.historicalProbabilityCache.get(symbol);
    if (!force && hit && Date.now() - hit.at < SignalEngine.PATTERN_CACHE_TTL_MS) return hit.pattern;
    return undefined;
  }

  /**
   * Drop the cached account-risk snapshot. Must run whenever risk counters
   * change OUTSIDE the close path (e.g. a user-initiated breaker reset) —
   * otherwise the fill gate keeps refusing on stale numbers for up to its
   * 5s TTL, and a Reset→Trade click appears to do nothing.
   */
  invalidateAccountRiskCache(): void {
    this.accountRiskCache = null;
  }
  /** Per-symbol last-known regime (Phase 6) — transition detection. */
  private lastRegime = new Map<string, { regime: MarketRegimeSnapshot['regime']; at: number }>();
  /** Latest goal-mode analysis per symbol (Goal mode). */
  private goalAnalyses = new Map<string, GoalAnalysis>();
  /** Symbol → id of the active goal signal (Goal mode), so re-scans refresh
   *  the same signal in place instead of churning new identities. */
  private goalSignalIds = new Map<string, string>();

  constructor(private deps: SignalEngineDeps) {}

  getActive(symbol?: string): Signal[] {
    const all = [...this.activeSignals.values()];
    return symbol ? all.filter((s) => s.symbol === symbol) : all;
  }

  /** Instruments the scanner should analyze (Phase 23): the selected whitelist
   *  ∩ not-disabled, minus disabled asset classes. */
  async enabledSymbols(): Promise<string[]> {
    const settings = await this.loadSettings();
    const selected = settings.selectedPairs ?? [];
    const disabled = settings.disabledAssets ?? [];
    const disabledClasses = settings.disabledAssetClasses ?? [];
    const all = await this.deps.ctx.providers.marketData.getSymbols();
    // Symbol lock FIRST (XM/MT5 pattern): when set, signals exist for that
    // symbol only — the scanner never sweeps anything else, whatever the
    // watchlist says.
    const lock = (settings.symbolLock ?? '').toUpperCase() || null;
    if (lock) {
      return all.filter((s) => s.toUpperCase() === lock && !disabled.includes(s) && !disabledClasses.includes(assetClassFor(s)));
    }
    return all.filter((s) =>
      (selected.length === 0 || selected.includes(s)) &&
      !disabled.includes(s) &&
      !disabledClasses.includes(assetClassFor(s)));
  }

  async loadSettings(): Promise<UserSettings> {
    try {
      const stored = await this.deps.ctx.store.findOne<UserSettings>('userSettings', {});
      if (stored) return { ...defaultSettings(), ...stored };
    } catch {
      /* fall through to defaults */
    }
    return defaultSettings();
  }

  /**
   * Real account risk state (spec §34): daily/weekly P&L, drawdown and
   * consecutive losses come from the paper account — never hardcoded zeros.
   * Cached briefly because the scanner calls this per symbol per sweep.
   */
  private async accountRiskState(): Promise<{ dailyPnlPct: number; weeklyPnlPct: number; drawdownPct: number; consecutiveLosses: number }> {
    const now = Date.now();
    if (this.accountRiskCache && now - this.accountRiskCache.at < 5_000) return this.accountRiskCache;
    let state = { dailyPnlPct: 0, weeklyPnlPct: 0, drawdownPct: 0, consecutiveLosses: 0 };
    try {
      const acct = await this.deps.ctx.store.findOne<{
        startingBalance: number; dailyPnl: number; dailyPnlResetAt?: number; weeklyPnl: number; weeklyPnlResetAt?: number; maxDrawdownPct: number; consecutiveLosses: number;
      }>('paperAccounts', {});
      if (acct && (acct.startingBalance ?? 0) > 0) {
        const sb = acct.startingBalance;
        // Roll the UTC windows BEFORE reading them — after midnight the stored
        // counters still hold yesterday's loss until the next trade closes,
        // and breakers/UI would misreport daily headroom for up to 24h.
        const dayRoll = rollWindow(acct.dailyPnl ?? 0, acct.dailyPnlResetAt ?? 0, now, dayWindowKey);
        const weekRoll = rollWindow(acct.weeklyPnl ?? 0, acct.weeklyPnlResetAt ?? 0, now, weekWindowKey);
        state = {
          dailyPnlPct: dayRoll.value / sb * 100,
          weeklyPnlPct: weekRoll.value / sb * 100,
          drawdownPct: acct.maxDrawdownPct ?? 0,
          consecutiveLosses: acct.consecutiveLosses ?? 0,
        };
      }
    } catch {
      /* no paper account yet — zeros are correct */
    }
    this.accountRiskCache = { at: now, ...state };
    return this.accountRiskCache;
  }

  /**
   * Sizing/conversion rate (units of quote currency per 1 unit of the account
   * currency) from LIVE cross rates — USD/INR for INR accounts. Falls back to
   * the USD convention while the rate feed is silent (never invents prices).
   */
  private accountRate(symbol: string, accountCurrency: string): number {
    return accountQuoteRate(symbol, accountCurrency, (s) => this.deps.marketData.getLatest(s)?.mid);
  }

  /**
   * XAU/USD 10-bar rate of change in % (XAUUSD-LSTM adoption) from COMPLETED
   * candles only — no lookahead. Neutral (undefined) when gold history is not
   * resident or the symbol IS gold.
   */
  private goldRoc10(symbol: string, tf: Timeframe): number | undefined {
    if (symbol === 'XAU/USD') return undefined;
    try {
      const candles = this.deps.candles.getCompletedCandles('XAU/USD', tf, 11);
      if (candles.length < 11) return undefined;
      const now = candles[candles.length - 1].close;
      const before = candles[0].close;
      if (!before) return undefined;
      return ((now - before) / before) * 100;
    } catch {
      return undefined;
    }
  }

  /** STRICT quote-currency → account-currency conversion. Returns undefined
   *  when no honest cross-rate path exists — callers fail closed. A silent
   *  parity here treated JPY-quoted notionals as USD (~157× inflation) and
   *  mis-drove currency-exposure breakers, portfolio risk preflight and the
   *  minimum-profit gate (USD/JPY entries were silently untradeable). */
  private toAccount(symbol: string, accountCurrency: string, quoteAmount: number): number | undefined {
    return quoteToAccountStrict(symbol, accountCurrency, quoteAmount, (s) => this.deps.marketData.getLatest(s)?.mid);
  }

  /**
   * Fill-time safety re-check (spec §70/§122): account state may have changed
   * since the signal was created (daily loss, drawdown, max positions,
   * consecutive losses). Anything tripped -> NO ORDER.
   */
  async evaluateEntryGate(symbol: string, signal: Signal, settings: UserSettings): Promise<{ ok: boolean; reason: string }> {
    const acct = await this.accountRiskState();
    const positions = await this.deps.ctx.store.find<any>('paperPositions', { status: 'OPEN' });
    const openPositions = positions as Array<{ symbol: string; direction: 'BUY' | 'SELL'; lots: number; entryPrice: number }>;
    const equity = settings.availableCapital;
    const symbols = [symbol, ...openPositions.map((p) => p.symbol)];
    // Currency exposure in ACCOUNT currency: portfolioRisk.assess compares raw
    // quote-currency notionals (JPY/CAD/...) against the account equity, mixing
    // units and overstating JPY-quoted pairs ~100×. Recompute the largest net
    // per-currency exposure in real money so the % is meaningful vs equity.
    const netByCurrency: Record<string, number> = {};
    for (const p of openPositions) {
      // An orphaned/delisted position (symbol left the asset master) must
      // degrade to "skipped", never throw out of the fill gate — one stale DB
      // row used to block EVERY entry process-wide.
      let pa: ReturnType<typeof getAsset>;
      try {
        pa = getAsset(p.symbol);
      } catch {
        continue;
      }
      const [base, quote] = p.symbol.split('/');
      const notional = (p.lots ?? 0) * pa.contractSize * (p.entryPrice ?? 0);
      // Exposure is compared against the wallet's equity — wallet currency.
      // Unknown conversion rate ⇒ infinite exposure (fail closed): the
      // breaker must trip rather than under-count a leg we cannot price.
      const legAccount = this.toAccount(p.symbol, this.goalCurrencyFor(settings), notional) ?? Number.POSITIVE_INFINITY;
      const longCur = p.direction === 'BUY' ? base : quote;
      const shortCur = p.direction === 'BUY' ? quote : base;
      netByCurrency[longCur] = (netByCurrency[longCur] ?? 0) + legAccount;
      netByCurrency[shortCur] = (netByCurrency[shortCur] ?? 0) - legAccount;
    }
    const maxNetExposure = Object.values(netByCurrency).reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    const breakers = this.deps.circuitBreakers.evaluate({
      settings,
      dailyPnlPct: acct.dailyPnlPct,
      weeklyPnlPct: acct.weeklyPnlPct,
      drawdownPct: acct.drawdownPct,
      consecutiveLosses: acct.consecutiveLosses,
      openPositions: openPositions.length,
      correlatedPositions: this.deps.circuitBreakers.countCorrelated(symbols, this.deps.correlation.matrix(symbols, 50)),
      leverage: 0,
      currencyExposurePct: equity > 0 ? maxNetExposure / equity * 100 : 0,
    });
    if (breakers.triggered) {
      return { ok: false, reason: `circuit breaker at fill: ${breakers.activeBreakers.join(', ')}` };
    }
    // ---- Multi-position entries: real-broker free-margin semantics ----------
    // Like MT5: the ONLY aggregate cap is free margin — the candidate's margin
    // is summed with every open position's margin and checked against
    // maxMarginUsedPct (margin/equity, i.e. the stop-out line). Leverage is a
    // per-position cap (the broker's offered leverage), never summed across the
    // portfolio. So goal mode opens SEVERAL positions at once while margin
    // allows; when margin runs out the entry is deferred — the signal stays
    // alive and retries on the next tick. This also replaces the old hard
    // single-position block: with free margin a new position opens even in
    // single-position mode; only the margin cap defers it.
    // Margin/exposure here are checked against EQUITY — the paper wallet's
    // own currency (the user's setting until an MT5 account binds, then the
    // account's). Every conversion below must use it, or the caps would be
    // evaluated in mismatched units.
    const walletCcy = this.goalCurrencyFor(settings);
    const lotsFor = signal.plannedLots && signal.plannedLots > 0
      ? signal.plannedLots
      : (() => {
          const s = sizePosition({
            symbol,
            entryPrice: this.deps.marketData.getLatest(symbol)?.mid ?? signal.entry.preferredEntry,
            stopLossPrice: signal.stopLoss.price,
            settings,
            usdRate: this.accountRate(symbol, walletCcy),
            walletCurrency: walletCcy,
          });
          return s.valid ? s.lots : 0;
        })();
    if (lotsFor > 0 && equity > 0) {
      // § margin engine: ONE pricing point for margin — the paper engine's
      // marginPerLot over LIVE broker specs (contract size, account leverage,
      // conversion). The per-lot figure scales by the candidate's lots and is
      // summed with each open position's live margin; no parallel margin model
      // can drift from what the fill actually charges.
      const perLot = this.deps.marginPerLot?.(symbol) ?? null;
      if (perLot === null || !(perLot > 0)) {
        return { ok: false, reason: `margin for ${symbol} cannot be priced right now — entry deferred` };
      }
      const marginAccount = perLot * lotsFor;
      const notionalAccount = marginAccount * settings.maxLeverage; // exposure bound for the leverage check
      let openMargin = 0;
      for (const p of openPositions) {
        const pLots = (p as { lots?: number }).lots ?? 0;
        const pPerLot = pLots > 0 ? this.deps.marginPerLot?.(p.symbol) ?? null : null;
        if (pPerLot === null) continue; // unpriceable (delisted/stale) — excluded like orphans
        openMargin += pPerLot * pLots;
      }
      const totalMarginPct = ((openMargin + marginAccount) / equity) * 100;
      if (settings.maxMarginUsedPct > 0 && totalMarginPct > settings.maxMarginUsedPct) {
        return { ok: false, reason: `margin ${totalMarginPct.toFixed(1)}% (${openPositions.length + 1} positions) exceeds max ${settings.maxMarginUsedPct}%` };
      }
      const positionLeverage = notionalAccount / equity;
      if (positionLeverage > settings.maxLeverage) {
        return { ok: false, reason: `leverage ${positionLeverage.toFixed(1)} for this position exceeds max ${settings.maxLeverage}` };
      }
    }
    // Goal signals carry a pre-sized plan; the fill-time goalFeasibility check
    // (container.tryOpenForSignal) validates that exact size against margin,
    // leverage and profit caps. The risk-percent re-sizing below is only for
    // strict-pipeline signals, where sizing derives from maxRiskPercent.
    if (signal.plannedLots && signal.plannedLots > 0) {
      return { ok: true, reason: 'goal plan validated at fill' };
    }
    // ---- Minimum profit: the expected TP1 profit must meet the user's floor.
    if (settings.minimumProfit > 0 && signal.takeProfit.tp1 !== null) {
      const asset = getAsset(symbol);
      const sizing = sizePosition({
        symbol,
        entryPrice: signal.entry.preferredEntry,
        stopLossPrice: signal.stopLoss.price,
        settings,
        usdRate: this.accountRate(symbol, this.goalCurrencyFor(settings)),
        walletCurrency: this.goalCurrencyFor(settings),
      });
      if (sizing.valid && sizing.lots > 0) {
        const perUnit = signal.direction === 'BUY'
          ? (signal.takeProfit.tp1 - signal.entry.preferredEntry)
          : (signal.entry.preferredEntry - signal.takeProfit.tp1);
        const tick = this.deps.marketData.getLatest(symbol);
        const spreadCost = (tick?.spread ?? 0) * asset.contractSize * sizing.lots;
        const profitQuote = perUnit * asset.contractSize * sizing.lots;
        const profitAcct = this.toAccount(symbol, settings.accountCurrency, profitQuote);
        const spreadAcct = this.toAccount(symbol, settings.accountCurrency, spreadCost);
        const expectedProfit = profitAcct !== undefined && spreadAcct !== undefined ? profitAcct - spreadAcct : Number.NaN;
        if (!Number.isFinite(expectedProfit) || expectedProfit < settings.minimumProfit) {
          return {
            ok: false,
            reason: Number.isFinite(expectedProfit)
              ? `expected profit ${expectedProfit.toFixed(2)} below minimum ${settings.minimumProfit}`
              : `no live conversion rate to price minimum profit for ${symbol}`,
          };
        }
      }
    }
    return { ok: true, reason: 'ok' };
  }

  async persistSignal(signal: Signal): Promise<void> {
    try {
      // Upsert by signalId: a signal is stored ONCE and updated as its state
      // changes. State transitions are recorded separately in 'signalEvents'.
      // (Inserting on every transition created duplicate history rows.)
      await this.deps.ctx.store.updateOne('signals', { signalId: signal.id }, { $set: { ...signal } as never }, true);
    } catch (err) {
      logger.warn('signal persist failed', { err: String(err) });
    }
  }

  async updateSignalState(signal: Signal, to: SignalState, note: string, emit = true): Promise<void> {
    const res = this.deps.stateMachine.transition(signal, to, note);
    if (!res.ok) {
      logger.warn('state transition rejected', { signalId: signal.id, from: signal.state, to, reason: res.reason });
      return;
    }
    await this.persistSignal(signal);
    try {
      await this.deps.ctx.store.insertOne('signalEvents', { signalId: signal.id, state: to, timestamp: Date.now(), note });
    } catch {
      /* non-fatal */
    }
    if (emit) {
      const eventName =
        to === 'INVALIDATED' ? CHANNELS.signalInvalidated
          : to === 'MISSED' ? CHANNELS.signalMissed
            : to === 'ENTRY_REACHED' || to === 'POSITION_ACTIVE' ? CHANNELS.signalState
              : CHANNELS.signalUpdated;
      this.deps.ctx.events.emit(eventName, { signalId: signal.id, symbol: signal.symbol, timestamp: Date.now(), state: to, note });
    }
  }

  /** Full analysis pipeline for one symbol at the current moment. */
  async analyzeSymbol(symbol: string, force = false): Promise<AnalyzeResult> {
    const analysisStart = Date.now();
    try {
      const result = await this.analyzeSymbolInner(symbol, force);
      METRICS.analysisRuns().inc();
      METRICS.decisions().inc({ decision: result.decision });
      METRICS.tickToDecision().observe({ symbol: result.dataQuality?.symbol ?? symbol }, Date.now() - analysisStart);
      return result;
    } catch (err) {
      METRICS.analysisFailures().inc();
      throw err;
    }
  }

  private async analyzeSymbolInner(symbol: string, force = false): Promise<AnalyzeResult> {
    const settings = await this.loadSettings();
    const now = Date.now();
    const blockedBy: string[] = [];
    // Symbol lock FIRST (XM/MT5 pattern): outside the lock nothing is analyzed
    // at all — this covers event-driven/refresh callers, not just the scanner.
    if (await this.isLockedOut(symbol)) {
      return { symbol, decision: 'NO_TRADE', reason: `SYMBOL_LOCK — only ${(settings.symbolLock ?? '').toUpperCase()} is scanned`, state: 'RISK_BLOCKED', blockedBy: ['SYMBOL_LOCK'] };
    }
    // ---- Global emergency stop (spec §90) ---------------------------------
    if (this.deps.emergencyStop.isTriggered()) {
      return {
        symbol,
        decision: 'NO_TRADE',
        reason: `EMERGENCY STOP active — no new signals (${this.deps.emergencyStop.status().reason})`,
        state: 'RISK_BLOCKED',
        blockedBy: ['EMERGENCY_STOP'],
      };
    }
    // ---- Kill switches (Phase 23) + instrument whitelist --------------------
    const assetClassOf = assetClassFor(symbol);
    if ((settings.disabledAssetClasses ?? []).includes(assetClassOf)) {
      return { symbol, decision: 'NO_TRADE', reason: `ASSET_CLASS_DISABLED — ${assetClassOf} trading is off`, state: 'RISK_BLOCKED', blockedBy: ['ASSET_CLASS_DISABLED'] };
    }
    if ((settings.disabledAssets ?? []).includes(symbol)) {
      return { symbol, decision: 'NO_TRADE', reason: 'ASSET_DISABLED — instrument switched off', state: 'RISK_BLOCKED', blockedBy: ['ASSET_DISABLED'] };
    }
    const selected = settings.selectedPairs ?? [];
    if (selected.length > 0 && !selected.includes(symbol)) {
      return { symbol, decision: 'NO_TRADE', reason: 'ASSET_NOT_SELECTED', state: 'RISK_BLOCKED', blockedBy: ['ASSET_NOT_SELECTED'] };
    }
    const tick = this.deps.marketData.getLatest(symbol);
    const asset = getAsset(symbol);
    const isCrypto = assetClassFor(symbol) === 'CRYPTO';
    // Spread cap: forex uses the pair-scaled default; crypto uses per-asset ticks.
    const maxSpreadPips = asset.maxSpreadPips ?? DEFAULT_MAX_SPREAD_PIPS;

    // ---- 0. DATA QUALITY / FRESHNESS ------------------------------------
    // Engine-level freshness (tick age + coverage) — never a network probe:
    // provider health checks would compete with live polling for the same
    // free-tier request budget and stall signal generation.
    const providerHealth = this.deps.marketData.health();
    const quality = assessQuality({
      symbol,
      timestamp: now,
      latestTick: tick ?? null,
      candles: Object.fromEntries(['1m', '5m', '15m', '1h', '4h', '1D'].map((tf) => [tf, this.deps.candles.getCandles(symbol, tf as Timeframe, 100)])),
      providerHealth,
      newsAvailable: this.deps.news.health().ok,
      calendarAvailable: this.deps.events.health().ok,
      maxSpreadPips,
      // The decision genuinely requires the analysis timeframes; intraday timeframes
      // build up live after boot and must not block trading quality forever.
      requiredTimeframes: ['1h', '4h', '1D'],
      // Staleness is poll-aware: a REST provider's scheduled cadence plus its
      // own quote freshness ceiling are expected, not faults.
      staleThresholdMs: this.deps.marketData.staleGraceFor(symbol),
    });

    // ---- Market session state (Phase 1-3) -----------------------------------
    // Evaluated after the data-quality block above rather than before it: the
    // weekend/out-of-window return is a decision like any other, and every
    // decision carries its quality context. Short-circuiting first omitted
    // `dataQuality` entirely — invisible all week, then every weekend the
    // integration contract failed on the calendar instead of on code.
    const market = marketState(symbol, now, {
      weekendTradingEnabled: settings.weekendTradingEnabled,
      preferredSessions: settings.preferredSessions,
    });
    if (!market.isTradable) {
      const reason = market.isWeekend && !settings.weekendTradingEnabled
        ? 'MARKET_CLOSED (weekend)'
        : 'OUTSIDE_TRADING_WINDOW';
      return { symbol, decision: 'NO_TRADE', reason, state: 'RISK_BLOCKED', dataQuality: quality, blockedBy: [reason] };
    }
    // FXBot adoption — weekend-gap risk window: from 20:00 UTC Friday the
    // engine stops OPENING positions; the paper engine auto-flattens any that
    // are already open. Nothing new is entered into the Friday-close gap.
    if (assetClassFor(symbol) !== 'CRYPTO' && (settings.weekendFlattenEnabled ?? true) && isWeekendGapRiskWindow(now)) {
      return { symbol, decision: 'NO_TRADE', reason: 'WEEKEND_GAP_RISK (flatten window, Fri 20:00 UTC)', state: 'RISK_BLOCKED', dataQuality: quality, blockedBy: ['WEEKEND_GAP_RISK'] };
    }
    if (!tick) {
      blockedBy.push('no market data');
      return { symbol, decision: 'NO_TRADE', reason: 'no market data', state: 'DATA_ERROR', dataQuality: quality, blockedBy };
    }
    if (quality.score < 0.7) {
      blockedBy.push(`data quality ${quality.score}`);
      return { symbol, decision: 'NO_TRADE', reason: `data quality too low (${quality.score})`, state: 'DATA_ERROR', dataQuality: quality, blockedBy };
    }
    // DEMO-feed guard: simulated prices must never drive "real" signals unless
    // explicitly opted in via ALLOW_DEMO_SIGNALS.
    if (!config.allowDemoSignals && tick.mode === 'DEMO') {
      blockedBy.push('demo feed');
      return { symbol, decision: 'NO_TRADE', reason: 'simulated (DEMO) feed — signal generation disabled', state: 'RISK_BLOCKED', dataQuality: quality, blockedBy };
    }
    const spreadPips = priceToPips(symbol, tick.ask - tick.bid);

    // ---- Spread regime (Phase 4) ------------------------------------------
    // Rolling per-symbol distribution: ABNORMAL blocks new entries. Open
    // positions are never closed because of a temporary spread spike.
    const spreadRegime = this.deps.conditions.spreadStatus(symbol, spreadPips);
    if (spreadRegime.level === 'ABNORMAL') {
      blockedBy.push(`spread ${spreadPips.toFixed(1)} pips abnormal (median ${spreadRegime.median})`);
      await this.invalidatePreEntry(symbol, 'spread abnormal — no new entry');
      return { symbol, decision: 'NO_TRADE', reason: `SPREAD_TOO_HIGH — ${spreadPips.toFixed(1)} pips vs median ${spreadRegime.median}`, state: 'RISK_BLOCKED', dataQuality: quality, blockedBy };
    }
    const spreadPenalty = spreadRegime.level === 'ELEVATED' ? 10 : 0;

    // ---- Gather candles & indicators for all timeframes ------------------
    const candlesByTf: Partial<Record<Timeframe, Candle[]>> = {};
    const indicatorsByTf: Record<string, unknown> = {};
    for (const tf of ['1m', '5m', '15m', '30m', '1h', '4h', '1D'] as Timeframe[]) {
      candlesByTf[tf] = this.deps.candles.getCandles(symbol, tf, 260);
      const snap = await this.deps.indicators.getSnapshot(symbol, tf, force);
      if (snap) indicatorsByTf[tf] = snap;
    }
    const primaryTf: Timeframe = '1h';
    const primaryCandles = candlesByTf[primaryTf] ?? [];
    if (primaryCandles.length < 100) {
      blockedBy.push('insufficient candle history');
      return { symbol, decision: 'WAIT', reason: 'insufficient candle history for analysis', state: 'DATA_ERROR', dataQuality: quality, blockedBy };
    }

    // ---- Multi-timeframe, price action, S/R, session ---------------------
    const mtf = this.deps.multiTimeframe.analyze(candlesByTf, indicatorsByTf as never, symbol, now);
    const priceAction = analyzePriceAction(primaryCandles, symbol, primaryTf, now);
    const levels = computeLevels({
      candles: candlesByTf['1h'] ?? primaryCandles,
      higherTfCandles: candlesByTf['4h'] ?? primaryCandles,
      dailyCandles: candlesByTf['1D'] ?? primaryCandles,
      symbol,
      currentPrice: tick.mid,
    });
    const session = sessionSnapshot(now);

    // ---- News / events / sentiment --------------------------------------
    const news = this.deps.news.getLatest();
    const newsForPair = news.filter((n) => n.currencies.some((c) => symbol.split('/').includes(c)));
    const eventRisk = await this.deps.events.assess({ symbol, now });
    const sentiment = newsForPair.length ? await this.deps.sentiment.aggregateByCurrency(newsForPair) : [];
    const pairSentiment = sentiment.filter((s) => symbol.split('/').includes(s.currency));
    const newsSentimentScore = pairSentiment.length ? pairSentiment.reduce((a, b) => a + b.score, 0) / pairSentiment.length : 0;

    // ---- Historical patterns ---------------------------------------------
    let pattern: PatternResult | undefined = this.cachedPattern(symbol, force);
    if (!pattern) {
      pattern = this.deps.patterns.analyze(primaryCandles, primaryCandles.length - 1, { horizonBars: 8 });
      this.historicalProbabilityCache.set(symbol, { pattern, at: Date.now() });
    }

    // ---- Regime -----------------------------------------------------------
    const newsDriven = eventRisk.imminentHighImpact || (newsForPair.some((n) => n.importance === 'HIGH'));
    const regimeInput = {
      symbol,
      timeframe: primaryTf,
      timestamp: now,
      indicatorValues: (indicatorsByTf[primaryTf] as { values: Record<string, number | null> } | undefined)?.values ?? {},
      priceAction,
      newsDriven,
      highVolatilityNews: eventRisk.imminentHighImpact,
    };
    const regime = detectRegime({
      ...regimeInput,
      // Liquidity stress (spec §27): spread > 50% of the asset's cap signals
      // abnormally wide spreads / thin liquidity -> risk-controlled regime.
      spreadStress: spreadPips > maxSpreadPips * 0.5,
    });
    // Phase 6: regime transition tracking — previous/current + change stamp
    // are recorded so signals and snapshots show WHEN the market shifted.
    const prevRegime = this.lastRegime.get(symbol);
    const regimeChanged = prevRegime !== undefined && prevRegime.regime !== regime.regime;
    regime.previousRegime = prevRegime?.regime ?? null;
    regime.regimeChanged = regimeChanged;
    regime.regimeChangeTimestamp = regimeChanged ? now : null;
    this.lastRegime.set(symbol, { regime: regime.regime, at: now });
    // Phase 5: volatility regime from the rolling ATR% distribution.
    const volStatus = this.deps.conditions.volatilityStatus(symbol, regime.atrPct ?? null);
    const extremeVolatility = volStatus.level === 'EXTREME';
    const highVolatility = volStatus.level === 'HIGH';

    // ---- Feature vector & ML ----------------------------------------------
    const indicatorsPrimary = (indicatorsByTf[primaryTf] as { values: Record<string, number | null> } | null);
    const featureInput: FeatureContextInput = {
      symbol,
      timeframe: primaryTf,
      timestamp: now,
      indicators: indicatorsPrimary as never,
      spreadPips,
      session: session.session,
      regime: regime.regime,
      eventRisk: eventRisk.eventRisk,
      newsSentiment: newsSentimentScore,
      historicalBuyProbability: pattern.available ? pattern.buyOutcome : 0.5,
      historicalAvailable: pattern.available,
      dataQualityScore: quality.score,
      // XAU/USD momentum bias (BaseMax/XAUUSD-LSTM adoption): gold as the
      // risk-sentiment bellwether — 10-bar ROC of the primary TF's gold
      // candles, neutral when gold history is not resident. Never the symbol
      // itself: self-momentum is already in the indicator block.
      goldRoc10: this.goldRoc10(symbol, primaryTf),
      goldAvailable: symbol !== 'XAU/USD' && (this.deps.candles.getCompletedCandles('XAU/USD', primaryTf, 11).length >= 11),
    };
    const featureVector = await this.deps.features.buildAndStore(featureInput);
    const featureValues = featureVector.values;

    // ---- Strategy router (spec §28) — after indicators are available -------
    const strategy: StrategySelection = selectStrategy(regime.regime, indicatorsPrimary?.values ?? null, priceAction);
    if ((settings.disabledStrategies ?? []).includes(strategy.strategy)) {
      blockedBy.push(`strategy ${strategy.strategy} disabled`);
      await this.invalidatePreEntry(symbol, `strategy ${strategy.strategy} disabled`);
      return { symbol, decision: 'NO_TRADE', reason: `STRATEGY_DISABLED — ${strategy.strategy}`, state: 'RISK_BLOCKED', dataQuality: quality, probability: undefined, blockedBy };
    }

    let mlProbability: number | null = null;
    let mlConfidence: number | null = null;
    let modelDisagreement = 0;
    let modelVersion = 'none';
    let datasetVersion = 'none';
    let mlBlocked = false;
    try {
      const pred = await this.deps.ai.predict({
        symbol,
        timeframe: primaryTf,
        timestamp: now,
        features: featureValues,
      });
      if (pred.available) {
        mlProbability = pred.calibratedProbability;
        mlConfidence = pred.confidence;
        modelVersion = pred.modelVersion;
        datasetVersion = pred.datasetVersion;
        // challenger shadow check
        const shadow = await this.deps.ai.predict({
          symbol,
          timeframe: primaryTf,
          timestamp: now,
          features: featureValues,
          useShadow: true,
        }).catch(() => null);
        if (shadow && shadow.available && pred.calibratedProbability !== null) {
          modelDisagreement = Math.abs(pred.calibratedProbability - shadow.calibratedProbability);
        }
      } else {
        mlBlocked = true;
      }
    } catch {
      mlBlocked = true;
    }
    if (mlBlocked && !config.allowSignalsWithoutMl) {
      blockedBy.push('ML engine unavailable');
      return {
        symbol, decision: 'WAIT', reason: 'ML engine unavailable — waiting per safe policy', state: 'MODEL_BLOCKED',
        dataQuality: quality, probability: undefined, blockedBy,
      };
    }
    if (mlProbability === null) {
      blockedBy.push('no ML probability');
      return { symbol, decision: 'INSUFFICIENT_CONFIDENCE', reason: 'no ML probability', state: 'INSUFFICIENT_CONFIDENCE', dataQuality: quality, blockedBy };
    }

    // ---- Direction synthesis (ensemble, spec §27) -------------------------
    // Every component is scored on a comparable scale and the combined score
    // plus all component scores are recorded in the signal snapshot so any
    // signal can be audited component by component.
    const primaryValues = (indicatorsByTf[primaryTf] as { values: Record<string, number | null> })?.values ?? {};
    let technicalScore = computeTechnicalScore(mtf.consensus, priceAction, regime, primaryValues);
    // Spec §3: when higher timeframes (1D/4h/1h) oppose the setup timeframes
    // (15m/5m/1m), confidence must fall — the penalty typically pushes the
    // combined score below the entry threshold (NO_TRADE) on strong conflict.
    const mtfConflict = mtf.conflict ?? false;
    if (mtfConflict) technicalScore -= 25;
    const scoreBreakdown = buildScoreBreakdown({
      mtf, priceActionAnalysis: priceAction, regime, values: primaryValues, conflict: mtfConflict, extremeVolatility,
    });
    const patternBias = pattern.available ? (pattern.buyOutcome - pattern.sellOutcome) * 100 : 0;
    const mlBias = (mlProbability - 0.5) * 200;
    const newsBias = newsSentimentScore * 30;
    const eventBias = eventRisk.eventRisk > 0.5 ? -40 : 0; // avoid trading into high-impact windows
    // Phase 4-5 penalties: elevated spread and high volatility demand more
    // evidence, never fewer safety controls.
    if (highVolatility) technicalScore -= 10;
    const combined = technicalScore * 0.5 + patternBias * 0.1 + mlBias * 0.25 + newsBias * 0.08 + eventBias * 0.07 - spreadPenalty;
    const componentScores: Record<string, number> = {
      ...scoreBreakdown,
      spread: Number((spreadRegime.level === 'ELEVATED' ? -15 : 0).toFixed(1)),
      technical: Number(technicalScore.toFixed(1)),
      pattern: Number(patternBias.toFixed(1)),
      ml: Number(mlBias.toFixed(1)),
      news: Number(newsBias.toFixed(1)),
      event: Number(eventBias.toFixed(1)),
      combined: Number(combined.toFixed(1)),
    };

    let direction: 'BUY' | 'SELL' | null = null;
    if (combined >= 25 && mlProbability >= settings.minConfidence) direction = 'BUY';
    else if (combined <= -25 && mlProbability <= 1 - settings.minConfidence) direction = 'SELL';

    if (!direction) {
      const reason = `combined score ${combined.toFixed(0)} below threshold (ml ${mlProbability.toFixed(2)})`;
      // Spec §37: the thesis weakened below threshold -> the old pre-entry
      // signal must not keep waiting on a dead setup.
      await this.invalidatePreEntry(symbol, `thesis weakened: ${reason}`);
      return { symbol, decision: 'WAIT', reason, state: 'CANDIDATE', dataQuality: quality, probability: mlProbability, regime: regime.regime, blockedBy };
    }

    // ---- Entry / SL / TP / R:R --------------------------------------------
    const entryPlan = buildEntry({
      symbol, direction, currentPrice: tick.mid,
      atr: (indicatorsByTf[primaryTf] as { values: Record<string, number | null> })?.values?.atr14 ?? null,
      levels, structure: priceAction.trendStructure, timestamp: now,
      // Entry style (spec §22): BREAKOUT/MOMENTUM anchor on the market price.
      strategy: strategy.strategy,
    });
    const slResult = buildStopLoss({
      symbol, direction, entry: entryPlan.preferredEntry,
      atr: (indicatorsByTf[primaryTf] as { values: Record<string, number | null> })?.values?.atr14 ?? null,
      levels,
    });
    if (!slResult.valid) {
      blockedBy.push(`SL invalid: ${slResult.reason ?? 'invalid'}`);
      await this.invalidatePreEntry(symbol, `stop loss invalid: ${slResult.reason ?? 'invalid'}`);
      return { symbol, decision: 'NO_TRADE', reason: slResult.reason ?? 'SL invalid', state: 'QUALIFIED', dataQuality: quality, probability: mlProbability, blockedBy };
    }
    const tp = buildTakeProfit({
      symbol, direction, entry: entryPlan.preferredEntry, stopLoss: slResult.plan.price,
      atr: (indicatorsByTf[primaryTf] as { values: Record<string, number | null> })?.values?.atr14 ?? null,
      levels,
    });
    if (tp.rr1 < settings.minRr) {
      blockedBy.push(`R:R ${tp.rr1} below minimum ${settings.minRr}`);
      await this.invalidatePreEntry(symbol, `risk/reward ${tp.rr1.toFixed(2)} fell below minimum ${settings.minRr}`);
      return { symbol, decision: 'NO_TRADE', reason: `R:R ${tp.rr1.toFixed(2)} below minimum ${settings.minRr}`, state: 'QUALIFIED', dataQuality: quality, probability: mlProbability, blockedBy };
    }
    const levelCheck = entryTooCloseToLevel(symbol, entryPlan.preferredEntry, levels);
    if (levelCheck.tooClose) {
      blockedBy.push(levelCheck.reason ?? 'entry too close to level');
      await this.invalidatePreEntry(symbol, levelCheck.reason ?? 'entry too close to level');
      return { symbol, decision: 'NO_TRADE', reason: levelCheck.reason ?? 'entry too close to level', state: 'QUALIFIED', dataQuality: quality, probability: mlProbability, blockedBy };
    }
    componentScores.entry = Number(entrySubScore(tp.rr1, levelCheck.tooClose, slResult.valid).toFixed(1));

    // ---- Expected value (spec §25) ------------------------------------------
    // Forex: per-lot values with flat commission and swap. Crypto: per-unit
    // values (contractSize = 1) with percentage taker fee and funding cost.
    // Win/loss/spread are QUOTE-currency amounts; USD commission/swap MUST be
    // converted into the quote currency first (¥7 ≠ $7 — mixing units
    // understated JPY-pair costs ~150× and passed negative-EV trades).
    //
    // The ACCOUNT TYPE owns the cost model: when an XM account is bound, spread
    // — swap come from that account's own live data (`symbol_info` + the live
    // tick) and the commission from its account terms (e.g. spread-only Ultra
    // Low Standard = no per-lot commission). Dropping that link is what made a
    // spread-only account trade on a spread-plus-$7/lot assumption.
    const pWin = direction === 'BUY' ? mlProbability : 1 - mlProbability;
    const qpu = quotePerUsdLive(symbol, (s) => this.deps.marketData.getLatest(s)?.mid);
    const usdToQuote = (usd: number): number => (qpu !== null ? usd * qpu : 0);

    const spreadQuote = brokerSpreadPerLot(symbol, tick.spread > 0 ? tick.spread : null);
    // Planning basis: signals price the account type the user selected, whether
    // or not money may move yet. `costProvenance` below records which basis was
    // used, so an unacknowledged published figure can never look confirmed.
    const commission = plannedCommissionUsdPerLot();
    const swapQuote = brokerSwapQuotePerLotNight(symbol, direction);

    const platformSpreadPerLot = tick.spread * asset.contractSize;
    const platformCommissionPerLot = usdToQuote(asset.commissionPerLot);
    const platformSwapPerLot = usdToQuote(direction === 'BUY' ? -asset.swapLong : -asset.swapShort);

    // Crypto keeps its percentage-fee model (a per-lot commission in USD is not
    // how crypto CFDs are charged); the broker cost model applies to FX/metals.
    const commissionPerLot = isCrypto
      ? entryPlan.preferredEntry * (asset.takerFee ?? 0)
      : commission && commission.usdPerLotRoundTurn !== null
        ? usdToQuote(commission.usdPerLotRoundTurn)
        : platformCommissionPerLot;
    const swapPerDayPerLot = isCrypto
      ? (asset.fundingRate ?? 0) * entryPlan.preferredEntry * (24 / (asset.fundingIntervalHours ?? 8)) * (direction === 'BUY' ? -1 : 1)
      : swapQuote.value !== null
        // symbol_info quotes swaps in QUOTE currency, like the P&L it offsets.
        ? swapQuote.value
        : platformSwapPerLot;
    const commissionSource = isCrypto
      ? 'platform fee model (taker fee)'
      : commission
        ? `${commission.source}${commission.usdPerLotRoundTurn === null ? ' — amount unknown, platform default applied' : ''}`
        : 'platform default';
    const evInput: EvInput = {
      symbol,
      probabilityWin: pWin,
      averageWinPerLot: Math.abs(tp.tp1 - entryPlan.preferredEntry) * asset.contractSize,
      averageLossPerLot: Math.abs(entryPlan.preferredEntry - slResult.plan.price) * asset.contractSize,
      spreadPerLot: spreadQuote.value ?? platformSpreadPerLot,
      commissionPerLot,
      swapPerDayPerLot,
      daysHeld: isCrypto ? 1 : 2,
    };
    const ev = calculateExpectedValue(evInput);
    const costPolicy = brokerAccountCosts();
    ev.costProvenance = {
      profileId: costPolicy?.profileId ?? 'PLATFORM',
      label: costPolicy?.label ?? 'platform defaults (no broker account bound)',
      spread: spreadQuote.value !== null ? `${spreadQuote.source}: ${spreadQuote.detail}` : `platform default: ${spreadQuote.detail}`,
      commission: commissionSource,
      swap: swapQuote.value !== null ? `${swapQuote.source}: ${swapQuote.detail}` : 'platform default swap points',
      commissionPerLotUsdRoundTurn: commission?.usdPerLotRoundTurn ?? null,
      brokerSourced: spreadQuote.source === 'MT5_SYMBOL_INFO' || spreadQuote.source === 'LIVE_FEED',
    };
    // Wallet not in USD: EV monetary fields are converted to the wallet
    // currency (₹ for an INR wallet) so signal/position displays match the
    // wallet. evPerRisk and positive are ratios — unaffected by scaling.
    const evCcy = this.goalCurrencyFor(settings);
    if (evCcy !== 'USD') {
      const rate = this.accountRate(symbol, evCcy);
      const f = (n: number): number => (rate > 0 ? n / rate : n);
      ev.evPerTrade = f(ev.evPerTrade);
      ev.averageWin = f(ev.averageWin);
      ev.averageLoss = f(ev.averageLoss);
      ev.tradingCosts = f(ev.tradingCosts);
      ev.breakdown = {
        spread: f(ev.breakdown.spread),
        commission: f(ev.breakdown.commission),
        slippage: f(ev.breakdown.slippage),
        swap: f(ev.breakdown.swap),
      };
    }
    // Phase 5: extreme volatility raises the EV bar — a marginal setup is not
    // worth the tail risk.
    const evOk = ev.positive && (!extremeVolatility || ev.evPerRisk >= 0.5);
    if (!evOk) {
      blockedBy.push(ev.positive ? 'expected value below extreme-volatility bar' : 'negative expected value');
      // Spec §37: EV went negative -> old signal is dead, not just paused.
      await this.invalidatePreEntry(symbol, ev.positive ? 'EV below extreme-volatility bar' : `expected value ${ev.evPerTrade.toFixed(2)} turned non-positive`);
      return { symbol, decision: 'NO_TRADE', reason: ev.positive ? 'EV insufficient under extreme volatility' : `expected value ${ev.evPerTrade.toFixed(2)} is not positive`, state: 'QUALIFIED', dataQuality: quality, probability: mlProbability, blockedBy };
    }

    // ---- Portfolio / correlation / circuit breakers -------------------------
    const positions = await this.deps.ctx.store.find<any>('paperPositions', { status: 'OPEN' });
    const openPositions = positions as PaperPosition[];
    const equity = settings.availableCapital;
    // Real account state (spec §34) — daily/weekly loss, drawdown and
    // consecutive losses feed the circuit breakers; never hardcoded zeros.
    const acct = await this.accountRiskState();
    // Currency exposure in ACCOUNT currency (net long/short per currency,
    // converted through live cross rates) — PortfolioRiskEngine.assess nets raw
    // quote-currency notionals, which compares yen against rupees and
    // overstates JPY-quoted pairs ~100×. Same computation as the fill gate.
    const netByCurrency: Record<string, number> = {};
    for (const p of openPositions) {
      let pa: ReturnType<typeof getAsset>;
      try {
        pa = getAsset(p.symbol);
      } catch {
        continue; // orphaned/delisted position — skip, never kill analysis
      }
      const [base, quote] = p.symbol.split('/');
      const notional = (p.lots ?? 0) * pa.contractSize * (p.entryPrice ?? 0);
      // Exposure is compared against the wallet's equity — wallet currency.
      // Unknown conversion rate ⇒ infinite exposure (fail closed): the
      // breaker must trip rather than under-count a leg we cannot price.
      const legAccount = this.toAccount(p.symbol, this.goalCurrencyFor(settings), notional) ?? Number.POSITIVE_INFINITY;
      const longCur = p.direction === 'BUY' ? base : quote;
      const shortCur = p.direction === 'BUY' ? quote : base;
      netByCurrency[longCur] = (netByCurrency[longCur] ?? 0) + legAccount;
      netByCurrency[shortCur] = (netByCurrency[shortCur] ?? 0) - legAccount;
    }
    const maxNetExposure = Object.values(netByCurrency).reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    // Phase 5: extreme volatility halves the risk per trade.
    const sizingSettings = extremeVolatility ? { ...settings, maxRiskPercent: Math.max(0.1, settings.maxRiskPercent / 2) } : settings;
    // Fractional-Kelly risk cap (quant-trading-bot adoption): the static
    // maxRiskPercent stays the user's POLICY ceiling, but when the wallet has
    // enough closed-trade history the Kelly estimate bounds the actual risk
    // inside it. Only ever tightens — a hot streak cannot raise sizing.
    let kellyCapped = sizingSettings;
    try {
      const closed = (await this.deps.kellyStats?.()) ?? [];
      const wins = closed.filter((t) => t.pnl > 0);
      const losses = closed.filter((t) => t.pnl < 0);
      if (wins.length > 0 && losses.length > 0) {
        const avgWin = wins.reduce((s, t) => s + t.pnl, 0) / wins.length;
        const avgLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length);
        const cap = kellyRiskCap({ winRate: wins.length / closed.length, payoffRatio: avgWin / avgLoss, trades: closed.length });
        const riskPct = (cap?.riskFraction ?? 1) * 100;
        if (cap?.basis === 'sampled' && riskPct < sizingSettings.maxRiskPercent) {
          kellyCapped = { ...sizingSettings, maxRiskPercent: Number(riskPct.toFixed(3)) };
        }
      }
    } catch { /* Kelly stats unavailable — the static policy stands */ }
    const sizing = sizePosition({
      symbol,
      entryPrice: entryPlan.preferredEntry,
      stopLossPrice: slResult.plan.price,
      settings: kellyCapped,
      usdRate: this.accountRate(symbol, this.goalCurrencyFor(settings)),
      walletCurrency: this.goalCurrencyFor(settings),
    });
    if (!sizing.valid) {
      blockedBy.push(`sizing: ${sizing.reason}`);
      await this.invalidatePreEntry(symbol, `sizing failed: ${sizing.reason}`);
      return { symbol, decision: 'NO_TRADE', reason: sizing.reason, state: 'RISK_BLOCKED', dataQuality: quality, probability: mlProbability, blockedBy };
    }
    // Phase 14: capital allocation — the aggregate portfolio risk budget must
    // hold after this position; a strong signal never overrides portfolio risk.
    // Deferred (not blocking): the signal is still shown and the fill-time gate
    // enforces the limit — so candidates remain visible while positions are open.
    const deferredBlocks: string[] = [];
    const alloc = this.deps.portfolioRisk.preflightCheck(
      openPositions,
      equity > 0 ? (sizing.riskAmount / equity) * 100 : 0,
      equity,
      (p) => {
        const pa = getAsset(p.symbol);
        const riskPerUnit = Math.abs(p.entryPrice - (p.initialStopLoss ?? p.stopLoss));
        return this.toAccount(p.symbol, this.goalCurrencyFor(settings), riskPerUnit * p.lots * pa.contractSize) ?? Number.POSITIVE_INFINITY;
      },
    );
    if (!alloc.allowed) deferredBlocks.push(alloc.reason ?? 'portfolio risk budget exceeded');
    // Spec §18: investment filters — the sized position must fit the user's
    // minimum/maximum investment. Never force a trade to fit the money.
    const notional = sizing.lots * asset.contractSize * entryPlan.preferredEntry;
    if (settings.minimumInvestment > 0 && notional < settings.minimumInvestment) {
      blockedBy.push(`notional ${notional.toFixed(0)} below minimum investment ${settings.minimumInvestment}`);
      await this.invalidatePreEntry(symbol, 'sized position below minimum investment');
      return { symbol, decision: 'NO_TRADE', reason: 'NO SUITABLE OPPORTUNITY — sized position below minimum investment', state: 'RISK_BLOCKED', dataQuality: quality, probability: mlProbability, blockedBy };
    }
    if (settings.maximumPositionSize > 0 && notional > settings.maximumPositionSize) {
      blockedBy.push(`notional ${notional.toFixed(0)} above maximum position size ${settings.maximumPositionSize}`);
      await this.invalidatePreEntry(symbol, 'sized position above maximum investment');
      return { symbol, decision: 'NO_TRADE', reason: 'NO SUITABLE OPPORTUNITY — sized position above maximum investment', state: 'RISK_BLOCKED', dataQuality: quality, probability: mlProbability, blockedBy };
    }
    const profitCheck = canAchieveProfitSafe(settings.minimumProfit, sizing, tp.rr1);
    if (!profitCheck) {
      blockedBy.push('profit constraint not achievable without violating risk');
      await this.invalidatePreEntry(symbol, 'requested minimum profit no longer achievable within risk limits');
      return { symbol, decision: 'NO_TRADE', reason: 'requested minimum profit not achievable within risk limits', state: 'RISK_BLOCKED', dataQuality: quality, probability: mlProbability, blockedBy };
    }
    // ---- Portfolio limits (Phase 15) ---------------------------------------
    // Deferred to fill time: signals stay visible even when the portfolio is
    // full; the entry gate blocks execution until capacity frees up.
    if (settings.maxForexPositions > 0 && assetClassOf === 'FOREX' && openPositions.filter((p) => assetClassFor(p.symbol) === 'FOREX').length >= settings.maxForexPositions) {
      deferredBlocks.push('max forex positions reached');
    }
    if (settings.maxCryptoPositions > 0 && assetClassOf === 'CRYPTO' && openPositions.filter((p) => assetClassFor(p.symbol) === 'CRYPTO').length >= settings.maxCryptoPositions) {
      deferredBlocks.push('max crypto positions reached');
    }
    if (settings.maxTradesPerAsset > 0 && openPositions.filter((p) => p.symbol === symbol).length >= settings.maxTradesPerAsset) {
      deferredBlocks.push('max trades per asset reached');
    }
    if (settings.maxTradesPerCurrency > 0) {
      const base = symbol.split('/')[0];
      const perCur = openPositions.filter((p) => p.symbol.split('/')[0] === base).length;
      if (perCur >= settings.maxTradesPerCurrency) deferredBlocks.push(`max trades per currency (${base}) reached`);
    }
    const corrCheck = this.deps.correlation.checkNewPosition(symbol, openPositions.map((p) => p.symbol), settings.maxCorrelatedPositions);
    if (!corrCheck.allowed) deferredBlocks.push(corrCheck.reason ?? 'correlation block');
    const breakerInput = {
      settings,
      dailyPnlPct: acct.dailyPnlPct,
      weeklyPnlPct: acct.weeklyPnlPct,
      drawdownPct: acct.drawdownPct,
      consecutiveLosses: acct.consecutiveLosses,
      openPositions: openPositions.length,
      correlatedPositions: this.deps.circuitBreakers.countCorrelated(openPositions.map((p) => p.symbol), this.deps.correlation.matrix([symbol, ...openPositions.map((p) => p.symbol)], 50)),
      leverage: sizing.leverageUsed,
      currencyExposurePct: equity > 0 ? maxNetExposure / equity * 100 : 0,
    };
    const breakers = this.deps.circuitBreakers.evaluate(breakerInput);
    if (breakers.triggered) deferredBlocks.push(`circuit breakers: ${breakers.activeBreakers.join(', ')}`);

    // ---- Uncertainty & risk classification ----------------------------------
    const uncertainty = evaluateUncertainty({
      mlProbability,
      mlConfidence,
      modelDisagreement,
      historicalConfidence: pattern.available ? pattern.confidence : null,
      regime: regime.regime,
      dataQualityScore: quality.score,
      newsConflict: 0,
      expectedValueCertain: true,
      spreadPips,
      maxSpreadPips,
      // The user's configured confidence floor governs the ML gate — not a
      // hardcoded constant that silently overrides it in both directions.
      minConfidence: settings.minConfidence,
    });
    if (uncertainty.insufficient) {
      blockedBy.push(uncertainty.reason);
      await this.invalidatePreEntry(symbol, `insufficient confidence: ${uncertainty.reason}`);
      return { symbol, decision: 'INSUFFICIENT_CONFIDENCE', reason: uncertainty.reason, state: 'INSUFFICIENT_CONFIDENCE', dataQuality: quality, probability: mlProbability, blockedBy };
    }

    const riskAssessment = classifyRisk({
      symbol,
      timestamp: now,
      components: {
        volatility: regime.volatility === 'HIGH' ? 0.8 : regime.volatility === 'MEDIUM' ? 0.4 : 0.2,
        spread: Math.min(1, spreadPips / maxSpreadPips),
        news: newsForPair.some((n) => n.importance === 'HIGH') ? 0.7 : 0.2,
        economicEvents: eventRisk.eventRisk,
        mlUncertainty: 1 - (mlConfidence ?? 0.5),
        rr: tp.rr1 >= 2 ? 0.1 : tp.rr1 >= 1.5 ? 0.3 : 0.6,
        regime: regime.regime === 'UNCERTAIN' ? 0.8 : regime.regime === 'HIGH_VOLATILITY' || regime.regime === 'NEWS_DRIVEN' ? 0.6 : 0.3,
        dataQuality: 1 - quality.score,
        portfolioExposure: settings.maxOpenPositions > 0 ? Math.min(1, openPositions.length / settings.maxOpenPositions) : 0,
        correlation: equity > 0 ? Math.min(1, maxNetExposure / equity) : 0,
        drawdown: Math.min(1, acct.drawdownPct / 100),
        modelHealth: mlBlocked ? 1 : 0,
      },
      critical: eventRisk.imminentHighImpact ? ['RED: high-impact event approaching'] : [],
    });
    if (riskAssessment.blocked) {
      blockedBy.push('risk classification blocked');
      await this.invalidatePreEntry(symbol, 'risk classification blocked');
      return { symbol, decision: 'NO_TRADE', reason: 'risk classification blocked', state: 'RISK_BLOCKED', dataQuality: quality, probability: mlProbability, blockedBy };
    }

    // ---- Create / update the signal -----------------------------------------
    const signal = await this.upsertSignal({
      symbol, direction, now, tick: tick.mid, bid: tick.bid, ask: tick.ask, spread: tick.spread,
      settings, quality, mtf, priceAction, levels, regime, ev, entryPlan, slResult: slResult.plan, tp,
      mlProbability, mlConfidence: mlConfidence ?? 0.5, pattern, newsForPair, eventRisk, sentiment,
      modelVersion, datasetVersion, featureVersion: FEATURE_VERSION,
      strategy, technicalScore: combined, componentScores, sizing, riskAssessment, blockedBy,
    });
    return {
      symbol, decision: signal.direction === 'BUY' ? 'BUY' : 'SELL', reason: 'signal generated', state: signal.state,
      signal, dataQuality: quality, probability: mlProbability, blockedBy: [...blockedBy, ...deferredBlocks],
      deferredBlocks,
    };
  }

  /**
   * Goal mode: hunts EVERY enabled symbol for a setup that can cover the user's
   * minimumProfit goal within the risk/margin/leverage caps. Direction comes
   * from the technical consensus WITHOUT the ML gate (real indicators, real
   * prices — never fabricated). Sizing is goal-driven: lots are chosen so the
   * TP move alone yields at least the goal profit, then the position is checked
   * against the caps. Never raises risk beyond the caps to chase the goal — the
   * analysis reports exactly how much more would be needed. Achievable setups
   * produce an actionable WAITING_FOR_ENTRY signal (market-order entry zone at
   * the live price) so the existing Trade button / auto-trade / fill-time gate
   * handle execution unchanged.
   */
  /**
   * Currency the GOAL (minimum profit, sizing, margin figures) is denominated
   * in: the user's account-currency setting UNTIL an MT5 account binds — the
   * paper wallet then adopts the account's own currency, and the goal must
   * follow it. Sizing a ₹-goal position while the wallet measures the profit
   * target in $ (or the reverse) is a unit error that misstates the goal by
   * the conversion rate (≈90× for INR/USD).
   */
  goalCurrencyFor(settings: UserSettings): string {
    const wallet = this.deps.walletCurrency?.()?.toUpperCase();
    return wallet || settings.accountCurrency || 'USD';
  }

  /**
   * True when `symbol` is OUTSIDE the current symbol lock (XM/MT5 pattern):
   * a locked symbol means signals and analysis happen for it ONLY. The
   * scanner's enabledSymbols() already excludes locked-out symbols; this
   * guard covers the other callers (event-driven refreshSymbol, debounce
   * paths) so a pre-lock symbol never keeps churning stale signals.
   */
  async isLockedOut(symbol: string): Promise<boolean> {
    const settings = await this.loadSettings();
    const lock = (settings.symbolLock ?? '').toUpperCase() || null;
    return lock !== null && symbol.toUpperCase() !== lock;
  }

  async analyzeForGoal(symbol: string, force = false): Promise<GoalAnalysis> {
    const settings = await this.loadSettings();
    // Symbol lock FIRST — analysis exists only for the locked symbol.
    if (await this.isLockedOut(symbol)) {
      this.goalAnalyses.delete(symbol);
      await this.invalidateGoalSignal(symbol, 'symbol lock changed');
      return { symbol, goalProfit: settings.minimumProfit, updatedAt: Date.now(), direction: null, entry: 0, entryMin: 0, entryMax: 0, stopLoss: 0, takeProfit: 0, rr: 0, lots: 0, expectedProfit: 0, riskAmount: 0, riskPctRequired: 0, marginPct: 0, leverageUsed: 0, probability: null, confidence: 0, achievable: false, reason: `symbol lock — only ${(settings.symbolLock ?? '').toUpperCase()} is scanned` };
    }
    const accountCurrency = this.goalCurrencyFor(settings);
    const now = Date.now();
    const asset = getAsset(symbol);
    const mkAnalysis = (a: Omit<GoalAnalysis, 'symbol' | 'goalProfit' | 'updatedAt'>): GoalAnalysis => {
      const out: GoalAnalysis = { symbol, goalProfit: settings.minimumProfit, updatedAt: now, ...a };
      this.goalAnalyses.set(symbol, out);
      return out;
    };

    const tick = this.deps.marketData.getLatest(symbol);
    if (!tick) return mkAnalysis({ direction: null, entry: 0, entryMin: 0, entryMax: 0, stopLoss: 0, takeProfit: 0, rr: 0, lots: 0, expectedProfit: 0, riskAmount: 0, riskPctRequired: 0, marginPct: 0, leverageUsed: 0, probability: null, confidence: 0, achievable: false, reason: 'no market data' });

    // ---- Technical consensus (no ML gate — the goal is the driver) --------
    const candlesByTf: Partial<Record<Timeframe, Candle[]>> = {};
    const indicatorsByTf: Record<string, unknown> = {};
    for (const tf of ['15m', '1h', '4h', '1D'] as Timeframe[]) {
      candlesByTf[tf] = this.deps.candles.getCandles(symbol, tf, 160);
      const snap = await this.deps.indicators.getSnapshot(symbol, tf, force);
      if (snap) indicatorsByTf[tf] = snap;
    }
    const primaryCandles = candlesByTf['1h'] ?? [];
    if (primaryCandles.length < 30) {
      return mkAnalysis({ direction: null, entry: tick.mid, entryMin: tick.mid, entryMax: tick.mid, stopLoss: tick.mid, takeProfit: tick.mid, rr: 0, lots: 0, expectedProfit: 0, riskAmount: 0, riskPctRequired: 0, marginPct: 0, leverageUsed: 0, probability: null, confidence: 0, achievable: false, reason: 'insufficient candle history' });
    }
    const mtf = this.deps.multiTimeframe.analyze(candlesByTf, indicatorsByTf as never, symbol, now);
    const priceAction = analyzePriceAction(primaryCandles, symbol, '1h', now);
    const levels = computeLevels({
      candles: candlesByTf['1h'] ?? primaryCandles,
      higherTfCandles: candlesByTf['4h'] ?? primaryCandles,
      dailyCandles: candlesByTf['1D'] ?? primaryCandles,
      symbol,
      currentPrice: tick.mid,
    });
    const values = (indicatorsByTf['1h'] as { values: Record<string, number | null> } | undefined)?.values ?? {};
    const regime = detectRegime({
      symbol, timeframe: '1h', timestamp: now, indicatorValues: values, priceAction,
      newsDriven: false, highVolatilityNews: false,
    });
    const technicalScore = computeTechnicalScore(mtf.consensus, priceAction, regime, values);
    const direction: 'BUY' | 'SELL' | null = technicalScore >= 15 ? 'BUY' : technicalScore <= -15 ? 'SELL' : null;
    if (!direction) {
      await this.invalidateGoalSignal(symbol, 'no clear directional consensus');
      return mkAnalysis({ direction: null, entry: tick.mid, entryMin: tick.mid, entryMax: tick.mid, stopLoss: tick.mid, takeProfit: tick.mid, rr: 0, lots: 0, expectedProfit: 0, riskAmount: 0, riskPctRequired: 0, marginPct: 0, leverageUsed: 0, probability: null, confidence: 0, achievable: false, reason: `no clear directional consensus (technical score ${technicalScore.toFixed(0)})` });
    }

    // ---- Real live plan: entry at the executable side, structure/ATR SL and TP
    const entry = direction === 'BUY' ? (tick.ask ?? tick.mid) : (tick.bid ?? tick.mid);
    const atr = values.atr14 && values.atr14 > 0 ? values.atr14 : null;
    const pipSize = asset.pipSize;
    const slResult = buildStopLoss({ symbol, direction, entry, atr, levels });
    const slPrice = slResult.valid
      ? slResult.plan.price
      : direction === 'BUY' ? entry - (atr ? Math.max(atr * 1.5, 5 * pipSize) : 10 * pipSize)
        : entry + (atr ? Math.max(atr * 1.5, 5 * pipSize) : 10 * pipSize);
    const slDist = Math.abs(entry - slPrice);
    const tpPlan = buildTakeProfit({ symbol, direction, entry, stopLoss: slPrice, atr, levels });
    const tpOnSide = tpPlan.tp1 !== undefined && (direction === 'BUY' ? tpPlan.tp1 > entry : tpPlan.tp1 < entry);
    const tpPrice = tpOnSide ? tpPlan.tp1 : (direction === 'BUY' ? entry + Math.max(slDist * 2, (atr ?? 0) * 2 || slDist * 2) : entry - Math.max(slDist * 2, (atr ?? 0) * 2 || slDist * 2));
    const rr = priceToPips(symbol, Math.abs(tpPrice - entry)) / priceToPips(symbol, slDist);

    // ---- Goal-driven feasibility (pure math, unit-tested) ------------------
    if (settings.minimumProfit <= 0) {
      await this.invalidateGoalSignal(symbol, 'no profit goal set');
      return mkAnalysis({ direction, entry, entryMin: entry, entryMax: entry, stopLoss: slPrice, takeProfit: tpPrice, rr, lots: 0, expectedProfit: 0, riskAmount: 0, riskPctRequired: 0, marginPct: 0, leverageUsed: 0, probability: null, confidence: 0, achievable: false, reason: 'set a minimum profit goal first' });
    }
    const getMid = (s: string): number | undefined => this.deps.marketData.getLatest(s)?.mid;
    const feasibility = goalFeasibility({
      symbol,
      accountCurrency,
      capital: settings.availableCapital,
      riskPercent: settings.maxRiskPercent,
      goalProfit: settings.minimumProfit,
      entryPrice: entry,
      stopLossPrice: slPrice,
      takeProfitPrice: tpPrice,
      usdRate: accountQuoteRate(symbol, settings.accountCurrency, getMid),
      maxLeverage: settings.maxLeverage,
      maxMarginUsedPct: settings.maxMarginUsedPct,
      getMid,
    });

    let pattern = this.cachedPattern(symbol, force);
    if (!pattern) {
      pattern = this.deps.patterns.analyze(primaryCandles, primaryCandles.length - 1, { horizonBars: 8 });
      this.historicalProbabilityCache.set(symbol, { pattern, at: Date.now() });
    }
    const probability = pattern?.available ? (direction === 'BUY' ? pattern.buyOutcome : 1 - pattern.buyOutcome) : null;

    // ---- AI gate (realtime ML — NEVER bypassed, not even in goal mode) -----
    // The goal drives SIZING; the model must still validate the DIRECTION on
    // the current market state. Features are built exactly like the strict
    // pipeline (same FeatureEngine, same inputs) so train/serve never skews.
    const aiNews = this.deps.news.getLatest().filter((n) => n.currencies.some((c) => symbol.split('/').includes(c)));
    const aiEventRisk = (() => { try { return this.deps.events.assess({ symbol, now }); } catch { return { eventRisk: 0, imminentHighImpact: false } as ReturnType<typeof this.deps.events.assess>; } })();
    const aiSentiment = aiNews.length ? await this.deps.sentiment.aggregateByCurrency(aiNews).catch(() => []) : [];
    const aiNewsScore = aiSentiment.filter((s) => symbol.split('/').includes(s.currency)).reduce((a, b) => a + b.score, 0) / (aiSentiment.filter((s) => symbol.split('/').includes(s.currency)).length || 1);
    const aiQuality = assessQuality({
      symbol, timestamp: now, latestTick: tick ?? null,
      candles: Object.fromEntries(['1h', '4h', '1D'].map((tf) => [tf, this.deps.candles.getCandles(symbol, tf as Timeframe, 100)])),
      providerHealth: this.deps.marketData.health(),
      newsAvailable: this.deps.news.health().ok,
      calendarAvailable: this.deps.events.health().ok,
      maxSpreadPips: asset.maxSpreadPips ?? DEFAULT_MAX_SPREAD_PIPS,
      requiredTimeframes: ['1h'],
      staleThresholdMs: this.deps.marketData.staleGraceFor(symbol),
    });
    let aiProbability: number | null = null;
    let aiConfidence: number | null = null;
    let aiModelVersion = 'none';
    let aiBlocked = true;
    let aiReason = 'AI engine unavailable — NO TRADE';
    try {
      const aiVector = await this.deps.features.buildAndStore({
        symbol,
        timeframe: '1h',
        timestamp: now,
        indicators: indicatorsByTf['1h'] as never,
        spreadPips: priceToPips(symbol, tick.spread ?? 0),
        session: sessionSnapshot(now).session,
        regime: regime.regime,
        eventRisk: aiEventRisk.eventRisk,
        newsSentiment: aiNewsScore,
        historicalBuyProbability: pattern?.available ? pattern.buyOutcome : 0.5,
        historicalAvailable: pattern?.available ?? false,
        dataQualityScore: aiQuality.score,
        goldRoc10: this.goldRoc10(symbol, '1h'),
        goldAvailable: symbol !== 'XAU/USD' && (this.deps.candles.getCompletedCandles('XAU/USD', '1h', 11).length >= 11),
      });
      const aiPred = await this.deps.ai.predict({ symbol, timeframe: '1h', timestamp: now, features: aiVector.values });
      if (aiPred.available && aiPred.calibratedProbability !== null && Number.isFinite(aiPred.calibratedProbability)) {
        aiProbability = aiPred.calibratedProbability;
        aiConfidence = aiPred.confidence;
        aiModelVersion = aiPred.modelVersion;
        aiBlocked = false;
      } else {
        aiReason = 'AI prediction unavailable or invalid — NO TRADE';
      }
    } catch {
      aiBlocked = true;
    }
    const dirConfidence = aiProbability !== null ? (direction === 'BUY' ? aiProbability : 1 - aiProbability) : 0;
    if (!aiBlocked && dirConfidence < settings.minConfidence) {
      aiBlocked = true;
      aiReason = `AI confidence ${(dirConfidence * 100).toFixed(0)}% below required ${(settings.minConfidence * 100).toFixed(0)}% — NO TRADE`;
    }

    const zonePips = Math.max(3, (atr ? (atr / pipSize) * 0.5 : 5));
    const analysis: GoalAnalysis = {
      symbol,
      direction,
      entry,
      entryMin: Number((entry - zonePips * pipSize).toFixed(asset.pricePrecision)),
      entryMax: Number((entry + zonePips * pipSize).toFixed(asset.pricePrecision)),
      stopLoss: slPrice,
      takeProfit: tpPrice,
      rr: Number(rr.toFixed(2)),
      lots: feasibility.lots,
      goalProfit: settings.minimumProfit,
      expectedProfit: Number(feasibility.expectedProfit.toFixed(2)),
      riskAmount: Number(feasibility.riskAmount.toFixed(2)),
      riskPctRequired: Number(feasibility.riskPctRequired.toFixed(2)),
      marginPct: Number(feasibility.marginPct.toFixed(2)),
      leverageUsed: Number(feasibility.leverageUsed.toFixed(1)),
      probability,
      // The confidence label is the MODEL's — the forbidden hardcoded 0.5 is
      // gone: a goal signal without a real prediction reads 0 until AI passes.
      confidence: aiConfidence ?? 0,
      aiGate: aiBlocked ? 'BLOCKED' : 'PASS',
      aiProbability,
      aiConfidence,
      aiModelVersion,
      aiReason: aiBlocked ? aiReason : undefined,
      achievable: feasibility.achievable,
      reason: feasibility.reason,
      updatedAt: now,
    };
    this.goalAnalyses.set(symbol, analysis);
    if (analysis.achievable && !aiBlocked) {
      await this.upsertGoalSignal(symbol, analysis, atr, now, settings, regime);
      analysis.signalId = this.goalSignalIds.get(symbol);
    } else {
      // AI-blocked (or infeasible) setups must never sit as executable
      // signals: the model is entitled to disagree with the technical
      // direction, and a stale executable row would either trade against the
      // model or (worse) show the user a misleading "passing" confidence.
      // The analysis card remains visible with aiGate=BLOCKED + the reason.
      await this.invalidateGoalSignal(symbol, aiBlocked ? (aiReason || 'AI gate blocked') : analysis.reason);
    }
    this.goalAnalyses.set(symbol, analysis);
    return analysis;
  }

  /**
   * Drop goal analyses for symbols NOT in `keep` — a symbol-lock change (or
   * any universe shrink) must not leave pre-lock analyses on the card. The
   * scanner calls this after each sweep with the scanned set.
   */
  pruneGoalAnalyses(keep: Set<string>): void {
    for (const symbol of [...this.goalAnalyses.keys()]) {
      if (!keep.has(symbol)) this.goalAnalyses.delete(symbol);
    }
  }

  /** Latest goal analyses (Goal mode), achievable setups first. */
  getGoalAnalyses(): GoalAnalysis[] {
    return [...this.goalAnalyses.values()].sort((a, b) => {
      if (a.achievable !== b.achievable) return a.achievable ? -1 : 1;
      if (a.direction !== b.direction) return a.direction ? -1 : 1;
      return (b.probability ?? 0) - (a.probability ?? 0);
    });
  }

  /** Mode-aware per-symbol refresh: goal mode hunts for the goal profit across
   *  every symbol; strict mode runs the full ML-gated pipeline. */
  async refreshSymbol(symbol: string, force = false): Promise<AnalyzeResult | GoalAnalysis> {
    const settings = await this.loadSettings();
    if (settings.signalMode === 'goal') return this.analyzeForGoal(symbol, force);
    return this.analyzeSymbol(symbol, force);
  }

  /**
   * Creates / refreshes the actionable goal signal for a symbol in place (same
   * identity while the direction holds, zone re-anchored to the live price).
   * The fill-time gate still has final authority — margin/leverage/profit caps
   * are re-verified at execution, so a signal that became unachievable is
   * honestly blocked there instead of being silently dropped.
   */
  private async upsertGoalSignal(symbol: string, analysis: GoalAnalysis, atr: number | null, now: number, settings: UserSettings, regime: MarketRegimeSnapshot): Promise<void> {
    const direction = analysis.direction!;
    const existingId = this.goalSignalIds.get(symbol);
    let existing = existingId ? this.activeSignals.get(existingId) : undefined;
    if (existing && existing.direction !== direction) {
      await this.updateSignalState(existing, 'INVALIDATED', `goal direction changed ${existing.direction} → ${direction}`);
      this.activeSignals.delete(existing.id);
      this.goalSignalIds.delete(symbol);
      existing = undefined;
    }
    const asset = getAsset(symbol);
    const signal: Signal = {
      id: existing?.id ?? crypto.randomUUID(),
      signalId: existing?.signalId ?? crypto.randomUUID(),
      symbol,
      direction,
      state: 'WAITING_FOR_ENTRY',
      decision: direction,
      timestamp: existing?.timestamp ?? now,
      expiresAt: now + Math.min(settings.signalExpiryMs, 10 * 60_000),
      updatedAt: now,
      price: analysis.entry,
      plannedLots: analysis.lots,
      entry: {
        entryMin: analysis.entryMin,
        entryMax: analysis.entryMax,
        preferredEntry: analysis.entry,
        status: 'READY',
        reason: 'goal market order at live price',
        entryType: 'MARKET',
      },
      stopLoss: {
        price: analysis.stopLoss,
        pips: Math.abs(analysis.entry - analysis.stopLoss) / asset.pipSize,
        basis: existing?.stopLoss.basis ?? (atr ? 'structure/ATR' : 'ATR fallback'),
      },
      takeProfit: { tp1: analysis.takeProfit, tp2: 0, tp3: null, rr1: analysis.rr, rr2: 0, rr3: null },
      // Real model outputs (§ AI gate): probability/confidence come from the
      // live prediction that validated this goal signal — never a hardcoded 0.5.
      confidence: analysis.aiConfidence ?? 0,
      probability: analysis.aiProbability ?? 0.5,
      risk: { symbol, timestamp: now, level: 'YELLOW', score: 40, components: { goal: 1 }, critical: [], blocked: false },
      expectedValue: {
        evPerTrade: 0, evPerRisk: analysis.rr, probabilityWin: 0.5, probabilityLoss: 0.5,
        averageWin: 0, averageLoss: 0, tradingCosts: 0, positive: true,
        breakdown: { spread: 0, commission: 0, slippage: 0, swap: 0 },
      },
      regime,
      rr: analysis.rr,
      evidence: {
        technical: [`goal hunt — technical consensus ${analysis.direction}`, `risk ${analysis.riskPctRequired}% / margin ${analysis.marginPct}%`],
        multiTimeframe: [],
        priceAction: [],
        historical: [],
        ml: ['goal mode — no ML gate'],
        news: [],
        risk: [`goal ${analysis.goalProfit} ${this.goalCurrencyFor(settings)}`, `expected profit ${analysis.expectedProfit}`, `leverage ${analysis.leverageUsed}`],
        opposing: [],
      },
      snapshotId: existing?.snapshotId ?? crypto.randomUUID(),
      modelVersion: 'goal-hunt-v1',
      featureVersion: 'goal-hunt-v1',
      indicatorVersion: INDICATOR_VERSION,
      configurationVersion: hashSettings(settings),
      strategy: 'RISK_CONTROLLED',
      strategyVersion: 'goal-v1',
      strategyReason: 'goal hunt',
      mode: 'LIVE',
      signalVersion: (existing?.signalVersion ?? 0) + 1,
      previousVersion: existing?.signalVersion ?? null,
      lastChangeReason: existing ? 'goal plan refreshed at live price' : 'goal hunt signal created',
      events: existing?.events ?? [{ state: 'WAITING_FOR_ENTRY', timestamp: now, note: 'created by goal hunt' }],
    };
    this.activeSignals.set(signal.id, signal);
    this.goalSignalIds.set(symbol, signal.id);
    await this.persistSignal(signal);
    if (existing) this.deps.ctx.events.emit(CHANNELS.signalUpdated, signal);
    else this.deps.ctx.events.emit(CHANNELS.signalCreated, signal);
  }

  /** Invalidates a goal signal when the thesis died (direction gone / no goal
   *  set). Signals with an open position are never touched here. */
  private async invalidateGoalSignal(symbol: string, reason: string): Promise<void> {
    const id = this.goalSignalIds.get(symbol);
    if (!id) return;
    const signal = this.activeSignals.get(id);
    if (!signal || signal.positionId) {
      this.goalSignalIds.delete(symbol);
      return;
    }
    if (['POSITION_ACTIVE', 'TP1_HIT', 'TP2_HIT', 'TRAILING', 'CLOSED', 'SL_HIT', 'CANCELLED'].includes(signal.state)) {
      this.goalSignalIds.delete(symbol);
      return;
    }
    await this.updateSignalState(signal, 'INVALIDATED', `goal thesis gone: ${reason}`);
    this.activeSignals.delete(signal.id);
    this.goalSignalIds.delete(symbol);
  }

  private async upsertSignal(input: {
    symbol: string; direction: 'BUY' | 'SELL'; now: number; tick: number; bid: number; ask: number; spread: number;
    settings: UserSettings; quality: DataQualityReport; mtf: ReturnType<MultiTimeframeEngine['analyze']>;
    priceAction: PriceActionAnalysis; levels: Levels; regime: MarketRegimeSnapshot;
    ev: ReturnType<typeof calculateExpectedValue>; entryPlan: ReturnType<typeof buildEntry>;
    slResult: ReturnType<typeof buildStopLoss>['plan']; tp: ReturnType<typeof buildTakeProfit>;
    mlProbability: number; mlConfidence: number; pattern: PatternResult | undefined;
    newsForPair: NewsItem[]; eventRisk: EventRiskResult; sentiment: CurrencySentiment[];
    modelVersion: string; datasetVersion: string; featureVersion: string;
    strategy: StrategySelection;
    technicalScore: number; componentScores: Record<string, number>;
    sizing: ReturnType<typeof sizePosition>; riskAssessment: ReturnType<typeof classifyRisk>; blockedBy: string[];
  }): Promise<Signal> {
    let existing = [...this.activeSignals.values()].find(
      (s) => s.symbol === input.symbol && s.state !== 'INVALIDATED' && s.state !== 'MISSED' && s.state !== 'CLOSED' && s.state !== 'PERFORMANCE_RECORDED',
    );

    // if a signal exists but direction changed -> invalidate and create new
    if (existing && existing.direction !== input.direction) {
      await this.updateSignalState(existing, 'INVALIDATED', 'direction changed');
      this.activeSignals.delete(existing.id);
      existing = undefined;
    }
    // Spec §10/§11: a strategy change means a genuinely new market state —
    // roll to a fresh signal identity instead of reusing the old one.
    if (existing && existing.strategy !== input.strategy.strategy) {
      await this.updateSignalState(existing, 'INVALIDATED', `new market state — strategy changed ${existing.strategy ?? 'none'} → ${input.strategy.strategy}`);
      this.activeSignals.delete(existing.id);
      existing = undefined;
    }
    const isNew = !existing;
    const buildEvidence = (): SignalEvidence => ({
      technical: [
        `MTF consensus ${input.mtf.consensus}`,
        input.priceAction.trendStructure !== 'UNCLEAR' ? `structure ${input.priceAction.trendStructure}` : 'structure unclear',
        input.regime.regime,
      ],
      multiTimeframe: input.mtf.timeframes.filter((t) => ['1D', '4h', '1h'].includes(t.timeframe)).map((t) => `${t.timeframe} ${t.trend} (${t.momentum})`),
      priceAction: input.priceAction.patterns.slice(0, 5),
      historical: input.pattern?.available
        ? [`${input.pattern.similarCount} similar states: BUY ${(input.pattern.buyOutcome * 100).toFixed(0)}% / SELL ${(input.pattern.sellOutcome * 100).toFixed(0)}%`]
        : ['historical pattern analysis unavailable'],
      ml: [`ML probability ${(input.mlProbability * 100).toFixed(1)}% (model ${input.modelVersion})`],
      news: input.newsForPair.slice(0, 3).map((n) => `${n.headline} [${n.importance}]`),
      risk: [
        `risk level ${input.riskAssessment.level} (${input.riskAssessment.score})`,
        `EV ${input.ev.evPerTrade.toFixed(2)}`,
        `R:R ${input.tp.rr1.toFixed(2)}`,
        `data quality ${(input.quality.score * 100).toFixed(0)}%`,
      ],
      opposing: [
        ...(input.mtf.conflict ? ['MTF conflict: higher timeframes oppose the lower-timeframe setup'] : []),
        ...(input.regime.regimeChanged ? [`regime changed ${input.regime.previousRegime} → ${input.regime.regime}`] : []),
        ...(input.eventRisk.eventsInWindow.length ? [`events: ${input.eventRisk.detail}`] : []),
        ...(input.newsForPair.some((n) => n.importance === 'HIGH') ? ['high-importance news present'] : []),
        ...(input.regime.volatility === 'HIGH' ? ['elevated volatility'] : []),
        ...(input.sentiment.filter((s) => Math.sign(s.score) === (input.direction === 'BUY' ? -1 : 1)).map((s) => `${s.currency} sentiment ${s.score.toFixed(2)}`)),
      ],
    });

    const signalId = crypto.randomUUID();
    const id = existing?.id ?? signalId;
    const snapshotInput: SnapshotInput = {
      signalId: id,
      timestamp: input.now,
      symbol: input.symbol,
      direction: input.direction,
      price: input.tick,
      bid: input.bid,
      ask: input.ask,
      spread: input.spread,
      indicators: {},
      assetClass: this.deps.marketData.getLatest(input.symbol)?.assetClass,
      strategy: input.strategy.strategy,
      strategyVersion: input.strategy.strategyVersion,
      strategyReason: input.strategy.reason,
      multiTimeframe: input.mtf,
      priceAction: input.priceAction,
      levels: input.levels,
      news: input.newsForPair.slice(0, 10),
      events: input.eventRisk.eventsInWindow,
      sentiment: input.sentiment,
      regime: input.regime,
      mlProbability: input.mlProbability,
      historicalProbability: input.pattern?.buyOutcome ?? 0.5,
      technicalScore: input.technicalScore,
      componentScores: input.componentScores,
      riskScore: input.riskAssessment.score,
      expectedValue: input.ev,
      entry: input.entryPlan,
      stopLoss: input.slResult,
      takeProfit: input.tp,
      modelVersion: input.modelVersion,
      featureVersion: input.featureVersion,
      datasetVersion: input.datasetVersion,
      indicatorVersion: INDICATOR_VERSION,
      configurationVersion: hashSettings(input.settings),
      dataQualityScore: input.quality.score,
      mode: this.deps.ctx.providers.marketData.mode,
    };
    if (isNew) await this.deps.snapshots.create(snapshotInput);

    const signal: Signal = {
      id,
      signalId: id,
      symbol: input.symbol,
      direction: input.direction,
      state: 'WAITING_FOR_ENTRY',
      decision: input.direction,
      timestamp: input.now,
      // Spec §93: hard expiry. The live refresh loop re-analyzes constantly,
      // so a still-valid setup is re-created fresh after expiry — a signal
      // never lingers indefinitely.
      expiresAt: input.now + (input.settings.signalExpiryMs ?? 2 * 3600_000),
      updatedAt: input.now,
      price: input.tick,
      entry: input.entryPlan,
      stopLoss: input.slResult,
      takeProfit: input.tp,
      confidence: input.mlConfidence,
      probability: input.mlProbability,
      risk: input.riskAssessment,
      expectedValue: input.ev,
      regime: input.regime,
      rr: input.tp.rr1,
      strategy: input.strategy.strategy,
      strategyVersion: input.strategy.strategyVersion,
      strategyReason: input.strategy.reason,
      evidence: buildEvidence(),
      snapshotId: id,
      modelVersion: input.modelVersion,
      featureVersion: input.featureVersion,
      indicatorVersion: INDICATOR_VERSION,
      configurationVersion: hashSettings(input.settings),
      signalVersion: 1,
      mode: this.deps.ctx.providers.marketData.mode,
      events: [{ state: 'WAITING_FOR_ENTRY', timestamp: input.now, note: 'signal created' }],
    };

    if (isNew) {
      this.activeSignals.set(id, signal);
      await this.persistSignal(signal);
      this.deps.ctx.events.emit(CHANNELS.signalCreated, signal);
      this.deps.alerts.emit('NEW_SIGNAL', `New ${input.direction} signal ${input.symbol}`, input.symbol, 'INFO');
      return signal;
    }

    if (!existing) return signal; // unreachable — satisfies the type checker

    // LIVE UPDATE — the market moved but the same-direction thesis still holds:
    // refresh the analytical fields in place, preserving identity, lifecycle
    // state, events and the creation timestamp. Entry/SL/TP stay locked once
    // the signal has left WAITING_FOR_ENTRY (an opened position holds them).
    existing.price = input.tick;
    existing.updatedAt = input.now;
    existing.confidence = input.mlConfidence;
    existing.probability = input.mlProbability;
    existing.risk = input.riskAssessment;
    existing.expectedValue = input.ev;
    existing.regime = input.regime;
    existing.rr = input.tp.rr1;
    existing.evidence = buildEvidence();
    existing.modelVersion = input.modelVersion;
    existing.featureVersion = input.featureVersion;
    existing.strategy = input.strategy.strategy;
    existing.strategyVersion = input.strategy.strategyVersion;
    existing.strategyReason = input.strategy.reason;
    existing.indicatorVersion = INDICATOR_VERSION;
    existing.configurationVersion = hashSettings(input.settings);
    // (entry/SL/TP stay frozen — see comment above)
    // Entry/SL/TP are FROZEN at creation. The tick path owns ENTRY_REACHED /
    // MISSED against the stored zone; re-anchoring the entry to chase the
    // market would resurrect exactly the stale-call behavior this engine must
    // prevent (spec §10). Analytics refresh — levels do not.
    this.activeSignals.set(id, existing);
    await this.persistSignal(existing);
    this.deps.ctx.events.emit(CHANNELS.signalUpdated, existing);
    return existing;
  }

  /**
   * Called on every market update: refresh live signals. Entry-zone checks use
   * the REAL side of the spread: a BUY is actionable when the ask is inside
   * the zone (you pay ask), a SELL when the bid is inside it. Falls back to
   * mid when no bid/ask is available.
   */
  async refreshSignal(tick: Tick): Promise<void> {
    const symbol = tick.symbol;
    const now = Date.now();
    // Manage EVERY live pre-entry signal for the symbol — goal-mode and
    // strict-mode signals can coexist, and managing only the first `find()`
    // hit left the other one stale on ENTRY_REACHED/MISSED transitions.
    const candidates = [...this.activeSignals.values()].filter((s) => s.symbol === symbol);
    if (candidates.length === 0) return;
    for (const existing of candidates) {
      // ---- Expiry (spec §93) ------------------------------------------------
      // Past expiresAt a pre-entry signal is EXPIRED; the 15s refresh loop
      // immediately re-analyzes and re-creates only if a valid setup re-appears.
      if (signalExpired(existing, now) && isPreEntryState(existing.state)) {
        await this.updateSignalState(existing, 'EXPIRED', `signal expired after ${((now - existing.timestamp) / 1000).toFixed(0)}s`);
        this.deps.alerts.emit('SIGNAL_EXPIRED', `Signal expired for ${symbol} — running fresh analysis`, symbol, 'INFO');
        this.activeSignals.delete(existing.id);
        continue;
      }
      if (existing.state === 'WAITING_FOR_ENTRY') {
        if (existing.direction === 'BUY') {
          const price = tick.ask ?? tick.mid; // you buy at the ask
          if (price >= existing.entry.entryMin && price <= existing.entry.entryMax) {
            await this.updateSignalState(existing, 'ENTRY_REACHED', `entry reached at ask ${price}`);
            this.deps.alerts.emit('ENTRY_REACHED', `Entry reached for ${symbol}`, symbol, 'INFO');
          } else if (price > existing.entry.entryMax) {
            await this.updateSignalState(existing, 'MISSED', `entry zone missed (ask ${price})`);
            this.deps.alerts.emit('ENTRY_MISSED', `Entry missed for ${symbol}`, symbol, 'WARNING');
            this.activeSignals.delete(existing.id);
          }
        } else {
          const price = tick.bid ?? tick.mid; // you sell at the bid
          if (price >= existing.entry.entryMin && price <= existing.entry.entryMax) {
            await this.updateSignalState(existing, 'ENTRY_REACHED', `entry reached at bid ${price}`);
            this.deps.alerts.emit('ENTRY_REACHED', `Entry reached for ${symbol}`, symbol, 'INFO');
          } else if (price < existing.entry.entryMin) {
            await this.updateSignalState(existing, 'MISSED', `entry zone missed (bid ${price})`);
            this.deps.alerts.emit('ENTRY_MISSED', `Entry missed for ${symbol}`, symbol, 'WARNING');
            this.activeSignals.delete(existing.id);
          }
        }
      }
      // SL/TP checks for active positions happen in the paper engine
      existing.price = tick.mid;
      existing.updatedAt = now;
    }
  }

  /**
   * Manual cancel (spec §9 CANCELLED): only pre-position signals can be
   * cancelled; an open position is closed through the paper engine instead.
   */
  async cancelSignal(signalId: string, note = 'cancelled by user'): Promise<{ ok: boolean; reason?: string }> {
    const signal = [...this.activeSignals.values()].find((s) => s.id === signalId);
    if (!signal) return { ok: false, reason: 'signal not active' };
    if (!isPreEntryState(signal.state)) return { ok: false, reason: `cannot cancel a ${signal.state} signal` };
    await this.updateSignalState(signal, 'CANCELLED', note);
    this.activeSignals.delete(signal.id);
    this.deps.alerts.emit('SIGNAL_INVALIDATED', `Signal ${signal.symbol} cancelled by user`, signal.symbol, 'INFO');
    return { ok: true };
  }

  /**
   * Spec §37/§93: when a fresh analysis is materially worse than an existing
   * pre-entry signal (WAIT, negative EV, risk blocks…), the old signal is
   * INVALIDATED — it must never keep waiting on a dead thesis. The next
   * analysis pass creates a new signal only if a valid setup re-appears.
   */
  private async invalidatePreEntry(symbol: string, reason: string): Promise<void> {
    for (const s of [...this.activeSignals.values()]) {
      if (s.symbol === symbol && isPreEntryState(s.state)) {
        await this.updateSignalState(s, 'INVALIDATED', reason);
        this.activeSignals.delete(s.id);
      }
    }
  }

  invalidateAll(reason: string): void {
    for (const [id, signal] of this.activeSignals) {
      // Only PRE-ENTRY signals are invalidated by a global health event. A
      // POSITION_ACTIVE signal backs an open position — stripping its
      // lifecycle state would sever the audit chain while the position keeps
      // trading.
      if (!isPreEntryState(signal.state)) continue;
      void this.updateSignalState(signal, 'INVALIDATED', reason);
      this.activeSignals.delete(id);
    }
  }
}

function defaultSettings(): UserSettings {
  return {
    minimumProfit: 0,
    availableCapital: 10000,
    accountCurrency: 'USD',
    slippageBps: 1,
    signalExpiryMs: 2 * 3600_000,
    minimumInvestment: 0,
    maximumPositionSize: 0,
    disabledAssetClasses: [],
    disabledAssets: [],
    disabledStrategies: [],
    weekendTradingEnabled: false,
    weekendFlattenEnabled: true,
    tp1ClosePct: 30,
    tp2ClosePct: 40,
    breakevenEnabled: false,
    breakevenActivateR: 1,
    trailingMethod: 'ATR',
    trailingPercent: 0.5,
    trailingFixedDistance: 0,
    maxForexPositions: 0,
    maxCryptoPositions: 0,
    maxTradesPerAsset: 0,
    maxTradesPerCurrency: 0,
    singlePositionMode: false,
    autoTradeEnabled: false,
    maxMarginUsedPct: 0,
    signalMode: 'goal',
    maxRiskPercent: 1,
    minRr: 1.5,
    minConfidence: 0.55,
    maxDailyLossPercent: 3,
    maxWeeklyLossPercent: 6,
    maxDrawdownPercent: 10,
    maxConsecutiveLosses: 5,
    maxOpenPositions: 5,
    maxCorrelatedPositions: 3,
    maxLeverage: 50,
    maxCurrencyExposurePercent: 30,
    selectedPairs: ['EUR/USD', 'GBP/USD', 'USD/JPY', 'USD/CHF', 'AUD/USD', 'USD/CAD', 'NZD/USD', 'EUR/GBP', 'EUR/JPY', 'GBP/JPY', 'XAU/USD'],
    selectedTimeframes: ['15m', '1h', '4h'],
    preferredSessions: [],
    newsTrading: false,
    highImpactNewsRestriction: true,
    trailingStopEnabled: false,
    trailingStopMode: 'price',
    trailingStopAtrMultiplier: 2,
    lotMode: 'auto',
    manualLot: 0.1,
    trailingStopActivateR: 1,
    paperStartingCapital: 10000,
  };
}

function computeTechnicalScore(consensus: string, pa: PriceActionAnalysis, regime: MarketRegimeSnapshot, values: Record<string, number | null>): number {
  let score = 0;
  if (consensus === 'BULLISH') score += 30;
  if (consensus === 'BEARISH') score -= 30;
  if (pa.trendStructure === 'UPTREND') score += 15;
  if (pa.trendStructure === 'DOWNTREND') score -= 15;
  if (regime.regime === 'TRENDING_BULLISH') score += 20;
  if (regime.regime === 'TRENDING_BEARISH') score -= 20;
  // EMA structure: a stacked 9/20/50 alignment is the primary trend evidence
  // on any chart platform (MT5/XM included). ADX is a lagging confirmation —
  // omitting this term left a clearly stacked chart scoring ≈0 (RSI/MACD
  // noise only) whenever ADX sat below its threshold, which starved goal mode
  // of direction on exactly the pairs a user locks in to trade.
  const close = values.close ?? null;
  const ema9 = values.ema9 ?? null;
  const ema20 = values.ema20 ?? null;
  const ema50 = values.ema50 ?? null;
  if (ema9 !== null && ema20 !== null) {
    if (ema9 > ema20 && (ema50 === null || ema20 > ema50)) score += 15;
    else if (ema9 < ema20 && (ema50 === null || ema20 < ema50)) score -= 15;
  }
  if (close !== null && ema9 !== null) score += close > ema9 ? 5 : close < ema9 ? -5 : 0;
  const rsi = values.rsi14 ?? 50;
  score += ((rsi - 50) / 50) * 15;
  // MACD histogram is in PRICE units — a fixed multiplier pegs GBP/JPY at the
  // clamp every bar while contributing ~0 on EUR/USD. Normalize by ATR14 so
  // one unit ≈ "one ATR of momentum" on every symbol.
  const macdH = values.macdHistogram ?? 0;
  const atr = values.atr14 ?? null;
  const macdTerm = atr && atr > 0 ? Math.max(-10, Math.min(10, (macdH / atr) * 30)) : 0;
  score += macdTerm;
  const adxV = values.adx ?? 0;
  score += Math.max(-10, Math.min(10, (adxV - 20) / 4));
  return Math.max(-100, Math.min(100, score));
}

function canAchieveProfitSafe(minimumProfit: number, sizing: ReturnType<typeof sizePosition>, rr: number): boolean {
  if (minimumProfit <= 0) return true;
  if (!sizing.valid) return false;
  const achievable = sizing.expectedLoss * rr;
  return achievable >= minimumProfit;
}

/** Indicator-set version (spec §27) — bump when the indicator engine changes. */
const INDICATOR_VERSION = 'indicators-v1';

/** Deterministic, stable hash of the user configuration (spec §27). */
function hashSettings(s: UserSettings): string {
  const { userId: _u, ...rest } = s;
  const j = JSON.stringify(rest);
  let h = 0;
  for (let i = 0; i < j.length; i++) h = (h * 31 + j.charCodeAt(i)) | 0;
  return `cfg-${Math.abs(h).toString(36)}`;
}

/**
 * Granular score breakdown (spec §12): every component scored on ±100 so a
 * signal can be audited per factor, not just as one blended number.
 */
export function buildScoreBreakdown(input: {
  mtf: ReturnType<MultiTimeframeEngine['analyze']>;
  priceActionAnalysis: PriceActionAnalysis;
  regime: MarketRegimeSnapshot;
  values: Record<string, number | null>;
  conflict: boolean;
  extremeVolatility?: boolean;
}): Record<string, number> {
  const { mtf, priceActionAnalysis, regime, values, conflict } = input;
  let trend = 0;
  const close = values.close ?? null;
  const ema9 = values.ema9 ?? null;
  const ema20 = values.ema20 ?? null;
  const ema50 = values.ema50 ?? null;
  if (close !== null && ema9 !== null && ema20 !== null) {
    if (close > ema9 && ema9 > ema20 && (ema50 === null || ema20 > ema50)) trend = 40;
    else if (close < ema9 && ema9 < ema20 && (ema50 === null || ema20 < ema50)) trend = -40;
  }
  const rsi = values.rsi14 ?? 50;
  const macdH = values.macdHistogram ?? 0;
  const atrB = values.atr14 ?? null;
  const macdMomentum = atrB && atrB > 0 ? Math.max(-30, Math.min(30, (macdH / atrB) * 60)) : 0;
  const momentum = ((rsi - 50) / 50) * 40 + macdMomentum;
  const volatility = input.extremeVolatility ? -50 : regime.volatility === 'HIGH' ? -30 : regime.volatility === 'LOW' ? 0 : 10;
  const pa =
    priceActionAnalysis.trendStructure === 'UPTREND' ? 30
      : priceActionAnalysis.trendStructure === 'DOWNTREND' ? -30
        : priceActionAnalysis.trendStructure === 'RANGE' ? 0 : -10;
  const mtfScore = (mtf.alignment ?? 0) * 60 - (conflict ? 40 : 0);
  const regimeScore =
    regime.regime === 'TRENDING_BULLISH' ? 30
      : regime.regime === 'TRENDING_BEARISH' ? -30
        : regime.regime === 'UNCERTAIN' ? -30 : 0;
  return {
    trend: Number(trend.toFixed(1)),
    momentum: Number(momentum.toFixed(1)),
    volatility: Number(volatility.toFixed(1)),
    priceAction: Number(pa.toFixed(1)),
    mtf: Number(mtfScore.toFixed(1)),
    regime: Number(regimeScore.toFixed(1)),
  };
}

/** Entry sub-score (spec §22): R:R quality + level proximity + SL validity. */
export function entrySubScore(rr: number, tooCloseToLevel: boolean, slValid: boolean): number {
  let s = 0;
  if (slValid) s += 20;
  if (rr >= 2) s += 40;
  else if (rr >= 1.5) s += 20;
  else if (rr < 1.2) s -= 30;
  if (tooCloseToLevel) s -= 30;
  return s;
}
