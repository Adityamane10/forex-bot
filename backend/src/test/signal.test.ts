import { describe, it, expect } from 'vitest';
import { SignalStateMachine } from '../engines/signalStateMachine';
import { evaluateUncertainty } from '../engines/uncertaintyEngine';
import { activeSessions, sessionSnapshot } from '../engines/sessionEngine';
import { calculateExpectedValue } from '../engines/expectedValueEngine';
import { buildEntry } from '../engines/entryEngine';
import { buildStopLoss } from '../engines/stopLossEngine';
import { buildTakeProfit } from '../engines/takeProfitEngine';
import { computeMetrics } from '../engines/metricsEngine';
import { Signal } from '@fx/shared';

function makeSignal(): Signal {
  return {
    id: 's1',
    signalId: 's1',
    symbol: 'EUR/USD',
    direction: 'BUY',
    state: 'SIGNAL_CREATED',
    decision: 'BUY',
    timestamp: Date.now(),
    updatedAt: Date.now(),
    price: 1.1,
    entry: { entryMin: 1.099, entryMax: 1.101, preferredEntry: 1.1, status: 'READY', reason: '' },
    stopLoss: { price: 1.095, pips: 50, basis: 'test' },
    takeProfit: { tp1: 1.11, tp2: 1.12, tp3: null, rr1: 2, rr2: 4, rr3: null },
    confidence: 0.6,
    probability: 0.6,
    risk: { symbol: 'EUR/USD', timestamp: Date.now(), level: 'GREEN', score: 20, components: {}, critical: [], blocked: false },
    expectedValue: { evPerTrade: 10, evPerRisk: 0.5, probabilityWin: 0.6, probabilityLoss: 0.4, averageWin: 100, averageLoss: 50, tradingCosts: 5, positive: true, breakdown: { spread: 1, commission: 2, slippage: 1, swap: 1 } },
    regime: { symbol: 'EUR/USD', timeframe: '1h', timestamp: Date.now(), regime: 'RANGING', adx: 15, atrPct: 0.2, volatility: 'MEDIUM', description: '' },
    rr: 2,
    evidence: { technical: [], multiTimeframe: [], priceAction: [], historical: [], ml: [], news: [], risk: [], opposing: [] },
    snapshotId: 'snap1',
    modelVersion: 'm1',
    featureVersion: 'f1',
    mode: 'DEMO',
    events: [],
  };
}

describe('signal state machine', () => {
  const sm = new SignalStateMachine();

  it('allows valid lifecycle transitions', () => {
    const s = makeSignal();
    expect(sm.transition(s, 'WAITING_FOR_ENTRY', '').ok).toBe(true);
    expect(sm.transition(s, 'ENTRY_REACHED', '').ok).toBe(true);
    expect(sm.transition(s, 'POSITION_ACTIVE', '').ok).toBe(true);
    expect(sm.transition(s, 'TP1_HIT', '').ok).toBe(true);
    expect(sm.transition(s, 'CLOSED', '').ok).toBe(true);
    expect(sm.transition(s, 'PERFORMANCE_RECORDED', '').ok).toBe(true);
  });

  it('rejects invalid transitions', () => {
    const s = makeSignal();
    expect(sm.transition(s, 'PERFORMANCE_RECORDED', '').ok).toBe(false);
    expect(sm.transition(s, 'TP1_HIT', '').ok).toBe(false);
    expect(s.state).toBe('SIGNAL_CREATED');
  });

  it('records history on every transition', () => {
    const s = makeSignal();
    sm.transition(s, 'WAITING_FOR_ENTRY', 'entering wait');
    sm.transition(s, 'MISSED', 'price ran away');
    expect(s.events.map((e) => e.state)).toEqual(['WAITING_FOR_ENTRY', 'MISSED']);
  });

  it('invalid signal can never become active again', () => {
    const s = makeSignal();
    sm.transition(s, 'INVALIDATED', 'news shock');
    expect(sm.transition(s, 'SIGNAL_CREATED', '').ok).toBe(false);
  });
});

describe('uncertainty engine', () => {
  it('returns INSUFFICIENT_CONFIDENCE when ML is missing', () => {
    const out = evaluateUncertainty({
      mlProbability: null, mlConfidence: null, modelDisagreement: 0, historicalConfidence: null,
      regime: 'RANGING', dataQualityScore: 0.9, newsConflict: 0, expectedValueCertain: true,
      spreadPips: 1, maxSpreadPips: 25,
    });
    expect(out.decision).toBe('INSUFFICIENT_CONFIDENCE');
  });

  it('passes when everything is strong', () => {
    const out = evaluateUncertainty({
      mlProbability: 0.62, mlConfidence: 0.7, modelDisagreement: 0.1, historicalConfidence: 0.5,
      regime: 'TRENDING_BULLISH', dataQualityScore: 0.95, newsConflict: 0.2, expectedValueCertain: true,
      spreadPips: 1, maxSpreadPips: 25,
    });
    expect(out.insufficient).toBe(false);
  });

  it('flags regime uncertainty and wide spread', () => {
    const out = evaluateUncertainty({
      mlProbability: 0.6, mlConfidence: 0.6, modelDisagreement: 0.2, historicalConfidence: 0.4,
      regime: 'UNCERTAIN', dataQualityScore: 0.8, newsConflict: 0.1, expectedValueCertain: true,
      spreadPips: 40, maxSpreadPips: 25,
    });
    expect(out.decision).toBe('INSUFFICIENT_CONFIDENCE');
    expect(out.reason).toContain('regime');
    expect(out.reason).toContain('spread');
  });
});

describe('sessions', () => {
  it('London session at 09:00 UTC', () => {
    const ts = Date.UTC(2026, 7, 14, 9, 0, 0);
    const sessions = activeSessions(ts);
    expect(sessions).toContain('LONDON');
  });
  it('overlap detected at 14:00 UTC', () => {
    const ts = Date.UTC(2026, 7, 14, 14, 0, 0);
    expect(activeSessions(ts)).toContain('LONDON_NEW_YORK_OVERLAP');
  });
  it('Sydney session at 22:00 UTC', () => {
    const ts = Date.UTC(2026, 7, 14, 22, 0, 0);
    expect(activeSessions(ts)).toContain('SYDNEY');
  });
  it('snapshot has utcHour', () => {
    const snap = sessionSnapshot(Date.UTC(2026, 7, 14, 3, 0, 0));
    expect(snap.utcHour).toBe(3);
  });
});

describe('expected value engine', () => {
  it('positive EV when probabilities and R:R support it', () => {
    const ev = calculateExpectedValue({
      symbol: 'EUR/USD',
      probabilityWin: 0.6,
      averageWinPerLot: 1000,
      averageLossPerLot: 500,
      spreadPerLot: 10,
      commissionPerLot: 7,
      swapPerDayPerLot: -2, // rebate (negative = rebate per convention)
      daysHeld: 2,
    });
    expect(ev.positive).toBe(true);
    // costs = spread 10 + commission 7 + slippage (0.2 pips = 2) + swap rebate (-4) = 15
    expect(ev.tradingCosts).toBeCloseTo(15, 4);
    expect(ev.evPerTrade).toBeCloseTo(600 - 200 - 15, 4);
  });

  it('costs can flip EV negative', () => {
    const ev = calculateExpectedValue({
      symbol: 'EUR/USD',
      probabilityWin: 0.51,
      averageWinPerLot: 500,
      averageLossPerLot: 490,
      spreadPerLot: 40,
      commissionPerLot: 30,
      swapPerDayPerLot: -5,
      daysHeld: 2,
    });
    expect(ev.positive).toBe(false);
  });
});

describe('entry/SL/TP engines', () => {
  const levels = {
    support: [1.09, 1.085],
    resistance: [1.11, 1.115],
    pivot: 1.1,
    prevDayHigh: 1.112,
    prevDayLow: 1.088,
    prevWeekHigh: 1.12,
    prevWeekLow: 1.08,
    distanceToSupportPips: 100,
    distanceToResistancePips: 100,
    nearestSupport: 1.09,
    nearestResistance: 1.11,
  };

  it('BUY entry prefers a pullback below market, zone contains price', () => {
    const entry = buildEntry({
      symbol: 'EUR/USD', direction: 'BUY', currentPrice: 1.102, atr: 0.002,
      levels, structure: 'UPTREND', timestamp: Date.now(),
    });
    expect(entry.preferredEntry).toBeLessThan(1.102);
    expect(entry.status).toBe('READY');
    expect(entry.entryMin).toBeLessThan(entry.entryMax);
    expect(entry.entryMin).toBeLessThan(1.102);
    expect(entry.entryMax).toBeGreaterThan(1.102);
  });

  it('SELL entry mirrors: preferred above market, zone contains price', () => {
    const entry = buildEntry({
      symbol: 'EUR/USD', direction: 'SELL', currentPrice: 1.102, atr: 0.002,
      levels, structure: 'DOWNTREND', timestamp: Date.now(),
    });
    expect(entry.preferredEntry).toBeGreaterThan(1.102);
    expect(entry.status).toBe('READY');
    expect(entry.entryMin).toBeLessThan(1.102);
    expect(entry.entryMax).toBeGreaterThan(1.102);
  });

  it('entry zone sanity under high volatility', () => {
    const entry = buildEntry({
      symbol: 'EUR/USD', direction: 'BUY', currentPrice: 1.102, atr: 0.01,
      levels, structure: 'UPTREND', timestamp: Date.now(),
    });
    expect(entry.status).toBe('READY');
    expect(entry.entryMax - entry.entryMin).toBeGreaterThan(0);
  });

  it('SL below nearest support for BUY', () => {
    const sl = buildStopLoss({
      symbol: 'EUR/USD', direction: 'BUY', entry: 1.102, atr: 0.002, levels,
    });
    expect(sl.valid).toBe(true);
    expect(sl.plan.price).toBeLessThan(1.09);
  });

  it('TP R:R meets minimums', () => {
    const tp = buildTakeProfit({
      symbol: 'EUR/USD', direction: 'BUY', entry: 1.102, stopLoss: 1.088, atr: 0.002, levels,
    });
    expect(tp.rr1).toBeGreaterThan(1);
    expect(tp.tp1).toBeGreaterThan(1.102);
  });
});

describe('metrics engine', () => {
  it('computes win rate, profit factor, expectancy', () => {
    const trades = [
      { symbol: 'EUR/USD', direction: 'BUY', session: 'LONDON', regime: 'TRENDING_BULLISH', pnl: 100, durationMs: 1000, rr: 2 },
      { symbol: 'EUR/USD', direction: 'BUY', session: 'LONDON', regime: 'TRENDING_BULLISH', pnl: 100, durationMs: 1000, rr: 2 },
      { symbol: 'GBP/USD', direction: 'SELL', session: 'NEW_YORK', regime: 'RANGING', pnl: -50, durationMs: 500, rr: -1 },
    ] as never;
    const metrics = computeMetrics({
      trades,
      equityCurve: [{ time: 1, equity: 10000 }, { time: 2, equity: 10100 }, { time: 3, equity: 10150 }],
      startingCapital: 10000,
    });
    expect(metrics.tradeCount).toBe(3);
    expect(metrics.winRate).toBeCloseTo(2 / 3, 6);
    expect(metrics.profitFactor).toBeCloseTo(200 / 50, 6);
    expect(metrics.expectancy).toBeCloseTo(150 / 3, 6);
    expect(metrics.totalReturnPct).toBeCloseTo(1.5, 6);
    expect(metrics.byPair['EUR/USD'].trades).toBe(2);
    expect(metrics.bySession['LONDON'].trades).toBe(2);
  });

  it('max drawdown from equity curve', () => {
    const metrics = computeMetrics({
      trades: [],
      equityCurve: [
        { time: 1, equity: 10000 },
        { time: 2, equity: 11000 },
        { time: 3, equity: 9500 },
        { time: 4, equity: 10000 },
      ],
      startingCapital: 10000,
    });
    expect(metrics.maxDrawdownPct).toBeCloseTo(13.636, 2);
  });
});
