/**
 * Real-time candle engine. Converts ticks into 1m/5m/15m/30m/1h/4h/1D candles.
 * In-progress candles live in the cache (Redis in production, in-memory fallback);
 * completed candles are persisted to Mongo and appended to the in-memory buffer.
 * An incomplete candle is NEVER marked completed.
 */
import { Candle, Tick, Timeframe } from '@fx/shared';
import { TIMEFRAMES, TIMEFRAME_MS } from '@fx/shared';
import { FxContext, CHANNELS } from '../core/context';
import { logger } from '../core/logger';
import { config } from '../config';

interface CandleBuffer {
  candles: Candle[];
  open: Candle | null;
}

export class CandleEngine {
  private buffers = new Map<string, CandleBuffer>();
  private stats = { ticks: 0, candlesCompleted: 0, lateEvents: 0, duplicates: 0 };
  /** Last cache flush per symbol:tf — the tick path used to re-serialize and
   *  SET the whole buffer (×7 timeframes) on EVERY tick, saturating CPU and
   *  Redis bandwidth under streaming feeds. */
  private lastPersistAt = new Map<string, number>();
  private static readonly PERSIST_INTERVAL_MS = 5_000;
  /** Throttle OPEN-candle broadcasts: MT5 streams every 200ms×7 TF = 35 emits/candle; 400ms is live enough. */
  private lastOpenEmitAt = new Map<string, number>();
  private static readonly OPEN_EMIT_MS = 400;

  constructor(private ctx: FxContext) {
    this.ctx.events.on(CHANNELS.tick, (tick: Tick) => void this.onTick(tick));
  }

  private key(symbol: string, tf: Timeframe): string {
    return `${symbol}:${tf}`;
  }

  private buffer(symbol: string, tf: Timeframe): CandleBuffer {
    const k = this.key(symbol, tf);
    let b = this.buffers.get(k);
    if (!b) {
      b = { candles: [], open: null };
      this.buffers.set(k, b);
    }
    return b;
  }

  /** Seed the buffer from historical candles (e.g. on startup or backtest load).
   *  Bars still inside the current window are dropped: the live engine builds
   *  the current bar from real ticks and it must never be double-represented
   *  (duplicate timestamps break charts and downstream consumers). */
  async seed(symbol: string, tf: Timeframe, candles: Candle[]): Promise<void> {
    const tfMs = TIMEFRAME_MS[tf];
    const now = Date.now();
    const done = candles.filter((c) => c.openTime + tfMs <= now);
    const b = this.buffer(symbol, tf);
    b.candles = done;
    b.open = null;
    await this.persistBuffer(symbol, tf, true);
  }

  private async persistBuffer(symbol: string, tf: Timeframe, force = false): Promise<void> {
    const k = this.key(symbol, tf);
    const now = Date.now();
    if (!force && now - (this.lastPersistAt.get(k) ?? 0) < CandleEngine.PERSIST_INTERVAL_MS) return;
    this.lastPersistAt.set(k, now);
    const b = this.buffer(symbol, tf);
    await this.ctx.cache.set(`candles:${k}`, JSON.stringify({ candles: b.candles.slice(-200), open: b.open }), 3600_000);
  }

  private async persistCompleted(symbol: string, tf: Timeframe, candle: Candle): Promise<void> {
    try {
      await this.ctx.store.insertOne('candles', candle);
    } catch (err) {
      logger.warn('candle persist failed', { err: String(err) });
    }
  }

  /**
   * Deep history ingest: bulk-upsert MT5-exported candles into the Mongo
   * `candles` collection (keyed by symbol+timeframe+openTime). This is the
   * training-data backbone — Mongo used to hold only bars completed since the
   * backend last ran (40–65 bars), far too few to train a real model on.
   * Idempotent: re-running an export never duplicates rows.
   */
  async ingestHistory(symbol: string, tf: Timeframe, candles: Candle[]): Promise<number> {
    const tfMs = TIMEFRAME_MS[tf];
    const now = Date.now();
    const done = candles.filter((c) => c.openTime + tfMs <= now && Number.isFinite(c.close));
    if (!done.length) return 0;
    try {
      const count = await this.ctx.store.bulkUpsert('candles', done, ['symbol', 'timeframe', 'openTime']);
      // Warm the in-memory buffer so charts/signals immediately see deep
      // history without waiting for live closes to accumulate.
      const b = this.buffer(symbol, tf);
      const byTime = new Map(b.candles.map((c) => [c.openTime, c]));
      for (const c of done) byTime.set(c.openTime, c);
      const merged = [...byTime.values()].sort((a, z) => a.openTime - z.openTime);
      if (merged.length > config.maxCandlesInMemory) merged.splice(0, merged.length - config.maxCandlesInMemory);
      b.candles = merged;
      await this.persistBuffer(symbol, tf, true);
      return count;
    } catch (err) {
      logger.warn('history ingest failed', { symbol, tf, err: String(err) });
      return 0;
    }
  }

  async onTick(tick: Tick): Promise<void> {
    this.stats.ticks++;
    for (const tf of TIMEFRAMES) {
      const tfMs = TIMEFRAME_MS[tf];
      const openTime = Math.floor(tick.timestamp / tfMs) * tfMs;
      const b = this.buffer(tick.symbol, tf);

      if (!b.open) {
        b.open = {
          symbol: tick.symbol,
          timeframe: tf,
          open: tick.mid,
          high: tick.mid,
          low: tick.mid,
          close: tick.mid,
          volume: 1,
          openTime,
          closeTime: openTime + tfMs,
          state: 'OPEN',
          completed: false,
          updatedAt: tick.timestamp,
        };
        continue;
      }

      if (openTime < b.open.openTime) {
        // late event for an already-closed window: update the persisted candle only if it matches
        this.stats.lateEvents++;
        continue;
      }

      if (openTime === b.open.openTime) {
        if (b.open.updatedAt === tick.timestamp) {
          this.stats.duplicates++;
          continue;
        }
        b.open.high = Math.max(b.open.high, tick.mid);
        b.open.low = Math.min(b.open.low, tick.mid);
        b.open.close = tick.mid;
        b.open.volume += 1;
        b.open.updatedAt = tick.timestamp;
        this.maybeEmitOpen(tick.symbol, tf, b.open);
      } else {
        // close current candle, persist, open the new one
        const completed: Candle = { ...b.open, state: 'COMPLETED', completed: true, updatedAt: b.open.closeTime };
        b.candles.push(completed);
        if (b.candles.length > config.maxCandlesInMemory) b.candles.shift();
        void this.persistCompleted(tick.symbol, tf, completed);
        this.stats.candlesCompleted++;
        this.ctx.events.emit(CHANNELS.candle, completed);
        b.open = {
          symbol: tick.symbol,
          timeframe: tf,
          open: tick.mid,
          high: tick.mid,
          low: tick.mid,
          close: tick.mid,
          volume: 1,
          openTime,
          closeTime: openTime + tfMs,
          state: 'OPEN',
          completed: false,
          updatedAt: tick.timestamp,
        };
      }
      await this.persistBuffer(tick.symbol, tf);    }
  }

  private maybeEmitOpen(symbol: string, tf: Timeframe, open: Candle): void {
    const k = this.key(symbol, tf);
    const now = Date.now();
    if (now - (this.lastOpenEmitAt.get(k) ?? 0) < CandleEngine.OPEN_EMIT_MS) return;
    this.lastOpenEmitAt.set(k, now);
    this.ctx.events.emit(CHANNELS.candle, { ...open });
  }

  /** Current candle (may be incomplete) plus completed history.
   *  Defensively dedupes: if the open bar shares its window with the last
   *  completed bar (e.g. a seed raced a live tick), the live bar wins. */
  getCandles(symbol: string, tf: Timeframe, limit = 500): Candle[] {
    const b = this.buffer(symbol, tf);
    let out = b.candles;
    if (b.open) {
      const last = out[out.length - 1];
      if (last && last.openTime === b.open.openTime) {
        out = [...out.slice(0, -1), b.open];
      } else {
        out = [...out, b.open];
      }
    }
    // NaN/garbage limits must degrade to the default, not `slice(-NaN)` →
    // the FULL buffer (an unbounded payload on a public route).
    const lim = Number.isFinite(limit) && limit > 0 ? limit : 500;
    return out.slice(-lim);
  }

  getOpenCandle(symbol: string, tf: Timeframe): Candle | null {
    return this.buffer(symbol, tf).open;
  }

  /** Completed candles only. */
  getCompletedCandles(symbol: string, tf: Timeframe, limit = 500): Candle[] {
    return this.buffer(symbol, tf).candles.slice(-limit);
  }

  /**
   * Resynchronization after a disconnect/missed window (spec §5): if the
   * newest closed candle is older than the feed should have produced, fetch
   * the missed history from the provider and merge — filling gaps instead of
   * leaving holes that corrupt indicators. Never fabricates bars; the
   * still-current window is left to the live tick builder.
   * @returns number of candles back-filled
   */
  async resyncMissing(symbol: string, tf: Timeframe): Promise<number> {
    const b = this.buffer(symbol, tf);
    const tfMs = TIMEFRAME_MS[tf];
    const now = Date.now();
    const lastClosed = b.candles[b.candles.length - 1];
    const newest = Math.max(lastClosed?.openTime ?? 0, b.open?.openTime ?? 0);
    if (newest === 0) return 0; // nothing seeded — startup preload handles that
    const expected = now - tfMs * 2; // the latest closed bar that should exist
    if (newest >= expected) return 0; // healthy — nothing to fetch
    let history: Candle[] = [];
    try {
      history = await this.ctx.providers.marketData.getHistoricalCandles(symbol, tf, newest + tfMs, now);
    } catch (err) {
      logger.warn('resync fetch failed', { symbol, timeframe: tf, err: String(err) });
      return 0;
    }
    if (!history.length) return 0;
    const existing = new Set(b.candles.map((c) => c.openTime));
    let added = 0;
    for (const c of history) {
      if (existing.has(c.openTime)) continue;
      if (c.openTime + tfMs > now) continue; // current window is built live
      b.candles.push(c);
      existing.add(c.openTime);
      added++;
      void this.persistCompleted(symbol, tf, c);
    }
    if (added > 0) {
      b.candles.sort((a, c) => a.openTime - c.openTime);
      if (b.candles.length > config.maxCandlesInMemory) b.candles.splice(0, b.candles.length - config.maxCandlesInMemory);
      await this.persistBuffer(symbol, tf, true);
      logger.info('candle resync back-filled', { symbol, timeframe: tf, added });
    }
    return added;
  }

  statsSummary(): Record<string, unknown> {
    return { ...this.stats };
  }
}
