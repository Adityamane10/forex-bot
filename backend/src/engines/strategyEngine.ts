/**
 * Strategy router (spec §28). Modular strategies — trend-following, breakout,
 * pullback, momentum, mean-reversion, range, risk-controlled — are selected
 * from the detected market regime. The strategy is recorded on every signal
 * (strategyVersion) so performance can be sliced per strategy later. The
 * strategy NEVER overrides the risk engine; it only shapes which setup the
 * signal pipeline emphasizes.
 */
import { IndicatorSnapshot } from './indicatorEngine';
import { MarketRegime, StrategyName, PriceActionAnalysis } from '@fx/shared';

export const STRATEGY_VERSION = 'strategy-v1';

export interface StrategySelection {
  strategy: StrategyName;
  strategyVersion: string;
  regime: MarketRegime;
  reason: string;
}

const REGIME_TO_STRATEGY: Record<MarketRegime, { strategy: StrategyName; reason: string }> = {
  TRENDING_BULLISH: { strategy: 'TREND_FOLLOWING', reason: 'bullish trend regime → trend-following setup (buy strength with structure)' },
  TRENDING_BEARISH: { strategy: 'TREND_FOLLOWING', reason: 'bearish trend regime → trend-following setup (sell weakness with structure)' },
  BREAKOUT: { strategy: 'BREAKOUT', reason: 'breakout regime → breakout strategy (enter on confirmed range expansion)' },
  BREAKDOWN: { strategy: 'MOMENTUM', reason: 'breakdown regime → momentum strategy (downside continuation, strict stops)' },
  REVERSAL: { strategy: 'MEAN_REVERSION', reason: 'reversal regime → mean-reversion strategy (fade extended moves toward value)' },
  RANGING: { strategy: 'MEAN_REVERSION', reason: 'ranging regime → mean-reversion strategy (buy support / sell resistance)' },
  LOW_VOLATILITY: { strategy: 'RANGE', reason: 'low-volatility regime → range strategy (tight zones, small targets)' },
  HIGH_VOLATILITY: { strategy: 'RISK_CONTROLLED', reason: 'high-volatility regime → risk-controlled strategy (reduced size, wider stops)' },
  NEWS_DRIVEN: { strategy: 'RISK_CONTROLLED', reason: 'news-driven regime → risk-controlled strategy (event risk caps exposure)' },
  LIQUIDITY_STRESSED: { strategy: 'RISK_CONTROLLED', reason: 'liquidity-stressed regime → risk-controlled strategy (wide spreads block entries)' },
  UNCERTAIN: { strategy: 'RISK_CONTROLLED', reason: 'uncertain regime → risk-controlled strategy (likely NO TRADE until regime resolves)' },
};

export function selectStrategy(
  regime: MarketRegime,
  indicators: IndicatorSnapshot['values'] | null | undefined,
  priceAction: PriceActionAnalysis | null | undefined,
): StrategySelection {
  const base = REGIME_TO_STRATEGY[regime] ?? REGIME_TO_STRATEGY.UNCERTAIN;
  let reason = base.reason;
  // Pullback strategy: a trend regime whose current price action is a pullback
  // toward value (the entry engine prefers these) — still trend context.
  const pa = priceAction?.patterns ?? [];
  if (regime === 'TRENDING_BULLISH' || regime === 'TRENDING_BEARISH') {
    if (pa.includes('PULLBACK')) {
      reason = 'trend regime with active pullback → pullback strategy (enter the trend on the retrace, not the extreme)';
      return { strategy: 'PULLBACK', strategyVersion: STRATEGY_VERSION, regime, reason };
    }
  }
  // Momentum evidence sharpens the trend-following selection.
  const rsi = indicators?.rsi14 ?? null;
  if (regime === 'TRENDING_BULLISH' && rsi !== null && rsi > 65) {
    reason = 'bullish trend with strong momentum → momentum strategy (trend + RSI thrust)';
    return { strategy: 'MOMENTUM', strategyVersion: STRATEGY_VERSION, regime, reason };
  }
  if (regime === 'TRENDING_BEARISH' && rsi !== null && rsi < 35) {
    reason = 'bearish trend with strong momentum → momentum strategy (trend + RSI thrust)';
    return { strategy: 'MOMENTUM', strategyVersion: STRATEGY_VERSION, regime, reason };
  }
  return { ...base, strategyVersion: STRATEGY_VERSION, regime, reason };
}
