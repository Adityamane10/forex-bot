/**
 * Indian strategy routing + entry criteria (spec §12, §20, §52). Shared by the
 * live signal engine and the historical backtester so backtests and live signals
 * use EXACTLY the same rules.
 */
import type { IndiaIndicatorValues, MarketRegime, StrategyName } from '@fx/shared';

/** Regime → strategy routing table (spec §28, Indian side). */
export const INDIA_REGIME_STRATEGY: Partial<Record<string, StrategyName>> = {
  TRENDING_BULLISH: 'TREND_FOLLOWING',
  TRENDING_BEARISH: 'TREND_FOLLOWING',
  BREAKOUT: 'BREAKOUT',
  BREAKDOWN: 'BREAKOUT',
  RANGING: 'RANGE',
  REVERSAL: 'MEAN_REVERSION',
  HIGH_VOLATILITY: 'MOMENTUM',
  LOW_VOLATILITY: 'MEAN_REVERSION',
  NEWS_DRIVEN: 'RISK_CONTROLLED',
  LIQUIDITY_STRESSED: 'RISK_CONTROLLED',
  UNCERTAIN: 'RISK_CONTROLLED',
};

export function strategyForRegime(regime: MarketRegime | string): StrategyName {
  return INDIA_REGIME_STRATEGY[regime] ?? 'RISK_CONTROLLED';
}

export interface IndiaCriteriaContext {
  trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  support: number | null;
  resistance: number | null;
}

/** Pure entry-criteria evaluation used by the signal engine AND the backtester. */
export function indiaSignalCriteria(
  strategy: StrategyName,
  values: IndiaIndicatorValues,
  ctx: IndiaCriteriaContext,
): 'BUY' | 'SELL' | null {
  const close = values.close as number | null;
  const rsi = values.rsi14 as number | null;
  const adx = values.adx as number | null;
  const bbPos = values.bbPosition as number | null;
  const volRatio = values.volumeRatio as number | null;
  const hist = values.macdHistogram as number | null;
  const { support, resistance, trend } = ctx;

  switch (strategy) {
    case 'TREND_FOLLOWING':
      if (adx !== null && adx >= 20 && trend === 'BULLISH') return 'BUY';
      if (adx !== null && adx >= 20 && trend === 'BEARISH') return 'SELL';
      return null;
    case 'BREAKOUT':
      // Volume confirmation applies only when the feed actually reports volume.
      // A null ratio means the current bar carries no printed volume (LTP-only
      // feeds, index spot) — evidence unavailable, not evidence against, so the
      // band condition alone decides. A hard fail here made breakouts
      // unreachable for every instrument on such a feed.
      if (bbPos !== null && bbPos >= 1 && (volRatio === null || volRatio >= 1.2)) return 'BUY';
      if (bbPos !== null && bbPos <= 0 && (volRatio === null || volRatio >= 1.2)) return 'SELL';
      return null;
    case 'PULLBACK':
      if (trend === 'BULLISH' && rsi !== null && rsi >= 40 && rsi <= 55) return 'BUY';
      if (trend === 'BEARISH' && rsi !== null && rsi >= 45 && rsi <= 60) return 'SELL';
      return null;
    case 'MOMENTUM':
      if (rsi !== null && rsi > 60 && hist !== null && hist > 0 && (adx ?? 0) >= 20) return 'BUY';
      if (rsi !== null && rsi < 40 && hist !== null && hist < 0 && (adx ?? 0) >= 20) return 'SELL';
      return null;
    case 'MEAN_REVERSION':
      if (bbPos !== null && bbPos <= 0 && rsi !== null && rsi <= 35) return 'BUY';
      if (bbPos !== null && bbPos >= 1 && rsi !== null && rsi >= 65) return 'SELL';
      return null;
    case 'RANGE':
      if (support !== null && close !== null && close <= support * 1.001 && rsi !== null && rsi <= 55) return 'BUY';
      if (resistance !== null && close !== null && close >= resistance * 0.999 && rsi !== null && rsi >= 45) return 'SELL';
      return null;
    case 'RISK_CONTROLLED':
      if (rsi !== null && rsi > 55 && (adx ?? 0) >= 15) return 'BUY';
      if (rsi !== null && rsi < 45 && (adx ?? 0) >= 15) return 'SELL';
      return null;
    default:
      return null;
  }
}