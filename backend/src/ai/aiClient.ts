/**
 * HTTP client for the Python AI engine. Every call is wrapped so a down AI
 * engine degrades gracefully (health marked DOWN; signal engine responds
 * per policy — default: WAIT). Never fabricates predictions.
 */
import { MlPrediction, FeatureVector } from '@fx/shared';
import { config } from '../config';
import { logger } from '../core/logger';
import { METRICS } from '../ops/metrics';

export interface PredictRequest {
  symbol: string;
  timeframe: string;
  timestamp: number;
  features: Record<string, number>;
  useShadow?: boolean;
}

export interface TrainRequest {
  datasetId?: string;
  symbols: string[];
  timeframe: string;
  start: number;
  end: number;
  featureVersion: string;
  algorithm?: string;
  folds?: number;
  data?: Record<string, unknown[]>;
  /** Prebuilt feature rows from the backend's live feature engine —
   *  preferred over candles-only training (train/serve parity). */
  featureRows?: Record<string, Record<string, number>[]>;
}

export class AiClient {
  private lastError: string | null = null;

  constructor(private baseUrl = config.pythonAiUrl) {}

  async health(): Promise<{ ok: boolean; detail: string; latencyMs?: number }> {
    const t0 = Date.now();
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
      const latencyMs = Date.now() - t0;
      return { ok: res.ok, detail: res.ok ? 'ai engine online' : `HTTP ${res.status}`, latencyMs };
    } catch (err) {
      return { ok: false, detail: `unreachable: ${String(err)}`, latencyMs: Date.now() - t0 };
    }
  }

  async predict(req: PredictRequest): Promise<MlPrediction> {
    const t0 = Date.now();
    try {
      // § realtime measurement: every predict call records its latency so the
      // signal→AI leg is measured, never asserted.
      const res = await fetch(`${this.baseUrl}/predict`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`AI predict HTTP ${res.status}`);
      const json = (await res.json()) as MlPrediction;
      METRICS.aiPredictLatency().observe({ status: 'ok' }, Date.now() - t0);
      this.lastError = null;
      return json;
    } catch (err) {
      METRICS.aiPredictLatency().observe({ status: 'error' }, Date.now() - t0);
      this.lastError = String(err);
      logger.warn('ai predict failed', { err: String(err) });
      throw new Error(`AI engine unavailable (${String(err)})`);
    }
  }

  async train(req: TrainRequest): Promise<Record<string, unknown>> {
    try {
      const res = await fetch(`${this.baseUrl}/train`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
        signal: AbortSignal.timeout(600000),
      });
      if (!res.ok) throw new Error(`AI train HTTP ${res.status}`);
      return (await res.json()) as Record<string, unknown>;
    } catch (err) {
      this.lastError = String(err);
      throw new Error(`AI engine unavailable (${String(err)})`);
    }
  }

  async listModels(): Promise<{ local: unknown[]; champion: string | null; challenger: string | null }> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return { local: [], champion: null, challenger: null };
      const json = (await res.json()) as { local?: unknown[]; champion?: string | null; challenger?: string | null };
      return { local: json.local ?? [], champion: json.champion ?? null, challenger: json.challenger ?? null };
    } catch {
      return { local: [], champion: null, challenger: null };
    }
  }

  async promote(): Promise<{ promoted: boolean; reason: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/promote`, { method: 'POST', signal: AbortSignal.timeout(15000) });
      if (!res.ok) return { promoted: false, reason: `AI promote HTTP ${res.status}` };
      return (await res.json()) as { promoted: boolean; reason: string };
    } catch (err) {
      return { promoted: false, reason: `AI engine unavailable (${String(err)})` };
    }
  }

  async listDatasets(): Promise<unknown[]> {
    try {
      const res = await fetch(`${this.baseUrl}/datasets`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return [];
      return (await res.json()) as unknown[];
    } catch {
      return [];
    }
  }

  async driftStatus(): Promise<unknown> {
    try {
      const res = await fetch(`${this.baseUrl}/drift`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return { status: 'UNKNOWN' };
      return (await res.json()) as unknown;
    } catch {
      return { status: 'UNKNOWN' };
    }
  }

  /** Portfolio analytics (skfolio): covariance, min-variance/HRP weights,
   *  volatility, CVaR. Advisory only — never blocks trading. */
  async portfolioRisk(req: {
    symbols: string[];
    returns: Record<string, number[]>;
    weights?: Record<string, number>;
    annualizationFactor?: number;
  }): Promise<Record<string, unknown> | null> {
    try {
      const res = await fetch(`${this.baseUrl}/portfolio/risk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return null;
      return (await res.json()) as Record<string, unknown>;
    } catch (err) {
      logger.warn('ai portfolio analytics failed', { err: String(err) });
      return null;
    }
  }

  getLastError(): string | null {
    return this.lastError;
  }
}
