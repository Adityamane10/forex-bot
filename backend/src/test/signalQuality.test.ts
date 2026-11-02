/**
 * Signal-quality tests (spec §3, §9, §12, §22, §24): multi-timeframe conflict
 * detection, granular score breakdown, entry types by strategy, performance
 * attribution, and the CANCELLED signal state.
 */
import { describe, it, expect } from 'vitest';
import { Candle, IndicatorSnapshot, Timeframe } from '@fx/shared';
import { TIMEFRAME_MS } from '@fx/shared';
import { MultiTimeframeEngine } from '../engines/multiTimeframeEngine';
import { buildScoreBreakdown, entrySubScore } from '../engines/signalEngine';
import { computeMetrics } from '../engines/metricsEngine';
import { SignalStateMachine } from '../engines/signalStateMachine';
import { buildEntry } from '../engines/entryEngine';

function makeCandles(n: number, start: number, tfMs: number, rising = true): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const openTime = start + i * tfMs;
    const close = rising ? 10 + i * 0.01 : 12 - i * 0.01;
    out.push({
      symbol: 'EUR/USD', timeframe: '1h' as Timeframe, open: close - 0.01, high: close + 0.01, low: close - 0.02,
      close, volume: 10, openTime, closeTime: openTime + tfMs, state: 'COMPLETED', completed: true, updatedAt: openTime,
    });
  }
  return out;
}

function snap(tf: Timeframe, trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL'): IndicatorSnapshot {
  const values: Record<string, number | null> = {
    close: trend === 'BULLISH' ? 12 : 10,
    ema9: trend === 'BULLISH' ? 11 : 11,
    ema20: trend === 'BULLISH' ? 10 : 12,
    ema50: trend === 'BULLISH' ? 9 : 13,
    adx: trend === 'NEUTRAL' ? 10 : 30,
    rsi14: trend === 'BULLISH' ? 60 : 40,
    macdHistogram: trend === 'BULLISH' ? 0.001 : -0.001,
    atr14: 0.02,
    atrPct: 0.2,
    close10: null, rsiPeriod: null, ema9Prev: null, ema20Prev: null, ema50Prev: null, macd: null, macdSignal: null,
    stochK: 50, stochD: 50, adxPlus: 20, adxMinus: 15, bbUpper: 13, bbLower: 9, bbMiddle: 11, bbPct: 0.5, supertrend: 11, vwap: null, obv: 0, volSma: 10,
  };
  return { symbol: 'EUR/USD', timeframe: tf, timestamp: Date.now(), values };
}

describe('multi-timeframe conflict (spec §3)', () => {
  const engine = new MultiTimeframeEngine(undefined as never);
  const tfs = ['1m', '5m', '15m', '30m', '1h', '4h', '1D'] as Timeframe[];
  const start = Date.now() - 100 * 3600_000;

  function analyzeWith(trendByTf: Record<string, 'BULLISH' | 'BEARISH' | 'NEUTRAL'>) {
    const candlesByTf: Partial<Record<Timeframe, Candle[]>> = {};
    const indicatorsByTf: Partial<Record<Timeframe, IndicatorSnapshot | null>> = {};
    for (const tf of tfs) {
      candlesByTf[tf] = makeCandles(50, start, TIMEFRAME_MS[tf]);
      indicatorsByTf[tf] = snap(tf, trendByTf[tf]);
    }
    return engine.analyze(candlesByTf as never, indicatorsByTf as never, 'EUR/USD', Date.now());
  }

  it('flags higher-vs-lower disagreement as conflict', () => {
    const mtf = analyzeWith({ '1D': 'BEARISH', '4h': 'BEARISH', '1h': 'BEARISH', '15m': 'BULLISH', '5m': 'BULLISH', '1m': 'BULLISH', '30m': 'NEUTRAL' });
    expect(mtf.conflict).toBe(true);
    expect(mtf.consensus).toBe('MIXED');
  });

  it('no conflict when all timeframes agree', () => {
    const mtf = analyzeWith({ '1D': 'BULLISH', '4h': 'BULLISH', '1h': 'BULLISH', '15m': 'BULLISH', '5m': 'BULLISH', '1m': 'BULLISH', '30m': 'BULLISH' });
    expect(mtf.conflict).toBe(false);
    expect(mtf.consensus).toBe('BULLISH');
    expect(mtf.alignment).toBeGreaterThan(0.8);
  });
});

describe('granular score breakdown (spec §12)', () => {
  const mtf = {
    consensus: 'BULLISH', alignment: 0.4, conflict: true,
    timeframes: [], symbol: 'EUR/USD', timestamp: 0, description: '',
  } as never;
  const regime = { regime: 'TRENDING_BULLISH', volatility: 'HIGH' } as never;
  const pa = { trendStructure: 'UPTREND' } as never;

  it('produces trend/momentum/volatility/priceAction/mtf/regime sub-scores', () => {
    const scores = buildScoreBreakdown({ mtf, priceActionAnalysis: pa, regime, values: { close: 12, ema9: 11, ema20: 10, ema50: 9, rsi14: 60, macdHistogram: 0.001 }, conflict: true });
    for (const k of ['trend', 'momentum', 'volatility', 'priceAction', 'mtf', 'regime']) {
      expect(typeof scores[k]).toBe('number');
    }
    expect(scores.trend).toBeGreaterThan(0);
    expect(scores.mtf).toBeLessThan(0); // conflict penalty dominates the alignment gain
  });

  it('entry sub-score rewards good R:R and penalizes level-proximity', () => {
    expect(entrySubScore(2, false, true)).toBeGreaterThanOrEqual(60);
    expect(entrySubScore(1, true, false)).toBeLessThan(0);
  });
});

describe('performance attribution (spec §24)', () => {
  it('breaks down trades by strategy and direction', () => {
    const mk = (over: Partial<{ symbol: string; direction: 'BUY' | 'SELL'; strategy: string; pnl: number; session: string }> = {}) => ({
      id: 't', positionId: 'p', signalId: 's', symbol: 'EUR/USD', direction: 'BUY', lots: 1, entryPrice: 1,
      exitPrice: 1.01, exitReason: 'TP1', pnl: 10, fees: 0, swap: 0, rr: 2, openTime: 0, closeTime: 1,
      durationMs: 1, session: 'LONDON', regime: null, modelVersion: 'm', confidence: 0.6, probability: 0.6,
      expectedValue: 1, strategy: 'TREND_FOLLOWING', ...over,
    } as never);
    const metrics = computeMetrics({
      trades: [
        mk({ strategy: 'TREND_FOLLOWING', direction: 'BUY', pnl: 20 }),
        mk({ strategy: 'BREAKOUT', direction: 'SELL', pnl: -5 }),
      ] as never,
      equityCurve: [{ time: 0, equity: 1000 }, { time: 1, equity: 1015 }],
      startingCapital: 1000,
    });
    expect(metrics.byStrategy['TREND_FOLLOWING'].trades).toBe(1);
    expect(metrics.byStrategy['TREND_FOLLOWING'].pnl).toBe(20);
    expect(metrics.byStrategy['BREAKOUT'].pnl).toBe(-5);
    expect(metrics.byDirection.BUY.pnl).toBe(20);
    expect(metrics.byDirection.SELL.pnl).toBe(-5);
  });
});

describe('CANCELLED state (spec §9)', () => {
  const sm = new SignalStateMachine();
  const make = (state: string) => ({
    id: 's', signalId: 's', symbol: 'EUR/USD', direction: 'BUY' as const, state: state as never,
    decision: 'BUY' as const, timestamp: 0, expiresAt: 1e15, updatedAt: 0, price: 1,
    entry: {}, stopLoss: {}, takeProfit: {}, confidence: 0.6, probability: 0.6, risk: {}, expectedValue: {},
    regime: {}, rr: 2, evidence: {}, snapshotId: 's', modelVersion: 'm', featureVersion: 'f', mode: 'DEMO' as const,
    events: [],
  });

  it('pre-entry signals can be cancelled by the user', () => {
    expect(sm.transition(make('WAITING_FOR_ENTRY'), 'CANCELLED', 'user').ok).toBe(true);
    expect(sm.transition(make('ENTRY_REACHED'), 'CANCELLED', 'user').ok).toBe(true);
  });

  it('an opened position cannot be cancelled as a signal', () => {
    expect(sm.transition(make('POSITION_ACTIVE'), 'CANCELLED', 'user').ok).toBe(false);
  });

  it('a cancelled signal flows to performance recording', () => {
    const s = make('CANCELLED');
    expect(sm.transition(s, 'PERFORMANCE_RECORDED', 'recorded').ok).toBe(true);
  });
});

describe('strategy-aware entry types (spec §22)', () => {
  const levels = {
    support: [], resistance: [], pivot: 1, prevDayHigh: null, prevDayLow: null, prevWeekHigh: null, prevWeekLow: null,
    distanceToSupportPips: null, distanceToResistancePips: null, nearestSupport: null, nearestResistance: null,
  };
  const base = {
    symbol: 'EUR/USD', direction: 'BUY' as const, currentPrice: 1.1, atr: 0.001,
    levels, structure: 'UPTREND' as const, timestamp: 0,
  };

  it('breakout strategies anchor on the market price', () => {
    const plan = buildEntry({ ...base, strategy: 'BREAKOUT' });
    expect(plan.entryType).toBe('BREAKOUT');
    expect(plan.preferredEntry).toBeCloseTo(1.1, 4);
  });

  it('trend-following keeps the pullback limit zone', () => {
    const plan = buildEntry({ ...base, strategy: 'TREND_FOLLOWING' });
    expect(plan.entryType).toBe('PULLBACK');
    expect(plan.preferredEntry).toBeLessThan(1.1);
  });

  it('defaults to MARKET entry with no strategy hint', () => {
    const plan = buildEntry(base);
    expect(plan.entryType).toBe('MARKET');
  });
});
