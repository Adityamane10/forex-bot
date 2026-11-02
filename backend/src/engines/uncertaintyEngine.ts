/**
 * Uncertainty engine. The system must be able to say "I DON'T KNOW". Returns
 * INSUFFICIENT_CONFIDENCE when models disagree, probabilities are weak,
 * regime is unclear, data quality is poor, news conflict is high, or EV is
 * uncertain. Never forces a BUY/SELL.
 */
import { Decision } from '@fx/shared';

export interface UncertaintyInput {
  mlProbability: number | null; // P(up)
  mlConfidence: number | null;
  modelDisagreement: number; // 0..1 (1 = models fully disagree)
  historicalConfidence: number | null; // 0..1
  regime: string;
  dataQualityScore: number; // 0..1
  newsConflict: number; // 0..1
  expectedValueCertain: boolean;
  spreadPips: number;
  maxSpreadPips: number;
  /** User-configured confidence floor (settings.minConfidence). A hidden
   *  hardcoded floor must not override it in either direction. */
  minConfidence?: number;
}

export interface UncertaintyResult {
  decision: Decision;
  reason: string;
  insufficient: boolean;
}

export function evaluateUncertainty(input: UncertaintyInput): UncertaintyResult {
  const reasons: string[] = [];

  if (input.mlProbability === null || input.mlConfidence === null) {
    return { decision: 'INSUFFICIENT_CONFIDENCE', reason: 'ML prediction unavailable', insufficient: true };
  }
  if (input.modelDisagreement > 0.5) {
    reasons.push(`models disagree strongly (${(input.modelDisagreement * 100).toFixed(0)}%)`);
  }
  const minConfidence = Number.isFinite(input.minConfidence) && (input.minConfidence as number) > 0
    ? Math.min(1, input.minConfidence as number)
    : 0.55;
  if (input.mlConfidence < minConfidence) {
    reasons.push(`ML confidence too low (${(input.mlConfidence * 100).toFixed(0)}% < ${(minConfidence * 100).toFixed(0)}%)`);
  }
  if (input.regime === 'UNCERTAIN') {
    reasons.push('market regime uncertain');
  }
  if (input.dataQualityScore < 0.7) {
    reasons.push(`data quality poor (${(input.dataQualityScore * 100).toFixed(0)}%)`);
  }
  if (input.newsConflict > 0.7) {
    reasons.push('conflicting news signals');
  }
  if (!input.expectedValueCertain) {
    reasons.push('expected value uncertain');
  }
  if (input.spreadPips > input.maxSpreadPips) {
    reasons.push(`spread ${input.spreadPips.toFixed(1)} pips exceeds safe limit`);
  }
  if (input.historicalConfidence !== null && input.historicalConfidence < 0.3) {
    reasons.push('insufficient historical pattern support');
  }

  if (reasons.length) {
    return { decision: 'INSUFFICIENT_CONFIDENCE', reason: reasons.join('; '), insufficient: true };
  }
  return { decision: 'BUY', reason: 'uncertainty check passed', insufficient: false };
}
