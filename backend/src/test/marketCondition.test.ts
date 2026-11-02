/**
 * Market condition engine tests (Phases 4-5). Direct unit tests of the
 * rolling spread / ATR% classification consumed by the signal engine.
 */
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import { MarketConditionEngine } from '../engines/marketConditionEngine';
import { CHANNELS, FxContext } from '../core/context';
import { Candle, Tick } from '@fx/shared';

function makeCtx(): FxContext {
  return { events: new EventEmitter() } as unknown as FxContext;
}

function tick(symbol: string, bid: number, ask: number): Tick {
  return {
    symbol, bid, ask, mid: (bid + ask) / 2, spread: ask - bid,
    timestamp: Date.now(), source: 'TEST', mode: 'DEMO',
  } as Tick;
}

function candle(symbol: string, open: number, high: number, low: number, close: number, i: number): Candle {
  const openTime = Date.now() - (100 - i) * 3_600_000;
  return {
    symbol, timeframe: '1h', open, high, low, close, volume: 100,
    openTime, closeTime: openTime + 3_600_000,
    state: 'COMPLETED', completed: true, updatedAt: openTime + 3_600_000,
  } as Candle;
}

describe('market condition engine', () => {
  it('classifies spread NORMAL / ELEVATED / ABNORMAL against the rolling distribution', () => {
    const ctx = makeCtx();
    const engine = new MarketConditionEngine(ctx);
    const symbol = 'EUR/USD';
    // 30 ticks at a healthy ~1.0 pip spread (0.0001).
    for (let i = 0; i < 30; i++) ctx.events.emit(CHANNELS.tick, tick(symbol, 1.08, 1.0801));
    expect(engine.spreadStatus(symbol, 1).sampleCount).toBe(30);
    expect(engine.spreadStatus(symbol, 1).median).toBeCloseTo(1, 1);
    // Around the median → NORMAL.
    expect(engine.spreadStatus(symbol, 1).level).toBe('NORMAL');
    // Above median × 1.5 → ELEVATED.
    expect(engine.spreadStatus(symbol, 2).level).toBe('ELEVATED');
    // Above max(p95, median × 3) → ABNORMAL.
    expect(engine.spreadStatus(symbol, 4).level).toBe('ABNORMAL');
    // Zero/negative spreads (feeds without bid/ask) never poison the sample.
    const cold = makeCtx();
    const engine2 = new MarketConditionEngine(cold);
    cold.events.emit(CHANNELS.tick, tick('EUR/USD', 1.08, 1.08));
    expect(engine2.spreadStatus('EUR/USD', 1).sampleCount).toBe(0);
  });

  it('classifies volatility LOW / NORMAL / HIGH / EXTREME from completed 1h candles', () => {
    const ctx = makeCtx();
    const engine = new MarketConditionEngine(ctx);
    const symbol = 'GBP/USD';
    // 40 candles alternating a tight (10-pip) and wide (100-pip) true range →
    // the ATR% history spans a wide distribution, so percentile bands are
    // clearly separated and rounding noise cannot flip the classification.
    for (let i = 0; i < 40; i++) {
      const tr = i % 2 === 0 ? 0.001 : 0.01;
      ctx.events.emit(CHANNELS.candle, candle(symbol, 1.251, 1.251 + tr / 2, 1.251 - tr / 2, 1.251, i));
    }
    const probe = engine.volatilityStatus(symbol, 99); // compute the percentiles
    expect(probe.sampleCount).toBeGreaterThanOrEqual(20);
    expect(probe.p95).toBeGreaterThan(probe.p75);
    expect(probe.p75).toBeGreaterThan(probe.p25);
    // A value safely inside [p25, p75] → NORMAL.
    const midBand = (probe.p25 + probe.p75) / 2;
    expect(engine.volatilityStatus(symbol, midBand).level).toBe('NORMAL');
    // Far above p95 → EXTREME; far below p25 → LOW.
    expect(engine.volatilityStatus(symbol, probe.p95 * 2).level).toBe('EXTREME');
    expect(engine.volatilityStatus(symbol, probe.p25 / 2).level).toBe('LOW');
    // null current ATR → NORMAL (no data to judge against).
    expect(engine.volatilityStatus(symbol, null).level).toBe('NORMAL');
  });

  it('spread/volatility history is bounded (no unbounded memory growth)', () => {
    const ctx = makeCtx();
    const engine = new MarketConditionEngine(ctx);
    const symbol = 'EUR/USD';
    for (let i = 0; i < 2000; i++) ctx.events.emit(CHANNELS.tick, tick(symbol, 1.08, 1.0801));
    expect(engine.spreadStatus(symbol, 1).sampleCount).toBeLessThanOrEqual(300);
    for (let i = 0; i < 500; i++) ctx.events.emit(CHANNELS.candle, candle(symbol, 1.25, 1.251, 1.249, 1.2505, i));
    expect(engine.volatilityStatus(symbol, 0.09).sampleCount).toBeLessThanOrEqual(120);
  });
});
