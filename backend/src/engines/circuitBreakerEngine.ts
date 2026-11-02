/**
 * Risk circuit breakers. Hard, non-overridable limits: max daily/weekly loss,
 * max drawdown, max consecutive losses, max open positions, max correlated
 * positions, max leverage, max currency exposure. When any breaker trips,
 * new signals STOP. LLMs can never override these.
 */
import { BreakerType, CircuitBreakerState, UserSettings } from '@fx/shared';
import { PaperPosition } from '@fx/shared';

export interface BreakerInput {
  settings: UserSettings;
  dailyPnlPct: number; // % of starting capital
  weeklyPnlPct: number;
  drawdownPct: number;
  consecutiveLosses: number;
  openPositions: number;
  correlatedPositions: number;
  leverage: number;
  currencyExposurePct: number;
}

export class CircuitBreakerEngine {
  evaluate(input: BreakerInput): CircuitBreakerState {
    const active: BreakerType[] = [];
    const details: CircuitBreakerState['details'] = {};
    const s = input.settings;

    const check = (type: BreakerType, limit: number, current: number, breaker: boolean) => {
      details[type] = { limit, current: Number(current.toFixed(2)) };
      if (breaker) active.push(type);
    };
    // 0 means "unlimited" for every count/ratio breaker — a 0 limit must not
    // become a permanent global block (and NaN-prone exposure math).
    const gtZero = (n: number): boolean => Number.isFinite(n) && n > 0;

    check('MAX_DAILY_LOSS', s.maxDailyLossPercent, Math.abs(input.dailyPnlPct), input.dailyPnlPct <= -s.maxDailyLossPercent);
    check('MAX_WEEKLY_LOSS', s.maxWeeklyLossPercent, Math.abs(input.weeklyPnlPct), input.weeklyPnlPct <= -s.maxWeeklyLossPercent);
    check('MAX_DRAWDOWN', s.maxDrawdownPercent, input.drawdownPct, gtZero(s.maxDrawdownPercent) && input.drawdownPct >= s.maxDrawdownPercent);
    check('MAX_CONSECUTIVE_LOSSES', s.maxConsecutiveLosses, input.consecutiveLosses, gtZero(s.maxConsecutiveLosses) && input.consecutiveLosses >= s.maxConsecutiveLosses);
    check('MAX_OPEN_POSITIONS', s.maxOpenPositions, input.openPositions, gtZero(s.maxOpenPositions) && input.openPositions >= s.maxOpenPositions);
    check('MAX_CORRELATED_POSITIONS', s.maxCorrelatedPositions, input.correlatedPositions, gtZero(s.maxCorrelatedPositions) && input.correlatedPositions >= s.maxCorrelatedPositions);
    check('MAX_LEVERAGE', s.maxLeverage, input.leverage, gtZero(s.maxLeverage) && input.leverage >= s.maxLeverage);
    check('MAX_CURRENCY_EXPOSURE', s.maxCurrencyExposurePercent, input.currencyExposurePct, gtZero(s.maxCurrencyExposurePercent) && input.currencyExposurePct >= s.maxCurrencyExposurePercent);

    return {
      triggered: active.length > 0,
      activeBreakers: active,
      details,
      updatedAt: Date.now(),
    };
  }

  /** Max correlated positions currently held, given the correlation matrix. */
  countCorrelated(openSymbols: string[], matrix: Record<string, Record<string, number>>, threshold = 0.7): number {
    if (openSymbols.length === 0) return 0;
    let max = 0;
    for (const sym of openSymbols) {
      let count = 0;
      for (const other of openSymbols) {
        if (sym === other) continue;
        if (Math.abs(matrix[sym]?.[other] ?? 0) >= threshold) count++;
      }
      max = Math.max(max, count);
    }
    return max;
  }
}
