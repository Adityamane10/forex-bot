/**
 * IndiaAnalysisEngine (spec §18). Turns the latest indicator snapshot + model
 * prediction + market/session state into a per-instrument analysis snapshot that
 * the signal engine and UI consume. The regime and session formulas MUST match
 * ai-engine/app/india_features.py so live analysis and training see identical
 * context.
 */
import type {
  IndiaAnalysisSnapshot,
  IndiaIndicatorSnapshot,
  IndiaMarketSessionInfo,
  IndiaModelPrediction,
  IndiaSegment,
  IndiaTimeframe,
  MarketRegime,
} from '@fx/shared';
import { IndiaPredictionClient, buildIndiaFeatures } from './ml';
import { IndiaInstrumentService } from './instruments';
import { IndiaCandleEngine } from './candle-engine';
import { IndiaIndicatorEngine } from './indicator-engine';
import { istDateKey } from './session';

export function indiaSessionIndex(epochMs: number): number {
  const ist = new Date(epochMs + 5.5 * 3600 * 1000);
  const h = ist.getUTCHours();
  if (h >= 9 && h <= 15) return h - 9;
  return 0;
}

export function indiaRegime(
  adx: number | null | undefined,
  ema9: number | null | undefined,
  ema50: number | null | undefined,
  volatility: number | null | undefined,
): number {
  // Categorical mapping shared with backtest contextFor: bull/bear by EMA
  // side × ADX strength, volatility overrides. The old numeric score
  // (adx/10 + emaSide + vol) indexed REGIME_NAMES arbitrarily — 0 mapped to
  // TRENDING_BULLISH and a strong uptrend mapped to NEWS_DRIVEN, inverting
  // strategy routing. Now both live and backtest agree on what a regime means.
  const vol = volatility ?? 1;
  if (vol >= 2) return 6; // HIGH_VOLATILITY
  if (vol <= 0) return 7; // LOW_VOLATILITY
  const bullish = ema9 != null && ema50 != null && ema9 > ema50;
  const bearish = ema9 != null && ema50 != null && ema9 < ema50;
  const strongTrend = adx != null && adx >= 25;
  if (strongTrend && bullish) return 0; // TRENDING_BULLISH
  if (strongTrend && bearish) return 1; // TRENDING_BEARISH
  if (strongTrend) return 3; // BREAKOUT
  if (adx != null && adx < 15) return 2; // RANGING
  if (bullish) return 0;
  if (bearish) return 1;
  return 10; // UNCERTAIN
}

const REGIME_NAMES: MarketRegime[] = [
  'TRENDING_BULLISH',
  'TRENDING_BEARISH',
  'RANGING',
  'BREAKOUT',
  'BREAKDOWN',
  'REVERSAL',
  'HIGH_VOLATILITY',
  'LOW_VOLATILITY',
  'NEWS_DRIVEN',
  'LIQUIDITY_STRESSED',
  'UNCERTAIN',
];

export interface IndiaAnalysisEngineOptions {
  instrumentService: IndiaInstrumentService;
  candleEngine: IndiaCandleEngine;
  indicatorEngine: IndiaIndicatorEngine;
  predictionClient?: IndiaPredictionClient;
  primaryTimeframe?: IndiaTimeframe;
}

export class IndiaAnalysisEngine {
  private instruments: IndiaInstrumentService;
  private candles: IndiaCandleEngine;
  private indicators: IndiaIndicatorEngine;
  private predictionClient: IndiaPredictionClient | null;
  private primaryTimeframe: IndiaTimeframe;
  private cache = new Map<string, { at: number; snap: IndiaAnalysisSnapshot }>();
  private static CACHE_TTL_MS = 4000;

  constructor(opts: IndiaAnalysisEngineOptions) {
    this.instruments = opts.instrumentService;
    this.candles = opts.candleEngine;
    this.indicators = opts.indicatorEngine;
    this.predictionClient = opts.predictionClient ?? null;
    this.primaryTimeframe = opts.primaryTimeframe ?? '5m';
  }

  async analyze(instrumentToken: string, session: IndiaMarketSessionInfo): Promise<IndiaAnalysisSnapshot> {
    const cached = this.cache.get(instrumentToken);
    const now = Date.now();
    if (cached && now - cached.at < IndiaAnalysisEngine.CACHE_TTL_MS) return cached.snap;

    const instrument = this.instruments.getByToken(instrumentToken);
    if (!instrument) {
      return this.basic('INSTRUMENT_NOT_FOUND', instrumentToken, session, now);
    }

    const candles = this.candles.getCandles(instrumentToken, this.primaryTimeframe, 500);
    if (candles.length < 30) {
      return this.basic('NO_DATA', instrumentToken, session, now);
    }

    const indicatorSnap = await this.indicators.getSnapshot(instrumentToken, candles, this.primaryTimeframe);
    const regimeNum = indiaRegime(
      indicatorSnap.values.adx,
      indicatorSnap.values.ema9,
      indicatorSnap.values.ema50,
      indicatorSnap.values.volatility,
    );
    const features = buildIndiaFeatures(indicatorSnap.values, {
      session: indiaSessionIndex(now),
      regime: regimeNum,
      spread: 0,
      timestamp: now,
    });

    let prediction: IndiaModelPrediction | null = null;
    if (this.predictionClient) {
      prediction = await this.predictionClient.predict({
        instrumentToken,
        tradingSymbol: instrument.tradingSymbol,
        underlying: instrument.underlying,
        timeframe: this.primaryTimeframe,
        timestamp: now,
        features,
      });
    }

    const snap = this.buildSnapshot(
      instrumentToken,
      instrument.tradingSymbol,
      instrument.underlying,
      instrument.segment,
      indicatorSnap,
      prediction,
      features,
      regimeNum,
      session,
      now,
    );
    this.cache.set(instrumentToken, { at: now, snap });
    return snap;
  }

  async analyzeAll(session: IndiaMarketSessionInfo): Promise<IndiaAnalysisSnapshot[]> {
    const tokens = this.instruments.executionInstruments().map((i) => i.instrumentToken);
    const results: IndiaAnalysisSnapshot[] = [];
    for (const t of tokens) results.push(await this.analyze(t, session));
    return results;
  }

  private buildSnapshot(
    instrumentToken: string,
    tradingSymbol: string,
    underlying: string,
    segment: IndiaSegment,
    indicatorSnap: IndiaIndicatorSnapshot,
    prediction: IndiaModelPrediction | null,
    features: Record<string, number>,
    regimeNum: number,
    session: IndiaMarketSessionInfo,
    now: number,
  ): IndiaAnalysisSnapshot {
    const v = indicatorSnap.values;
    const close = (v.close as number) ?? 0;
    const ema9 = v.ema9 as number | undefined;
    const ema20 = v.ema20 as number | undefined;
    const ema50 = v.ema50 as number | undefined;
    const rsi = v.rsi14 as number | undefined;
    const adx = v.adx as number | undefined;
    const bbPos = v.bbPosition as number | undefined;
    const vwapPos = v.vwapPosition as number | undefined;
    const swingHigh = v.swingHigh as number | undefined;
    const swingLow = v.swingLow as number | undefined;
    const volatilityNum = v.volatility as number | undefined;

    const support = swingLow ?? (v.support as number | undefined) ?? null;
    const resistance = swingHigh ?? (v.resistance as number | undefined) ?? null;

    const sessionIdx = indiaSessionIndex(now);
    const sessionPhase = sessionIdx === 0 ? 'CLOSED' : sessionIdx <= 1 ? 'OPEN' : sessionIdx <= 3 ? 'MID' : 'LATE';

    let trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
    if (v.trend === 1) trend = 'BULLISH';
    else if (v.trend === -1) trend = 'BEARISH';
    else if (rsi !== undefined && adx !== undefined && adx >= 20) trend = rsi > 55 ? 'BULLISH' : rsi < 45 ? 'BEARISH' : 'NEUTRAL';

    const strength = adx !== undefined ? Math.min(1, adx / 50) : 0;
    const momentum: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = trend === 'NEUTRAL' ? 'NEUTRAL' : trend;
    const volatility: 'HIGH' | 'MEDIUM' | 'LOW' =
      volatilityNum === undefined ? 'MEDIUM' : volatilityNum >= 2 ? 'HIGH' : volatilityNum <= 0 ? 'LOW' : 'MEDIUM';

    const structure: IndiaAnalysisSnapshot['structure'] = determineStructure(v, swingHigh, swingLow, trend);

    const higherHighs = swingHigh !== undefined && (v.previousSwingHigh as number | undefined) !== undefined
      ? (v.previousSwingHigh as number) < swingHigh : false;
    const lowerLows = swingLow !== undefined && (v.previousSwingLow as number | undefined) !== undefined
      ? (v.previousSwingLow as number) > swingLow : false;

    const confidence = Math.min(1, strength * 0.6 + (prediction?.confidence ?? 0) * 0.4);
    const signalQuality = Math.min(1, confidence * (session.marketOpen ? 1 : 0.5));

    const regime: MarketRegime = REGIME_NAMES[Math.min(REGIME_NAMES.length - 1, Math.max(0, Math.round(regimeNum)))] ?? 'UNCERTAIN';

    const mlProbe = prediction
      ? `ML ${(prediction.probability * 100).toFixed(0)}% (v${prediction.modelVersion})${prediction.available ? '' : ' offline'}`
      : 'ML offline';

    return {
      id: `${instrumentToken}:${this.primaryTimeframe}:${now}`,
      instrumentToken,
      tradingSymbol,
      underlying,
      segment,
      timeframe: this.primaryTimeframe,
      timestamp: now,
      marketTimestamp: indicatorSnap.timestamp,
      trend,
      regime,
      momentum,
      volatility,
      structure,
      swingHigh: swingHigh ?? null,
      swingLow: swingLow ?? null,
      higherHighs,
      higherLows: higherHighs, // symmetric heuristic from the same pair of points
      lowerHighs: lowerLows,
      lowerLows,
      support,
      resistance,
      signalQuality,
      confidence,
      featureSnapshot: features,
      prediction,
      riskContext: {
        close,
        atr: (v.atr14 as number | undefined) ?? 0,
        atrPct: (v.atrPct as number | undefined) ?? 0,
        bbPosition: bbPos ?? 0,
        vwapPosition: vwapPos ?? 0,
        rsi: rsi ?? 0,
        adx: adx ?? 0,
        macdHistogram: (v.macdHistogram as number | undefined) ?? 0,
        // Unknown volume (no printed volume in the live bar) must stay unknown.
        // Coercing it to 0 here flowed into the strategy layer as "the tape is
        // dead", which permanently vetoed every volume-confirmed entry.
        ...(v.volumeRatio == null ? {} : { volumeRatio: v.volumeRatio as number }),
        trend: (v.trend as number | undefined) ?? 0,
        volatility: volatilityNum ?? 1,
        regime: regimeNum,
        sessionPhase,
      },
      description: [
        `${trend} regime ${regime}`,
        `S ${support ?? '—'} / R ${resistance ?? '—'}`,
        `IST ${sessionPhase}`,
        session.marketOpen ? 'market open' : `market ${session.status.toLowerCase()}`,
      ].join(' · '),
      createdAt: now,
    };
  }

  private basic(
    state: 'INSTRUMENT_NOT_FOUND' | 'NO_DATA',
    instrumentToken: string,
    session: IndiaMarketSessionInfo,
    now: number,
  ): IndiaAnalysisSnapshot {
    const segment: IndiaSegment = 'NSE_INDEX';
    return {
      id: `${instrumentToken}:${this.primaryTimeframe}:${now}`,
      instrumentToken,
      tradingSymbol: instrumentToken,
      underlying: instrumentToken,
      segment,
      timeframe: this.primaryTimeframe,
      timestamp: now,
      marketTimestamp: now,
      trend: 'NEUTRAL',
      regime: 'UNCERTAIN',
      momentum: 'NEUTRAL',
      volatility: 'MEDIUM',
      structure: 'UNCLEAR',
      swingHigh: null,
      swingLow: null,
      higherHighs: false,
      higherLows: false,
      lowerHighs: false,
      lowerLows: false,
      support: null,
      resistance: null,
      signalQuality: 0,
      confidence: 0,
      featureSnapshot: {},
      prediction: null,
      riskContext: { state },
      description: `no data for ${instrumentToken} (${state.toLowerCase().replace(/_/g, ' ')})`,
      createdAt: now,
    };
  }
}

function determineStructure(
  v: Record<string, number | null>,
  swingHigh: number | undefined,
  swingLow: number | undefined,
  trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL',
): IndiaAnalysisSnapshot['structure'] {
  const adx = v.adx as number | undefined;
  const bbWidth = v.bbWidth as number | undefined;
  if (trend === 'BULLISH') return 'UPTREND';
  if (trend === 'BEARISH') return 'DOWNTREND';
  if (bbWidth !== undefined && bbWidth < 0.03) return 'RANGE';
  if (adx !== undefined && adx >= 25) return 'BREAKOUT';
  return 'UNCLEAR';
}

export const _unused = 0;