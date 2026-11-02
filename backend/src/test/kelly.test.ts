/**
 * Fractional-Kelly risk cap (quant-trading-bot adoption): pure-math unit
 * tests. The cap only ever TIGHTENS the user's static risk policy.
 */
import { describe, it, expect } from 'vitest';
import { kellyRiskCap, KELLY_MIN_TRADES } from '../math/kelly';

describe('kellyRiskCap', () => {
  it('computes the classic Kelly fraction from win rate and payoff', () => {
    // p=0.55, b=1.2 → f* = 0.55 − 0.45/1.2 = 0.175 → quarter-Kelly = 4.375%
    const cap = kellyRiskCap({ winRate: 0.55, payoffRatio: 1.2, trades: 50 });
    expect(cap).not.toBeNull();
    expect(cap!.fullKelly).toBeCloseTo(0.175, 6);
    expect(cap!.riskFraction).toBeCloseTo(0.04375, 6);
    expect(cap!.basis).toBe('sampled');
  });

  it('caps at the configured ceiling (5%) even when Kelly is huge', () => {
    // p=0.9, b=1 → f* = 0.8 → quarter 20% → ceiling 5%
    const cap = kellyRiskCap({ winRate: 0.9, payoffRatio: 1.0, trades: 100 });
    expect(cap!.riskFraction).toBeLessThanOrEqual(0.05);
  });

  it('floors at the configured minimum (0.25%) when Kelly is tiny but positive', () => {
    // p=0.51, b=1.01 → f* = 0.51 − 0.49/1.01 ≈ 0.0246 → quarter ≈ 0.6% > floor
    const cap = kellyRiskCap({ winRate: 0.505, payoffRatio: 1.001, trades: 60 });
    expect(cap!.riskFraction).toBeGreaterThanOrEqual(0.0025);
  });

  it('clamps a NEGATIVE edge to zero and never raises risk', () => {
    // p=0.4, b=1 → f* = 0.4 − 0.6 < 0 → fullKelly 0, suggested = floor
    const cap = kellyRiskCap({ winRate: 0.4, payoffRatio: 1.0, trades: 100 });
    expect(cap!.fullKelly).toBe(0);
    expect(cap!.riskFraction).toBeLessThanOrEqual(0.05);
  });

  it('refuses to size on insufficient sample (caller keeps static policy)', () => {
    const cap = kellyRiskCap({ winRate: 0.8, payoffRatio: 3, trades: KELLY_MIN_TRADES - 1 });
    expect(cap!.basis).toBe('insufficient-data');
  });

  it('returns null on invalid inputs', () => {
    expect(kellyRiskCap({ winRate: 0.5, payoffRatio: 0, trades: 50 })).toBeNull();
    expect(kellyRiskCap({ winRate: NaN, payoffRatio: 1.5, trades: 50 })).toBeNull();
  });
});
