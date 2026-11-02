/**
 * Model registry. Tracks model versions, the CHAMPION (production) and
 * CHALLENGER (shadow) models, and promotion rules. The champion can influence
 * paper signals; the challenger only predicts. Promotion requires passing
 * validation criteria (profit factor, expectancy, drawdown, calibration).
 */
import { ModelVersion } from '@fx/shared';
import { FxContext } from '../core/context';
import { logger } from '../core/logger';
import { AiClient } from '../ai/aiClient';

export class ModelRegistry {
  constructor(private ctx: FxContext, private ai: AiClient) {}

  async register(version: ModelVersion): Promise<boolean> {
    const existing = await this.ctx.store.findOne('modelVersions', { modelVersion: version.modelVersion });
    if (existing) return false;
    await this.ctx.store.insertOne('modelVersions', version);
    return true;
  }

  /** Mirror models reported by the AI engine into the local registry (idempotent). */
  async syncFromAi(remote: unknown[]): Promise<number> {
    let added = 0;
    for (const raw of remote as Array<Record<string, unknown>>) {
      if (raw.status !== 'CHAMPION' && raw.status !== 'CHALLENGER') continue;
      if (await this.register(raw as unknown as ModelVersion)) added++;
    }
    return added;
  }

  async champion(): Promise<ModelVersion | null> {
    const all = await this.ctx.store.find<ModelVersion>('modelVersions', {}, { createdAt: -1 }, 100);
    return all.find((m) => m.status === 'CHAMPION') ?? null;
  }

  async challenger(): Promise<ModelVersion | null> {
    const all = await this.ctx.store.find<ModelVersion>('modelVersions', {}, { createdAt: -1 }, 100);
    return all.find((m) => m.status === 'CHALLENGER' && m.shadow) ?? null;
  }

  async list(limit = 50): Promise<ModelVersion[]> {
    return this.ctx.store.find<ModelVersion>('modelVersions', {}, { createdAt: -1 }, limit);
  }

  /** Statistical minimum bar: not worse than random guessing (Brier >= 0.25 or AUC <= 0.5). */
  private passesQualityGate(metrics: Record<string, number>): boolean {
    return (metrics.brier ?? 1) < 0.25 && (metrics.auc ?? 0) > 0.5;
  }

  /** Promote the challenger if it passes the quality gate and beats the champion. */
  async evaluateChallenger(): Promise<{ promoted: boolean; reason: string }> {
    const champion = await this.champion();
    const all = await this.ctx.store.find<ModelVersion>('modelVersions', {}, { createdAt: -1 }, 100);
    const challenger = all.find((m) => m.status === 'CHALLENGER' && m.shadow && this.passesQualityGate(m.metrics)) ?? null;
    if (!champion) {
      if (challenger) {
        await this.setStatus(challenger.modelVersion, 'CHAMPION');
        return { promoted: true, reason: 'no champion existed; challenger promoted' };
      }
      return { promoted: false, reason: 'no champion and no challenger above quality gate (brier >= 0.25 or auc <= 0.5)' };
    }
    if (!challenger) {
      return { promoted: false, reason: 'no challenger above quality gate (brier >= 0.25 or auc <= 0.5)' };
    }
    const ch = champion.metrics;
    const cl = challenger.metrics;
    const checks: string[] = [];
    const beat = (key: string) => (cl[key] ?? -Infinity) > (ch[key] ?? -Infinity) * 1.05;
    if (beat('profitFactor')) checks.push('profitFactor');
    if (beat('expectancy')) checks.push('expectancy');
    if ((cl.maxDrawdown ?? Infinity) < (ch.maxDrawdown ?? Infinity) * 0.95) checks.push('maxDrawdown');
    if ((cl.brier ?? 1) < (ch.brier ?? 1) * 0.95) checks.push('brier');
    if (checks.length >= 2) {
      await this.setStatus(champion.modelVersion, 'ARCHIVED');
      await this.setStatus(challenger.modelVersion, 'CHAMPION');
      return { promoted: true, reason: `challenger beats champion on: ${checks.join(', ')}` };
    }
    return { promoted: false, reason: 'challenger did not meet promotion criteria' };
  }

  async setStatus(modelVersion: string, status: ModelVersion['status']): Promise<void> {
    await this.ctx.store.updateOne('modelVersions', { modelVersion }, { $set: { status } });
  }

  /** Compute calibration metrics from stored predictions + outcomes. */
  async computeCalibrationMetrics(limit = 500): Promise<{ brier: number | null; calibrationError: number | null; samples: number }> {
    try {
      const preds = await this.ctx.store.find<any>('predictions', {}, { timestamp: -1 }, limit);
      if (preds.length < 30) return { brier: null, calibrationError: null, samples: preds.length };
      let brier = 0;
      let calibrationError = 0;
      let samples = 0;
      for (const p of preds) {
        if (p.outcome === undefined || p.outcome === null) continue;
        const pUp = p.calibratedProbability ?? p.probability ?? 0.5;
        brier += (pUp - p.outcome) ** 2;
        samples++;
      }
      brier = samples ? brier / samples : 0;
      calibrationError = Math.sqrt(brier); // simple proxy (Brier -> RMSE)
      return { brier: Number(brier.toFixed(5)), calibrationError: Number(calibrationError.toFixed(5)), samples };
    } catch (err) {
      logger.warn('calibration metrics failed', { err: String(err) });
      return { brier: null, calibrationError: null, samples: 0 };
    }
  }
}
