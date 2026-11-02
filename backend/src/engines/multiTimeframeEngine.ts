/**
 * Multi-timeframe analysis. For each timeframe (1m..1D) derives trend,
 * momentum, volatility, EMA structure, RSI, MACD, ADX, ATR and price
 * structure from the indicator snapshot. Used as one component of the
 * final decision — never as the sole trigger.
 */
import { Candle, IndicatorSnapshot, MultiTimeframeAnalysis, Timeframe, TimeframeAnalysis } from '@fx/shared';
import { TIMEFRAMES } from '@fx/shared';
import { IndicatorEngine } from './indicatorEngine';
import { analyzePriceAction } from './priceActionEngine';
import { volatilityBand } from './regimeEngine';

function classifyTrend(values: IndicatorSnapshot['values']): TimeframeAnalysis['trend'] {
  const ema9 = values.ema9 ?? null;
  const ema20 = values.ema20 ?? null;
  const ema50 = values.ema50 ?? null;
  const close = values.close ?? null;
  const adxV = values.adx ?? null;
  if (close === null || ema9 === null || ema20 === null) return 'NEUTRAL';
  if (adxV !== null && adxV < 20) return 'NEUTRAL';
  if (close > ema9 && ema9 > ema20 && (ema50 === null || ema20 > ema50)) return 'BULLISH';
  if (close < ema9 && ema9 < ema20 && (ema50 === null || ema20 < ema50)) return 'BEARISH';
  return 'NEUTRAL';
}

function classifyMomentum(values: IndicatorSnapshot['values']): TimeframeAnalysis['momentum'] {
  const rsiV = values.rsi14 ?? null;
  const macdH = values.macdHistogram ?? null;
  const stochK = values.stochK ?? null;
  let score = 0;
  if (rsiV !== null) {
    if (rsiV > 55) score++;
    else if (rsiV < 45) score--;
  }
  if (macdH !== null) {
    if (macdH > 0) score++;
    else if (macdH < 0) score--;
  }
  if (stochK !== null) {
    if (stochK > 55) score++;
    else if (stochK < 45) score--;
  }
  return score >= 2 ? 'BULLISH' : score <= -2 ? 'BEARISH' : 'NEUTRAL';
}

function classifyVolatility(values: IndicatorSnapshot['values'], tf: Timeframe): TimeframeAnalysis['volatility'] {
  const atrPct = values.atrPct ?? null;
  if (atrPct === null) return 'MEDIUM';
  // Per-timeframe ATR% bands (shared with the regime engine) — fixed daily-
  // scale thresholds misclassified every FX timeframe as LOW volatility.
  const band = volatilityBand(tf);
  if (atrPct > band.high) return 'HIGH';
  if (atrPct < band.low) return 'LOW';
  return 'MEDIUM';
}

function classifyEmaStructure(values: IndicatorSnapshot['values']): TimeframeAnalysis['emaStructure'] {
  const ema9 = values.ema9 ?? null;
  const ema20 = values.ema20 ?? null;
  const ema50 = values.ema50 ?? null;
  if (ema9 === null || ema20 === null) return 'MIXED';
  if (ema9 > ema20 && (ema50 === null || ema20 > ema50)) return 'BULLISH';
  if (ema9 < ema20 && (ema50 === null || ema20 < ema50)) return 'BEARISH';
  return 'MIXED';
}

export class MultiTimeframeEngine {
  constructor(private indicatorEngine: IndicatorEngine) {}

  analyze(candlesByTf: Partial<Record<Timeframe, Candle[]>>, indicatorsByTf: Partial<Record<Timeframe, IndicatorSnapshot | null>>, symbol: string, timestamp: number): MultiTimeframeAnalysis {
    const timeframes: TimeframeAnalysis[] = [];
    let bullishCount = 0;
    let bearishCount = 0;
    for (const tf of TIMEFRAMES) {
      const candles = candlesByTf[tf];
      const snap = indicatorsByTf[tf];
      if (!candles || candles.length < 30 || !snap) continue;
      const pa = analyzePriceAction(candles, symbol, tf, timestamp);
      const trend = classifyTrend(snap.values);
      const momentum = classifyMomentum(snap.values);
      const volatility = classifyVolatility(snap.values, tf);
      const emaStructure = classifyEmaStructure(snap.values);
      const tfAnalysis: TimeframeAnalysis = {
        timeframe: tf,
        trend,
        momentum,
        volatility,
        emaStructure,
        rsi: snap.values.rsi14 ?? null,
        macd: {
          histogram: snap.values.macdHistogram ?? null,
          signal: snap.values.macdSignal ?? null,
          line: snap.values.macd ?? null,
        },
        adx: snap.values.adx ?? null,
        atr: snap.values.atr14 ?? null,
        priceStructure: pa.patterns[0] ?? 'CONSOLIDATION',
      };
      timeframes.push(tfAnalysis);
      if (trend === 'BULLISH') bullishCount++;
      if (trend === 'BEARISH') bearishCount++;
    }
    const consensus = bullishCount > bearishCount && bullishCount >= 2 ? 'BULLISH'
      : bearishCount > bullishCount && bearishCount >= 2 ? 'BEARISH' : 'MIXED';
    const top = timeframes.filter((t) => ['1D', '4h', '1h'].includes(t.timeframe));
    const descParts = top.map((t) => `${t.timeframe}=${t.trend}`);

    // ---- Higher vs lower timeframe agreement (spec §3) --------------------
    // 1D/4h/1h = macro/medium trend; 15m/5m/1m = setup/entry confirmation.
    // When the two groups trend in OPPOSITE directions the setup is
    // conflicted: confidence must fall (handled by the signal engine).
    const higher = timeframes.filter((t) => ['1D', '4h', '1h'].includes(t.timeframe));
    const lower = timeframes.filter((t) => ['15m', '5m', '1m'].includes(t.timeframe));
    const majority = (list: TimeframeAnalysis[]): 'BULLISH' | 'BEARISH' | 'NEUTRAL' => {
      const b = list.filter((t) => t.trend === 'BULLISH').length;
      const s = list.filter((t) => t.trend === 'BEARISH').length;
      return b > s ? 'BULLISH' : s > b ? 'BEARISH' : 'NEUTRAL';
    };
    const higherDir = majority(higher);
    const lowerDir = majority(lower);
    const conflict =
      higher.length > 0 && lower.length > 0 &&
      higherDir !== 'NEUTRAL' && lowerDir !== 'NEUTRAL' &&
      higherDir !== lowerDir;
    const alignment = timeframes.length > 0 ? (bullishCount - bearishCount) / timeframes.length : 0;

    return {
      symbol,
      timestamp,
      timeframes,
      consensus,
      alignment: Number(alignment.toFixed(2)),
      conflict,
      description: descParts.length ? descParts.join(' / ') : 'insufficient data',
    };
  }
}

export { classifyTrend, classifyMomentum, classifyVolatility, classifyEmaStructure };
