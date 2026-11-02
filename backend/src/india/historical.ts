/**
 * IndiaHistoricalService (spec §22). Back-fills and serves REAL broker history,
 * persists it, and seeds the live candle engine. History is always broker-sourced
 * (or already-persisted store data) — never fabricated.
 */
import type { IndiaCandle, IndiaTimeframe } from '@fx/shared';
import { INDIA_COLLECTIONS, INDIA_TIMEFRAME_MS } from '@fx/shared';
import { DataStore } from '../db/store';
import { Cache } from '../db/cache';
import { IndiaBrokerAdapter } from './brokers/types';
import { IndiaCandleEngine } from './candle-engine';
import { IndiaInstrumentService } from './instruments';
import { logger } from '../core/logger';

export class IndiaHistoricalService {
  constructor(
    private store: DataStore,
    private cache: Cache,
    private adapter: IndiaBrokerAdapter,
    private candles: IndiaCandleEngine,
    private instruments: IndiaInstrumentService,
  ) {}

  /** Fetch history for a token+timeframe, seed the candle engine and persist it. */
  async fetchAndSeed(
    instrumentToken: string,
    timeframe: IndiaTimeframe,
    from: number,
    to: number,
    limit = 2000,
  ): Promise<IndiaCandle[]> {
    const instrument = this.instruments.getByToken(instrumentToken);
    if (!instrument) throw new Error('instrument not found');
    const history = await this.adapter.getHistoricalCandles(instrumentToken, timeframe, from, to);
    const trimmed = history.slice(-limit);
    await this.candles.seed(instrumentToken, timeframe, trimmed);
    for (const c of trimmed) {
      await this.store.insertOne(INDIA_COLLECTIONS.candles, c).catch(() => undefined);
    }
    logger.info('india: history fetched', { token: instrumentToken, timeframe, bars: trimmed.length });
    return trimmed;
  }

  /** Load persisted candles from the store for a token/timeframe/range. */
  async loadStored(
    instrumentToken: string,
    timeframe: IndiaTimeframe,
    from: number,
    to: number,
  ): Promise<IndiaCandle[]> {
    const stored = await this.store.find<IndiaCandle & { _id?: unknown }>(
      INDIA_COLLECTIONS.candles,
      {
        instrumentToken,
        timeframe,
        openTime: { $gte: from, $lte: to },
      },
      { openTime: 1 },
      10_000,
    );
    return stored.map(({ _id, ...c }) => c);
  }

  /** Candle bucket size for a range (used by the backtester UI). */
  barsForRange(timeframe: IndiaTimeframe, from: number, to: number): number {
    return Math.max(0, Math.ceil((to - from) / INDIA_TIMEFRAME_MS[timeframe]));
  }
}