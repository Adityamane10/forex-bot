/**
 * Indicator engine. Computes the full indicator set for a symbol/timeframe from
 * the candle buffer, caches the latest snapshot in the cache layer and emits
 * indicator.update events. All calculations are pure (see math/indicators).
 */
import { Candle, Timeframe } from '@fx/shared';
import {
  adx, atr, bollinger, cci, classicPivots, ema, keltner, macd, momentum,
  obv, roc, rsi, sma, stochastic, supertrend, swingPoints, williamsR,
} from '../math/indicators';
import { chandelierExit, linearRegressionValue, williamsFractals, zlsma } from '../math/confluence';
import { CandleEngine } from './candleEngine';
import { FxContext, CHANNELS } from '../core/context';
import { logger } from '../core/logger';

export interface IndicatorValues {
  [key: string]: number | null;
}

export interface IndicatorSnapshot {
  symbol: string;
  timeframe: Timeframe;
  timestamp: number;
  values: IndicatorValues;
  series?: Record<string, Array<{ time: number; value: number }>>;
}

export class IndicatorEngine {
  private lastComputed = new Map<string, number>();

  constructor(private ctx: FxContext, private candleEngine: CandleEngine) {}

  private key(symbol: string, tf: Timeframe): string {
    return `${symbol}:${tf}`;
  }

  /** Compute full indicator set from candles. Pure and unit-testable. */
  compute(candles: Candle[]): IndicatorValues {
    if (candles.length < 3) return {};
    const closes = candles.map((c) => c.close);
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);
    const volumes = candles.map((c) => c.volume);
    const lastIdx = candles.length - 1;
    const val = (arr: (number | null)[]): number | null => {
      const v = arr[lastIdx];
      return v === undefined || v === null || Number.isNaN(v) ? null : Number(v.toFixed(6));
    };
    const last = candles[lastIdx];

    const ema9 = ema(closes, 9);
    const ema20 = ema(closes, 20);
    const ema50 = ema(closes, 50);
    const ema100 = ema(closes, 100);
    const ema200 = ema(closes, 200);
    const rsi14 = rsi(closes, 14);
    const macd14 = macd(closes, 12, 26, 9);
    const stoch = stochastic(highs, lows, closes, 14, 3);
    const cci20 = cci(highs, lows, closes, 20);
    const roc10 = roc(closes, 10);
    const mom10 = momentum(closes, 10);
    const wr14 = williamsR(highs, lows, closes, 14);
    const atr14 = atr(highs, lows, closes, 14);
    const bb = bollinger(closes, 20, 2);
    const kc = keltner(highs, lows, closes, 20, 10, 2);
    const adx14 = adx(highs, lows, closes, 14);
    const st = supertrend(highs, lows, closes, 10, 3);
    const obvSeries = obv(closes, volumes);
    const swings = swingPoints(highs, lows, 3);
    const pivots = classicPivots(last.high, last.low, last.close);
    const sma50 = sma(closes, 50);
    const sma200 = sma(closes, 200);

    // ---- Confluence indicators (adopted: geraked/metatrader5 EA family) ----
    const chand = chandelierExit(highs, lows, closes, 22, 3);
    const zlsma50 = zlsma(closes, 50);
    const lrc25 = linearRegressionValue(closes, 25);
    const fractals = williamsFractals(highs, lows, 2);

    const bbPosition = val(bb.middle) && val(bb.upper) && val(bb.lower)
      ? (closes[lastIdx] - (bb.lower[lastIdx] ?? NaN)) / (((bb.upper[lastIdx] ?? NaN) - (bb.lower[lastIdx] ?? NaN)) || 1)
      : null;

    return {
      close: last.close,
      sma20: val(sma(closes, 20)),
      sma50: val(sma50),
      sma200: val(sma200),
      ema9: val(ema9),
      ema20: val(ema20),
      ema50: val(ema50),
      ema100: val(ema100),
      ema200: val(ema200),
      ema9minus20: val(ema9.map((v, i) => (Number.isNaN(v) || Number.isNaN(ema20[i]) ? NaN : v - ema20[i]))),
      ema20minus50: val(ema20.map((v, i) => (Number.isNaN(v) || Number.isNaN(ema50[i]) ? NaN : v - ema50[i]))),
      ema50minus200: val(ema50.map((v, i) => (Number.isNaN(v) || Number.isNaN(ema200[i]) ? NaN : v - ema200[i]))),
      rsi14: val(rsi14),
      macd: val(macd14.line),
      macdSignal: val(macd14.signal),
      macdHistogram: val(macd14.histogram),
      stochK: val(stoch.k),
      stochD: val(stoch.d),
      cci20: val(cci20),
      roc10: val(roc10),
      momentum10: val(mom10),
      williamsR14: val(wr14),
      atr14: val(atr14),
      atrPct: val(atr14.map((v) => (Number.isNaN(v) ? NaN : (v / closes[lastIdx]) * 100))),
      bbUpper: val(bb.upper),
      bbMiddle: val(bb.middle),
      bbLower: val(bb.lower),
      bbWidth: val(bb.bandwidth),
      bbPosition,
      kcUpper: val(kc.upper),
      kcMiddle: val(kc.middle),
      kcLower: val(kc.lower),
      adx: val(adx14.adx),
      plusDi: val(adx14.plusDi),
      minusDi: val(adx14.minusDi),
      supertrend: val(st.line),
      supertrendDirection: val(st.direction),
      obv: val(obvSeries),
      swingHigh: swings.highs.length ? highs[swings.highs[swings.highs.length - 1]] : null,
      swingLow: swings.lows.length ? lows[swings.lows[swings.lows.length - 1]] : null,
      pivot: Number(pivots.pivot.toFixed(6)),
      pivotR1: Number(pivots.r1.toFixed(6)),
      pivotS1: Number(pivots.s1.toFixed(6)),
      range: Number((last.high - last.low).toFixed(6)),
      body: Number(Math.abs(last.close - last.open).toFixed(6)),
      upperWick: Number((last.high - Math.max(last.open, last.close)).toFixed(6)),
      lowerWick: Number((Math.min(last.open, last.close) - last.low).toFixed(6)),
      // Confluence values: Chandelier trailing levels, ZLSMA, LR-candle body,
      // and the most recent CONFIRMED fractals (confirmation delay honored:
      // a fractal at index i is only used from bar i+2 onward, which the
      // search below enforces by scanning indices <= lastIdx - depth).
      chandelierLong: val(chand.long),
      chandelierShort: val(chand.short),
      zlsma50: val(zlsma50),
      lrc25: val(lrc25),
      fractalHigh: (() => {
        for (let i = lastIdx - 2; i >= 0; i--) {
          const f = fractals.fractalHigh[i];
          if (f !== undefined && !Number.isNaN(f)) return Number(f.toFixed(6));
        }
        return null;
      })(),
      fractalLow: (() => {
        for (let i = lastIdx - 2; i >= 0; i--) {
          const f = fractals.fractalLow[i];
          if (f !== undefined && !Number.isNaN(f)) return Number(f.toFixed(6));
        }
        return null;
      })(),
    };
  }

  async getSnapshot(symbol: string, tf: Timeframe, force = false): Promise<IndicatorSnapshot | null> {
    const k = this.key(symbol, tf);
    const candles = this.candleEngine.getCandles(symbol, tf, 260);
    if (candles.length < 3) return null;

    const openCandle = candles[candles.length - 1];
    const ts = openCandle.updatedAt;
    const last = this.lastComputed.get(k);
    if (!force && last !== undefined && ts - last < 1500) {
      // serve from cache when nothing materially changed
      const cached = await this.ctx.cache.get(`indicators:${k}`);
      if (cached) {
        try {
          return JSON.parse(cached) as IndicatorSnapshot;
        } catch {
          /* fall through to recompute */
        }
      }
    }

    const values = this.compute(candles);
    this.lastComputed.set(k, ts);
    const snapshot: IndicatorSnapshot = {
      symbol,
      timeframe: tf,
      timestamp: ts,
      values,
    };
    await this.ctx.cache.set(`indicators:${k}`, JSON.stringify(snapshot), 60_000);
    this.ctx.events.emit(CHANNELS.indicator, snapshot);
    return snapshot;
  }

  async warmAll(symbol: string, timeframes: Timeframe[]): Promise<void> {
    for (const tf of timeframes) {
      try {
        await this.getSnapshot(symbol, tf, true);
      } catch (err) {
        logger.warn('indicator warm failed', { symbol, tf, err: String(err) });
      }
    }
  }
}
