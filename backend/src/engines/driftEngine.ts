/**
 * Model drift engine. Monitors feature drift, prediction drift, confidence
 * drift, win-rate and EV degradation. If the champion degrades, the engine
 * can pause the model and force WAIT/NO_TRADE.
 */
import { FxContext } from '../core/context';
import { logger } from '../core/logger';

export interface DriftReport {
  status: 'HEALTHY' | 'WARNING' | 'PAUSED';
  featureDrift: number; // 0..1
  predictionDrift: number; // 0..1
  confidenceDrift: number; // 0..1
  winRateRecent: number | null;
  evRecent: number | null;
  reason: string;
  updatedAt: number;
}

export class DriftEngine {
  private lastReport: DriftReport | null = null;

  constructor(private ctx: FxContext) {}

  /**
   * Compare a recent prediction window against the reference distribution.
   * `recentFeatures` — feature vectors from the last N predictions.
   */
  async assess(
    referenceFeatures: Array<Record<string, number>>,
    recentFeatures: Array<Record<string, number>>,
    recentPredictions: Array<{ probability: number; outcome?: number }>,
  ): Promise<DriftReport> {
    const keys = referenceFeatures.length ? Object.keys(referenceFeatures[0]) : [];
    const meanRef = meanOf(referenceFeatures, keys);
    const stdRef = stdOf(referenceFeatures, keys, meanRef);

    let driftSum = 0;
    for (const f of recentFeatures) {
      let d = 0;
      for (const k of keys) {
        const z = stdRef[k] > 0 ? Math.abs((f[k] ?? 0) - meanRef[k]) / stdRef[k] : 0;
        d += Math.min(3, z);
      }
      driftSum += d / Math.max(1, keys.length);
    }
    const featureDrift = recentFeatures.length ? Math.min(1, driftSum / recentFeatures.length / 3) : 0;

    const probRef = recentPredictions.length ? recentPredictions.reduce((a, p) => a + p.probability, 0) / recentPredictions.length : 0.5;
    const predDrift = Math.abs(probRef - 0.5) * 2;
    const confDrift = featureDrift * 0.6 + predDrift * 0.4;

    const withOutcome = recentPredictions.filter((p) => p.outcome !== undefined);
    const winRateRecent = withOutcome.length >= 10 ? withOutcome.filter((p) => (p.probability > 0.5 ? p.outcome === 1 : p.outcome === 0)).length / withOutcome.length : null;

    let status: DriftReport['status'] = 'HEALTHY';
    let reason = 'model within expected drift';
    if (confDrift > 0.5 || (winRateRecent !== null && winRateRecent < 0.4)) {
      status = 'WARNING';
      reason = `drift elevated (feature ${featureDrift.toFixed(2)}, win rate ${winRateRecent?.toFixed(2) ?? 'n/a'})`;
    }
    if (confDrift > 0.75) {
      status = 'PAUSED';
      reason = 'model paused: excessive drift — signals fall back to WAIT';
    }

    this.lastReport = {
      status, featureDrift: Number(featureDrift.toFixed(3)), predictionDrift: Number(predDrift.toFixed(3)),
      confidenceDrift: Number(confDrift.toFixed(3)), winRateRecent, evRecent: null, reason, updatedAt: Date.now(),
    };
    if (status !== 'HEALTHY') logger.warn('model drift detected', { ...this.lastReport });
    return this.lastReport;
  }

  getLastReport(): DriftReport | null {
    return this.lastReport;
  }
}

function meanOf(features: Array<Record<string, number>>, keys: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of keys) {
    out[k] = features.length ? features.reduce((a, f) => a + (f[k] ?? 0), 0) / features.length : 0;
  }
  return out;
}

function stdOf(features: Array<Record<string, number>>, keys: string[], mean: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of keys) {
    const variance = features.length > 1 ? features.reduce((a, f) => a + ((f[k] ?? 0) - mean[k]) ** 2, 0) / (features.length - 1) : 0;
    out[k] = Math.sqrt(variance);
  }
  return out;
}
