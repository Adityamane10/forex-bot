/**
 * IndiaSignalEngine (spec §12, §20, §21, §34). Generates engine-driven signals
 * for the Indian universe from REAL analysis output only. Signals carry
 * engine-computed entry, SL, target, quantity and risk in INR. Strategies are
 * routed by market regime; every strategy declares the indicators it needs.
 *
 * Universal vs Goal: when GOAL owns execution authority, universal signals are
 * signal-only (executionBlocked = true). Never overrides Forex/Crypto engines.
 */
import type {
  IndiaAnalysisSnapshot,
  IndiaExecutionAuthorityState,
  IndiaInstrument,
  IndiaMarketSessionInfo,
  IndiaSignal,
  IndiaSignalGateTrail,
  IndiaSignalRejection,
  IndiaTick,
  IndiaTimeframe,
  StrategyName,
} from '@fx/shared';
import { INDIA_CHANNELS, INDIA_COLLECTIONS, INDIA_REDIS_KEYS, INDIA_REJECTION_REASONS, INDIA_SIGNAL_STATES } from '@fx/shared';
import { DataStore } from '../db/store';
import { Cache } from '../db/cache';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { indiaConfig } from './config';
import { IndiaInstrumentService } from './instruments';
import { IndiaAnalysisEngine, indiaRegime } from './analysis';
import { IndiaOptionFlowEngine } from './option-flow';
import { generateIndiaStopLoss, generateIndiaTakeProfit } from './sl-tp';
import { sizeIndiaPosition } from './risk-engine';
import { IndiaIndicatorValues } from '@fx/shared';
import { INDIA_REGIME_STRATEGY, indiaSignalCriteria } from './strategies';
import { runIndiaGates, summariseTrail } from './signal-gates';
import { evaluateMlGate } from './goal-opportunity';
import type { OptionAnalyticsEngine } from './option-analytics';
import type { IndiaUserSettingsService } from './user-settings';

/**
 * Result of preparing one goal candidate: either an UNSAVED signal ready for
 * ranking/finalization, or the exact stage/reason it failed a mandatory check.
 */
export interface PreparedGoalCandidate {
  instrument: IndiaInstrument;
  side: 'BUY' | 'SELL';
  strategy: StrategyName;
  signal?: IndiaSignal;
  stage?: IndiaSignalRejection['stage'];
  reason?: string;
  gateTrail?: IndiaSignalGateTrail;
}

/**
 * The one thing the gates need from the market feed: the last quote for a
 * contract, without awaiting anything.
 *
 * The gates run inside a synchronous scan loop over the whole subscribed
 * universe. Reading the quote from the shared cache instead would turn one scan
 * into hundreds of sequential round-trips, so `IndiaMarketFeedService` keeps a
 * process-local tick book and satisfies this interface.
 */
export interface IndiaTickReader {
  lastTick(instrumentToken: string): IndiaTick | null;
}

export interface IndiaSignalEngineOptions {
  store: DataStore;
  cache: Cache;
  events: EventEmitter;
  instruments: IndiaInstrumentService;
  analysis: IndiaAnalysisEngine;
  optionFlow?: IndiaOptionFlowEngine;
  /** Chain analytics (IV, greeks, max pain, liquidity) read synchronously from
   *  its cache. Optional: without it the gates fall back to OI-only posture. */
  optionAnalytics?: OptionAnalyticsEngine;
  /** Synchronous last-quote source for the depth gate. Structural rather than the
   *  feed class itself, so this module stays out of the feed's import graph and a
   *  test can hand in a map. */
  ticks?: IndiaTickReader;
  primaryTimeframe?: IndiaTimeframe;
  /** The user's saved capital/risk/margin values. Universal sizing reads these
   *  LIVE on every scan — the numbers the user set in the dashboard govern
   *  signal sizing, not compiled-in defaults. Optional: tests may omit it. */
  userSettings?: IndiaUserSettingsService;
}

export class IndiaSignalEngine {
  private recent = new Map<string, { side: 'BUY' | 'SELL'; at: number }>();
  private static COOLDOWN_MS = 30_000;
  private static SIGNAL_TTL_MS = 5 * 60_000;

  constructor(private opts: IndiaSignalEngineOptions) {}

  /** Scan the universe once and emit any new signals (market-open only). */
  async scan(session: IndiaMarketSessionInfo, authority: IndiaExecutionAuthorityState): Promise<IndiaSignal[]> {
    if (!session.marketOpen) return [];
    // Indices are price references, not tradable contracts — signals on them
    // can never be executed and once burned a paper fill at ₹26,111 × 1.
    const instruments = this.opts.instruments.executionInstruments()
      .filter((i) => i.contractType !== 'INDEX');
    const out: IndiaSignal[] = [];
    for (const instrument of instruments) {
      const analysis = await this.opts.analysis.analyze(instrument.instrumentToken, session);
      const signal = this.evaluate(instrument, analysis, session, authority);
      if (signal) out.push(signal);
    }
    return out;
  }

  /** Evaluate one instrument against its regime-routed strategy. */
  evaluate(
    instrument: IndiaInstrument,
    analysis: IndiaAnalysisSnapshot,
    session: IndiaMarketSessionInfo,
    authority: IndiaExecutionAuthorityState,
  ): IndiaSignal | null {
    const close = analysis.riskContext.close as number | undefined;
    if (!close || close <= 0) return null;
    const values = this.valuesFromSnapshot(analysis);
    const strategy = INDIA_REGIME_STRATEGY[analysis.regime] ?? 'RISK_CONTROLLED';
    const side = indiaSignalCriteria(strategy, values, { trend: analysis.trend, support: analysis.support, resistance: analysis.resistance });
    if (!side) return null;

    const now = Date.now();
    const last = this.recent.get(instrument.instrumentToken);
    if (last && last.side === side && now - last.at < IndiaSignalEngine.COOLDOWN_MS) {
      return null;
    }
    // Marked before the gates run, deliberately. A setup that is going to be
    // rejected should be rejected once, not on every scan tick for as long as the
    // conditions persist — this doubles as the throttle on the rejection feed.
    this.recent.set(instrument.instrumentToken, { side, at: now });

    // Universal path honours the same ML gate: without a live model there is no
    // honest conviction to publish, signal-only or otherwise.
    const ml = this.mlGate(analysis, side);
    if (!ml.ok) {
      this.reject(instrument, side, strategy, now, 'GATE', ml.reason);
      return null;
    }

    const entry = close;
    const stopLoss = generateIndiaStopLoss({
      instrument, indicators: values, side, entry, strategy, minRr: 1.5, timeframe: this.opts.primaryTimeframe ?? '5m',
    });
    const target = generateIndiaTakeProfit({
      instrument, indicators: values, side, entry, strategy, minRr: 1.5, timeframe: this.opts.primaryTimeframe ?? '5m',
    }, stopLoss);

    // Gates before sizing: they are pure and cheap, and a blocked setup should not
    // spend a margin calculation. It also means the trail reports the reason the
    // trade was refused rather than a downstream symptom of it.
    const gate = this.runGates({
      instrument, side, entry, stopLoss: stopLoss.price, target: target.target,
      baseConfidence: analysis.confidence, now,
    });
    if (!gate.trail.passed) {
      this.reject(instrument, side, strategy, now, 'GATE', summariseTrail(gate.trail), gate.trail);
      return null;
    }

    const sizing = sizeIndiaPosition({
      instrument,
      // Universal sizing follows the USER'S saved settings when available —
      // capital, max risk/trade and margin % from the dashboard. Falls back to
      // the compiled-in defaults only when no settings service exists (tests).
      amountInr: this.opts.userSettings?.sync().amountInr ?? indiaConfig.defaultGoal.amountInr,
      maxRiskInr: this.opts.userSettings?.sync().maxRiskInr ?? indiaConfig.defaultGoal.maxRiskInr,
      maxMarginPercent: this.opts.userSettings?.sync().maxMarginPercent ?? indiaConfig.defaultGoal.maxMarginPercent,
      side,
      entry,
      stopLoss: stopLoss.price,
      target: target.target,
    });
    if (!sizing.valid || sizing.quantity <= 0) {
      this.reject(instrument, side, strategy, now, 'SIZING', sizing.reason, gate.trail);
      return null;
    }

    const goalOwns = authority.owner === 'GOAL';
    const signal: IndiaSignal = {
      signalId: randomUUID(),
      instrumentToken: instrument.instrumentToken,
      tradingSymbol: instrument.tradingSymbol,
      underlying: instrument.underlying,
      exchange: instrument.exchange,
      segment: instrument.segment,
      contractType: instrument.contractType,
      side,
      entry,
      stopLoss: stopLoss.price,
      target: target.target,
      quantity: sizing.quantity,
      lotSize: instrument.lotSize,
      riskInr: sizing.maximumLoss,
      expectedProfitInr: sizing.targetProfit,
      rr: sizing.rr,
      confidence: gate.trail.finalConfidence,
      strategy,
      timeframe: this.opts.primaryTimeframe ?? '5m',
      createdAt: now,
      marketTimestamp: analysis.marketTimestamp,
      expiresAt: now + IndiaSignalEngine.SIGNAL_TTL_MS,
      status: 'READY',
      analysis,
      owner: 'UNIVERSAL',
      executionMode: authority.universal.executionMode,
      optionConfirmation: gate.posture,
      gateTrail: gate.trail,
      blockedReason: goalOwns ? 'GOAL owns execution authority; universal signals are signal-only' : undefined,
      invalidatedReason: null,
    };

    this.persist(signal).catch(() => undefined);
    this.opts.events.emit(INDIA_CHANNELS.signal, signal);
    this.opts.cache
      .set(INDIA_REDIS_KEYS.signal + signal.signalId, JSON.stringify(signal), 300)
      .catch(() => undefined);
    return signal;
  }

  /**
   * Mandatory ML gate (spec §15) — delegates to the shared, testable rule set:
   * availability always required; strict-meta veto only when configured; and a
   * side-aligned stacked-probability floor that enforces genuine conviction
   * without depending on the current bundles' constant (uninformative) meta
   * output. The old confidence=0.5 fallback stays dead.
   */
  private mlGate(analysis: IndiaAnalysisSnapshot, side: 'BUY' | 'SELL'): { ok: boolean; reason: string } {
    const result = evaluateMlGate(analysis.prediction, side, {
      strictMeta: indiaConfig.mlMetaStrict,
      minProbability: indiaConfig.mlMinProbability,
    });
    return { ok: result.ok, reason: result.reason };
  }

  /**
   * Prepare one goal candidate WITHOUT persisting or emitting: criteria →
   * engine SL/TP → ML gate → pre-trade gates → goal sizing. The caller ranks
   * all prepared candidates and finalizes only the winner (§7), so the market
   * decides the best trade instead of instrument iteration order.
   */
  prepareGoal(
    instrument: IndiaInstrument,
    analysis: IndiaAnalysisSnapshot,
    session: IndiaMarketSessionInfo,
    goal: { goalId: string; maxRiskInr: number; amountInr: number; maxMarginPercent: number; executionMode: IndiaSignal['executionMode'] },
  ): PreparedGoalCandidate {
    const close = analysis.riskContext.close as number | undefined;
    if (!session.marketOpen) return { instrument, side: 'BUY', strategy: 'RISK_CONTROLLED', stage: 'GATE', reason: 'market closed' };
    if (!close || close <= 0) return { instrument, side: 'BUY', strategy: 'RISK_CONTROLLED', stage: 'NO_SETUP', reason: 'no close price' };

    const values = this.valuesFromSnapshot(analysis);
    const strategy = INDIA_REGIME_STRATEGY[analysis.regime] ?? 'RISK_CONTROLLED';
    const side = indiaSignalCriteria(strategy, values, { trend: analysis.trend, support: analysis.support, resistance: analysis.resistance });
    if (!side) return { instrument, side: 'BUY', strategy, stage: 'NO_SETUP', reason: 'entry criteria not met' };

    const now = Date.now();
    const ml = this.mlGate(analysis, side);
    if (!ml.ok) return { instrument, side, strategy, stage: 'GATE', reason: ml.reason };
    const entry = close;
    const stopLoss = generateIndiaStopLoss({
      instrument, indicators: values, side, entry, strategy, minRr: 1.5, timeframe: this.opts.primaryTimeframe ?? '5m',
    });
    const target = generateIndiaTakeProfit({
      instrument, indicators: values, side, entry, strategy, minRr: 1.5, timeframe: this.opts.primaryTimeframe ?? '5m',
    }, stopLoss);

    // The same gates as the universal path. A goal has a profit mandate, but that
    // is not a reason to accept an entry the option book, the clock or the spread
    // says is bad — it is a reason to wait for the next setup.
    const gate = this.runGates({
      instrument, side, entry, stopLoss: stopLoss.price, target: target.target,
      baseConfidence: analysis.confidence, now,
    });
    if (!gate.trail.passed) return { instrument, side, strategy, stage: 'GATE', reason: summariseTrail(gate.trail), gateTrail: gate.trail };

    const sizing = sizeIndiaPosition({
      instrument,
      amountInr: goal.amountInr,
      maxRiskInr: goal.maxRiskInr,
      maxMarginPercent: goal.maxMarginPercent,
      side,
      entry,
      stopLoss: stopLoss.price,
      target: target.target,
    });
    if (!sizing.valid || sizing.quantity <= 0) {
      return { instrument, side, strategy, stage: 'SIZING', reason: sizing.reason, gateTrail: gate.trail };
    }

    const signal: IndiaSignal = {
      signalId: randomUUID(),
      instrumentToken: instrument.instrumentToken,
      tradingSymbol: instrument.tradingSymbol,
      underlying: instrument.underlying,
      exchange: instrument.exchange,
      segment: instrument.segment,
      contractType: instrument.contractType,
      side,
      entry,
      stopLoss: stopLoss.price,
      target: target.target,
      quantity: sizing.quantity,
      lotSize: instrument.lotSize,
      riskInr: sizing.maximumLoss,
      expectedProfitInr: sizing.targetProfit,
      rr: sizing.rr,
      confidence: gate.trail.finalConfidence,
      strategy,
      timeframe: this.opts.primaryTimeframe ?? '5m',
      createdAt: now,
      marketTimestamp: analysis.marketTimestamp,
      expiresAt: now + IndiaSignalEngine.SIGNAL_TTL_MS,
      status: 'READY',
      analysis,
      owner: 'GOAL',
      executionMode: goal.executionMode,
      goalId: goal.goalId,
      optionConfirmation: gate.posture,
      gateTrail: gate.trail,
      invalidatedReason: null,
    };
    return { instrument, side, strategy, signal };
  }

  /** Legacy single-shot path kept for compatibility: prepare + finalize. */
  async evaluateForGoal(
    instrument: IndiaInstrument,
    analysis: IndiaAnalysisSnapshot,
    session: IndiaMarketSessionInfo,
    goal: { goalId: string; maxRiskInr: number; amountInr: number; maxMarginPercent: number; executionMode: IndiaSignal['executionMode'] },
  ): Promise<IndiaSignal | null> {
    const prepared = this.prepareGoal(instrument, analysis, session, goal);
    if (!prepared.signal) {
      this.reject(prepared.instrument, prepared.side, prepared.strategy, Date.now(), prepared.stage ?? 'GATE', prepared.reason ?? 'rejected', prepared.gateTrail, goal.goalId);
      return null;
    }
    this.finalizeGoalSignal(prepared.signal);
    return prepared.signal;
  }

  /** Persist + emit a ranked goal signal at the moment it becomes THE trade. */
  finalizeGoalSignal(signal: IndiaSignal): void {
    this.persist(signal).catch(() => undefined);
    this.opts.events.emit(INDIA_CHANNELS.signal, signal);
    this.opts.cache
      .set(INDIA_REDIS_KEYS.signal + signal.signalId, JSON.stringify(signal), 300)
      .catch(() => undefined);
  }

  /** Cached chain-analytics context for opportunity scoring — synchronous, no I/O. */
  optionSnapshotFor(underlying: string): { sentiment: { signal?: string | null } | null; ivAnalysis: { atmIv?: number | null } | null } | null {
    const a = this.opts.optionAnalytics?.cached(underlying);
    if (!a) return null;
    return {
      sentiment: { signal: a.sentiment?.signal ?? null },
      ivAnalysis: { atmIv: a.ivAnalysis?.atmIV != null ? a.ivAnalysis.atmIV * 100 : null },
    };
  }

  /** Flag expired signals (engine maintenance, run on a timer). */
  async expireOldSignals(): Promise<number> {
    const now = Date.now();
    let count = 0;
    try {
      const stored = await this.opts.store.find<IndiaSignal & { _id?: unknown }>(INDIA_COLLECTIONS.signals, {
        status: 'READY',
      });
      for (const s of stored) {
        if ((s.expiresAt ?? 0) < now) {
          await this.opts.store.updateOne(INDIA_COLLECTIONS.signals, { signalId: s.signalId }, { $set: { status: 'EXPIRED' } });
          this.opts.events.emit(INDIA_CHANNELS.signalInvalidated, { signalId: s.signalId, reason: 'expired' });
          count += 1;
        }
      }
    } catch {
      /* collection may not exist */
    }
    return count;
  }

  /**
   * Run the pre-trade gates for one candidate.
   *
   * Replaces the old `optionConfirmation`, which added `+0.15` when the option
   * posture agreed and did nothing at all when it disagreed — so the option book
   * could only ever help a trade, never stop one. It also read `side === 'BUY'`
   * as bullish regardless of `optionType`, which inverted the check on every put.
   *
   * All three reads are synchronous lookups. This runs inside a scan loop and
   * must not await a REST call; when a cache is cold the gates report that
   * honestly rather than blocking the trade.
   */
  private runGates(input: {
    instrument: IndiaInstrument;
    side: 'BUY' | 'SELL';
    entry: number;
    stopLoss: number;
    target: number;
    baseConfidence: number;
    now: number;
  }): { trail: IndiaSignalGateTrail; posture: IndiaSignal['optionConfirmation'] } {
    const { instrument } = input;
    const analytics = this.opts.optionAnalytics?.cached(instrument.underlying) ?? null;
    const flow = this.opts.optionFlow?.cached(instrument.underlying, instrument.expiry ?? null) ?? null;
    // The traded contract's own book, not the underlying's — the depth gate asks
    // whether *this* strike can be dealt in.
    const tick = this.opts.ticks?.lastTick(instrument.instrumentToken) ?? null;

    const trail = runIndiaGates({ ...input, analytics, flow, tick });

    // Prefer the chain's own sentiment — it weighs PCR, max pain and OI activity
    // together — and fall back to the OI-only posture.
    const posture = analytics?.sentiment.signal ?? flow?.posture ?? null;
    return { trail, posture };
  }

  /**
   * Record a setup the engine found and then declined.
   *
   * Rejections are as informative as signals for paper trading: without them the
   * UI can only show what was traded, and "why did nothing happen for two hours"
   * has no answer. Emitted on its own channel and not persisted — these are high
   * frequency and only interesting while they are fresh.
   */
  private reject(
    instrument: IndiaInstrument,
    side: 'BUY' | 'SELL' | null,
    strategy: StrategyName | null,
    at: number,
    stage: IndiaSignalRejection['stage'],
    reason: string,
    gateTrail?: IndiaSignalGateTrail,
    goalId?: string,
  ): void {
    const rejection: IndiaSignalRejection = {
      instrumentToken: instrument.instrumentToken,
      tradingSymbol: instrument.tradingSymbol,
      underlying: instrument.underlying,
      side,
      strategy,
      at,
      stage,
      reason,
      gateTrail,
      goalId,
    };
    this.opts.events.emit(INDIA_CHANNELS.signalRejected, rejection);
  }

  private async persist(signal: IndiaSignal): Promise<void> {
    try {
      await this.opts.store.insertOne(INDIA_COLLECTIONS.signals, signal);
    } catch {
      /* best-effort */
    }
  }

  /** Rebuild numeric indicator values from the analysis risk/feature context. */
  private valuesFromSnapshot(a: IndiaAnalysisSnapshot): IndiaIndicatorValues {
    const values: IndiaIndicatorValues = {};
    const rc = a.riskContext;
    values.close = typeof rc.close === 'number' ? rc.close : null;
    values.rsi14 = typeof rc.rsi === 'number' ? rc.rsi : null;
    values.adx = typeof rc.adx === 'number' ? rc.adx : null;
    values.bbPosition = typeof rc.bbPosition === 'number' ? rc.bbPosition : null;
    values.vwapPosition = typeof rc.vwapPosition === 'number' ? rc.vwapPosition : null;
    values.macdHistogram = typeof rc.macdHistogram === 'number' ? rc.macdHistogram : null;
    values.volumeRatio = typeof rc.volumeRatio === 'number' ? rc.volumeRatio : null;
    values.trend = typeof rc.trend === 'number' ? rc.trend : null;
    values.atr14 = typeof rc.atr === 'number' ? rc.atr : null;
    values.support = a.support;
    values.resistance = a.resistance;
    values.swingHigh = a.swingHigh;
    values.swingLow = a.swingLow;
    return values;
  }
}

export const indiaSignalStates = INDIA_SIGNAL_STATES;
export const indiaRejectionReasons = INDIA_REJECTION_REASONS;
export { indiaRegime };
