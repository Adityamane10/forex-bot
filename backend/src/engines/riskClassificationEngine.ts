/**
 * Risk classification engine. Every signal gets GREEN (low risk),
 * YELLOW (medium risk) or RED (high risk) from: volatility, spread, news,
 * economic events, ML uncertainty, R:R, regime, data quality, portfolio
 * exposure, correlation, drawdown and model health. Critical conditions
 * produce a BLOCK.
 */
import { RiskAssessment, RiskLevel } from '@fx/shared';

export interface RiskComponents {
  volatility: number; // 0..1
  spread: number; // 0..1
  news: number; // 0..1
  economicEvents: number; // 0..1
  mlUncertainty: number; // 0..1 (1 - confidence)
  rr: number; // 0..1 (low R:R = high risk component)
  regime: number; // 0..1
  dataQuality: number; // 0..1 (1 - score)
  portfolioExposure: number; // 0..1
  correlation: number; // 0..1
  drawdown: number; // 0..1
  modelHealth: number; // 0..1
}

export interface RiskClassificationInput {
  symbol: string;
  timestamp: number;
  components: Partial<RiskComponents>;
  critical: string[];
}

const WEIGHTS: Record<keyof RiskComponents, number> = {
  volatility: 0.12,
  spread: 0.1,
  news: 0.1,
  economicEvents: 0.1,
  mlUncertainty: 0.14,
  rr: 0.1,
  regime: 0.08,
  dataQuality: 0.08,
  portfolioExposure: 0.06,
  correlation: 0.06,
  drawdown: 0.03,
  modelHealth: 0.03,
};

export function classifyRisk(input: RiskClassificationInput): RiskAssessment {
  const c: RiskComponents = { ...defaultComponents(), ...input.components };
  let score = 0;
  for (const [k, w] of Object.entries(WEIGHTS)) {
    score += Math.min(1, Math.max(0, c[k as keyof RiskComponents])) * w;
  }
  // Red flags push into RED regardless of the weighted score
  const redFlags = input.critical.filter((f) => f.startsWith('RED:'));
  const critical = [...input.critical];
  if (redFlags.length) score = Math.max(score, 0.8);
  if (score >= 0.7) critical.push('BLOCK: risk score too high');

  const level: RiskLevel = score >= 0.7 ? 'RED' : score >= 0.45 ? 'YELLOW' : 'GREEN';
  return {
    symbol: input.symbol,
    timestamp: input.timestamp,
    level,
    score: Number((score * 100).toFixed(1)),
    components: Object.fromEntries(Object.entries(c).map(([k, v]) => [k, Number(v.toFixed(3))])),
    critical,
    blocked: critical.some((f) => f.startsWith('BLOCK:')),
  };
}

function defaultComponents(): RiskComponents {
  return {
    volatility: 0.3,
    spread: 0.2,
    news: 0,
    economicEvents: 0,
    mlUncertainty: 0.3,
    rr: 0.3,
    regime: 0.3,
    dataQuality: 0.1,
    portfolioExposure: 0,
    correlation: 0,
    drawdown: 0,
    modelHealth: 0,
  };
}
