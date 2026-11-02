/**
 * IndiaCandleEngine (spec §8, §10, §17). Builds candles from real broker ticks
 * with correct exchange-timeframe boundaries. Candles NEVER advance via timers
 * after market close — a tick is required to open/update a bar.
 */
import type { IndiaCandle, IndiaTick, IndiaTimeframe } from '@fx/shared';
import { INDIA_TIMEFRAMES, INDIA_TIMEFRAME_MS, INDIA_CHANNELS, INDIA_COLLECTIONS, INDIA_REDIS_KEYS, indiaBucketStart } from '@fx/shared';
import { DataStore } from '../db/store';
import { Cache } from '../db/cache';
import { EventEmitter } from 'events';
import { indiaConfig } from './config';
import { IndiaInstrumentService } from './instruments';
import { IndiaMarketSessionService } from './session';

/**
 * Bars retained per token/timeframe — the single bound on buffer depth.
 *
 * It used to be five different numbers. `seed` kept 5000, but `closeBar` spliced
 * back to 2000, `resyncMissing` sliced to 2000, `getCandles` defaulted to 2000, and
 * two read-merge-seed round-trips in `market-feed.ts` asked for 2000. So the 90-day
 * startup seed survived exactly until the first live bar closed, and then 3000 bars
 * of it were gone — on 1m, most of the history the indicators were ever given,
 * discarded by a number nobody had reason to look at.
 *
 * Exported so that a caller which reads a buffer, merges into it and seeds it back
 * cannot truncate the write it is about to make.
 */
export const INDIA_CANDLE_BUFFER_MAX = 5000;

export class IndiaCandleEngine {
  private buffers = new Map<string, IndiaCandle[]>(); // key: token:tf
  private openCandles = new Map<string, IndiaCandle>();
  private ticksSeen = 0;
  private candlesCompleted = 0;
  private lateEvents = 0;
  private duplicates = 0;

  constructor(
    private store: DataStore,
    private cache: Cache,
    private events: EventEmitter,
    private instruments: IndiaInstrumentService,
    private session: IndiaMarketSessionService,
  ) {}

  private key(token: string, tf: IndiaTimeframe): string {
    return `${token}:${tf}`;
  }

  onTick(tick: IndiaTick): void {
    this.ticksSeen += 1;
    const instr = this.instruments.getByToken(tick.instrumentToken);
    if (!instr) return;
    // A tick from outside a trading session may not open or extend a bar.
    //
    // The file header promises bars never advance on a timer after the close, and the
    // websocket keeps that promise for free because it goes quiet. The REST last-price
    // fallback does not: `getLtpBatch` stamps every tick with `Date.now()` rather than an
    // exchange time, so polling a shut market yields a fresh timestamp carrying Friday's
    // price — and this loop would faithfully open a Sunday-evening bucket for it and emit
    // it as a live bar. Nothing downstream could tell that bar from a real one.
    //
    // Returning here still leaves the tick its real job: the feed has already written it
    // to the tick book and emitted `india:tick` by this point, so the UI gets its last
    // traded price and its "as of last close" caption. What it does not get is a candle
    // that the exchange would not recognise. Holiday-aware, because a holiday is exactly
    // when a wall-clock timestamp looks most like a trading one.
    if (!this.session.isTradingTime(tick.marketTimestamp)) return;
    for (const tf of INDIA_TIMEFRAMES) {
      // Anchored to the session open, not to the epoch: see `indiaBucketStart`.
      // On 30m and 1h the epoch grid disagreed with the broker's own bars, and the
      // id embeds openTime, so the two never deduplicated against each other.
      const openTime = indiaBucketStart(tick.marketTimestamp, tf);
      const k = this.key(tick.instrumentToken, tf);
      const open = this.openCandles.get(k);

      if (!open) {
        this.openCandles.set(
          k,
          this.makeCandle(tick, instr, tf, openTime, false),
        );
        continue;
      }
      if (openTime < open.openTime) {
        // Tick belongs to an earlier window: stale/late event, never fabricate.
        this.lateEvents += 1;
        continue;
      }
      if (openTime === open.openTime) {
        // Same window: duplicate detection then in-place update.
        if (open.updatedAt === tick.marketTimestamp) {
          this.duplicates += 1;
          continue;
        }
        open.high = Math.max(open.high, tick.ltp);
        open.low = Math.min(open.low, tick.ltp);
        open.close = tick.ltp;
        open.volume += tick.volume ?? 0;
        if (tick.openInterest !== null) open.openInterest = tick.openInterest;
        open.updatedAt = tick.marketTimestamp;
        // Emit the live open candle so the frontend chart updates in real-time
        this.events.emit(INDIA_CHANNELS.candle, open);
        continue;
      }
      // New window: close the current bar and open the next.
      const completed = { ...open, state: 'COMPLETED' as const, completed: true, closeTime: open.closeTime, updatedAt: open.closeTime };
      this.closeBar(tick, instr, tf, completed, openTime);
    }
  }

  private makeCandle(tick: IndiaTick, instr: NonNullable<ReturnType<IndiaInstrumentService['getByToken']>>, tf: IndiaTimeframe, openTime: number, completed: boolean): IndiaCandle {
    const tfMs = INDIA_TIMEFRAME_MS[tf];
    return {
      id: `${tick.instrumentToken}:${tf}:${openTime}`,
      exchange: instr.exchange,
      segment: instr.segment,
      instrumentToken: tick.instrumentToken,
      tradingSymbol: instr.tradingSymbol,
      underlying: instr.underlying,
      timeframe: tf,
      open: tick.ltp,
      high: tick.ltp,
      low: tick.ltp,
      close: tick.ltp,
      volume: tick.volume ?? 0,
      openInterest: tick.openInterest,
      openTime,
      closeTime: openTime + tfMs,
      state: completed ? 'COMPLETED' : 'OPEN',
      completed,
      updatedAt: tick.marketTimestamp,
    };
  }

  private async closeBar(tick: IndiaTick, instr: NonNullable<ReturnType<IndiaInstrumentService['getByToken']>>, tf: IndiaTimeframe, completed: IndiaCandle, nextOpenTime: number): Promise<void> {
    const k = this.key(tick.instrumentToken, tf);
    const buf = this.buffers.get(k) ?? [];
    buf.push(completed);
    if (buf.length > INDIA_CANDLE_BUFFER_MAX) buf.splice(0, buf.length - INDIA_CANDLE_BUFFER_MAX);
    this.buffers.set(k, buf);
    this.candlesCompleted += 1;
    this.openCandles.set(k, this.makeCandle(tick, instr, tf, nextOpenTime, false));
    this.events.emit(INDIA_CHANNELS.candle, completed);
    this.cache
      .set(INDIA_REDIS_KEYS.candle + k, JSON.stringify({ open: this.openCandles.get(k), completed: buf }), indiaConfig.candleCacheTtlMs)
      .catch(() => undefined);
    void this.store.insertOne(INDIA_COLLECTIONS.candles, completed).catch(() => undefined);
  }

  /**
   * Seed historical candles (from the broker REST API), replacing whatever the
   * buffer held. Bars still inside their window are dropped, so a live tick and a
   * broker bar never double-represent the same period.
   *
   * The open bar needs the same treatment and used not to get it. `openCandles` is a
   * separate map that this method left untouched, so a bar whose window had closed
   * with no tick arriving to roll it — routine for a thinly traded strike, and
   * routine for any instrument the websocket is not subscribed to — stayed parked
   * there while the broker's COMPLETED copy of that same bar landed in the buffer.
   * `getCandles` then appended the stale OPEN one *after* it, and the response
   * carried two entries under one id, wrong OHLC last: a chart that takes last-wins
   * drew the stale bar over the broker's own figures.
   *
   * Dropped on supersession rather than on the clock. "Its window has closed" would
   * be the simpler test and would catch the same case, but it also discards a bar
   * that no incoming data replaces — locally accumulated ticks, gone. Keying on the
   * id means the bar only ever leaves when something authoritative has taken its
   * place.
   */
  async seed(token: string, tf: IndiaTimeframe, candles: IndiaCandle[]): Promise<void> {
    const k = this.key(token, tf);
    const now = Date.now();
    const valid = candles
      .filter((c) => c.openTime + INDIA_TIMEFRAME_MS[tf] <= now)
      .sort((a, b) => a.openTime - b.openTime);
    // Keep up to 5000 bars (increased from 2000) so lower timeframes have more history
    const kept = valid.slice(-INDIA_CANDLE_BUFFER_MAX);
    this.buffers.set(k, kept);

    const open = this.openCandles.get(k);
    if (open && kept.some((c) => c.id === open.id)) this.openCandles.delete(k);

    await this.cache
      .set(INDIA_REDIS_KEYS.candle + k, JSON.stringify({ open: this.openCandles.get(k) ?? null, completed: kept }), indiaConfig.candleCacheTtlMs)
      .catch(() => undefined);
  }

  /** Reconcile gaps: if the newest closed bar is older than 2×tf, back-fill
   *  from the broker historical API (spec §10 reopen reconciliation). */
  async resyncMissing(token: string, tf: IndiaTimeframe, fetchHistorical: (from: number, to: number) => Promise<IndiaCandle[]>): Promise<void> {
    const k = this.key(token, tf);
    const buf = this.buffers.get(k) ?? [];
    const last = buf[buf.length - 1];
    const tfMs = INDIA_TIMEFRAME_MS[tf];
    if (!last || last.openTime + tfMs * 2 >= Date.now()) return;
    try {
      const history = await fetchHistorical(last.openTime + tfMs, Date.now());
      const merged = [...buf, ...history];
      const dedup = new Map<string, IndiaCandle>();
      for (const c of merged) dedup.set(c.id, c);
      const sorted = [...dedup.values()].sort((a, b) => a.openTime - b.openTime).slice(-INDIA_CANDLE_BUFFER_MAX);
      this.buffers.set(k, sorted);
    } catch {
      /* non-fatal */
    }
  }

  getCandles(token: string, tf: IndiaTimeframe, limit = INDIA_CANDLE_BUFFER_MAX): IndiaCandle[] {
    const k = this.key(token, tf);
    const buf = this.buffers.get(k) ?? [];
    const open = this.openCandles.get(k);
    const out = [...buf];
    if (open) out.push(open);
    return out.slice(-limit);
  }

  getCompletedCandles(token: string, tf: IndiaTimeframe, limit = 500): IndiaCandle[] {
    const k = this.key(token, tf);
    return (this.buffers.get(k) ?? []).slice(-limit);
  }

  stats(): { ticks: number; candlesCompleted: number; lateEvents: number; duplicates: number } {
    return { ticks: this.ticksSeen, candlesCompleted: this.candlesCompleted, lateEvents: this.lateEvents, duplicates: this.duplicates };
  }
}