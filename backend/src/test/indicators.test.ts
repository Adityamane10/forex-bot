import { describe, it, expect } from 'vitest';
import {
  sma, ema, rsi, macd, atr, bollinger, stochastic, cci, roc, momentum,
  williamsR, adx, supertrend, obv, swingPoints, classicPivots, standardDeviation,
} from '../math/indicators';

describe('indicators', () => {
  it('SMA: known values', () => {
    const out = sma([1, 2, 3, 4, 5], 3);
    expect(out[0]).toBeNaN();
    expect(out[1]).toBeNaN();
    expect(out[2]).toBeCloseTo(2, 6);
    expect(out[3]).toBeCloseTo(3, 6);
    expect(out[4]).toBeCloseTo(4, 6);
  });

  it('SMA: matches simple average of last N', () => {
    const values = [10, 12, 11, 13, 14, 15, 14, 16];
    const out = sma(values, 4);
    const last = out[out.length - 1];
    expect(last).toBeCloseTo((15 + 14 + 16 + 14) / 4, 6);
  });

  it('EMA: constant series stays constant, monotonic series tracks direction', () => {
    const constant = Array.from({ length: 60 }, () => 100);
    const out = ema(constant, 20);
    expect(out[59]).toBeCloseTo(100, 6);
    const rising = Array.from({ length: 60 }, (_, i) => 100 + i);
    const risingOut = ema(rising, 20);
    expect(risingOut[59]).toBeGreaterThan(100);
    expect(risingOut[59]).toBeLessThan(159);
    expect(out[0]).toBeNaN();
  });

  it('RSI: all values within 0..100, oversold in downtrend', () => {
    const values = Array.from({ length: 40 }, (_, i) => 100 - i);
    const out = rsi(values, 14);
    for (const v of out) {
      if (!Number.isNaN(v)) expect(v).toBeGreaterThanOrEqual(0);
      if (!Number.isNaN(v)) expect(v).toBeLessThanOrEqual(100);
    }
    expect(out[out.length - 1]).toBeLessThan(30); // sustained downtrend -> oversold
  });

  it('RSI: all 100s for a pure uptrend', () => {
    const values = Array.from({ length: 30 }, (_, i) => i + 1);
    const out = rsi(values, 14);
    expect(out[out.length - 1]).toBe(100);
  });

  it('MACD: histogram is line - signal', () => {
    const values = Array.from({ length: 100 }, (_, i) => 100 + Math.sin(i / 5) * 5);
    const { line, signal, histogram } = macd(values, 12, 26, 9);
    for (let i = 0; i < values.length; i++) {
      if (Number.isNaN(histogram[i])) continue;
      expect(histogram[i]).toBeCloseTo(line[i] - signal[i], 6);
    }
  });

  it('ATR: positive and aligned', () => {
    const high = [10, 11, 12, 11, 12, 13, 14, 13, 14, 15, 16, 15, 16, 17, 18, 17];
    const low = [9, 10, 11, 10, 11, 12, 13, 12, 13, 14, 15, 14, 15, 16, 17, 16];
    const close = [9.5, 10.5, 11.5, 10.5, 11.5, 12.5, 13.5, 12.5, 13.5, 14.5, 15.5, 14.5, 15.5, 16.5, 17.5, 16.5];
    const out = atr(high, low, close, 14);
    const v = out[out.length - 1];
    expect(Number.isNaN(v)).toBe(false);
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(3);
  });

  it('Bollinger: upper >= middle >= lower, bandwidth positive', () => {
    const values = Array.from({ length: 50 }, (_, i) => 100 + Math.sin(i / 3) * 5);
    const { middle, upper, lower, bandwidth } = bollinger(values, 20, 2);
    const i = 49;
    expect(upper[i]).toBeGreaterThanOrEqual(middle[i]);
    expect(middle[i]).toBeGreaterThanOrEqual(lower[i]);
    expect(bandwidth[i]).toBeGreaterThan(0);
  });

  it('Stochastic: within 0..100', () => {
    const high = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i / 3) * 3 + 1);
    const low = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i / 3) * 3 - 1);
    const close = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i / 3) * 3);
    const { k, d } = stochastic(high, low, close, 14, 3);
    for (const v of [k[39], d[39]]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });

  it('CCI/ROC/Momentum/WilliamsR produce finite aligned values', () => {
    const close = Array.from({ length: 60 }, (_, i) => 100 + i * 0.1);
    const high = close.map((c) => c + 0.5);
    const low = close.map((c) => c - 0.5);
    expect(cci(high, low, close, 20)[59]).toBeGreaterThan(100); // steady rise -> strongly positive CCI
    expect(roc(close, 10)[59]).toBeCloseTo(1, 1); // ~1% over 10 bars
    expect(momentum(close, 10)[59]).toBeCloseTo(1, 6);
    const wr = williamsR(high, low, close, 14)[59];
    expect(wr).toBeGreaterThan(-100);
    expect(wr).toBeLessThan(0);
  });

  it('ADX: aligned, non-negative', () => {
    const close = Array.from({ length: 100 }, (_, i) => 100 + i * 0.5);
    const high = close.map((c) => c + 0.5);
    const low = close.map((c) => c - 0.5);
    const { adx: a } = adx(high, low, close, 14);
    expect(Number.isNaN(a[a.length - 1])).toBe(false);
    expect(a[a.length - 1]).toBeGreaterThan(0);
  });

  it('Supertrend: direction follows price', () => {
    const up = Array.from({ length: 50 }, (_, i) => 100 + i);
    const high = up.map((c) => c + 0.5);
    const low = up.map((c) => c - 0.5);
    const { direction } = supertrend(high, low, up, 10, 3);
    expect(direction[49]).toBe(1);
  });

  it('OBV: rises when closes rise', () => {
    const close = [10, 11, 12, 11, 12, 13];
    const volume = [100, 100, 100, 100, 100, 100];
    const out = obv(close, volume);
    expect(out[out.length - 1]).toBe(300);
  });

  it('swing points: detects a peak', () => {
    const highs = [1, 2, 3, 4, 5, 4, 3, 2, 1];
    const lows = [0.5, 1, 2, 3, 4, 3, 2, 1, 0.5];
    const { highs: sh } = swingPoints(highs, lows, 2);
    expect(sh).toContain(4);
  });

  it('classic pivots: P = (H+L+C)/3', () => {
    const p = classicPivots(110, 90, 100);
    expect(p.pivot).toBeCloseTo(100, 6);
    expect(p.r1).toBeCloseTo(110, 6);
    expect(p.s1).toBeCloseTo(90, 6);
  });

  it('standardDeviation: known value', () => {
    const out = standardDeviation([2, 4, 4, 4, 5, 5, 7, 9], 8);
    expect(out[7]).toBeCloseTo(2, 6);
  });

  it('handles empty/short inputs without crashing', () => {
    expect(sma([], 5)).toEqual([]);
    expect(rsi([1, 2], 14)).toHaveLength(2);
    expect(macd([], 12, 26, 9).line).toEqual([]);
    expect(atr([], [], [], 14)).toEqual([]);
  });
});
