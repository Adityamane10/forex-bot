/**
 * Historical pattern engine. Finds historically similar market states
 * (nearest neighbors in feature space) and reports the distribution of
 * outcomes that FOLLOWED those states. Strictly timestamp-safe: for a state
 * at time T only outcomes observed after T are counted.
 */
import { Candle, Timeframe } from '@fx/shared';
import { IndicatorEngine, IndicatorValues } from './indicatorEngine';

export interface PatternResult {
  similarCount: number;
  buyOutcome: number; // fraction of similar states that rose over horizon
  sellOutcome: number;
  neutralOutcome: number;
  avgForwardReturn: number; // average forward return (pct) over horizon
  confidence: number; // 0..1 based on sample size
  available: boolean;
  reason?: string;
}

export interface PatternEngineOptions {
  horizonBars: number;
  minSamples: number;
  maxSamples: number;
  threshold: number; // distance threshold for "similar"
}

const DEFAULTS: PatternEngineOptions = {
  horizonBars: 12,
  minSamples: 60,
  maxSamples: 500,
  threshold: 0.85,
};

/** Reduce an indicator snapshot to a comparable state vector. */
export function stateVector(values: IndicatorValues): number[] {
  const pick = (k: string): number => {
    const v = values[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  };
  return [
    pick('rsi14') / 100,
    pick('macdHistogram') / (Math.abs(pick('close')) || 1) * 10000,
    pick('adx') / 100,
    pick('atrPct'),
    pick('ema9minus20') / (Math.abs(pick('close')) || 1) * 10000,
    pick('bbPosition') / 2,
    pick('momentum10') / (Math.abs(pick('close')) || 1) * 10000,
    pick('roc10') / 100,
    pick('stochK') / 100,
  ];
}

export class PatternEngine {
  constructor(private indicatorEngine: IndicatorEngine) {}

  private zscore(v: number, mean: number, std: number): number {
    return std > 0 ? (v - mean) / std : 0;
  }

  /**
   * Find similar historical states for the CURRENT state and compute outcomes.
   * `candles` must be ordered oldest -> newest and MUST NOT contain future
   * candles relative to `currentIndex`.
   */
  analyze(candles: Candle[], currentIndex: number, options?: Partial<PatternEngineOptions>): PatternResult {
    const opts = { ...DEFAULTS, ...options };
    const fail = (reason: string): PatternResult => ({
      similarCount: 0, buyOutcome: 0, sellOutcome: 0, neutralOutcome: 0,
      avgForwardReturn: 0, confidence: 0, available: false, reason,
    });
    if (currentIndex < 100) return fail('insufficient history for pattern analysis');

    // Build state vectors for every timestamp-safe window ending at i (i < currentIndex).
    const vectors: Array<{ i: number; vec: number[] }> = [];
    for (let i = 60; i < currentIndex; i++) {
      const window = candles.slice(i - 59, i + 1);
      if (window.length < 60) continue;
      const snap = this.indicatorEngine.compute(window);
      const vec = stateVector(snap);
      if (vec.every((v) => v === 0)) continue;
      vectors.push({ i, vec });
    }
    if (vectors.length < opts.minSamples) return fail('insufficient historical samples');

    // Normalize using stats from historical vectors only (no future leakage).
    const dim = vectors[0].vec.length;
    const means: number[] = [];
    const stds: number[] = [];
    for (let d = 0; d < dim; d++) {
      const col = vectors.map((v) => v.vec[d]);
      const mean = col.reduce((a, b) => a + b, 0) / col.length;
      const std = Math.sqrt(col.reduce((a, b) => a + (b - mean) ** 2, 0) / col.length);
      means.push(mean);
      stds.push(std);
    }

    const currentWindow = candles.slice(Math.max(0, currentIndex - 59), currentIndex + 1);
    if (currentWindow.length < 60) return fail('current window too short');
    const currentVec = stateVector(this.indicatorEngine.compute(currentWindow));
    const currentNorm = currentVec.map((v, d) => this.zscore(v, means[d], stds[d]));

    const dists = vectors
      .map(({ i, vec }) => {
        const norm = vec.map((v, d) => this.zscore(v, means[d], stds[d]));
        let sum = 0;
        for (let d = 0; d < dim; d++) sum += (norm[d] - currentNorm[d]) ** 2;
        return { i, dist: Math.sqrt(sum / dim) };
      })
      .sort((a, b) => a.dist - b.dist)
      .slice(0, opts.maxSamples);

    const threshold = opts.threshold;
    const similar = dists.filter((d) => d.dist <= threshold).slice(0, Math.min(opts.maxSamples, 200));
    if (similar.length < opts.minSamples) {
      // relax threshold gracefully to gather enough samples
      const relaxed = dists.slice(0, Math.min(opts.maxSamples, 200));
      return {
        similarCount: relaxed.length,
        buyOutcome: this.outcomes(candles, relaxed, opts.horizonBars).buy,
        sellOutcome: this.outcomes(candles, relaxed, opts.horizonBars).sell,
        neutralOutcome: this.outcomes(candles, relaxed, opts.horizonBars).neutral,
        avgForwardReturn: this.outcomes(candles, relaxed, opts.horizonBars).avgReturn,
        confidence: Math.min(1, relaxed.length / 300),
        available: true,
        reason: `relaxed similarity (${relaxed.length} samples)`,
      };
    }
    const out = this.outcomes(candles, similar, opts.horizonBars);
    return {
      similarCount: similar.length,
      buyOutcome: out.buy,
      sellOutcome: out.sell,
      neutralOutcome: out.neutral,
      avgForwardReturn: out.avgReturn,
      confidence: Math.min(1, similar.length / 300),
      available: true,
    };
  }

  private outcomes(candles: Candle[], similar: Array<{ i: number; dist: number }>, horizonBars: number): { buy: number; sell: number; neutral: number; avgReturn: number } {
    let buy = 0;
    let sell = 0;
    let neutral = 0;
    let totalReturn = 0;
    let n = 0;
    for (const { i } of similar) {
      const end = i + horizonBars;
      if (end >= candles.length) continue; // timestamp-safe: only completed horizons
      const entry = candles[i].close;
      const exit = candles[end].close;
      const ret = (exit - entry) / entry;
      totalReturn += ret;
      n++;
      if (ret > 0.001) buy++;
      else if (ret < -0.001) sell++;
      else neutral++;
    }
    return {
      buy: n ? buy / n : 0,
      sell: n ? sell / n : 0,
      neutral: n ? neutral / n : 0,
      avgReturn: n ? (totalReturn / n) * 100 : 0,
    };
  }
}
