/**
 * Market regime engine (spec §27). Combines ADX, ATR, EMA structure, momentum,
 * price action and spread stress into one of: TRENDING_BULLISH,
 * TRENDING_BEARISH, RANGING, BREAKOUT, BREAKDOWN, REVERSAL,
 * HIGH_VOLATILITY, LOW_VOLATILITY, NEWS_DRIVEN, LIQUIDITY_STRESSED,
 * UNCERTAIN. When the regime is UNCERTAIN the signal engine must WAIT.
 */
import { MarketRegime, MarketRegimeSnapshot, Timeframe } from '@fx/shared';
import { IndicatorSnapshot } from './indicatorEngine';
import { PriceActionAnalysis } from '@fx/shared';

export interface RegimeInput {
  symbol: string;
  timeframe: Timeframe;
  timestamp: number;
  indicatorValues: IndicatorSnapshot['values'];
  priceAction: PriceActionAnalysis;
  newsDriven: boolean;
  highVolatilityNews: boolean;
  /** True when the live spread is abnormally wide vs the asset's typical range. */
  spreadStress?: boolean;
}

/**
 * ATR% (atr/close×100) volatility bands PER TIMEFRAME. The old fixed
 * 0.35/0.12 thresholds were daily-scale numbers applied to hourly bars:
 * EUR/USD ATR% ≈ 0.07–0.15 on 1h sat permanently in LOW_VOLATILITY while
 * BTC pegged HIGH. Bands are calibrated so FX majors read MEDIUM in normal
 * conditions; crypto legitimately reads HIGH (its ATR% is ~3-5× FX).
 */
export function volatilityBand(tf: Timeframe): { high: number; low: number } {
  switch (tf) {
    case '1m': return { high: 0.06, low: 0.02 };
    case '5m': return { high: 0.09, low: 0.03 };
    case '15m': return { high: 0.13, low: 0.05 };
    case '30m': return { high: 0.17, low: 0.06 };
    case '1h': return { high: 0.25, low: 0.08 };
    case '4h': return { high: 0.45, low: 0.15 };
    case '1D': return { high: 0.9, low: 0.3 };
    default: return { high: 0.25, low: 0.08 };
  }
}

export function detectRegime(input: RegimeInput): MarketRegimeSnapshot {
  const v = input.indicatorValues;
  const adxV = v.adx ?? null;
  const atrPct = v.atrPct ?? null;
  const ema9 = v.ema9 ?? null;
  const ema20 = v.ema20 ?? null;
  const close = v.close ?? null;
  const pa = input.priceAction.patterns;

  let regime: MarketRegime = 'UNCERTAIN';
  let description = '';

  const trending = adxV !== null && adxV >= 25;
  const band = volatilityBand(input.timeframe);
  const highVol = atrPct !== null && atrPct >= band.high;
  const lowVol = atrPct !== null && atrPct <= band.low;
  const bullishEma = close !== null && ema9 !== null && ema20 !== null && close > ema9 && ema9 > ema20;
  const bearishEma = close !== null && ema9 !== null && ema20 !== null && close < ema9 && ema9 < ema20;

  if (input.newsDriven) {
    regime = 'NEWS_DRIVEN';
    description = 'high-impact news in window; regime driven by event risk';
  } else if (input.spreadStress) {
    regime = 'LIQUIDITY_STRESSED';
    description = 'spread abnormally wide — liquidity stress; high execution-cost risk';
  } else if (pa.includes('BREAKDOWN')) {
    regime = 'BREAKDOWN';
    description = highVol
      ? 'price broke below the recent range with expanding volatility'
      : 'price broke below the recent range';
  } else if (pa.includes('BREAKOUT')) {
    regime = 'BREAKOUT';
    description = highVol
      ? 'price broke the recent range with expanding volatility'
      : 'price broke above the recent range';
  } else if (trending && bullishEma) {
    regime = 'TRENDING_BULLISH';
    description = `ADX ${adxV?.toFixed(1)} with bullish EMA structure`;
  } else if (trending && bearishEma) {
    regime = 'TRENDING_BEARISH';
    description = `ADX ${adxV?.toFixed(1)} with bearish EMA structure`;
  } else if ((pa.includes('REVERSAL') || pa.includes('PULLBACK')) && adxV !== null && adxV >= 20) {
    regime = 'REVERSAL';
    description = 'reversal/pullback structure with moderate trend';
  } else if (highVol) {
    regime = 'HIGH_VOLATILITY';
    description = `elevated volatility (ATR ${atrPct?.toFixed(2)}%)`;
  } else if (lowVol) {
    regime = 'LOW_VOLATILITY';
    description = `low volatility (ATR ${atrPct?.toFixed(2)}%)`;
  } else if (pa.includes('RANGE') || pa.includes('CONSOLIDATION')) {
    regime = 'RANGING';
    description = 'price consolidating without clear trend';
  } else {
    regime = 'UNCERTAIN';
    description = 'no dominant regime signal — treat as uncertain';
  }

  return {
    symbol: input.symbol,
    timeframe: input.timeframe,
    timestamp: input.timestamp,
    regime,
    adx: adxV,
    atrPct,
    volatility: highVol ? 'HIGH' : lowVol ? 'LOW' : 'MEDIUM',
    description,
  };
}
