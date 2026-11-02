/**
 * Unit tests for the pure paper-execution math (spec §40-41, §34, §93):
 * slippage fills, UTC daily/weekly window rollover, signal expiry.
 */
import { describe, it, expect } from 'vitest';
import { applySlippage, dayWindowKey, weekWindowKey, rollWindow } from '../math/paperMath';
import { computeGoalProgress } from '../math/paperMath';
import { isPreEntryState, signalExpired } from '../engines/signalStateMachine';
import { Signal } from '@fx/shared';

describe('paper fill slippage (spec §40-41)', () => {
  it('BUY fills above the reference price by the slippage (100 bps = 1%)', () => {
    expect(applySlippage('BUY', 100, 100)).toBeCloseTo(101, 10);
  });

  it('SELL fills below the reference price by the slippage', () => {
    expect(applySlippage('SELL', 100, 100)).toBeCloseTo(99, 10);
  });

  it('zero slippage leaves the price unchanged (never a perfect execution by default)', () => {
    expect(applySlippage('BUY', 1.1234, 0)).toBe(1.1234);
    expect(applySlippage('SELL', 1.1234, 0)).toBe(1.1234);
  });

  it('negative slippage is clamped to zero — it can never improve the fill', () => {
    expect(applySlippage('BUY', 100, -50)).toBe(100);
    expect(applySlippage('SELL', 100, -50)).toBe(100);
  });
});

describe('daily/weekly window rollover (spec §34)', () => {
  it('rolls the daily counter when the UTC day changes', () => {
    const t1 = Date.UTC(2026, 7, 18, 23, 59, 59);
    const t2 = Date.UTC(2026, 7, 19, 0, 0, 1);
    expect(dayWindowKey(t2)).not.toBe(dayWindowKey(t1));
    const r = rollWindow(-300, t1, t2, dayWindowKey);
    expect(r.value).toBe(0);
    expect(r.resetAt).toBe(t2);
  });

  it('keeps the counter within the same window', () => {
    const t1 = Date.UTC(2026, 7, 18, 10, 0, 0);
    const t2 = Date.UTC(2026, 7, 18, 11, 30, 0);
    const r = rollWindow(-300, t1, t2, dayWindowKey);
    expect(r.value).toBe(-300);
    expect(r.resetAt).toBe(t1);
  });

  it('uses Monday-based UTC weeks', () => {
    const sunday = Date.UTC(2026, 7, 16, 12, 0, 0);
    const monday = Date.UTC(2026, 7, 17, 12, 0, 0);
    expect(weekWindowKey(monday)).not.toBe(weekWindowKey(sunday));
  });
});

describe('signal expiry (spec §93)', () => {
  const base: Signal = {
    id: 's1', signalId: 's1', symbol: 'EUR/USD', direction: 'BUY',
    state: 'WAITING_FOR_ENTRY', decision: 'BUY', timestamp: 0, updatedAt: 0,
    expiresAt: 1000, price: 1,
    entry: { entryMin: 0, entryMax: 0, preferredEntry: 0, status: 'READY', reason: '' },
    stopLoss: { price: 0.99, pips: 10, basis: 'test' },
    takeProfit: { tp1: 1.01, tp2: 1.02, tp3: null, rr1: 2, rr2: 3, rr3: null },
    confidence: 0.6, probability: 0.6,
    risk: { symbol: 'EUR/USD', timestamp: 0, level: 'YELLOW', score: 30, components: {}, critical: [], blocked: false },
    expectedValue: {
      evPerTrade: 5, evPerRisk: 0.5, probabilityWin: 0.6, probabilityLoss: 0.4,
      averageWin: 10, averageLoss: 5, tradingCosts: 1, positive: true,
      breakdown: { spread: 1, commission: 0, slippage: 0, swap: 0 },
    },
    regime: { symbol: 'EUR/USD', timeframe: '1h', timestamp: 0, regime: 'RANGING', adx: null, atrPct: null, volatility: 'MEDIUM', description: 'test' },
    rr: 2,
    evidence: { technical: [], multiTimeframe: [], priceAction: [], historical: [], ml: [], news: [], risk: [], opposing: [] },
    snapshotId: 's1', modelVersion: 'm', featureVersion: 'f', mode: 'DEMO', events: [],
  };

  it('flags signals past their expiry and never expires a disabled expiry', () => {
    expect(signalExpired({ ...base, expiresAt: 1000 }, 1001)).toBe(true);
    expect(signalExpired({ ...base, expiresAt: 1000 }, 999)).toBe(false);
    expect(signalExpired({ ...base, expiresAt: 0 }, Date.now())).toBe(false);
  });

  it('only pre-position states can expire into a fresh analysis', () => {
    expect(isPreEntryState('CANDIDATE')).toBe(true);
    expect(isPreEntryState('WAITING_FOR_ENTRY')).toBe(true);
    expect(isPreEntryState('ENTRY_REACHED')).toBe(true);
    expect(isPreEntryState('POSITION_ACTIVE')).toBe(false);
    expect(isPreEntryState('TRAILING')).toBe(false);
    expect(isPreEntryState('CLOSED')).toBe(false);
  });
});

describe('goal progress (INR paper wallet)', () => {
  it('pauses auto entries only when cumulative NET P&L reaches the target', () => {
    const below = computeGoalProgress({ target: 200, realized: 120, unrealized: -30 });
    expect(below.achieved).toBe(false);
    expect(below.autoPaused).toBe(false);
    expect(below.remaining).toBe(110);

    const reached = computeGoalProgress({ target: 200, realized: 150, unrealized: 80 });
    expect(reached.achieved).toBe(true);
    expect(reached.autoPaused).toBe(true);
    expect(reached.percent).toBe(100);
  });

  it('never reports negative remaining and ignores an unset goal', () => {
    const over = computeGoalProgress({ target: 100, realized: 260, unrealized: 0 });
    expect(over.remaining).toBe(0);
    const unset = computeGoalProgress({ target: 0, realized: 500, unrealized: 10 });
    expect(unset.achieved).toBe(false);
    expect(unset.autoPaused).toBe(false);
  });

  it('counts floating P&L toward the goal - a losing open can un-reach it', () => {
    const at = computeGoalProgress({ target: 200, realized: 220, unrealized: -40 });
    expect(at.total).toBe(180);
    expect(at.achieved).toBe(false);
  });
});
