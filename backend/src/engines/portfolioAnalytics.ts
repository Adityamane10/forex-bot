/**
 * Portfolio analytics client (advisory). Pulls aligned closes from the candle
 * engine for every symbol with an open paper position, computes simple
 * returns, and asks the AI engine (skfolio) for covariance, optimized weights,
 * volatility and CVaR. Best-effort + cached: a down AI engine or thin history
 * NEVER blocks or alters trading decisions (the fill-time gates stay
 * synchronous and local).
 */
import { getAsset } from '@fx/shared';
import { AiClient } from '../ai/aiClient';
import { CandleEngine } from './candleEngine';
import { PaperTradingEngine } from './paperTradingEngine';
import { logger } from '../core/logger';

const TF_FACTOR: Record<string, number> = {
  '1m': 362880, '5m': 72576, '15m': 24192, '30m': 12096, '1h': 6048, '4h': 1512, '1D': 252,
};

export class PortfolioAnalytics {
  private cache: { at: number; payload: Record<string, unknown> | null } | null = null;

  constructor(
    private ai: AiClient,
    private candles: CandleEngine,
    private paper: PaperTradingEngine,
  ) {}

  async get(timeframe = '1h', ttlMs = 60_000): Promise<Record<string, unknown> | null> {
    if (this.cache && Date.now() - this.cache.at < ttlMs) return this.cache.payload;
    const payload = await this.compute(timeframe);
    this.cache = { at: Date.now(), payload };
    return payload;
  }

  private async compute(timeframe: string): Promise<Record<string, unknown> | null> {
    try {
      const positions = this.paper.getOpenPositions();
      if (positions.length === 0) {
        return { status: 'NO_POSITIONS', detail: 'open a position to get portfolio analytics' };
      }
      const symbols = [...new Set(positions.map((p) => p.symbol))];
      // Align closes by candle openTime across the involved symbols.
      const buckets = new Map<number, Map<string, number>>();
      for (const sym of symbols) {
        const list = this.candles.getCandles(sym, timeframe as never, 300);
        for (const c of list) {
          let row = buckets.get(c.openTime);
          if (!row) {
            row = new Map();
            buckets.set(c.openTime, row);
          }
          row.set(sym, c.close);
        }
      }
      const times = [...buckets.keys()].sort((a, b) => a - b);
      const returns: Record<string, number[]> = {};
      for (const sym of symbols) returns[sym] = [];
      for (const t of times) {
        const row = buckets.get(t)!;
        for (const sym of symbols) {
          const prev = times[times.indexOf(t) - 1];
          const prevRow = prev !== undefined ? buckets.get(prev)! : null;
          const close = row.get(sym);
          const prevClose = prevRow?.get(sym);
          if (close === undefined || prevClose === undefined || prevClose === 0) continue;
          returns[sym].push(close / prevClose - 1);
        }
      }
      const n = returns[symbols[0]].length;
      if (n < 20) {
        return { status: 'INSUFFICIENT_DATA', detail: `only ${n} aligned bars — need >= 20` };
      }
      // Drop rows where any involved symbol lacks data.
      const keep: number[] = [];
      for (let i = 0; i < n; i++) {
        if (symbols.every((s) => Number.isFinite(returns[s][i]))) keep.push(i);
      }
      if (keep.length < 10) {
        return { status: 'INSUFFICIENT_DATA', detail: 'symbol histories barely overlap' };
      }
      const aligned: Record<string, number[]> = {};
      for (const sym of symbols) aligned[sym] = keep.map((i) => returns[sym][i]);
      // Current portfolio weights = notional (lots x contract size x entry).
      const weights: Record<string, number> = {};
      for (const p of positions) {
        const asset = getAsset(p.symbol);
        weights[p.symbol] = (weights[p.symbol] ?? 0) + p.lots * asset.contractSize * p.entryPrice;
      }
      return await this.ai.portfolioRisk({
        symbols,
        returns: aligned,
        weights,
        annualizationFactor: TF_FACTOR[timeframe] ?? 6048,
      });
    } catch (err) {
      logger.warn('portfolio analytics compute failed', { err: String(err) });
      return null;
    }
  }
}
