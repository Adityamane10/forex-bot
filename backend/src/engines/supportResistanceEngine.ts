/**
 * Support/resistance engine. Aggregates swing levels, pivots and previous
 * day/week high/low into nearest support/resistance with pip distances.
 * Entry rejections ("too close to S/R") are computed from these distances.
 */
import { Candle, Levels, Timeframe } from '@fx/shared';
import { getAsset, priceToPips } from '@fx/shared';
import { classicPivots, swingPoints } from '../math/indicators';

export interface SupportResistanceInput {
  candles: Candle[]; // timeframe for local levels (e.g. 1h)
  higherTfCandles: Candle[]; // for higher-timeframe levels (e.g. 4h/1D)
  dailyCandles: Candle[]; // for previous day/week levels
  symbol: string;
  currentPrice: number;
}

export function computeLevels(input: SupportResistanceInput): Levels {
  const { symbol, currentPrice } = input;
  const asset = getAsset(symbol);
  const support: number[] = [];
  const resistance: number[] = [];

  const addLevels = (candles: Candle[], strength: number, weight: number) => {
    if (candles.length < strength * 2 + 1) return;
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);
    const { highs: sh, lows: sl } = swingPoints(highs, lows, strength);
    const pushUnique = (arr: number[], v: number, w: number) => {
      // cluster levels within 0.15 * ATR-ish tolerance
      const tolerance = Math.max(asset.pipSize * 3, 0.00005 * (v || 1));
      for (const existing of arr) {
        if (Math.abs(existing - v) < tolerance) {
          // strengthen existing level by bumping (not stored) — keep simple: skip
          return;
        }
      }
      for (let i = 0; i < w; i++) arr.push(v);
    };
    for (const i of sh) pushUnique(resistance, highs[i], weight);
    for (const i of sl) pushUnique(support, lows[i], weight);
  };

  addLevels(input.candles, 3, 1);
  addLevels(input.higherTfCandles, 2, 2);

  let prevDayHigh: number | null = null;
  let prevDayLow: number | null = null;
  let prevWeekHigh: number | null = null;
  let prevWeekLow: number | null = null;

  // Daily levels must come from COMPLETED daily bars only — the live candle
  // buffer appends the in-progress day, and pivots/prev-day derived from a
  // partial bar drift all session for no market reason (live/backtest split).
  const completedDaily = input.dailyCandles.filter((c) => c.state === 'COMPLETED' && c.completed);
  const daily = completedDaily.length >= 1
    ? completedDaily
    : input.dailyCandles.slice(0, -1); // legacy buffers without state flags

  if (daily.length >= 1) {
    const prevDay = daily[daily.length - 1];
    prevDayHigh = prevDay.high;
    prevDayLow = prevDay.low;
    resistance.push(prevDayHigh);
    support.push(prevDayLow);
  }
  if (daily.length >= 5) {
    const weekCandles = daily.slice(-5);
    prevWeekHigh = Math.max(...weekCandles.map((c) => c.high));
    prevWeekLow = Math.min(...weekCandles.map((c) => c.low));
    resistance.push(prevWeekHigh);
    support.push(prevWeekLow);
  }

  // Pivot points from the most recent COMPLETED daily candle
  const lastDay = daily.length > 0 ? daily[daily.length - 1] : undefined;
  const pivot = lastDay ? classicPivots(lastDay.high, lastDay.low, lastDay.close).pivot : currentPrice;
  const { r1, s1 } = lastDay ? classicPivots(lastDay.high, lastDay.low, lastDay.close) : { r1: currentPrice, s1: currentPrice };
  resistance.push(r1);
  support.push(s1);

  // nearest levels below / above current price
  const below = support.filter((s) => s < currentPrice).sort((a, b) => b - a);
  const above = resistance.filter((r) => r > currentPrice).sort((a, b) => a - b);
  const nearestSupport = below.length ? below[0] : support.length ? Math.max(...support) : null;
  const nearestResistance = above.length ? above[0] : resistance.length ? Math.min(...resistance) : null;

  return {
    support: [...new Set(support)].sort((a, b) => b - a).slice(0, 6),
    resistance: [...new Set(resistance)].sort((a, b) => a - b).slice(0, 6),
    pivot: Number(pivot.toFixed(asset.pricePrecision)),
    prevDayHigh,
    prevDayLow,
    prevWeekHigh,
    prevWeekLow,
    distanceToSupportPips: nearestSupport !== null ? priceToPips(symbol, currentPrice - nearestSupport) : null,
    distanceToResistancePips: nearestResistance !== null ? priceToPips(symbol, nearestResistance - currentPrice) : null,
    nearestSupport,
    nearestResistance,
  };
}

/** Reject setups whose entry would sit too close to a strong level. */
export function entryTooCloseToLevel(symbol: string, entry: number, levels: Levels, minPipsFromLevel = 5): { tooClose: boolean; reason?: string } {
  const asset = getAsset(symbol);
  const tolerance = minPipsFromLevel * asset.pipSize;
  for (const s of levels.support) {
    if (entry >= s && entry - s < tolerance) return { tooClose: true, reason: `entry ${entry} within ${minPipsFromLevel} pips of support ${s}` };
  }
  for (const r of levels.resistance) {
    if (entry <= r && r - entry < tolerance) return { tooClose: true, reason: `entry ${entry} within ${minPipsFromLevel} pips of resistance ${r}` };
  }
  return { tooClose: false };
}

export function hasValidSlPlacement(sl: number, levels: Levels, symbol: string, direction: 'BUY' | 'SELL'): { valid: boolean; reason?: string } {
  const asset = getAsset(symbol);
  const tolerance = 3 * asset.pipSize;
  if (direction === 'BUY' && levels.nearestSupport !== null && sl >= levels.nearestSupport - tolerance) {
    return { valid: false, reason: 'SL above nearest support' };
  }
  if (direction === 'SELL' && levels.nearestResistance !== null && sl <= levels.nearestResistance + tolerance) {
    return { valid: false, reason: 'SL below nearest resistance' };
  }
  return { valid: true };
}
