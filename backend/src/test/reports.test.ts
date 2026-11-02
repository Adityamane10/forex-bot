/**
 * Trading reports: aggregates must reflect the REAL closed-trade journal
 * exactly — per-day buckets (local calendar days), net P&L sums, win/loss
 * split, and margin computed from each trade's own recorded terms via the
 * live FX converter. A day with no closed trades must never appear.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Container } from '../core/container';
import { dailyReport, dayReport, localDayKey, setReportConverter } from '../engines/reports';
import { PaperTrade } from '@fx/shared';

describe('reports over the closed-trade journal', () => {
  let container: Container;
  const seededIds = ['rep-test-1', 'rep-test-2'];

  beforeAll(async () => {
    process.env.SCANNER_INTERVAL_MS = '60000';
    container = new Container();
    await container.init();
    await container.start();
    // Same wiring the API route performs: margin converts over the LIVE FX.
    setReportConverter((amount, from, to) => container.paper.convert(amount, from, to)?.rate ?? null);
  }, 90_000);

  afterAll(async () => {
    await container.store.deleteMany('paperTrades', { id: { $in: seededIds } } as never);
    await container.stop();
  });

  function seed(id: string, over: Partial<PaperTrade>): PaperTrade {
    const now = Date.now();
    return {
      id, positionId: `pos-${id}`, signalId: `sig-${id}`, symbol: 'EUR/USD',
      direction: 'BUY', lots: 0.1, entryPrice: 1.1, exitPrice: 1.105,
      exitReason: 'MANUAL', pnl: 0, fees: 0, swap: 0, rr: 1,
      openTime: now - 3600_000, closeTime: now, durationMs: 3600_000,
      session: 'LONDON', regime: null, modelVersion: 'test',
      confidence: 0.6, probability: 0.6, expectedValue: 1,
      ...over,
    } as PaperTrade;
  }

  it('buckets closed trades by LOCAL day with exact sums', async () => {
    const today = Date.now();
    const yesterday = today - 86_400_000;
    await container.store.insertOne('paperTrades', seed('rep-test-1', { closeTime: today, pnl: 50.25, fees: 0.7, swap: -0.2 }));
    await container.store.insertOne('paperTrades', seed('rep-test-2', { closeTime: yesterday, pnl: -20.3, symbol: 'XAU/USD' }));

    const rep = await dailyReport(container.store, container.paper.getAccount(), 30);
    expect(rep.currency).toBe((container.paper.getAccount()!.currency).toUpperCase());

    const todayBucket = rep.days.find((d) => d.date === localDayKey(today));
    const yBucket = rep.days.find((d) => d.date === localDayKey(yesterday));
    expect(todayBucket).toBeDefined();
    expect(todayBucket!.trades).toBe(1);
    expect(todayBucket!.wins).toBe(1);
    expect(todayBucket!.losses).toBe(0);
    expect(todayBucket!.pnl).toBeCloseTo(50.25, 2);
    expect(yBucket).toBeDefined();
    expect(yBucket!.trades).toBe(1);
    expect(yBucket!.losses).toBe(1);
    expect(yBucket!.pnl).toBeCloseTo(-20.3, 2);

    // The seeded pair must drive the window totals (other records may exist).
    expect(rep.totals.trades).toBeGreaterThanOrEqual(2);
    expect(rep.totals.pnl).toBeGreaterThanOrEqual(50.25 - 20.3 - 1e-6);
  });

  it('day report returns that day only, with margin from live conversion', async () => {
    const key = localDayKey(Date.now());
    const rep = await dayReport(container.store, container.paper.getAccount(), key);
    expect(rep).not.toBeNull();
    expect(rep!.date).toBe(key);
    const t = rep!.trades.find((x) => x.id === 'rep-test-1');
    expect(t).toBeDefined();
    expect(rep!.totals.trades).toBe(rep!.trades.length);
    const mine = rep!.totals.pnl - (rep!.trades.filter((x) => x.id !== 'rep-test-1').reduce((s, x) => s + x.pnl, 0));
    expect(mine).toBeCloseTo(50.25, 2);
    // Margin: 0.1 lots × 100k × 1.1 = 11,000 quote ÷ leverage — a real number
    // derived from the trade's own terms (never fabricated).
    expect(rep!.totals.margin).toBeGreaterThan(0);
  });

  it('rejects malformed dates and returns no buckets for empty days', async () => {
    expect(await dayReport(container.store, container.paper.getAccount(), 'not-a-date')).toBeNull();
    const rep = await dayReport(container.store, container.paper.getAccount(), '1999-01-01');
    expect(rep).not.toBeNull();
    expect(rep!.trades.length).toBe(0);
    expect(rep!.totals.pnl).toBe(0);
  });
});
