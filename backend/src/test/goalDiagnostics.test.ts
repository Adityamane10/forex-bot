import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import type {
  IndiaAnalysisSnapshot,
  IndiaInstrument,
  IndiaMarketSessionInfo,
  IndiaModelPrediction,
  IndiaPosition,
} from '@fx/shared';
import { IndiaGoalEngine } from '../india/goal-engine';
import { IndiaPaperExecutionEngine } from '../india/paper-execution';
import type { PreparedGoalCandidate } from '../india/signal-engine';

// ---------------------------------------------------------------------------
// Goal engine scan diagnostics (spec §34, §12): every stage the scan evaluates
// must be observable — "no signals" alone is never an acceptable state. The
// ENGINE under test here is the real IndiaGoalEngine; only its collaborators
// (analysis / signal engine / execution / storage) are faked.
// ---------------------------------------------------------------------------

const NOW_BASE = Date.now();

function makeInstrument(overrides: Partial<IndiaInstrument> = {}): IndiaInstrument {
  return {
    instrumentToken: '99999',
    instrumentKey: 'NSE_OPT|99999',
    exchange: 'NSE',
    segment: 'NSE_OPT',
    tradingSymbol: 'NIFTY 25000 CE',
    underlying: 'NIFTY',
    name: 'NIFTY 25000 CE',
    contractType: 'OPT',
    expiry: Date.now() + 3 * 86_400_000,
    strike: 25000,
    optionType: 'CE',
    lotSize: 65,
    tickSize: 0.05,
    freezeQuantity: null,
    status: 'ACTIVE',
    tradable: true,
    ...overrides,
  };
}

function makePrediction(overrides: Partial<IndiaModelPrediction> = {}): IndiaModelPrediction {
  return {
    instrumentToken: '99999',
    tradingSymbol: 'NIFTY 25000 CE',
    underlying: 'NIFTY',
    timeframe: '5m',
    timestamp: Date.now(),
    probability: 0.62,
    confidence: 0.55,
    modelVersion: 'india-v2-test',
    featureVersion: 'india-features-v1',
    horizon: 1,
    available: true,
    mlStatus: 'ONLINE',
    metaProbability: 0.8,
    metaThreshold: 0.6,
    filtered: false,
    direction: 1,
    ...overrides,
  };
}

function makeAnalysis(prediction: IndiaModelPrediction | null): IndiaAnalysisSnapshot {
  return {
    id: 't:5m:0',
    instrumentToken: '99999',
    tradingSymbol: 'NIFTY 25000 CE',
    underlying: 'NIFTY',
    segment: 'NSE_OPT',
    timeframe: '5m',
    timestamp: Date.now(),
    marketTimestamp: Date.now(),
    trend: 'BULLISH',
    regime: 'TRENDING_BULLISH',
    momentum: 'BULLISH',
    volatility: 'MEDIUM',
    structure: 'UPTREND',
    swingHigh: 102,
    swingLow: 96,
    higherHighs: true,
    higherLows: true,
    lowerHighs: false,
    lowerLows: false,
    support: 96,
    resistance: 102,
    signalQuality: 0.8,
    confidence: 0.7,
    featureSnapshot: {},
    prediction,
    riskContext: {
      close: 100,
      atr: 1.2,
      rsi: 58,
      adx: 28,
      macdHistogram: 0.4,
      volumeRatio: undefined,
      sessionPhase: 'MID',
    },
    description: 'test',
    createdAt: Date.now(),
  } as IndiaAnalysisSnapshot;
}

const session: IndiaMarketSessionInfo = {
  status: 'OPEN',
  marketOpen: true,
  isHoliday: false,
  ist: { hour: 10, minute: 30 },
  marketOpenAt: NOW_BASE - 3_600_000,
  marketCloseAt: NOW_BASE + 3_600_000,
  segments: {},
} as unknown as IndiaMarketSessionInfo;

function makePosition(): IndiaPosition {
  return {
    positionId: 'pos-1',
    strategyOwner: 'GOAL',
    executionMode: 'AUTO',
    goalId: 'g1',
    signalId: 's1',
    instrumentToken: '99999',
    tradingSymbol: 'NIFTY 25000 CE',
    underlying: 'NIFTY',
    exchange: 'NSE',
    segment: 'NSE_OPT',
    contractType: 'OPT',
    side: 'BUY',
    quantity: 65,
    entry: 100,
    stopLoss: 97,
    target: 106,
    openedAt: Date.now(),
    closedAt: null,
    currentPrice: 100,
    unrealizedPnl: 0,
    realizedPnl: 0,
    status: 'OPEN',
    exitReason: null,
    trailingStop: null,
    breakevenApplied: false,
    audit: [],
  };
}

interface Harness {
  engine: IndiaGoalEngine;
  events: EventEmitter;
  setAnalysis: (a: IndiaAnalysisSnapshot | null, hasData?: boolean) => void;
  setPrepared: (p: PreparedGoalCandidate | null) => void;
  executed: { signalId: string | null };
}

function buildHarness(instrument = makeInstrument()): Harness {
  const events = new EventEmitter();
  const store = {
    find: async () => [],
    updateOne: async () => ({}),
    insertOne: async () => ({}),
  } as never;
  const cache = { set: async () => undefined, get: async () => null } as never;

  const instrumentService = {
    executionInstruments: () => [instrument],
    getByToken: (token: string) => (token === instrument.instrumentToken ? instrument : null),
  } as never;

  let analysisResult: IndiaAnalysisSnapshot | null = makeAnalysis(makePrediction());
  const analysis = {
    analyze: async () => analysisResult ?? makeAnalysis(null),
  } as never;

  let preparedResult: PreparedGoalCandidate | null = null;
  const signalEngine = {
    prepareGoal: (): PreparedGoalCandidate =>
      preparedResult ?? {
        instrument,
        side: 'BUY',
        strategy: 'TREND_FOLLOWING',
        stage: 'NO_SETUP',
        reason: 'entry criteria not met',
      },
    finalizeGoalSignal: () => undefined,
    optionSnapshotFor: () => null,
  } as never;

  const executed = { signalId: null as string | null };
  const paper = {
    openPositions: () => [] as IndiaPosition[],
    execute: async (signal: { signalId: string }) => {
      executed.signalId = signal.signalId;
      return makePosition();
    },
    close: async () => null,
    exitAll: async () => [],
  } as never;

  const authority = { acquire: () => true, release: () => undefined } as never;

  const engine = new IndiaGoalEngine(
    store, cache, events,
    instrumentService, analysis, signalEngine, paper, authority,
    null, () => true,
  );

  return {
    engine,
    events,
    executed,
    setAnalysis: (a, hasData = true) => {
      if (!a || !hasData) {
        // NO_DATA shape: riskContext carries only {state}, no close price.
        analysisResult = a ? ({ ...a, riskContext: { state: 'NO_DATA' } } as IndiaAnalysisSnapshot) : null;
      } else {
        analysisResult = a;
      }
    },
    setPrepared: (p) => {
      preparedResult = p;
    },
  };
}

function goalConfig(overrides: Record<string, unknown> = {}) {
  return {
    goalId: 'g1',
    amountInr: 5000,
    minimumProfitInr: 100,
    maxRiskInr: 2000,
    maxMarginPercent: 50,
    numberOfTrades: 4,
    executionMode: 'AUTO' as const,
    sessionPolicy: 'TODAY_ONLY' as const,
    tradeUnderlyings: ['NIFTY'],
    createdAt: Date.now(),
    ...overrides,
  };
}

describe('IndiaGoalEngine scan diagnostics (§34)', () => {
  it('names ML unavailability as the block reason instead of "no signals" (§12)', async () => {
    const h = buildHarness();
    h.setAnalysis(makeAnalysis(makePrediction({ available: false, mlStatus: 'OFFLINE', probability: 0, confidence: 0 })));
    await h.engine.start(goalConfig());
    await h.engine.scan(session);

    const snap = h.engine.progressSnapshot();
    expect(snap?.waitReason).toMatch(/ML unavailable/i);
    expect(snap?.diagnostics?.blockReason).toContain('India V2 ML is unavailable');
    expect(snap?.diagnostics?.mlStatus).toBe('OFFLINE');
    expect(h.executed.signalId).toBeNull();
  });

  it('counts where candidates died: ML low-conviction rejections are visible per stage', async () => {
    const inst = makeInstrument();
    const h = buildHarness(inst);
    h.setAnalysis(makeAnalysis(makePrediction({ probability: 0.4, direction: -1 })));
    h.setPrepared({
      instrument: inst,
      side: 'BUY',
      strategy: 'TREND_FOLLOWING',
      stage: 'GATE',
      reason: 'ML_LOW_CONVICTION: side-aligned 0.40 < required 0.55',
    });
    await h.engine.start(goalConfig());
    await h.engine.scan(session);

    const d = h.engine.progressSnapshot()?.diagnostics;
    expect(d?.criteriaPassed).toBe(1);
    expect(d?.candidatesPrepared).toBe(0);
    expect(d?.rejected.ml).toBe(1);
    expect(d?.rejected.exampleReasons.GATE).toContain('ML_LOW_CONVICTION');
    expect(h.executed.signalId).toBeNull();
  });

  it('reports coverage starvation honestly when no instrument has candle data', async () => {
    const h = buildHarness();
    h.setAnalysis(makeAnalysis(makePrediction()), false);
    h.setPrepared(null); // prepareGoal would fail on missing close price anyway
    await h.engine.start(goalConfig());
    await h.engine.scan(session);

    const d = h.engine.progressSnapshot()?.diagnostics;
    expect(d?.instrumentsScanned).toBe(1);
    expect(d?.instrumentsWithData).toBe(0);
    expect(d?.validCandidates).toBe(0);
  });

  it('publishes a ranked candidate and executes it when every gate passes', async () => {
    const inst = makeInstrument();
    const h = buildHarness(inst);
    h.setAnalysis(makeAnalysis(makePrediction()));
    h.setPrepared({
      instrument: inst,
      side: 'BUY',
      strategy: 'TREND_FOLLOWING',
      signal: {
        signalId: 'sig-1',
        instrumentToken: inst.instrumentToken,
        tradingSymbol: inst.tradingSymbol,
        underlying: inst.underlying,
        exchange: inst.exchange,
        segment: inst.segment,
        contractType: inst.contractType,
        side: 'BUY',
        entry: 100,
        stopLoss: 97,
        target: 106,
        quantity: 65,
        lotSize: 65,
        riskInr: 195,
        expectedProfitInr: 390,
        rr: 2,
        confidence: 0.8,
        strategy: 'TREND_FOLLOWING',
        timeframe: '5m',
        createdAt: Date.now(),
        marketTimestamp: Date.now(),
        expiresAt: Date.now() + 300_000,
        status: 'READY',
        analysis: makeAnalysis(makePrediction()),
        owner: 'GOAL',
        executionMode: 'AUTO',
        goalId: 'g1',
        invalidatedReason: null,
      },
    });
    await h.engine.start(goalConfig());
    await h.engine.scan(session);

    const prog = h.engine.progressSnapshot();
    expect(prog?.currentSignal?.signalId).toBe('sig-1');
    expect(prog?.activeTrade?.positionId).toBe('pos-1');
    expect(prog?.state).toBe('POSITION_OPEN');
    expect(prog?.diagnostics?.validCandidates).toBe(1);
    expect(prog?.diagnostics?.candidatesPrepared).toBe(1);
    expect(h.executed.signalId).toBe('sig-1');
    expect(prog?.waitReason ?? null).toBeNull();
  });

  it('refreshes live session fields on every scan pass (no frozen CLOSED panel)', async () => {
    const h = buildHarness();
    await h.engine.start(goalConfig());
    const before = h.engine.progressSnapshot()?.updatedAt ?? 0;
    await new Promise((r) => setTimeout(r, 15));
    await h.engine.scan(session);

    const prog = h.engine.progressSnapshot();
    expect(prog?.marketOpen).toBe(true);
    expect(prog?.marketStatus).toBe('OPEN');
    expect((prog?.updatedAt ?? 0)).toBeGreaterThan(before);
  });

  it('holds new entries while the data-health gate reports stale (§40)', async () => {
    const events = new EventEmitter();
    const store = { find: async () => [], updateOne: async () => ({}), insertOne: async () => ({}) } as never;
    const cache = { set: async () => undefined, get: async () => null } as never;
    const instrument = makeInstrument();
    const instrumentService = {
      executionInstruments: () => [instrument],
      getByToken: () => instrument,
    } as never;
    const analysis = { analyze: async () => makeAnalysis(makePrediction()) } as never;
    const signalEngine = {
      prepareGoal: () => ({ instrument, side: 'BUY' as const, strategy: 'TREND_FOLLOWING' as const, stage: 'NO_SETUP' as const, reason: 'entry criteria not met' }),
      finalizeGoalSignal: () => undefined,
      optionSnapshotFor: () => null,
    } as never;
    const executed = { signalId: null as string | null };
    const paper = {
      openPositions: () => [],
      execute: async (signal: { signalId: string }) => { executed.signalId = signal.signalId; return makePosition(); },
      close: async () => null,
      exitAll: async () => [],
    } as never;
    const engine = new IndiaGoalEngine(
      store, cache, events,
      instrumentService, analysis, signalEngine, paper,
      { acquire: () => true, release: () => undefined } as never,
      null,
      () => false, // data health says STALE
    );
    await engine.start(goalConfig());
    await engine.scan(session);

    const prog = engine.progressSnapshot();
    expect(executed.signalId).toBeNull();
    expect(prog?.waitReason).toMatch(/Stale data/i);
    expect(prog?.diagnostics?.blockReason).toContain('Data feed stale');
  });
});

describe('IndiaPaperExecutionEngine maintenance staleness threshold', () => {
  function buildPaperEngine() {
    const events = new EventEmitter();
    const instrument = makeInstrument();
    const store = { find: async () => [], insertOne: async () => ({}) } as never;
    const cache = { set: async () => undefined } as never;
    const instruments = { getByToken: (t: string) => (t === instrument.instrumentToken ? instrument : null) } as never;
    const engine = new IndiaPaperExecutionEngine(store, cache, events, instruments, {});
    return { engine, instrument };
  }

  function autoSignal(token: string) {
    const now = Date.now();
    return {
      signalId: `sig-maint-${now}`,
      instrumentToken: token,
      tradingSymbol: 'NIFTY 25000 CE',
      underlying: 'NIFTY',
      exchange: 'NSE',
      segment: 'NSE_OPT',
      contractType: 'OPT',
      side: 'BUY' as const,
      entry: 100,
      stopLoss: 97,
      target: 106,
      quantity: 65,
      lotSize: 65,
      riskInr: 195,
      expectedProfitInr: 390,
      rr: 2,
      confidence: 0.8,
      strategy: 'TREND_FOLLOWING',
      timeframe: '5m',
      createdAt: now,
      marketTimestamp: now,
      expiresAt: now + 300_000,
      status: 'READY',
      owner: 'GOAL',
      executionMode: 'AUTO',
      goalId: 'g1',
      invalidatedReason: null,
    };
  }

  it('closes a position once staleness exceeds the given threshold', async () => {
    const { engine, instrument } = buildPaperEngine();
    const pos = await engine.execute(autoSignal(instrument.instrumentToken), session, { owner: 'GOAL' });
    expect(pos).not.toBeNull();

    const closed = await engine.maintenance(Date.now(), Date.now() - 10 * 60_000, 30_000);
    expect(closed.length).toBe(1);
    expect(closed[0].trade.exitReason).toBe('DATA_STALE');
  });

  it('does NOT force-close while the poll backoff legitimately exceeds the base window', async () => {
    const { engine, instrument } = buildPaperEngine();
    const pos = await engine.execute(autoSignal(instrument.instrumentToken), session, { owner: 'GOAL' });
    expect(pos).not.toBeNull();

    // Broker throttle: the poll is currently waiting 30s. Staleness of 40s is
    // inside max(tickStaleMs*2=30s, backoff*1.5=45s) → hold the position.
    const closed = await engine.maintenance(Date.now(), Date.now() - 40_000, Math.max(15_000 * 2, 30_000 * 1.5));
    expect(closed.length).toBe(0);
  });
});
