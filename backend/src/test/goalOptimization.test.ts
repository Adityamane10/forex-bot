import { describe, it, expect } from 'vitest';
import type { IndiaAnalysisSnapshot, IndiaInstrument, IndiaModelPrediction, IndiaOpportunity } from '@fx/shared';
import {
  scoreGoalCandidate,
  rankGoalCandidates,
  evaluateStagnation,
  evaluateMlGate,
  derivedIndiaVolatility,
} from '../india/goal-opportunity';
import { validateIndiaLotSize, INDIA_LOT_SIZE_REFERENCE } from '../india/lot-size';
import { impliedVolatility, optionPrice } from '../india/options-math';

// ---------------------------------------------------------------------------
// Goal-Time Optimization Engine (spec §4–§9, §11, §15, §20, §24).
// Pure-logic tests: no broker, no network, no DB. Fail-closed semantics are the
// point — every mandatory check must refuse rather than guess.
// ---------------------------------------------------------------------------

const NOW = Date.UTC(2026, 7, 24, 5, 0); // 10:30 IST, market open

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
    expiry: NOW + 3 * 86_400_000,
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
    timestamp: NOW,
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

function makeAnalysis(overrides: Partial<IndiaAnalysisSnapshot> = {}): IndiaAnalysisSnapshot {
  return {
    id: 't:5m:0',
    instrumentToken: '99999',
    tradingSymbol: 'NIFTY 25000 CE',
    underlying: 'NIFTY',
    segment: 'NSE_OPT',
    timeframe: '5m',
    timestamp: NOW,
    marketTimestamp: NOW,
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
    prediction: null,
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
    createdAt: NOW,
    ...overrides,
  } as IndiaAnalysisSnapshot;
}

const baseCtx = {
  strategy: 'TREND_FOLLOWING' as const,
  side: 'BUY' as const,
  entry: 100,
  stopLoss: 97,
  target: 106,
  riskInr: 195,
  expectedProfitInr: 390,
  rr: 2,
  quantity: 65,
  goalRemainingInr: 500,
  maxRiskInr: 2000,
  now: NOW,
};

describe('lot-size reference layer (spec §4)', () => {
  it('accepts NIFTY 65 and BANKNIFTY 30 — the configured exchange mandates', () => {
    // Aug-2026 revision cycle: NIFTY 75 → 65, FINNIFTY 65 → 60, verified
    // against the live Angel One instrument master on 2026-08-26.
    expect(INDIA_LOT_SIZE_REFERENCE['NIFTY']).toBe(65);
    expect(INDIA_LOT_SIZE_REFERENCE['BANKNIFTY']).toBe(30);
    expect(validateIndiaLotSize(makeInstrument({ underlying: 'NIFTY', lotSize: 65 })).ok).toBe(true);
    expect(validateIndiaLotSize(makeInstrument({ underlying: 'BANKNIFTY', lotSize: 30 })).ok).toBe(true);
  });

  it('blocks a stale master whose lot size disagrees with the mandate', () => {
    const v = validateIndiaLotSize(makeInstrument({ underlying: 'NIFTY', lotSize: 25 }));
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('expected 65');
  });

  it('passes underlyings without a configured reference using the master value', () => {
    const v = validateIndiaLotSize(makeInstrument({ underlying: 'RELIANCE', lotSize: 60 }));
    expect(v.ok).toBe(true);
    expect(v.lotSize).toBe(60);
  });

  it('rejects invalid master metadata', () => {
    expect(validateIndiaLotSize(makeInstrument({ lotSize: 0 })).ok).toBe(false);
  });

  it('opportunity scoring fails closed on a lot-size mismatch', () => {
    const r = scoreGoalCandidate({
      ...baseCtx,
      instrument: makeInstrument({ lotSize: 25 }),
      analysis: makeAnalysis(),
      prediction: makePrediction(),
    });
    expect(r.eligible).toBe(false);
    if (!r.eligible) expect(r.reason).toContain('LOT_SIZE_MISMATCH');
  });
});

describe('ML gate (spec §15) — fail closed', () => {
  it('refuses candidates when the model is offline', () => {
    const r = scoreGoalCandidate({
      ...baseCtx,
      instrument: makeInstrument(),
      analysis: makeAnalysis(),
      prediction: makePrediction({ available: false, mlStatus: 'OFFLINE', probability: 0, confidence: 0 }),
    });
    expect(r.eligible).toBe(false);
    if (!r.eligible) expect(r.reason).toContain('ML_UNAVAILABLE');
  });

  it('blocks a side-contradicting prediction via the conviction floor', () => {
    // Model leans up (p=0.80, direction=1 as the serving layer derives it from
    // p) but the criteria produced SELL: aligned probability = 1 − 0.80 = 0.20
    // → far below the floor.
    const g = evaluateMlGate(
      makePrediction({ probability: 0.8, direction: 1 }),
      'SELL',
      { strictMeta: false, minProbability: 0.55 },
    );
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.reason).toContain('ML_LOW_CONVICTION');
    expect(g.alignedProbability).toBeCloseTo(0.2, 5);
  });

  it('credits a SELL backed by a genuinely bearish model (direction −1 ⇒ p < 0.5)', () => {
    // The serving layer derives direction FROM p: direction=-1 always means
    // p<0.5. A SELL's aligned probability is 1−p — the old formula returned p
    // here, so every bearish conviction died at the gate.
    const g = evaluateMlGate(
      makePrediction({ probability: 0.38, direction: -1 }),
      'SELL',
      { strictMeta: false, minProbability: 0.55 },
    );
    expect(g.ok).toBe(true);
    expect(g.alignedProbability).toBeCloseTo(0.62, 5);
  });

  it('refuses a BUY against a genuinely bearish model', () => {
    // Mirror of the bug: the old formula credited this trade 1−p = 0.62 and
    // waved it through against the model's own verdict.
    const g = evaluateMlGate(
      makePrediction({ probability: 0.38, direction: -1 }),
      'BUY',
      { strictMeta: false, minProbability: 0.55 },
    );
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.reason).toContain('ML_LOW_CONVICTION');
    expect(g.alignedProbability).toBeCloseTo(0.38, 5);
  });

  it('strict-meta mode vetoes filtered predictions; default mode does not depend on the degenerate meta layer', () => {
    const pred = makePrediction({ filtered: true, metaProbability: 0.5, probability: 0.68, direction: 1 });
    const strict = evaluateMlGate(pred, 'BUY', { strictMeta: true, minProbability: 0.55 });
    expect(strict.ok).toBe(false);
    if (!strict.ok) expect(strict.reason).toContain('ML_FILTERED');

    // Default (non-strict): the current bundles emit a CONSTANT meta value that
    // carries zero information — conviction is enforced by the floor instead.
    const relaxed = evaluateMlGate(pred, 'BUY', { strictMeta: false, minProbability: 0.55 });
    expect(relaxed.ok).toBe(true);
    expect(relaxed.alignedProbability).toBeCloseTo(0.68, 5);
  });

  it('accepts fresh online predictions and reports their serving state', () => {
    const r = scoreGoalCandidate({
      ...baseCtx,
      instrument: makeInstrument(),
      analysis: makeAnalysis(),
      prediction: makePrediction(),
    });
    expect(r.eligible).toBe(true);
    if (r.eligible) expect(r.opportunity.mlStatus).toBe('ONLINE');
  });
});

describe('freshness + liquidity gates (spec §9, §24)', () => {
  it('rejects analysis older than a minute', () => {
    const stale = makeAnalysis({ marketTimestamp: NOW - 120_000, timestamp: NOW - 120_000 });
    const r = scoreGoalCandidate({
      ...baseCtx, instrument: makeInstrument(), analysis: stale,
      prediction: makePrediction({ timestamp: NOW - 120_000 }), now: NOW,
    });
    expect(r.eligible).toBe(false);
    if (!r.eligible) expect(r.reason).toContain('SIGNAL_STALE');
  });

  it('rejects contracts with a wide spread when a book exists', () => {
    const r = scoreGoalCandidate({
      ...baseCtx, instrument: makeInstrument(), analysis: makeAnalysis(), prediction: makePrediction(),
      tick: { ltp: 100, bid: 90, ask: 110 },
    });
    expect(r.eligible).false;
    if (!r.eligible) expect(r.reason).toContain('NO_LIQUIDITY');
  });

  it('scores UNKNOWN liquidity (no book) instead of fabricating one', () => {
    const r = scoreGoalCandidate({
      ...baseCtx, instrument: makeInstrument(), analysis: makeAnalysis(), prediction: makePrediction(),
      tick: { ltp: 100, bid: null, ask: null },
    });
    expect(r.eligible).toBe(true);
    if (r.eligible) expect(r.opportunity.liquidity).toBe('UNKNOWN');
  });

  it('rejects expired contracts outright', () => {
    const r = scoreGoalCandidate({
      ...baseCtx, instrument: makeInstrument({ expiry: NOW - 1000 }), analysis: makeAnalysis(), prediction: makePrediction(),
    });
    expect(r.eligible).toBe(false);
    if (!r.eligible) expect(r.reason).toContain('EXPIRY');
  });
});

describe('opportunity ranking (spec §7–§8)', () => {
  function scored(overrides: {
    probability?: number; direction?: number; expectedMinutesHint?: number; liquidity?: [number, number];
  }): IndiaOpportunity {
    const r = scoreGoalCandidate({
      ...baseCtx,
      instrument: makeInstrument(),
      analysis: makeAnalysis(overrides.expectedMinutesHint
        ? ({ riskContext: { close: 100, atr: overrides.expectedMinutesHint } } as never)
        : {}),
      prediction: makePrediction({ probability: overrides.probability ?? 0.62, direction: overrides.direction ?? 1 }),
      tick: overrides.liquidity ? { ltp: 100, bid: overrides.liquidity[0], ask: overrides.liquidity[1] } : null,
    });
    if (!r.eligible) throw new Error(`expected eligible, got ${r.reason}`);
    return r.opportunity;
  }

  it('prefers stronger aligned model conviction', () => {
    const strong = scored({ probability: 0.78 });
    const weak = scored({ probability: 0.58 });
    expect(strong.score).toBeGreaterThan(weak.score);
    expect(strong.tpProbability).toBeGreaterThan(weak.tpProbability);
  });

  it('penalises a slower target (time penalty)', () => {
    const slow = scored({ expectedMinutesHint: 0.2 }); // tiny ATR → long estimate
    const fast = scored({ expectedMinutesHint: 3 });   // big ATR → short estimate
    expect(fast.expectedMinutes).toBeLessThan(slow.expectedMinutes);
    expect(fast.score).toBeGreaterThan(slow.score);
  });

  it('penalises wide spreads relative to tight ones', () => {
    const tight = scored({ liquidity: [99.9, 100.0] });  // ~0.1% spread
    const wide = scored({ liquidity: [99.2, 100.0] });   // ~0.8% spread
    // Penalty components are stored negated — wider spread ⇒ more negative.
    expect(wide.components.spreadPenalty).toBeLessThan(tight.components.spreadPenalty);
    expect(wide.score).toBeLessThan(tight.score);
  });

  it('ranks purely by score, highest first', () => {
    const a = scored({ probability: 0.75 });
    const b = scored({ probability: 0.65 });
    const c = scored({ probability: 0.58 });
    const ranked = rankGoalCandidates([c, a, b]);
    expect(ranked[0].score).toBe(a.score);
  });
});

describe('stagnant-trade evaluation (spec §11)', () => {
  const args = { unrealizedPnlInr: 10, riskInr: 300, expectedProfitInr: 600 };

  it('cuts a position held past the barrier without reaching half its target', () => {
    expect(evaluateStagnation({ ...args, heldMinutes: 50, maxHoldMinutes: 45 })).toBe('HOLD_BARRIER');
  });

  it('gives a winning trade past the barrier more time', () => {
    // 80% of expected profit banked — the thesis is working, do not cut it.
    expect(evaluateStagnation({ heldMinutes: 50, unrealizedPnlInr: 480, riskInr: 300, expectedProfitInr: 600, maxHoldMinutes: 45 })).toBeNull();
  });

  it('flags early bleeding beyond a quarter of the risk', () => {
    expect(evaluateStagnation({ heldMinutes: 30, unrealizedPnlInr: -90, riskInr: 300, expectedProfitInr: 600, maxHoldMinutes: 45 })).toBe('BLEEDING');
  });

  it('leaves young, mildly negative positions alone', () => {
    expect(evaluateStagnation({ heldMinutes: 10, unrealizedPnlInr: -40, riskInr: 300, expectedProfitInr: 600, maxHoldMinutes: 45 })).toBeNull();
  });
});

describe('derived volatility (spec §21)', () => {
  it('converts ATM IV percent to an annualised fraction', () => {
    expect(derivedIndiaVolatility(14)).toBeCloseTo(0.14, 10);
    expect(derivedIndiaVolatility(null)).toBeNull();
    expect(derivedIndiaVolatility(0)).toBeNull();
  });
});

describe('options math determinism (spec §20)', () => {
  it('satisfies put-call parity through the pricer', () => {
    const spot = 25000, strike = 25000, years = 0.02, vol = 0.14, rate = 0.065;
    const call = optionPrice({ optionType: 'CE', spot, strike, years, volatility: vol, rate });
    const put = optionPrice({ optionType: 'PE', spot, strike, years, volatility: vol, rate });
    const parity = call - put - (spot - strike * Math.exp(-rate * years));
    expect(Math.abs(parity)).toBeLessThan(1e-6);
  });

  it('round-trips premium → IV → premium through the solver', () => {
    const iv = impliedVolatility({
      optionType: 'CE', premium: 142.5, spot: 25050, strike: 25000, years: 4 / 365,
    });
    expect(iv).not.toBeNull();
    const back = optionPrice({ optionType: 'CE', spot: 25050, strike: 25000, years: 4 / 365, volatility: iv! });
    expect(Math.abs(back - 142.5)).toBeLessThan(0.01);
  });

  it('returns null outside arbitrage bounds instead of inventing a vol', () => {
    expect(impliedVolatility({ optionType: 'CE', premium: -5, spot: 25000, strike: 25000, years: 0.02 })).toBeNull();
    // Deep ITM above hard upper bound (spot with no carry):
    expect(impliedVolatility({ optionType: 'CE', premium: 26000, spot: 25000, strike: 24000, years: 0.02 })).toBeNull();
  });
});
