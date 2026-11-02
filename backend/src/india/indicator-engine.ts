/**
 * Indian indicator pipeline (spec §16). Indicators update ONLY from real market
 * data. An indicator registry maps indicator → inputs; every strategy declares
 * the indicators it requires. VWAP, ATR, ADX, RSI, MACD, BB and market-structure
 * series are computed with no look-ahead (output at bar i uses bars [0..i]).
 */
import type { IndiaCandle, IndiaIndicatorSnapshot, IndiaIndicatorValues, IndiaTimeframe } from '@fx/shared';
import { INDIA_CHANNELS, INDIA_REDIS_KEYS, StrategyName } from '@fx/shared';
import { ema, sma, rsi, macd, atr, adx, bollinger, swingPoints } from '../math/indicators';
import { Cache } from '../db/cache';
import { EventEmitter } from 'events';

export interface IndiaIndicatorInput {
  candles: IndiaCandle[];
}

export interface IndiaIndicatorDef {
  name: string;
  /** Series inputs this indicator is built from (registry metadata). */
  requires: string[];
  description: string;
}

/**
 * Indicator registry (spec §16): every indicator the Indian analysis engine can
 * produce, its inputs and a description. The computation itself lives in
 * computeIndiaIndicators — this registry documents dependencies and is used by
 * strategies to declare required indicators.
 */
export const INDIA_INDICATOR_REGISTRY: Record<string, IndiaIndicatorDef> = {
  ema9: { name: 'ema9', requires: ['close'], description: '9-period exponential moving average' },
  ema20: { name: 'ema20', requires: ['close'], description: '20-period exponential moving average' },
  ema50: { name: 'ema50', requires: ['close'], description: '50-period exponential moving average' },
  sma20: { name: 'sma20', requires: ['close'], description: '20-period simple moving average' },
  sma50: { name: 'sma50', requires: ['close'], description: '50-period simple moving average' },
  rsi14: { name: 'rsi14', requires: ['close'], description: '14-period relative strength index' },
  macdLine: { name: 'macdLine', requires: ['close'], description: 'MACD line (12,26,9)' },
  macdSignal: { name: 'macdSignal', requires: ['close'], description: 'MACD signal line' },
  macdHistogram: { name: 'macdHistogram', requires: ['close'], description: 'MACD histogram' },
  atr14: { name: 'atr14', requires: ['high', 'low', 'close'], description: '14-period average true range' },
  atrPct: { name: 'atrPct', requires: ['atr14', 'close'], description: 'ATR as % of price' },
  adx: { name: 'adx', requires: ['high', 'low', 'close'], description: 'average directional index' },
  bbUpper: { name: 'bbUpper', requires: ['close'], description: 'Bollinger upper band (20,2)' },
  bbLower: { name: 'bbLower', requires: ['close'], description: 'Bollinger lower band (20,2)' },
  bbWidth: { name: 'bbWidth', requires: ['close'], description: 'Bollinger bandwidth' },
  bbPosition: { name: 'bbPosition', requires: ['close'], description: 'price position within the bands 0..1' },
  vwap: { name: 'vwap', requires: ['high', 'low', 'close', 'volume'], description: 'session-anchored volume-weighted average price' },
  vwapPosition: { name: 'vwapPosition', requires: ['vwap', 'close'], description: 'price vs VWAP as %' },
  volumeRatio: { name: 'volumeRatio', requires: ['volume'], description: 'current volume vs 20-bar average' },
  swingHigh: { name: 'swingHigh', requires: ['high'], description: 'most recent swing high' },
  swingLow: { name: 'swingLow', requires: ['low'], description: 'most recent swing low' },
};

/**
 * Compute the full Indian indicator set for a candle series. Pure function,
 * deterministic, no look-ahead.
 */
function last<T>(arr: T[]): T | undefined {
  return arr[arr.length - 1];
}

function pct(a: number | null | undefined, b: number | null | undefined): number | null {
  if (a === null || a === undefined || b === null || b === undefined || b === 0) return null;
  return (a / b - 1) * 100;
}

export function computeIndiaIndicators(candles: IndiaCandle[]): IndiaIndicatorValues {
  const values: IndiaIndicatorValues = {};
  if (candles.length < 30) return values;

  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const volumes = candles.map((c) => c.volume);

  // The last close itself. It was never written here — every downstream consumer
  // read `values.close` and got undefined: the analysis snapshot carried
  // riskContext.close = 0, and the signal engine's first guard
  // (`close <= 0 → reject`) discarded EVERY instrument on EVERY scan, silently.
  // No signals, no trades, no rejection events — the whole Indian engine starved
  // behind one missing assignment while every indicator around it computed fine.
  values.close = closes[closes.length - 1] ?? null;

  const ema9 = ema(closes, 9);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const rsi14 = rsi(closes, 14);
  const macdSer = macd(closes, 12, 26, 9);
  const atr14 = atr(highs, lows, closes, 14);
  const adxSer = adx(highs, lows, closes, 14);
  const bb = bollinger(closes, 20, 2);

  values.ema9 = last(ema9) ?? null;
  values.ema20 = last(ema20) ?? null;
  values.ema50 = last(ema50) ?? null;
  values.sma20 = last(sma20) ?? null;
  values.sma50 = last(sma50) ?? null;
  values.ema9minus20 = values.ema9 !== null && values.ema20 !== null ? values.ema9 - values.ema20 : null;
  values.ema20minus50 = values.ema20 !== null && values.ema50 !== null ? values.ema20 - values.ema50 : null;
  values.rsi14 = last(rsi14) ?? null;
  values.macdLine = last(macdSer.line) ?? null;
  values.macdSignal = last(macdSer.signal) ?? null;
  values.macdHistogram = last(macdSer.histogram) ?? null;
  values.atr14 = last(atr14) ?? null;
  // ATR as a FRACTION of price (atr/close), matching ai-engine india_features.py
  // (`atr_pct = atr / close`) and the volatility thresholds below (>0.01 = ATR
  // larger than 1% of price). This used to go through `pct()` — the percent
  // CHANGE from close to atr, ≈ −99.95 for every instrument in every regime —
  // so `atrPct > 0.01` could never fire and HIGH volatility was unreachable.
  values.atrPct = values.atr14 !== null && closes[closes.length - 1] > 0
    ? values.atr14 / closes[closes.length - 1]
    : null;
  values.adx = last(adxSer.adx) ?? null;
  values.plusDi = last(adxSer.plusDi) ?? null;
  values.minusDi = last(adxSer.minusDi) ?? null;
  values.bbUpper = last(bb.upper) ?? null;
  values.bbMiddle = last(bb.middle) ?? null;
  values.bbLower = last(bb.lower) ?? null;
  values.bbWidth = values.bbUpper !== null && values.bbLower !== null && values.bbMiddle ? (values.bbUpper - values.bbLower) / values.bbMiddle : null;
  values.bbPosition = values.bbUpper !== null && values.bbLower !== null && values.bbUpper !== values.bbLower ? (closes[closes.length - 1] - values.bbLower) / (values.bbUpper - values.bbLower) : null;

  // Anchored VWAP (session-anchored): cum(TP·V)/cum(V) from the day's first bar.
  const dayStarts = new Set(candles.map((c) => c.openTime - (c.openTime % 86_400_000)));
  let cumPv = 0;
  let cumV = 0;
  let dayKey = -1;
  let vwapLast: number | null = null;
  for (const c of candles) {
    const dk = c.openTime - (c.openTime % 86_400_000);
    if (dk !== dayKey) {
      dayKey = dk;
      cumPv = 0;
      cumV = 0;
      void dayStarts;
    }
    cumPv += ((c.high + c.low + c.close) / 3) * c.volume;
    cumV += c.volume;
    vwapLast = cumV > 0 ? cumPv / cumV : null;
  }
  values.vwap = vwapLast;
  values.vwapPosition = vwapLast !== null ? pct(closes[closes.length - 1], vwapLast) : null;

  // Volume momentum vs the 20-bar average.
  //
  // A zero CURRENT bar with a non-zero average is not "no volume activity", it
  // is "no volume data for the live bar" — the LTP feed carries no per-tick
  // volume, so the in-progress bar accumulates zero no matter how hard the
  // contract trades. Reporting that as ratio 0 (instead of unknown) hardened
  // every volume-confirmed entry: BREAKOUT demanded ≥1.2× and read the missing
  // figure as a dead tape, so the strategy could never fire on this feed.
  const volAvg = sma20Avg(volumes, 20);
  const lastVol = volumes[volumes.length - 1] ?? 0;
  values.volumeRatio = volAvg > 0 && lastVol > 0 ? lastVol / volAvg : null;

  // Market structure: swing highs/lows via zig-zag on the recent window.
  const swing = swingPoints(highs.slice(-60), lows.slice(-60), 3);
  values.swingHigh = swing.highs.length ? highs.slice(-60)[swing.highs[swing.highs.length - 1]] : null;
  values.swingLow = swing.lows.length ? lows.slice(-60)[swing.lows[swing.lows.length - 1]] : null;

  // Trend structure from EMA stack + ADX (encoded numerically: 1 bullish,
  // -1 bearish, 0 neutral — the snapshot type only stores numeric values).
  const adxV = values.adx;
  if (values.ema9 !== null && values.ema20 !== null && values.ema50 !== null && adxV !== null) {
    if (values.ema9 > values.ema20 && values.ema20 > values.ema50 && adxV >= 20) values.trend = 1;
    else if (values.ema9 < values.ema20 && values.ema20 < values.ema50 && adxV >= 20) values.trend = -1;
    else values.trend = 0;
  }
  if (values.bbWidth !== null && values.atrPct !== null) {
    values.volatility = values.bbWidth > 0.06 || values.atrPct > 0.01 ? 2 : values.bbWidth < 0.03 ? 0 : 1;
  }

  // Candle anatomy of the last bar.
  const lastC = candles[candles.length - 1];
  values.candleRange = lastC.high - lastC.low;
  values.candleBody = Math.abs(lastC.close - lastC.open);
  values.candleUpperWick = lastC.high - Math.max(lastC.open, lastC.close);
  values.candleLowerWick = Math.min(lastC.open, lastC.close) - lastC.low;

  // Support/resistance from recent swing points.
  if (values.swingLow !== null) values.support = values.swingLow;
  if (values.swingHigh !== null) values.resistance = values.swingHigh;

  // Round + nullify.
  for (const k of Object.keys(values)) {
    const v = values[k];
    if (v === null || v === undefined) continue;
    if (typeof v === 'number' && Number.isFinite(v)) values[k] = Math.round(v * 1e6) / 1e6;
    else if (typeof v === 'number') values[k] = null;
  }
  return values;
}

function sma20Avg(arr: number[], period: number): number {
  if (arr.length < period) return 0;
  let sum = 0;
  for (let i = arr.length - period; i < arr.length; i++) sum += arr[i] ?? 0;
  return sum / period;
}

/** Chart series for the most common overlays. */
export function indiaChartSeries(candles: IndiaCandle[]): Record<string, Array<{ time: number; value: number }>> {
  const closes = candles.map((c) => c.close);
  const out: Record<string, Array<{ time: number; value: number }>> = {};
  const buildPrice = (name: string, ser: Array<number | null> | null) => {
    if (!ser) return;
    out[name] = ser.map((v, i) => ({ time: candles[i].openTime / 1000, value: v ?? 0 })).filter((p) => p.value > 0);
  };
  const buildOsc = (name: string, ser: Array<number | null> | null) => {
    if (!ser) return;
    out[name] = ser.map((v, i) => ({ time: candles[i].openTime / 1000, value: v ?? 0 })).filter((p) => Number.isFinite(p.value));
  };
  buildPrice('ema9', ema(closes, 9));
  buildPrice('ema20', ema(closes, 20));
  buildPrice('sma20', sma(closes, 20));
  const r = rsi(closes, 14);
  out['rsi14'] = r.map((v, i) => ({ time: candles[i].openTime / 1000, value: v ?? 0 }));
  const m = macd(closes, 12, 26, 9);
  // MACD is an oscillator centered at zero — filtering `value>0` erased every
  // negative point and hid bearish crossings.
  buildOsc('macdLine', m.line);
  buildOsc('macdSignal', m.signal);
  return out;
}

export class IndiaIndicatorEngine {
  private snapshots = new Map<string, IndiaIndicatorSnapshot>();
  private lastCompute = new Map<string, number>();

  constructor(private cache: Cache, private events: EventEmitter) {}

  /** Compute (throttled) + cache + emit the snapshot for token/timeframe. */
  async getSnapshot(token: string, candles: IndiaCandle[], timeframe: IndiaTimeframe, force = false): Promise<IndiaIndicatorSnapshot> {
    const key = `${token}:${timeframe}`;
    const now = Date.now();
    const last = this.lastCompute.get(key) ?? 0;
    if (!force && now - last < 1500 && this.snapshots.has(key)) return this.snapshots.get(key) as IndiaIndicatorSnapshot;
    this.lastCompute.set(key, now);

    const values = computeIndiaIndicators(candles);
    const snapshot: IndiaIndicatorSnapshot = {
      instrumentToken: token,
      tradingSymbol: candles[0]?.tradingSymbol ?? token,
      underlying: candles[0]?.underlying ?? '',
      timeframe,
      timestamp: now,
      values,
      series: indiaChartSeries(candles),
    };
    this.snapshots.set(key, snapshot);
    this.events.emit(INDIA_CHANNELS.indicatorUpdate, snapshot);
    this.cache
      .set(INDIA_REDIS_KEYS.indicator + key, JSON.stringify(snapshot), 60_000)
      .catch(() => undefined);
    return snapshot;
  }
}

/** Strategies declare the indicators they require (spec §16). */
export const STRATEGY_INDICATOR_REQUIREMENTS: Record<StrategyName, string[]> = {
  TREND_FOLLOWING: ['ema9', 'ema20', 'ema50', 'adx', 'atr14'],
  BREAKOUT: ['bbUpper', 'bbLower', 'swingHigh', 'swingLow', 'volumeRatio', 'atr14'],
  PULLBACK: ['ema20', 'ema50', 'rsi14', 'macdHistogram', 'swingHigh', 'swingLow'],
  MOMENTUM: ['rsi14', 'macdHistogram', 'adx', 'volumeRatio'],
  MEAN_REVERSION: ['bbPosition', 'rsi14', 'vwapPosition'],
  RANGE: ['bbWidth', 'atr14', 'rsi14'],
  RISK_CONTROLLED: ['atr14', 'adx', 'bbWidth', 'rsi14'],
};