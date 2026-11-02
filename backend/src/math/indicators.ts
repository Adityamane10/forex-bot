/**
 * Pure technical indicator functions. Every function returns an array aligned
 * with the input (NaN during warm-up). No lookahead: each output value at index i
 * depends only on input values at indices <= i.
 */

export type Series = number[];

const NAN: Series = [];

export function sma(values: Series, period: number): Series {
  const out = new Array<number>(values.length).fill(NaN);
  if (values.length === 0 || period <= 0) return out;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (Number.isFinite(v)) {
      sum += v;
      count++;
    }
    if (i >= period) {
      const outV = values[i - period];
      if (Number.isFinite(outV)) {
        sum -= outV;
        count--;
      }
    }
    if (count === period) out[i] = sum / period;
  }
  return out;
}

export function ema(values: Series, period: number): Series {
  const out = new Array<number>(values.length).fill(NaN);
  if (values.length === 0 || period <= 0) return out;
  const k = 2 / (period + 1);
  let prev = NaN;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (Number.isNaN(prev)) {
      // seed with SMA of the first `period` values for a stable start
      if (i >= period - 1) {
        let sum = 0;
        for (let j = i - period + 1; j <= i; j++) sum += values[j];
        prev = sum / period;
        out[i] = prev;
      }
    } else {
      prev = v * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

export function rsi(values: Series, period = 14): Series {
  const out = new Array<number>(values.length).fill(NaN);
  if (values.length <= period) return out;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];
    if (change >= 0) avgGain += change;
    else avgLoss -= change;
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = rsiFromAverages(avgGain, avgLoss);
  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = rsiFromAverages(avgGain, avgLoss);
  }
  return out;
}

/** Wilder RSI from smoothed averages. A perfectly FLAT market (avgGain ===
 *  avgLoss === 0) is neutral 50 — returning 100 read as maximal bullishness
 *  and skewed every threshold downstream. */
function rsiFromAverages(avgGain: number, avgLoss: number): number {
  if (avgGain === 0 && avgLoss === 0) return 50;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

export interface MacdResult {
  line: Series;
  signal: Series;
  histogram: Series;
}

export function macd(values: Series, fast = 12, slow = 26, signalPeriod = 9): MacdResult {
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);
  const line = values.map((_, i) => (Number.isNaN(emaFast[i]) || Number.isNaN(emaSlow[i]) ? NaN : emaFast[i] - emaSlow[i]));
  const signal = ema(line, signalPeriod);
  const histogram = line.map((v, i) => (Number.isNaN(v) || Number.isNaN(signal[i]) ? NaN : v - signal[i]));
  return { line, signal, histogram };
}

export function stochastic(high: Series, low: Series, close: Series, kPeriod = 14, dPeriod = 3): { k: Series; d: Series } {
  const k = new Array<number>(close.length).fill(NaN);
  for (let i = kPeriod - 1; i < close.length; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      if (high[j] > hh) hh = high[j];
      if (low[j] < ll) ll = low[j];
    }
    k[i] = hh === ll ? 50 : ((close[i] - ll) / (hh - ll)) * 100;
  }
  const d = sma(k, dPeriod);
  return { k, d };
}

export function cci(high: Series, low: Series, close: Series, period = 20): Series {
  const out = new Array<number>(close.length).fill(NaN);
  const tp = close.map((c, i) => (high[i] + low[i] + c) / 3);
  const tpSma = sma(tp, period);
  for (let i = period - 1; i < close.length; i++) {
    const mean = tpSma[i];
    if (Number.isNaN(mean)) continue;
    let md = 0;
    for (let j = i - period + 1; j <= i; j++) md += Math.abs(tp[j] - mean);
    md /= period;
    out[i] = md === 0 ? 0 : (tp[i] - mean) / (0.015 * md);
  }
  return out;
}

export function roc(values: Series, period = 10): Series {
  const out = new Array<number>(values.length).fill(NaN);
  for (let i = period; i < values.length; i++) {
    const prev = values[i - period];
    out[i] = prev === 0 ? NaN : ((values[i] - prev) / prev) * 100;
  }
  return out;
}

export function momentum(values: Series, period = 10): Series {
  const out = new Array<number>(values.length).fill(NaN);
  for (let i = period; i < values.length; i++) out[i] = values[i] - values[i - period];
  return out;
}

export function williamsR(high: Series, low: Series, close: Series, period = 14): Series {
  const out = new Array<number>(close.length).fill(NaN);
  for (let i = period - 1; i < close.length; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (high[j] > hh) hh = high[j];
      if (low[j] < ll) ll = low[j];
    }
    out[i] = hh === ll ? -50 : ((hh - close[i]) / (hh - ll)) * -100;
  }
  return out;
}

export function atr(high: Series, low: Series, close: Series, period = 14): Series {
  const out = new Array<number>(close.length).fill(NaN);
  if (close.length <= 1) return out;
  const tr = new Array<number>(close.length).fill(NaN);
  for (let i = 1; i < close.length; i++) {
    const h = high[i];
    const l = low[i];
    const pc = close[i - 1];
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  // Wilder smoothing
  let prev = NaN;
  for (let i = 0; i < close.length; i++) {
    if (Number.isNaN(tr[i])) continue;
    if (Number.isNaN(prev)) {
      if (i < period) continue;
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) sum += tr[j];
      prev = sum / period;
    } else {
      prev = (prev * (period - 1) + tr[i]) / period;
    }
    out[i] = prev;
  }
  return out;
}

export interface BollingerResult {
  middle: Series;
  upper: Series;
  lower: Series;
  bandwidth: Series;
}

export function bollinger(values: Series, period = 20, stdDev = 2): BollingerResult {
  const middle = sma(values, period);
  const upper = new Array<number>(values.length).fill(NaN);
  const lower = new Array<number>(values.length).fill(NaN);
  const bandwidth = new Array<number>(values.length).fill(NaN);
  for (let i = period - 1; i < values.length; i++) {
    const m = middle[i];
    if (Number.isNaN(m)) continue;
    let sumSq = 0;
    for (let j = i - period + 1; j <= i; j++) sumSq += (values[j] - m) ** 2;
    const sd = Math.sqrt(sumSq / period);
    upper[i] = m + stdDev * sd;
    lower[i] = m - stdDev * sd;
    bandwidth[i] = m === 0 ? NaN : ((upper[i] - lower[i]) / m) * 100;
  }
  return { middle, upper, lower, bandwidth };
}

export interface KeltnerResult {
  middle: Series;
  upper: Series;
  lower: Series;
}

export function keltner(high: Series, low: Series, close: Series, emaPeriod = 20, atrPeriod = 10, mult = 2): KeltnerResult {
  const middle = ema(close, emaPeriod);
  const atrSeries = atr(high, low, close, atrPeriod);
  const upper = middle.map((m, i) => (Number.isNaN(m) || Number.isNaN(atrSeries[i]) ? NaN : m + mult * atrSeries[i]));
  const lower = middle.map((m, i) => (Number.isNaN(m) || Number.isNaN(atrSeries[i]) ? NaN : m - mult * atrSeries[i]));
  return { middle, upper, lower };
}

export interface AdxResult {
  adx: Series;
  plusDi: Series;
  minusDi: Series;
}

export function adx(high: Series, low: Series, close: Series, period = 14): AdxResult {
  const n = close.length;
  const plusDm = new Array<number>(n).fill(NaN);
  const minusDm = new Array<number>(n).fill(NaN);
  const tr = new Array<number>(n).fill(NaN);
  for (let i = 1; i < n; i++) {
    const up = high[i] - high[i - 1];
    const down = low[i - 1] - low[i];
    plusDm[i] = up > down && up > 0 ? up : 0;
    minusDm[i] = down > up && down > 0 ? down : 0;
    tr[i] = Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1]));
  }
  const atrS = atr(high, low, close, period);
  const plusDi = new Array<number>(n).fill(NaN);
  const minusDi = new Array<number>(n).fill(NaN);
  // Wilder-smoothed +DM/-DM
  let pDmSum = 0;
  let mDmSum = 0;
  for (let i = 1; i < n; i++) {
    if (i < period) {
      pDmSum += plusDm[i];
      mDmSum += minusDm[i];
      continue;
    }
    if (i === period) {
      pDmSum += plusDm[i];
      mDmSum += minusDm[i];
    } else {
      pDmSum = pDmSum - pDmSum / period + plusDm[i];
      mDmSum = mDmSum - mDmSum / period + minusDm[i];
    }
    const a = atrS[i];
    if (!Number.isNaN(a) && a > 0) {
      plusDi[i] = (pDmSum / period / a) * 100;
      minusDi[i] = (mDmSum / period / a) * 100;
    }
  }
  const dx = new Array<number>(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(plusDi[i]) || Number.isNaN(minusDi[i])) continue;
    const s = plusDi[i] + minusDi[i];
    dx[i] = s === 0 ? 0 : (Math.abs(plusDi[i] - minusDi[i]) / s) * 100;
  }
  // ADX = smoothed DX (Wilder), aligned to ATR index. The seed must skip NaN
  // DX values: seeding from a window containing one flat/zero-ATR bar
  // poisoned the recursion with NaN forever after.
  const adxOut = new Array<number>(n).fill(NaN);
  let firstIdx = -1;
  for (let i = 0; i < n; i++) {
    if (!Number.isNaN(dx[i])) {
      firstIdx = i;
      break;
    }
  }
  if (firstIdx >= 0) {
    // advance to a run of `period` CONSECUTIVE finite DX values
    let run = 0;
    let seedEnd = -1;
    for (let i = firstIdx; i < n; i++) {
      run = Number.isNaN(dx[i]) ? 0 : run + 1;
      if (run === period) { seedEnd = i; break; }
    }
    if (seedEnd >= 0) {
      const seedStart = seedEnd - period + 1;
      let sum = 0;
      for (let i = seedStart; i <= seedEnd; i++) sum += dx[i];
      let cur = sum / period;
      adxOut[seedEnd] = cur;
      for (let i = seedEnd + 1; i < n; i++) {
        cur = Number.isNaN(dx[i]) ? cur : (cur * (period - 1) + dx[i]) / period;
        adxOut[i] = cur;
      }
    }
  }
  return { adx: adxOut, plusDi, minusDi };
}

export interface SupertrendResult {
  line: Series;
  direction: Series; // 1 = up, -1 = down
}

export function supertrend(high: Series, low: Series, close: Series, period = 10, multiplier = 3): SupertrendResult {
  // Standard Supertrend: basic bands, final bands smoothed with lookback state,
  // trend flipped only on confirmed closes beyond the opposite final band.
  const n = close.length;
  const atrSeries = atr(high, low, close, period);
  const line = new Array<number>(n).fill(NaN);
  const direction = new Array<number>(n).fill(NaN);
  let prevDir = 1;
  let prevFinalUpper = NaN;
  let prevFinalLower = NaN;
  for (let i = 0; i < n; i++) {
    const a = atrSeries[i];
    if (Number.isNaN(a) || i === 0) continue;
    const hl2 = (high[i] + low[i]) / 2;
    const basicUpper = hl2 + multiplier * a;
    const basicLower = hl2 - multiplier * a;
    if (Number.isNaN(prevFinalUpper)) {
      // seed final bands with the first basic bands
      prevFinalUpper = basicUpper;
      prevFinalLower = basicLower;
      prevDir = close[i] >= hl2 ? 1 : -1;
      line[i] = prevDir === 1 ? prevFinalLower : prevFinalUpper;
      direction[i] = prevDir;
      continue;
    }
    const prevClose = close[i - 1];
    const finalUpper = basicUpper < prevFinalUpper || prevClose > prevFinalUpper ? basicUpper : prevFinalUpper;
    const finalLower = basicLower > prevFinalLower || prevClose < prevFinalLower ? basicLower : prevFinalLower;
    // Flip tests against the CURRENT final bands (Pine ta.supertrend
    // convention) — testing the previous bar's bands delayed flips and could
    // leave a band pulled through price unflipped.
    let dir = prevDir;
    if (close[i] > finalUpper) dir = 1;
    else if (close[i] < finalLower) dir = -1;
    line[i] = dir === 1 ? finalLower : finalUpper;
    direction[i] = dir;
    prevFinalUpper = finalUpper;
    prevFinalLower = finalLower;
    prevDir = dir;
  }
  return { line, direction };
}

export function obv(close: Series, volume: Series): Series {
  const out = new Array<number>(close.length).fill(NaN);
  let acc = 0;
  for (let i = 0; i < close.length; i++) {
    if (i === 0) {
      out[i] = 0;
      continue;
    }
    if (close[i] > close[i - 1]) acc += volume[i] || 0;
    else if (close[i] < close[i - 1]) acc -= volume[i] || 0;
    out[i] = acc;
  }
  return out;
}

export function standardDeviation(values: Series, period = 20): Series {
  const out = new Array<number>(values.length).fill(NaN);
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += values[j];
    const m = sum / period;
    let sumSq = 0;
    for (let j = i - period + 1; j <= i; j++) sumSq += (values[j] - m) ** 2;
    out[i] = Math.sqrt(sumSq / period);
  }
  return out;
}

/** Zig-zag style swing highs/lows. Returns indices of confirmed swings. */
export function swingPoints(high: Series, low: Series, strength = 3): { highs: number[]; lows: number[] } {
  const highs: number[] = [];
  const lows: number[] = [];
  for (let i = strength; i < high.length - strength; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - strength; j <= i + strength; j++) {
      if (high[j] > high[i]) isHigh = false;
      if (low[j] < low[i]) isLow = false;
    }
    if (isHigh) highs.push(i);
    if (isLow) lows.push(i);
  }
  return { highs, lows };
}

/** Classic pivot points from a single day (high/low/close). */
export function classicPivots(high: number, low: number, close: number): { pivot: number; r1: number; r2: number; r3: number; s1: number; s2: number; s3: number } {
  const p = (high + low + close) / 3;
  return {
    pivot: p,
    r1: 2 * p - low,
    r2: p + (high - low),
    r3: high + 2 * (p - low),
    s1: 2 * p - high,
    s2: p - (high - low),
    s3: low - 2 * (high - p),
  };
}

export function last<T>(arr: T[]): T | undefined {
  return arr.length ? arr[arr.length - 1] : undefined;
}

export function notNaN(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
