/**
 * Confluence indicators adopted from research of top open-source trading
 * systems (geraked/metatrader5 MQL5 Expert Advisors — MIT license —
 * specifically the CEZLSMA strategy family: Chandelier Exit + Zero-Lag SMA +
 * Williams Fractals, plus the LRCUTB linear-regression-candle EA).
 *
 * All functions are pure, aligned to the input series, and lookahead-free:
 * every output at index i depends only on inputs at indices <= i.
 */
import { atr, ema, sma } from './indicators';
import type { Series } from './indicators';

/** Highest value of `v` over the window ending at i (inclusive), NaN before warm-up. */
function rollingHighest(v: Series, period: number): Series {
  const out = new Array<number>(v.length).fill(NaN);
  for (let i = period - 1; i < v.length; i++) {
    let m = -Infinity;
    for (let j = i - period + 1; j <= i; j++) if (v[j] > m) m = v[j];
    out[i] = m;
  }
  return out;
}

/** Lowest value of `v` over the window ending at i (inclusive). */
function rollingLowest(v: Series, period: number): Series {
  const out = new Array<number>(v.length).fill(NaN);
  for (let i = period - 1; i < v.length; i++) {
    let m = Infinity;
    for (let j = i - period + 1; j <= i; j++) if (v[j] < m) m = v[j];
    out[i] = m;
  }
  return out;
}

/**
 * Chandelier Exit — trailing stop that hangs the ATR multiple off the highest
 * high (long) / lowest low (short) of the lookback window. In the CEZLSMA EA
 * this is THE exit engine; here it feeds the trailing-stop engine as an
 * alternative basis and the confluence score.
 */
export function chandelierExit(
  high: Series,
  low: Series,
  close: Series,
  period = 22,
  multiplier = 3,
): { long: Series; short: Series } {
  const a = atr(high, low, close, period);
  const hh = rollingHighest(high, period);
  const ll = rollingLowest(low, period);
  const long = new Array<number>(close.length).fill(NaN);
  const short = new Array<number>(close.length).fill(NaN);
  for (let i = 0; i < close.length; i++) {
    if (Number.isNaN(a[i]) || Number.isNaN(hh[i])) continue;
    long[i] = hh[i] - a[i] * multiplier;
    short[i] = ll[i] + a[i] * multiplier;
  }
  return { long, short };
}

/**
 * Zero-Lag SMA (ZLSMA) — an SMA of a de-lagged series: `2*close − EMA(close, lag)`
 * smoothed by an EMA, then carried into an SMA of the requested period. Tracks
 * price turns ~lag periods earlier than a plain SMA, which is why the CEZLSMA
 * EA pairs it with Chandelier Exit for trend-side confluence.
 */
export function zlsma(values: Series, period = 50): Series {
  const lag = Math.max(1, Math.round((period - 1) / 2));
  const e1 = ema(values, lag);
  const delagged = values.map((v, i) => (Number.isNaN(e1[i]) ? NaN : 2 * v - e1[i]));
  // EMA over the de-lagged series, treating the NaN warm-up as missing input.
  const cleaned = delagged.filter((v) => !Number.isNaN(v));
  const smoothed = ema(cleaned, period);
  const offset = delagged.length - cleaned.length;
  const out = new Array<number>(values.length).fill(NaN);
  for (let i = 0; i < cleaned.length; i++) out[i + offset] = smoothed[i];
  return out;
}

/** One Heikin-Ashi candle pair { open, close } at index i. */
export interface HeikinAshiPoint { open: number; close: number; high: number; low: number }

/**
 * Heikin-Ashi candles — smoothed OHLC that makes trend bars unambiguous
 * (hollow up-runs, no lower wicks). The CEZLSMA EA reads all its signals on
 * HA candles to filter noise; we expose the series for the confluence score
 * and potential chart mode.
 */
export function heikinAshi(open: Series, high: Series, low: Series, close: Series): { haOpen: Series; haClose: Series; haHigh: Series; haLow: Series } {
  const n = close.length;
  const haOpen = new Array<number>(n).fill(NaN);
  const haClose = new Array<number>(n).fill(NaN);
  const haHigh = new Array<number>(n).fill(NaN);
  const haLow = new Array<number>(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    haClose[i] = (open[i] + high[i] + low[i] + close[i]) / 4;
    if (i === 0) {
      haOpen[i] = (open[i] + close[i]) / 2;
    } else {
      haOpen[i] = (haOpen[i - 1] + haClose[i - 1]) / 2;
    }
    haHigh[i] = Math.max(high[i], haOpen[i], haClose[i]);
    haLow[i] = Math.min(low[i], haOpen[i], haClose[i]);
  }
  return { haOpen, haClose, haHigh, haLow };
}

/**
 * Williams Fractals — swing highs/lows confirmed after `depth` bars on each
 * side. NOTE on lookahead: a fractal at index i is only *confirmed* at
 * i+depth; callers must treat `fractalHigh[i]` as a level known from
 * bar i+depth onward (the return carries both the location and the value so
 * consumers can honor confirmation delay).
 */
export function williamsFractals(high: Series, low: Series, depth = 2): { fractalHigh: Series; fractalLow: Series } {
  const n = high.length;
  const fractalHigh = new Array<number>(n).fill(NaN);
  const fractalLow = new Array<number>(n).fill(NaN);
  for (let i = depth; i < n - depth; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - depth; j <= i + depth; j++) {
      if (j === i) continue;
      if (high[j] >= high[i]) isHigh = false;
      if (low[j] <= low[i]) isLow = false;
    }
    if (isHigh) fractalHigh[i] = high[i];
    if (isLow) fractalLow[i] = low[i];
  }
  return { fractalHigh, fractalLow };
}

/**
 * Linear Regression Candle — the "body" of the LRCUTB EA: the fitted value of
 * a linear regression over the last `period` closes. A close crossing its LR
 * line is the EA's trend trigger; we expose it for the confluence score.
 */
export function linearRegressionValue(values: Series, period = 25): Series {
  const out = new Array<number>(values.length).fill(NaN);
  for (let i = period - 1; i < values.length; i++) {
    // Regression of close on time over [i-period+1 .. i]
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    for (let j = 0; j < period; j++) {
      const y = values[i - period + 1 + j];
      sumX += j;
      sumY += y;
      sumXY += j * y;
      sumXX += j * j;
    }
    const den = period * sumXX - sumX * sumX;
    if (den === 0) continue;
    const slope = (period * sumXY - sumX * sumY) / den;
    const intercept = (sumY - slope * sumX) / period;
    out[i] = intercept + slope * (period - 1);
  }
  return out;
}

/** Convenience: simple rolling mean of the last `period` values (re-exported shape). */
export { sma };
