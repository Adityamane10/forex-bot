/**
 * Feature engine. Builds a versioned feature vector from indicator snapshots
 * plus context (spread, session, regime, event risk, news sentiment,
 * historical probability). Features are ONLY computed from data available at
 * the evaluation timestamp — no lookahead. Every feature records its version.
 */
import { FeatureVector, Timeframe } from '@fx/shared';
import { IndicatorSnapshot } from './indicatorEngine';
import { FxContext } from '../core/context';
import { logger } from '../core/logger';

/**
 * features-v4: replaces the raw absolute `close` with the scale-free
 * `closeVsEma200` (distance of price from its own 200-EMA, in ATR units).
 * The raw close was a symbol-identity feature: trees split on it (XAU/USD
 * ≈4312, USD/JPY ≈157, EUR/USD ≈1.17) and the model degenerated to a
 * per-symbol constant — freezing the AI gate. features-v3 adds cyclical time
 * encodings (hour/day-of-week sin-cos, michaeljf07/forex-predictor adoption)
 * and the XAU/USD 10-bar momentum bias (BaseMax/XAUUSD-LSTM adoption).
 * Models trained on older feature sets are refused at predict time.
 */
export const FEATURE_VERSION = 'features-v4';

export interface FeatureContextInput {
  symbol: string;
  timeframe: Timeframe;
  timestamp: number;
  indicators: IndicatorSnapshot | null;
  spreadPips: number;
  session: string;
  regime: string;
  eventRisk: number;
  newsSentiment: number; // -1..1 aggregated for symbol currencies
  historicalBuyProbability: number;
  historicalAvailable: boolean;
  dataQualityScore: number;
  /** XAU/USD 10-bar ROC in % (computed by the signal engine from completed
   *  gold candles). Absent/unavailable → neutral 0.5 encoding. */
  goldRoc10?: number;
  goldAvailable?: boolean;
}

export function buildFeatureVector(input: FeatureContextInput): FeatureVector {
  const v = input.indicators?.values ?? {};
  // ATR-relative scale: MACD and EMA spreads live in price units, so a fixed
  // absolute window saturates on volatile symbols (GBP/JPY ±0.15 histogram)
  // and vanishes on quiet ones (EUR/USD ±0.0003). Dividing by ATR14 puts
  // every symbol on one comparable scale; without ATR fall back to 0.2% of
  // price as a pseudo-ATR (deterministic, symbol-proportional).
  const atr = typeof v.atr14 === 'number' && v.atr14 > 0 ? v.atr14 : null;
  const closeAbs = typeof v.close === 'number' && v.close > 0 ? v.close : 0;
  const scale = atr ?? Math.max(1e-9, closeAbs * 0.002);
  const rel = (x: number | null | undefined, loAtr: number, hiAtr: number): number =>
    norm(typeof x === 'number' ? x / scale : 0, loAtr, hiAtr);
  const values: Record<string, number> = {
    // Scale-free trend position: (close − EMA200) / ATR — comparable across
    // every symbol, unlike the raw price it replaces (features-v4 fix).
    close: typeof v.ema200 === 'number' && v.ema200 > 0 && typeof v.close === 'number' && atr
      ? norm((v.close - v.ema200) / atr, -3, 3)
      : 0.5,
    rsi14: norm(v.rsi14, 0, 100),
    macdHistogram: rel(v.macdHistogram ?? 0, -0.5, 0.5),
    macdLine: rel(v.macd ?? 0, -1.5, 1.5),
    adx: norm(v.adx, 0, 60),
    atrPct: norm(v.atrPct ?? 0, 0, 1),
    bbPosition: norm(v.bbPosition ?? 0.5, 0, 1),
    ema9minus20: rel(v.ema9minus20 ?? 0, -1, 1),
    ema20minus50: rel(v.ema20minus50 ?? 0, -2, 2),
    ema50minus200: rel(v.ema50minus200 ?? 0, -4, 4),
    stochK: norm(v.stochK, 0, 100),
    williamsR14: norm(v.williamsR14 ?? -50, -100, 0),
    cci20: norm(v.cci20 ?? 0, -200, 200),
    roc10: norm(v.roc10 ?? 0, -2, 2),
    momentum10: rel(v.momentum10 ?? 0, -3, 3),
    bbWidth: norm(v.bbWidth ?? 0, 0, 10),
    supertrendDirection: v.supertrendDirection ?? 0,
    candleBody: norm(v.body ?? 0, 0, atr ?? 0.001),
    upperWick: norm(v.upperWick ?? 0, 0, atr ?? 0.001),
    lowerWick: norm(v.lowerWick ?? 0, 0, atr ?? 0.001),
    swingHighDistance: rel((v.swingHigh ?? 0) - (v.close ?? 0), -5, 5),
    swingLowDistance: rel((v.close ?? 0) - (v.swingLow ?? 0), -5, 5),
    spreadPips: norm(input.spreadPips, 0, 30),
    session: input.session === 'LONDON_NEW_YORK_OVERLAP' ? 1 : input.session === 'LONDON' || input.session === 'NEW_YORK' ? 0.7 : input.session === 'TOKYO' || input.session === 'SYDNEY' ? 0.4 : 0.2,
    regimeBullish: input.regime === 'TRENDING_BULLISH' ? 1 : 0,
    regimeBearish: input.regime === 'TRENDING_BEARISH' ? 1 : 0,
    regimeRange: input.regime === 'RANGING' || input.regime === 'LOW_VOLATILITY' ? 1 : 0,
    regimeBreakout: input.regime === 'BREAKOUT' ? 1 : 0,
    eventRisk: input.eventRisk,
    newsSentiment: input.newsSentiment,
    historicalBuyProbability: input.historicalAvailable ? input.historicalBuyProbability : 0.5,
    dataQualityScore: input.dataQualityScore,
    // Cyclical time (forex-predictor adoption): session effects are periodic,
    // so hour/day-of-week are encoded as sin/cos pairs — the model can learn
    // the midnight/weekend wraparound that a linear encoding cannot express.
    hourOfDaySin: cyclical(hourOfDay(input.timestamp), 24, 'sin'),
    hourOfDayCos: cyclical(hourOfDay(input.timestamp), 24, 'cos'),
    dayOfWeekSin: cyclical(dayOfWeek(input.timestamp), 7, 'sin'),
    dayOfWeekCos: cyclical(dayOfWeek(input.timestamp), 7, 'cos'),
    // XAU/USD momentum bias (XAUUSD-LSTM adoption): gold leads risk-on/-off;
    // normalized ±2% ROC → 0..1, neutral 0.5 when gold data is unavailable.
    goldMomentum: input.goldAvailable && typeof input.goldRoc10 === 'number' && Number.isFinite(input.goldRoc10)
      ? norm(input.goldRoc10, -2, 2)
      : 0.5,
  };

  return {
    symbol: input.symbol,
    timeframe: input.timeframe,
    timestamp: input.timestamp,
    featureVersion: FEATURE_VERSION,
    values,
  };
}

function norm(v: number | null | undefined, min: number, max: number): number {
  const val = typeof v === 'number' && Number.isFinite(v) ? v : 0;
  if (max === min) return 0;
  return Math.max(0, Math.min(1, (val - min) / (max - min)));
}

/** UTC fractional hour of the day (0..24) for cyclical encoding. */
function hourOfDay(ts: number): number {
  const d = new Date(ts);
  return d.getUTCHours() + d.getUTCMinutes() / 60;
}

/** UTC day of week (0=Sunday..6) for cyclical encoding. */
function dayOfWeek(ts: number): number {
  return new Date(ts).getUTCDay();
}

/** Encode a periodic quantity as sin/cos so the wraparound is learnable. */
function cyclical(value: number, period: number, which: 'sin' | 'cos'): number {
  const angle = (2 * Math.PI * value) / period;
  const raw = which === 'sin' ? Math.sin(angle) : Math.cos(angle);
  // map -1..1 → 0..1 so every feature keeps the [0,1] convention
  return (raw + 1) / 2;
}

export class FeatureEngine {
  constructor(private ctx: FxContext) {}

  async buildAndStore(input: FeatureContextInput): Promise<FeatureVector> {
    const vec = buildFeatureVector(input);
    try {
      await this.ctx.store.insertOne('features', vec);
    } catch (err) {
      logger.warn('feature persist failed', { err: String(err) });
    }
    return vec;
  }
}

export const featureNames = Object.keys(buildFeatureVector({
  symbol: 'EUR/USD',
  timeframe: '1h',
  timestamp: 0,
  indicators: null,
  spreadPips: 0,
  session: 'LONDON',
  regime: 'RANGING',
  eventRisk: 0,
  newsSentiment: 0,
  historicalBuyProbability: 0.5,
  historicalAvailable: false,
  dataQualityScore: 0.9,
}).values);
