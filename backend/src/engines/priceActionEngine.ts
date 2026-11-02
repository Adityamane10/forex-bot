/**
 * Price action engine. Detects market structure (HH/HL/LH/LL), breakouts,
 * pullbacks, consolidations and volatility regimes, plus candlestick patterns.
 * Patterns are evidence — never standalone trade triggers.
 */
import { Candle, CandlePattern, PriceAction, PriceActionAnalysis, Timeframe } from '@fx/shared';
import { swingPoints } from '../math/indicators';

export function detectCandlePatterns(candles: Candle[]): CandlePattern[] {
  const out: CandlePattern[] = [];
  if (candles.length < 3) return out;
  const c = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const prev2 = candles[candles.length - 3];

  const bullish = c.close > c.open;
  const bearish = c.close < c.open;

  if (bullish && prev.close < prev.open && c.close > prev.open && c.open < prev.close) out.push('BULLISH_ENGULFING');
  if (bearish && prev.close > prev.open && c.close < prev.open && c.open > prev.close) out.push('BEARISH_ENGULFING');

  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low;
  const prevRange = prev.high - prev.low;
  if (range > 0) {
    const upperWick = c.high - Math.max(c.open, c.close);
    const lowerWick = Math.min(c.open, c.close) - c.low;
    if (lowerWick > body * 2 && upperWick < body * 0.5) out.push('PIN_BAR_BULLISH');
    if (upperWick > body * 2 && lowerWick < body * 0.5) out.push('PIN_BAR_BEARISH');
    if (body < range * 0.1) out.push('DOJI');
  }
  if (range > 0 && prevRange > 0) {
    if (c.high <= prev.high && c.low >= prev.low) out.push('INSIDE_BAR');
  }
  // Morning / evening star (3-candle reversal)
  const prevBody = Math.abs(prev.close - prev.open);
  if (prevRange > 0 && prevBody > 0) {
    const prev2Body = Math.abs(prev2.close - prev2.open);
    if (prev2Body > 0 && prevRange > 0) {
      const bearish2 = prev2.close < prev2.open;
      if (bearish2 && prevBody < prevRange * 0.35 && bullish && c.close > (prev2.open + prev2.close) / 2) out.push('MORNING_STAR');
      const bullish2 = prev2.close > prev2.open;
      if (bullish2 && prevBody < prevRange * 0.35 && bearish && c.close < (prev2.open + prev2.close) / 2) out.push('EVENING_STAR');
    }
  }
  return out;
}

export function analyzePriceAction(candles: Candle[], symbol: string, timeframe: Timeframe, timestamp: number): PriceActionAnalysis {
  const out: PriceActionAnalysis = {
    symbol,
    timeframe,
    timestamp,
    patterns: [],
    candlePatterns: [],
    swingHigh: null,
    swingLow: null,
    trendStructure: 'UNCLEAR',
    description: '',
  };
  if (candles.length < 30) {
    out.description = 'insufficient history';
    return out;
  }

  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const closes = candles.map((c) => c.close);
  const swings = swingPoints(highs, lows, 3);
  const lastHigh = highs[highs.length - 1];
  const lastLow = lows[lows.length - 1];

  const recentSwingsH = swings.highs.slice(-6);
  const recentSwingsL = swings.lows.slice(-6);
  const sh = recentSwingsH.length >= 2 ? [highs[recentSwingsH[recentSwingsH.length - 2]], highs[recentSwingsH[recentSwingsH.length - 1]]] : [];
  const sl = recentSwingsL.length >= 2 ? [lows[recentSwingsL[recentSwingsL.length - 2]], lows[recentSwingsL[recentSwingsL.length - 1]]] : [];

  if (sh.length === 2 && sl.length === 2) {
    const [hh1, hh2] = sh;
    const [hl1, hl2] = sl;
    if (hh2 > hh1 && hl2 > hl1) {
      out.trendStructure = 'UPTREND';
      out.patterns.push('HIGHER_HIGH', 'HIGHER_LOW');
    } else if (hh2 < hh1 && hl2 < hl1) {
      out.trendStructure = 'DOWNTREND';
      out.patterns.push('LOWER_HIGH', 'LOWER_LOW');
    } else if (hh2 <= hh1 * 1.001 && hl2 >= hl1 * 0.999) {
      out.trendStructure = 'RANGE';
      out.patterns.push('RANGE', 'CONSOLIDATION');
    } else {
      out.trendStructure = 'RANGE';
      out.patterns.push('CONSOLIDATION');
    }
  }

  // Breakout / breakdown vs recent range
  const lookback = Math.min(60, candles.length);
  const rangeHigh = Math.max(...highs.slice(-lookback, -1));
  const rangeLow = Math.min(...lows.slice(-lookback, -1));
  if (lastHigh > rangeHigh && closes[closes.length - 1] > rangeHigh) out.patterns.push('BREAKOUT');
  if (lastLow < rangeLow && closes[closes.length - 1] < rangeLow) out.patterns.push('BREAKDOWN');

  // Pullback within an uptrend / downtrend
  if (out.trendStructure === 'UPTREND' && closes[closes.length - 1] < closes[closes.length - 4]) out.patterns.push('PULLBACK');
  if (out.trendStructure === 'DOWNTREND' && closes[closes.length - 1] > closes[closes.length - 4]) out.patterns.push('PULLBACK');

  // Volatility expansion / contraction via ATR proxy
  const recentRange = (c: Candle): number => (c.high - c.low) / (c.close || 1);
  const nowVol = recentRange(candles[candles.length - 1]);
  const histVols = candles.slice(-30, -1).map(recentRange);
  const avgVol = histVols.reduce((a, b) => a + b, 0) / Math.max(1, histVols.length);
  if (avgVol > 0) {
    if (nowVol > avgVol * 1.5) out.patterns.push('VOLATILITY_EXPANSION');
    if (nowVol < avgVol * 0.6) out.patterns.push('VOLATILITY_CONTRACTION');
  }

  // Reversal signal: trend flip with momentum shift
  if (out.trendStructure === 'DOWNTREND' && closes[closes.length - 1] > emaOf(closes, 20)) out.patterns.push('REVERSAL');
  if (out.trendStructure === 'UPTREND' && closes[closes.length - 1] < emaOf(closes, 20)) out.patterns.push('REVERSAL');

  out.swingHigh = lastHigh;
  out.swingLow = lastLow;
  out.candlePatterns = detectCandlePatterns(candles);
  out.description = [
    `structure: ${out.trendStructure.toLowerCase()}`,
    out.patterns.join(', '),
    out.candlePatterns.length ? `candles: ${out.candlePatterns.join(', ')}` : '',
  ].filter(Boolean).join(' | ');
  return out;
}

function emaOf(values: number[], period: number): number {
  if (values.length < period) return values[values.length - 1];
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) prev = values[i] * k + prev * (1 - k);
  return prev;
}
