/**
 * IndiaGoalEngine (spec §23–§31, §16–§17). Goal Trading runs a SEQUENCE of
 * engine-driven trades (numberOfTrades) toward a fixed profit target in INR.
 * Trades are strictly sequential: the next trade only starts after the previous
 * position is closed. The engine owns execution authority while active; when it
 * finishes (target reached / trades exhausted / stop), authority is released.
 *
 * sessionPolicy:
 *   TODAY_ONLY            — stop at market close (or when target is reached).
 *   CONTINUE_NEXT_SESSION — persist and resume next trading day.
 */
import type {
  IndiaGoal,
  IndiaGoalConfig,
  IndiaGoalDiagnostics,
  IndiaGoalProgress,
  IndiaGoalState,
  IndiaMarketSessionInfo,
  IndiaMlStatus,
  IndiaOpportunity,
  IndiaPosition,
  IndiaSignal,
  IndiaTick,
  IndiaTrade,
  IndiaTradeExitReason,
} from '@fx/shared';
import { INDIA_CHANNELS, INDIA_COLLECTIONS, INDIA_REDIS_KEYS, INDIA_GOAL_STATES } from '@fx/shared';
import { DataStore } from '../db/store';
import { Cache } from '../db/cache';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { logger } from '../core/logger';
import { IndiaInstrumentService } from './instruments';
import { IndiaAnalysisEngine } from './analysis';
import { IndiaSignalEngine, PreparedGoalCandidate } from './signal-engine';
import { IndiaPaperExecutionEngine } from './paper-execution';
import { IndiaExecutionAuthorityManager } from './execution-authority';
import { evaluateStagnation, rankGoalCandidates, scoreGoalCandidate, OpportunityOptionContext } from './goal-opportunity';

export class IndiaGoalEngine {
  private goal: IndiaGoal | null = null;
  private scanning = false;
  /** Synchronous last-quote source for opportunity scoring (spread/liquidity). */
  private ticks: { lastTick(instrumentToken: string): IndiaTick | null } | null;
  /** Data-health gate (spec §40): market open + stale feed ⇒ NO new trades. */
  private isDataHealthy: () => boolean;

  constructor(
    private store: DataStore,
    private cache: Cache,
    private events: EventEmitter,
    private instruments: IndiaInstrumentService,
    private analysis: IndiaAnalysisEngine,
    private signalEngine: IndiaSignalEngine,
    private paper: IndiaPaperExecutionEngine,
    private authority: IndiaExecutionAuthorityManager,
    ticks?: { lastTick(instrumentToken: string): IndiaTick | null } | null,
    isDataHealthy?: () => boolean,
  ) {
    this.ticks = ticks ?? null;
    // Default true so tests without a health service still exercise the loop.
    this.isDataHealthy = isDataHealthy ?? (() => true);
  }

  currentGoal(): IndiaGoal | null {
    return this.goal;
  }

  /**
   * Resume durable state after a restart (spec §25).
   *
   * An ACTIVE goal is RELOADED into memory, not stopped: the engine must
   * survive dev-restarts and deploys without losing the user's run. Session
   * rules then govern it exactly as they would have continuously — a
   * TODAY_ONLY goal that outlived the bell stops on its first scan tick, a
   * live one resumes scanning with fresh data. Only goals already terminal are
   * left untouched.
   */
  async init(): Promise<void> {
    try {
      const active = await this.store.find<IndiaGoal & { _id?: unknown }>(
        INDIA_COLLECTIONS.goals, { status: 'ACTIVE' }
      );
      const resumed = active.sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;
      if (resumed) {
        // The authority snapshot this process loaded may predate the goal
        // (restart races) — an ACTIVE goal without GOAL ownership is a scanner
        // that can never execute. Re-take it; failure means another engine
        // genuinely holds authority and the user must decide.
        if (!this.authority.acquire('GOAL', 'resumed ACTIVE goal after restart')) {
          logger.warn('india: resumed ACTIVE goal holds no execution authority — owned elsewhere', {
            goalId: resumed.goalId,
          });
        }
        this.goal = resumed;
        logger.info('india: resumed ACTIVE goal after restart', {
          goalId: resumed.goalId,
          completedTrades: resumed.progress.completedTrades,
          requestedTrades: resumed.progress.requestedTrades,
        });
        this.broadcast();
      }
    } catch {
      /* collection may not exist yet */
    }
  }

  async start(config: IndiaGoalConfig): Promise<IndiaGoal> {
    if (this.goal && this.goal.status === 'ACTIVE') return this.goal;
    // Honor the user's chosen executionMode: a MANUAL/OFF goal that starts
    // must not silently become AUTO trading (the authority used to flip it).
    if (config.executionMode !== 'AUTO') {
      throw new Error(`goal executionMode is ${config.executionMode} — automatic trading is disabled`);
    }
    if (!this.authority.acquire('GOAL', 'goal trading started')) {
      throw new Error('execution authority is held by another engine — goal trading cannot start');
    }
    const now = Date.now();
    this.goal = {
      goalId: config.goalId,
      config,
      state: 'SCANNING',
      progress: this.emptyProgress(config, now),
      trades: [],
      startedAt: now,
      completedAt: null,
      status: 'ACTIVE',
    };
    await this.persist();
    this.broadcast();
    return this.goal;
  }

  async stop(reason: IndiaTradeExitReason = 'ENGINE_EXIT', note = 'goal stopped'): Promise<IndiaGoal | null> {
    if (!this.goal || this.goal.status !== 'ACTIVE') return this.goal;
    await this.paper.exitAll(reason);
    this.goal.state = 'STOPPED';
    this.goal.status = 'STOPPED';
    this.goal.completedAt = Date.now();
    this.authority.release('GOAL', note);
    await this.persist();
    this.broadcast();
    return this.goal;
  }

  /** One goal-scan tick: look for a trade (only when no position is open). */
  async scan(session: IndiaMarketSessionInfo): Promise<void> {
    if (!this.goal || this.goal.status !== 'ACTIVE' || this.scanning) return;
    // A goal in MANUAL or OFF mode must not auto-trade even while ACTIVE —
    // the config controls it; otherwise /goal/diagnostics displays
    // autoTradeEnabled:false while it trades. Tests use a bare mock authority
    // without canExecute(); fall back to the underlying mode check.
    const can = typeof (this.authority as unknown as { canExecute?: (o: string) => { allowed: boolean } }).canExecute === 'function'
      ? (this.authority as unknown as { canExecute: (o: string) => { allowed: boolean } }).canExecute('GOAL')
      : { allowed: (this.authority.snapshot?.() ?? this.authority as unknown as { goal?: { executionMode?: string } }).goal?.executionMode !== 'OFF' };
    if (!can.allowed) return;
    if (!session.marketOpen) {
      if (this.goal.config.sessionPolicy === 'TODAY_ONLY') {
        await this.stop('MARKET_CLOSED', 'market closed (TODAY_ONLY goal)');
      }
      return;
    }
    this.scanning = true;
    try {
      const active = this.goal.progress.activeTrade ?? this.paper.openPositions().find((p) => p.goalId === this.goal?.goalId);
      if (active) {
        this.goal.state = 'MONITORING';
        await this.evaluateStagnation(active);
        await this.persist();
        this.broadcast();
        return;
      }

      if (this.goal.state === 'MONITORING' || this.goal.state === 'POSITION_OPEN') {
        this.goal.state = 'SCANNING_NEXT';
      }
      if (this.goal.progress.completedTrades >= this.goal.config.numberOfTrades) {
        await this.finish('GOAL_COMPLETED', `requested ${this.goal.config.numberOfTrades} trades completed`);
        return;
      }

      this.goal.state = 'SCANNING';
      // Data-health gate (§40): a stale feed must not source new trades, even
      // with the market technically open. Existing positions keep their normal
      // SL/TP/stagnation monitoring — only NEW entries are held back.
      if (!this.isDataHealthy()) {
        this.goal.progress.waitReason = 'Stale data — no new entries until the feed recovers';
        this.goal.progress.mlStatus = this.goal.progress.mlStatus ?? undefined;
        this.goal.progress.diagnostics = this.goal.progress.diagnostics
          ? { ...this.goal.progress.diagnostics, blockReason: 'Data feed stale — new entries held until ticks recover' }
          : this.goal.progress.diagnostics;
        await this.persist();
        this.broadcast();
        return;
      }
      const scanStartedAt = Date.now();
      // Filter instruments by tradeUnderlyings if specified. Indices are
      // excluded from the trading universe: they exist here for chart seeding
      // and price reference, and one of them once reached execution.
      const allowedUnderlyings = new Set(this.goal.config.tradeUnderlyings ?? []);
      const candidateInstruments = this.instruments.executionInstruments().filter((i) => {
        if (i.contractType === 'INDEX') return false;
        if (allowedUnderlyings.size === 0) return true;
        return allowedUnderlyings.has(i.underlying.toUpperCase());
      });

      // Per-stage diagnostic counters (§34): "no signals" must say WHERE every
      // candidate died, not just that it did. Example reasons keep the first
      // (usually the most representative) failure text per stage.
      let instrumentsWithData = 0;
      let criteriaPassed = 0;
      let candidatesPrepared = 0;
      const rejectedNoSetup: string[] = [];
      const rejectedMl: string[] = [];
      const rejectedGates: string[] = [];
      const rejectedSizing: string[] = [];
      const rejectedScoring: string[] = [];
      const firstByStage: IndiaGoalDiagnostics['rejected']['exampleReasons'] = {};

      // Collect and RANK every fresh candidate instead of trading the first one
      // that clears the bar (spec §7). Iteration order is instrument-master
      // accident; the market, not that accident, picks the trade.
      const scored: Array<{ signal: IndiaSignal; opportunity: IndiaOpportunity }> = [];
      let mlStatus: IndiaMlStatus | undefined;
      let sawMlOffline = false;
      let sawAnySetup = false;

      for (const instrument of candidateInstruments) {
        if (!this.goal || this.goal.status !== 'ACTIVE') return;
        const analysis = await this.analysis.analyze(instrument.instrumentToken, session);
        if (analysis.prediction) {
          mlStatus = analysis.prediction.mlStatus ?? (analysis.prediction.available ? 'ONLINE' : 'OFFLINE');
          if (!analysis.prediction.available || analysis.prediction.mlStatus === 'OFFLINE') sawMlOffline = true;
        }
        const hasData = !((analysis.riskContext as { state?: string }).state);
        if (hasData) instrumentsWithData += 1;
        const prepared: PreparedGoalCandidate = this.signalEngine.prepareGoal(instrument, analysis, session, {
          goalId: this.goal.goalId,
          maxRiskInr: this.goal.config.maxRiskInr,
          amountInr: this.goal.config.amountInr,
          maxMarginPercent: this.goal.config.maxMarginPercent,
          executionMode: this.goal.config.executionMode,
        });
        if (!prepared.signal) {
          // Entry criteria that never fired is the common healthy case; ML/gate/
          // sizing rejections are conditions the user may be able to act on.
          if (prepared.stage === 'NO_SETUP') {
            rejectedNoSetup.push(prepared.reason ?? 'no setup');
          } else if (prepared.stage === 'GATE') {
            if ((prepared.reason ?? '').startsWith('ML_')) rejectedMl.push(prepared.reason ?? '');
            else rejectedGates.push(prepared.reason ?? '');
            criteriaPassed += 1; // a side existed before the gate refused it
          } else if (prepared.stage === 'SIZING') {
            rejectedSizing.push(prepared.reason ?? '');
            criteriaPassed += 1;
          }
          continue;
        }
        sawAnySetup = true;
        criteriaPassed += 1;
        candidatesPrepared += 1;

        const tick = this.ticks?.lastTick(instrument.instrumentToken) ?? null;
        const optionContext: OpportunityOptionContext | null =
          this.signalEngine.optionSnapshotFor(instrument.underlying);
        const remaining = Math.max(
          1,
          this.goal.config.minimumProfitInr - this.goal.progress.totalPnlInr,
        );
        const result = scoreGoalCandidate({
          instrument,
          strategy: prepared.strategy,
          side: prepared.side,
          entry: prepared.signal.entry,
          stopLoss: prepared.signal.stopLoss,
          target: prepared.signal.target,
          riskInr: prepared.signal.riskInr,
          expectedProfitInr: prepared.signal.expectedProfitInr,
          rr: prepared.signal.rr,
          quantity: prepared.signal.quantity,
          analysis,
          prediction: analysis.prediction,
          optionContext,
          tick: tick ? { ltp: tick.ltp, bid: tick.bid, ask: tick.ask } : null,
          goalRemainingInr: remaining,
          maxRiskInr: this.goal.config.maxRiskInr,
          now: Date.now(),
        });
        if (result.eligible) scored.push({ signal: prepared.signal, opportunity: result.opportunity });
        else rejectedScoring.push(result.reason);
      }

      const ranked = rankGoalCandidates(scored.map((s) => s.opportunity));
      const bestPair = ranked.length
        ? scored.find((s) => s.opportunity === ranked[0])!
        : null;

      // Collapse the counters into the structured diagnostics object.
      const firstOf = (xs: string[]): string | undefined => xs[0];
      const diagnostics: IndiaGoalDiagnostics = {
        lastScanAt: Date.now(),
        lastScanDurationMs: Date.now() - scanStartedAt,
        marketOpen: session.marketOpen,
        dataHealthy: this.isDataHealthy(),
        mlStatus: mlStatus ?? null,
        optionDataReady: scored.some((s) => s.opportunity.components.oiConfirmation !== 0.5),
        instrumentsScanned: candidateInstruments.length,
        instrumentsWithData,
        criteriaPassed,
        candidatesPrepared,
        validCandidates: scored.length,
        rejected: {
          noSetup: rejectedNoSetup.length,
          ml: rejectedMl.length,
          gates: rejectedGates.length,
          sizing: rejectedSizing.length,
          scoring: rejectedScoring.length,
          exampleReasons: {
            ...(firstOf(rejectedNoSetup) ? { NO_SETUP: firstOf(rejectedNoSetup) } : {}),
            ...(firstOf([...rejectedMl, ...rejectedGates]) ? { GATE: firstOf([...rejectedMl, ...rejectedGates]) } : {}),
            ...(firstOf(rejectedSizing) ? { SIZING: firstOf(rejectedSizing) } : {}),
            ...(firstOf(rejectedScoring) ? { SCORING: firstOf(rejectedScoring) } : {}),
          },
        },
      };

      // Goal progress context for the UI (§27 + §34): the best current
      // opportunity, WHY nothing qualified when nothing did — with the true
      // stage breakdown, never collapsed into one vague line — and the ML
      // serving state. §12: an unavailable model names itself as the blocker.
      this.goal.progress.currentOpportunity = bestPair?.opportunity ?? null;
      this.goal.progress.mlStatus = mlStatus ?? (sawMlOffline ? 'OFFLINE' : undefined);
      this.goal.progress.diagnostics = diagnostics;
      this.goal.progress.waitReason = bestPair
        ? null
        : sawMlOffline
          ? 'ML unavailable — automatic goal trading blocked (fail closed)'
          : candidateInstruments.length === 0
            ? 'No instruments in goal universe'
            : rejectedMl.length > 0
              ? `${rejectedMl.length} setup(s) died at the ML gate — e.g. ${firstOf(rejectedMl)}`
              : rejectedGates.length > 0
                ? `${rejectedGates.length} setup(s) died at pre-trade gates — e.g. ${firstOf(rejectedGates)}`
                : rejectedSizing.length > 0
                  ? `${rejectedSizing.length} setup(s) failed sizing — e.g. ${firstOf(rejectedSizing)}`
                  : rejectedScoring.length > 0
                    ? `${rejectedScoring.length} candidate(s) failed scoring checks — e.g. ${firstOf(rejectedScoring)}`
                    : instrumentsWithData === 0
                      ? `No candle data yet for any of ${candidateInstruments.length} instruments — waiting for the feed to warm up`
                      : sawAnySetup
                        ? 'Setups found but none passed mandatory checks'
                        : 'No qualified setup right now';
      diagnostics.blockReason = bestPair
        ? null
        : sawMlOffline
          ? 'India V2 ML is unavailable — goal auto-trading is blocked until a model serves.'
          : null;
      this.goal.progress.realizedProfitInr = this.round2(this.goal.progress.totalPnlInr);
      this.goal.progress.remainingProfitInr = Math.max(0, Math.round((this.goal.config.minimumProfitInr - this.goal.progress.totalPnlInr) * 100) / 100);
      this.goal.progress.updatedAt = Date.now();
      this.goal.progress.marketOpen = session.marketOpen;
      this.goal.progress.marketStatus = session.status;
      await this.persist();
      this.broadcast();

      if (!bestPair) return;

      this.goal.state = 'SIGNAL_FOUND';
      this.goal.progress.currentSignal = bestPair.signal;
      await this.persist();
      this.broadcast();

      // The winner is finalized (persisted/emitted) at the moment it becomes
      // THE trade — losing candidates are never persisted as signals.
      this.signalEngine.finalizeGoalSignal(bestPair.signal);

      const position = await this.paper.execute(bestPair.signal, session, {
        owner: 'GOAL',
        // The goal mandate is a SEQUENCE of trades (spec §23): exactly one
        // position at a time. The caps make that structural invariant a hard
        // execution gate instead of relying on scan-loop ordering.
        caps: { maxOpenPositions: 1 },
      });
      if (!position) {
        this.goal.progress.currentSignal = null;
        this.goal.state = 'SCANNING';
        await this.persist();
        return;
      }
      await this.markSignalExecuted(bestPair.signal);
      this.goal.state = 'POSITION_OPEN';
      this.goal.progress.activeTrade = position;
      this.goal.progress.currentPosition = position;
      await this.persist();
      this.broadcast();
      return;
    } finally {
      this.scanning = false;
    }
  }

  /**
   * Strategy-defined stagnation exit (§11). Runs on every scan tick while a
   * goal position is open; frees the engine from trades whose thesis has died
   * without touching SL. Uses the strategy holding barrier from config — never
   * an arbitrary activity timer.
   */
  private async evaluateStagnation(position: IndiaPosition): Promise<void> {
    if (!this.goal || !position.openedAt) return;
    const cfg = this.goal.config;
    const maxHold = cfg.maxHoldMinutes ?? 45;
    const heldMinutes = (Date.now() - position.openedAt) / 60_000;
    const riskInr = Math.abs(position.entry - position.stopLoss) * position.quantity;
    const expectedProfitInr = Math.abs(position.target - position.entry) * position.quantity;
    const verdict = evaluateStagnation({
      heldMinutes,
      unrealizedPnlInr: position.unrealizedPnl,
      riskInr,
      expectedProfitInr,
      maxHoldMinutes: maxHold,
    });
    if (!verdict) return;
    logger.info('india: stagnant-trade exit', {
      positionId: position.positionId, verdict, heldMinutes: Math.round(heldMinutes),
      unrealizedPnl: Math.round(position.unrealizedPnl), expectedProfit: Math.round(expectedProfitInr),
    });
    this.goal.state = 'EXITING';
    await this.persist();
    await this.paper.close(position, position.currentPrice ?? position.entry, 'STAGNANT_TRADE');
  }

  private round2(x: number): number { return Math.round(x * 100) / 100; }

  /** Called by the paper engine's position close path (trade completed). */
  async onTradeClosed(position: IndiaPosition, trade: IndiaTrade): Promise<void> {
    if (!this.goal || this.goal.status !== 'ACTIVE' || position.goalId !== this.goal.goalId) return;
    this.goal.trades.push(trade);
    this.goal.progress.completedTrades += 1;
    this.goal.progress.remainingTrades = Math.max(0, this.goal.config.numberOfTrades - this.goal.progress.completedTrades);
    this.goal.progress.totalPnlInr += trade.netPnl;
    this.goal.progress.currentPnlInr = trade.netPnl;
    this.goal.progress.activeTrade = null;
    this.goal.progress.currentPosition = null;
    this.goal.progress.currentSignal = null;
    this.goal.progress.realizedProfitInr = Math.round(this.goal.progress.totalPnlInr * 100) / 100;
    this.goal.state = 'TRADE_COMPLETED';
    await this.persist();

    // Goal completion semantics (§6) — explicit, never silently redefined:
    //  CUMULATIVE (default, historical behaviour): realized net P&L ≥ target.
    //  PER_TRADE: the target sizes each trade's ambition; the run ends when the
    //             requested number of sequential trades has completed.
    const semantics = this.goal.config.profitSemantics ?? 'CUMULATIVE';
    if (semantics === 'CUMULATIVE' && this.goal.progress.totalPnlInr >= this.goal.config.minimumProfitInr) {
      await this.finish('GOAL_COMPLETED', `profit target ₹${this.goal.config.minimumProfitInr} reached`);
      return;
    }
    if (this.goal.progress.completedTrades >= this.goal.config.numberOfTrades) {
      await this.finish('GOAL_COMPLETED', `all ${this.goal.config.numberOfTrades} sequential trades done`);
      return;
    }
    this.goal.state = 'SCANNING_NEXT';
    this.broadcast();
  }

  /**
   * The panel-facing progress. `state` is synced from the GOAL here, on
   * purpose: the engine mutates `this.goal.state` through every transition
   * (SIGNAL_FOUND → POSITION_OPEN → …) but historically only `emptyProgress`
   * ever wrote `progress.state`, so every persisted/broadcast progress snapshot
   * froze at SCANNING while the goal itself was in trade.
   */
  progressSnapshot(): IndiaGoalProgress | null {
    return this.goal ? { ...this.goal.progress, state: this.goal.state, currentSignal: this.goal.progress.currentSignal ? { ...this.goal.progress.currentSignal } : null, currentPosition: this.goal.progress.currentPosition ? { ...this.goal.progress.currentPosition } : null, activeTrade: this.goal.progress.activeTrade ? { ...this.goal.progress.activeTrade } : null } : null;
  }

  private async finish(state: Extract<IndiaGoalState, 'GOAL_COMPLETED'>, note: string): Promise<void> {
    if (!this.goal) return;
    this.goal.state = state;
    this.goal.status = 'COMPLETED';
    this.goal.completedAt = Date.now();
    this.authority.release('GOAL', note);
    await this.persist();
    this.broadcast();
  }

  private emptyProgress(config: IndiaGoalConfig, now: number): IndiaGoalProgress {
    return {
      goalId: config.goalId,
      state: 'SCANNING',
      requestedTrades: config.numberOfTrades,
      completedTrades: 0,
      remainingTrades: config.numberOfTrades,
      activeTrade: null,
      currentSignal: null,
      currentPosition: null,
      currentPnlInr: 0,
      totalPnlInr: 0,
      targetInr: config.minimumProfitInr,
      currentStopLoss: null,
      marketOpen: false,
      marketStatus: 'CLOSED',
      updatedAt: now,
      realizedProfitInr: 0,
      remainingProfitInr: config.minimumProfitInr,
      currentOpportunity: null,
      waitReason: null,
      mlStatus: undefined,
      diagnostics: {
        lastScanAt: 0,
        lastScanDurationMs: 0,
        marketOpen: false,
        dataHealthy: true,
        mlStatus: null,
        optionDataReady: false,
        instrumentsScanned: 0,
        instrumentsWithData: 0,
        criteriaPassed: 0,
        candidatesPrepared: 0,
        validCandidates: 0,
        rejected: { noSetup: 0, ml: 0, gates: 0, sizing: 0, scoring: 0, exampleReasons: {} },
        blockReason: null,
      },
    };
  }

  private async markSignalExecuted(signal: IndiaSignal): Promise<void> {
    try {
      await this.store.updateOne(INDIA_COLLECTIONS.signals, { signalId: signal.signalId }, { $set: { status: 'POSITION_OPEN', positionId: signal.positionId ?? null } });
    } catch {
      /* best-effort */
    }
  }

  private async persist(): Promise<void> {
    if (!this.goal) return;
    // Keep the durable progress state aligned with the engine's own state
    // machine (see progressSnapshot) — restarts reload this document.
    this.goal.progress.state = this.goal.state;
    try {
      // Upsert by goalId so we always update the single authoritative document.
      await this.store.updateOne(
        INDIA_COLLECTIONS.goals,
        { goalId: this.goal.goalId },
        { $set: this.goal as unknown as Record<string, unknown> },
        true,  // upsert = true
      );
    } catch {
      /* best-effort */
    }
    this.cache
      .set(INDIA_REDIS_KEYS.goal + this.goal.goalId, JSON.stringify(this.goal), 86_400_000)
      .catch(() => undefined);
  }

  private broadcast(): void {
    if (!this.goal) return;
    const snap = this.progressSnapshot();
    if (snap) {
      this.events.emit(INDIA_CHANNELS.goalProgress, snap);
      this.events.emit(INDIA_CHANNELS.goal, this.goal);
    }
  }
}

export const indiaGoalStates = INDIA_GOAL_STATES;