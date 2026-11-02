/**
 * Indian ML pipeline (spec §19). Separate from the Forex/Crypto feature
 * definitions — incompatible Forex features are NEVER fed into the Indian model.
 * The Indian prediction endpoint is /india/predict on the existing FastAPI
 * service; predictions are always honest about availability and confidence.
 */
import type { IndiaIndicatorValues, IndiaModelPrediction, IndiaTimeframe } from '@fx/shared';
import { config } from '../config';
import { logger } from '../core/logger';

export const INDIA_FEATURE_VERSION = 'india-features-v1';

/** Indian feature vector — built ONLY from Indian indicators/analysis.
 *  Feature names + normalization bounds MUST stay in sync with
 *  ai-engine/app/india_features.py (build_india_features). */
export function buildIndiaFeatures(
  indicators: IndiaIndicatorValues,
  context: { session: number; regime: number; spread: number; timestamp: number },
): Record<string, number> {
  const f = indicators;
  const n = (v: unknown, min: number, max: number): number => {
    const x = typeof v === 'number' ? v : 0;
    if (max === min) return 0;
    return Math.max(0, Math.min(1, (x - min) / (max - min)));
  };
  const close = (f.close as number) ?? 0;
  return {
    close: n(close, 1000, 30000),
    ema9minus20: n(f.ema9minus20, -200, 200),
    ema20minus50: n(f.ema20minus50, -300, 300),
    rsi14: n(f.rsi14, 0, 100),
    macdHistogram: n(f.macdHistogram, -50, 50),
    adx: n(f.adx, 0, 60),
    atrPct: n(f.atrPct, 0, 0.03),
    bbPosition: n(f.bbPosition, 0, 1),
    bbWidth: n(f.bbWidth, 0, 0.15),
    vwapPosition: n(f.vwapPosition, -0.03, 0.03),
    volumeRatio: n(f.volumeRatio, 0, 5),
    swingHighDistance: n((f.swingHigh as number) ? close - (f.swingHigh as number) : 0, -500, 500),
    swingLowDistance: n((f.swingLow as number) ? close - (f.swingLow as number) : 0, -500, 500),
    candleBody: n(f.candleBody, 0, 300),
    upperWick: n(f.candleUpperWick, 0, 300),
    lowerWick: n(f.candleLowerWick, 0, 300),
    trend: n(f.trend, -1, 1),
    volatility: n(f.volatility, 0, 2),
    dayRange: n(f.candleRange, 0, 1500),
    session: n(context.session, 0, 6),
    regime: n(context.regime, 0, 8),
    spread: n(context.spread, 0, 10),
    timestamp: n(context.timestamp % 86_400_000, 0, 86_400_000),
  };
}

export interface IndiaPredictRequest {
  instrumentToken: string;
  tradingSymbol: string;
  underlying: string;
  timeframe: IndiaTimeframe;
  timestamp: number;
  features: Record<string, number>;
}

export class IndiaPredictionClient {
  private baseUrl: string;

  constructor(baseUrl = config.pythonAiUrl) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  /**
   * Predict via the Indian model endpoints — V2 (stacking + meta-labeling)
   * first, V1 champion as fallback. Always honest about availability.
   *
   * The returned `probability` is ONLY meaningful when `available` is true;
   * offline predictions carry probability 0 and mlStatus OFFLINE so that no
   * caller can mistake a placeholder for a real conviction (spec §15 forbids
   * the old confidence=0.5 fallback that let trading proceed blind).
   */
  async predict(req: IndiaPredictRequest): Promise<IndiaModelPrediction> {
    const base: IndiaModelPrediction = {
      instrumentToken: req.instrumentToken,
      tradingSymbol: req.tradingSymbol,
      underlying: req.underlying,
      timeframe: req.timeframe,
      timestamp: req.timestamp,
      probability: 0,
      confidence: 0,
      modelVersion: 'india-none',
      featureVersion: INDIA_FEATURE_VERSION,
      horizon: 1,
      available: false,
      mlStatus: 'OFFLINE',
      error: 'no Indian model trained — train via the India ML pipeline before enabling ML-gated signals',
    };
    // V2 stacked+meta bundle. A challenger serving while no champion is
    // promoted reports mlStatus SHADOW: real probabilities, not yet production.
    try {
      const v2 = await this.postJson('/india/v2/predict', {
        symbol: req.instrumentToken,
        timeframe: req.timeframe,
        timestamp: req.timestamp,
        features: req.features,
      });
      if (v2 && v2.available) {
        return {
          ...base,
          probability: Number(v2.probability) || 0,
          confidence: Math.max(0, Math.min(1, Number(v2.confidence) || 0)),
          modelVersion: String(v2.modelVersion ?? 'india-v2-unknown'),
          horizon: Number(v2.horizon) || 1,
          available: true,
          mlStatus: v2.fallback ? 'SHADOW' : 'ONLINE',
          metaProbability: typeof v2.metaProbability === 'number' ? v2.metaProbability : null,
          metaThreshold: typeof v2.threshold === 'number' ? v2.threshold : null,
          filtered: Boolean(v2.filtered),
          error: undefined,
        };
      }
    } catch (err) {
      logger.debug('india: v2 prediction unavailable, falling back to v1', { err: String(err) });
    }

    // V1 single-model champion.
    try {
      const v1 = await this.postJson('/india/predict', {
        symbol: req.instrumentToken,
        timeframe: req.timeframe,
        timestamp: req.timestamp,
        features: req.features,
      });
      if (v1 && v1.available && !v1.error) {
        return {
          ...base,
          probability: Number(v1.probability) || 0,
          confidence: Math.max(0, Math.min(1, Number(v1.confidence) || 0)),
          modelVersion: String(v1.modelVersion ?? 'india-unknown'),
          available: true,
          mlStatus: 'ONLINE',
          filtered: false,
          error: undefined,
        };
      }
      if (v1 && v1.error) return { ...base, error: String(v1.error) };
      return { ...base, error: 'model unavailable' };
    } catch (err) {
      logger.warn('india: prediction failed', { err: String(err) });
      return base;
    }
  }

  private async postJson(path: string, body: unknown): Promise<Record<string, unknown> | null> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) return null;
      return (await res.json()) as Record<string, unknown>;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Health of the India prediction endpoints — V2 registry preferred. */
  async health(): Promise<{ available: boolean; detail: string; status: 'ONLINE' | 'SHADOW' | 'OFFLINE' }> {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      const res = await fetch(`${this.baseUrl}/health`, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) return { available: false, detail: `health endpoint ${res.status}`, status: 'OFFLINE' };
      const json = (await res.json()) as {
        india?: { available: boolean; modelVersion: string | null };
      };
      if (json.india?.available) {
        return { available: true, detail: `india model ${json.india.modelVersion}`, status: 'ONLINE' };
      }
      // V2 challenger may be servable in shadow even without a v1 champion.
      const v2 = await fetch(`${this.baseUrl}/india/v2/models`, { signal: ctrl.signal })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null) as { challenger?: string | null; champion?: string | null } | null;
      if (v2?.challenger || v2?.champion) {
        const mode = v2.champion ? 'ONLINE' : 'SHADOW';
        const which = v2.champion ?? v2.challenger;
        return { available: true, detail: `india v2 model ${which} (${mode.toLowerCase()})`, status: mode as 'ONLINE' | 'SHADOW' };
      }
      return { available: false, detail: 'india model not trained', status: 'OFFLINE' };
    } catch {
      return { available: false, detail: 'ai engine unreachable', status: 'OFFLINE' };
    }
  }
}