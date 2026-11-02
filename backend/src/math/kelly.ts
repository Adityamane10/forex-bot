/**
 * Kelly-criterion risk-fraction cap (adopted from the quant-trading-bot
 * ecosystem: several of the highest-signal repos cap per-trade risk with a
 * fractional Kelly rather than a static percent-of-equity).
 *
 * Deliberately conservative and bounded:
 *  - fraction = winRate - (1 - winRate) / payoffRatio, clamped to [0, 1]
 *  - the FULL Kelly is never used (it over-bets on noisy win-rate estimates);
 *    a configurable fraction (default 0.25, "quarter Kelly") is applied
 *  - hard floor/ceiling bounds in RISK UNITS (fraction of equity the trade may
 *    risk) so a hot streak can never push sizing past the user's policy
 *  - "insufficient evidence" returns null => caller keeps the static risk
 */
export interface KellyInput {
  /** Closed-trade win rate, 0..1. */
  winRate: number;
  /** Average win / average loss in the same units (R or currency). > 0. */
  payoffRatio: number;
  /** Closed-trade sample size backing the estimate. */
  trades: number;
}

export interface KellyCap {
  /** Suggested risk as a fraction of equity, e.g. 0.015 = 1.5% per trade. */
  riskFraction: number;
  /** Full Kelly before the fractional multiplier (diagnostics). */
  fullKelly: number;
  /** How the inputs were treated (diagnostics / explainability). */
  basis: 'sampled' | 'insufficient-data';
}

export const KELLY_MIN_TRADES = 20;
/** Default fractional multiplier — quarter Kelly, the common practitioner cap. */
export const KELLY_FRACTION = 0.25;
/** Risk-unit bounds: never below 0.25% (unusable sizing) nor above 5% (ruin). */
export const KELLY_MIN_RISK = 0.0025;
export const KELLY_MAX_RISK = 0.05;

export function kellyRiskCap(input: KellyInput, opts?: { fraction?: number; minRisk?: number; maxRisk?: number }): KellyCap | null {
  const { winRate, payoffRatio, trades } = input;
  const fraction = opts?.fraction ?? KELLY_FRACTION;
  const minRisk = opts?.minRisk ?? KELLY_MIN_RISK;
  const maxRisk = opts?.maxRisk ?? KELLY_MAX_RISK;
  if (!Number.isFinite(winRate) || !Number.isFinite(payoffRatio) || payoffRatio <= 0) return null;
  if (!Number.isFinite(trades) || trades < KELLY_MIN_TRADES) {
    return { riskFraction: maxRisk, fullKelly: 0, basis: 'insufficient-data' };
  }
  const p = Math.min(1, Math.max(0, winRate));
  // Kelly for a binary bet with payoff ratio b: f* = p - (1-p)/b. Negative
  // Kelly means the edge is absent — the cap should not RAISE risk, so clamp
  // at zero and let the static sizing stand (cap only ever tightens).
  const full = Math.max(0, p - (1 - p) / payoffRatio);
  const suggested = Math.min(maxRisk, Math.max(minRisk, full * fraction));
  return { riskFraction: suggested, fullKelly: full, basis: 'sampled' };
}
