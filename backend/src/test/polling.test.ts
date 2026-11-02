import { describe, it, expect } from 'vitest';
import { scheduleIntervals } from '../providers/polling';
import { TokenBucket, bucketPerMinute } from '../providers/rateLimiter';

describe('scheduleIntervals (adaptive polling)', () => {
  const symbols = ['EUR/USD', 'GBP/USD', 'USD/JPY', 'USD/CHF', 'AUD/USD', 'USD/CAD', 'NZD/USD', 'EUR/GBP', 'EUR/JPY', 'GBP/JPY'];

  it('never exceeds the per-minute budget', () => {
    const budget = { budgetPerMinute: 55, activeIntervalMs: 5000, idleIntervalMs: 30000 };
    const intervals = scheduleIntervals(symbols, {}, budget);
    const cost = symbols.reduce((sum, s) => sum + 60_000 / intervals[s], 0);
    expect(cost).toBeLessThanOrEqual(55 + 1e-9);
    // no symbol faster than the active cap
    for (const s of symbols) expect(intervals[s]).toBeGreaterThanOrEqual(5000);
  });

  it('gives hot symbols the active interval while keeping idle symbols slow', () => {
    const budget = { budgetPerMinute: 55, activeIntervalMs: 5000, idleIntervalMs: 30000 };
    const weights = { 'EUR/USD': 1, 'GBP/USD': 0.8 };
    const intervals = scheduleIntervals(symbols, weights, budget);
    expect(intervals['EUR/USD']).toBe(5000);
    expect(intervals['GBP/USD']).toBe(5000);
    // idle symbols must stay at the idle interval (else budget blows up)
    expect(intervals['NZD/USD']).toBe(30000);
  });

  it('slows idle polling when even the idle rate exceeds the budget', () => {
    const budget = { budgetPerMinute: 3, activeIntervalMs: 5000, idleIntervalMs: 30000 };
    const intervals = scheduleIntervals(symbols, {}, budget);
    // 10 symbols at 30s = 20/min > 3/min budget → idle must stretch
    const cost = symbols.reduce((sum, s) => sum + 60_000 / intervals[s], 0);
    expect(cost).toBeLessThanOrEqual(3 + 1e-9);
    expect(intervals[symbols[0]]).toBeGreaterThan(30000);
  });

  it('handles empty and single-symbol inputs', () => {
    expect(scheduleIntervals([], {}, { budgetPerMinute: 55, activeIntervalMs: 5000, idleIntervalMs: 30000 })).toEqual({});
    const one = scheduleIntervals(['EUR/USD'], { 'EUR/USD': 1 }, { budgetPerMinute: 55, activeIntervalMs: 5000, idleIntervalMs: 30000 });
    expect(one['EUR/USD']).toBe(5000);
  });
});

describe('TokenBucket rate limiter', () => {
  it('allows a burst up to capacity, then throttles', async () => {
    let now = 0;
    const bucket = new TokenBucket(5, 5 / 60_000, () => now);
    for (let i = 0; i < 5; i++) expect(bucket.tryAcquire()).toBe(true);
    expect(bucket.tryAcquire()).toBe(false);
    // after 12s, ~1 token should have refilled
    now = 12_000;
    expect(bucket.tryAcquire()).toBe(true);
    expect(bucket.tryAcquire()).toBe(false);
  });

  it('acquire resolves immediately when a token is available', async () => {
    const bucket = bucketPerMinute(10);
    const started = Date.now();
    await bucket.acquire();
    expect(Date.now() - started).toBeLessThan(100);
  });

  it('steady-state rate matches the budget after the burst is drained', () => {
    let now = 0;
    const bucket = new TokenBucket(60, 60 / 60_000, () => now);
    // drain the initial burst
    for (let i = 0; i < 60; i++) bucket.tryAcquire();
    let granted = 0;
    for (let t = 1000; t <= 60_000; t += 1000) {
      now = t;
      // attempt two acquisitions per simulated second — only refill rate may pass
      if (bucket.tryAcquire()) granted++;
      if (bucket.tryAcquire()) granted++;
    }
    // ~60 refilled tokens over 60s
    expect(granted).toBeGreaterThanOrEqual(55);
    expect(granted).toBeLessThanOrEqual(61);
  });
});
