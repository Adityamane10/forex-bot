/**
 * Binance crypto market data provider (free public API, no key).
 *
 * REAL streaming data: a combined bookTicker WebSocket stream pushes live
 * bid/ask quotes; REST bookTicker/klines are used as fallback and for history.
 * Implements the WebSocket reliability rules from the spec (§10): heartbeat
 * ping/pong, automatic reconnect with exponential backoff, resubscription
 * after reconnect (the combined-stream URL re-subscribes every symbol), a
 * connection watchdog, and provider health reporting.
 *
 * Symbol mapping: internal "BTC/USDT" <-> exchange "BTCUSDT".
 *
 * Free-tier reality (documented in RESOURCE_AUDIT.md): public Binance market
 * data is free and unauthenticated; rate limits apply (bookTicker weight 2,
 * klines weight 2, 6000 weight/min IP limit). This provider stays far below.
 */
import WebSocket from 'ws';
import { Candle, CRYPTO_SYMBOLS, DataMode, Tick, Timeframe, TIMEFRAME_MS } from '@fx/shared';
import { config } from '../config';
import { logger } from '../core/logger';
import { MarketDataProvider } from './types';

const BINANCE_INTERVALS: Record<Timeframe, string> = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '30m': '30m',
  '1h': '1h',
  '4h': '4h',
  '1D': '1d',
};

export function binanceInterval(tf: Timeframe): string {
  return BINANCE_INTERVALS[tf] ?? '1h';
}

/** Internal "BTC/USDT" -> exchange "BTCUSDT". */
export function toExchangeSymbol(symbol: string): string {
  return symbol.replace('/', '');
}

/** Exchange "BTCUSDT" -> internal "BTC/USDT" (null if not a supported symbol). */
export function toInternalSymbol(exchangeSymbol: string): string | null {
  const s = exchangeSymbol.toUpperCase();
  const slash = s.replace(/(USDT|BTC|ETH|BNB|SOL|XRP|ADA|DOGE)$/i, (m) => `/${m.toUpperCase()}`);
  return slash !== s ? slash : null;
}

/** Map a Binance bookTicker payload to an internal Tick (null on bad input). */
export function mapBookTicker(data: {
  s?: string;
  b?: string;
  a?: string;
  E?: number;
}): Tick | null {
  const symbol = data.s ? toInternalSymbol(data.s) : null;
  if (!symbol) return null;
  const bid = Number(data.b);
  const ask = Number(data.a);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0 || ask < bid) return null;
  const mid = (bid + ask) / 2;
  return {
    timestamp: data.E ?? Date.now(),
    symbol,
    assetClass: 'CRYPTO',
    bid,
    ask,
    mid,
    spread: ask - bid,
    source: 'BINANCE',
    venue: 'BINANCE',
    mode: 'LIVE',
  };
}

/** Map a Binance kline row to an internal Candle (null on bad input). */
export function mapKline(raw: unknown[]): Candle | null {
  if (!Array.isArray(raw) || raw.length < 7) return null;
  const [openTime, open, high, low, close, volume, closeTime] = raw as [number, string, string, string, string, string, number];
  const o = Number(open);
  const h = Number(high);
  const l = Number(low);
  const c = Number(close);
  const v = Number(volume);
  if (![o, h, l, c, v].every((n) => Number.isFinite(n)) || h < l || h < o || h < c || l > o || l > c) return null;
  return {
    symbol: '',
    timeframe: '1h',
    open: o,
    high: h,
    low: l,
    close: c,
    volume: v,
    openTime,
    closeTime,
    state: 'COMPLETED',
    completed: true,
    updatedAt: closeTime,
  };
}

export class BinanceCryptoMarketDataProvider implements MarketDataProvider {
  readonly name = 'BINANCE';
  readonly mode: DataMode = 'LIVE';
  readonly streaming = true;
  readonly description =
    'Binance public spot REST + WebSocket (bookTicker stream). Free, no key, documented rate limits; bid/ask are REAL (not modeled).';
  /** Analysis timeframes are preloaded from history; intraday builds live. */
  readonly preloadTimeframes: Timeframe[] = ['1h', '4h', '1D'];
  readonly feedLatencyMs = 2000;

  private symbols: string[] = [...CRYPTO_SYMBOLS];
  private ws: WebSocket | null = null;
  private connected = false;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private lastMessageAt = 0;
  private closing = false;
  private listeners = new Map<string, Set<(t: Tick) => void>>();
  private lastTicks = new Map<string, Tick>();

  constructor(private restUrl = config.binanceRestUrl, private wsUrl = config.binanceWsUrl) {}

  private streamsUrl(): string {
    const streams = this.symbols.map((s) => `${toExchangeSymbol(s).toLowerCase()}@bookTicker`).join('/');
    return `${this.wsUrl}/stream?streams=${streams}`;
  }

  private resetTimers(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.heartbeatTimer = null;
    this.watchdogTimer = null;
  }

  private scheduleReconnect(): void {
    if (this.closing) return;
    if (this.reconnectTimer) return;
    const delay = Math.min(30_000, 1000 * 2 ** this.reconnectAttempts);
    this.reconnectAttempts++;
    logger.warn('binance ws reconnect scheduled', { delay, attempt: this.reconnectAttempts });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private openStream(): void {
    this.resetTimers();
    const ws = new WebSocket(this.streamsUrl());
    this.ws = ws;

    ws.on('open', () => {
      this.connected = true;
      this.reconnectAttempts = 0;
      this.lastMessageAt = Date.now();
      logger.info('binance ws connected', { symbols: this.symbols.length });
      // Heartbeat: send a ping every 10s (Binance drops idle/undead sockets).
      this.heartbeatTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.ping();
      }, 10_000);
      // Watchdog: if no inbound message for 60s the socket is dead -> reconnect.
      this.watchdogTimer = setInterval(() => {
        if (this.connected && Date.now() - this.lastMessageAt > 60_000) {
          logger.warn('binance ws watchdog: no data for 60s, reconnecting');
          this.connected = false;
          try {
            ws.terminate();
          } catch {
            /* already closed */
          }
          this.scheduleReconnect();
        }
      }, 15_000);
    });

    ws.on('message', (raw) => {
      this.lastMessageAt = Date.now();
      try {
        const msg = JSON.parse(raw.toString()) as { stream?: string; data?: { s?: string; b?: string; a?: string; E?: number } };
        if (!msg.data) return;
        const tick = mapBookTicker(msg.data);
        if (!tick) return;
        tick.receivedAt = Date.now();
        this.lastTicks.set(tick.symbol, tick);
        for (const cb of this.listeners.get(tick.symbol) ?? []) cb(tick);
      } catch (err) {
        logger.warn('binance ws message parse failed', { err: String(err) });
      }
    });

    ws.on('pong', () => {
      this.lastMessageAt = Date.now();
    });

    ws.on('close', () => {
      this.connected = false;
      this.resetTimers();
      this.ws = null;
      this.scheduleReconnect();
    });

    ws.on('error', (err) => {
      logger.warn('binance ws error', { err: String(err) });
    });
  }

  async connect(): Promise<void> {
    this.closing = false;
    this.openStream();
  }

  async disconnect(): Promise<void> {
    this.closing = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.resetTimers();
    this.connected = false;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }

  async getSymbols(): Promise<string[]> {
    return this.symbols;
  }

  setSymbols(symbols: string[]): void {
    // Accept any symbols handed to us (the container passes the crypto list).
    const next = symbols.length ? symbols : [...CRYPTO_SYMBOLS];
    const changed = next.join(',') !== this.symbols.join(',');
    this.symbols = next;
    // The combined-stream URL IS the subscription — after a symbol change the
    // socket must be rebuilt, otherwise new symbols never stream.
    if (changed && this.connected && !this.closing) {
      logger.info('binance ws resubscribing after symbol change', { symbols: next.length });
      try {
        this.ws?.close(); // 'close' handler schedules reconnect with the new URL
      } catch {
        /* ignore */
      }
    }
  }

  async subscribe(symbol: string, onTick: (tick: Tick) => void): Promise<() => void> {
    let set = this.listeners.get(symbol);
    if (!set) {
      set = new Set();
      this.listeners.set(symbol, set);
    }
    set.add(onTick);
    // Seed with the latest known quote so downstream never waits for the next push.
    const last = this.lastTicks.get(symbol);
    if (last) onTick(last);
    return () => {
      set.delete(onTick);
      if (set.size === 0) this.listeners.delete(symbol);
    };
  }

  async unsubscribe(symbol: string): Promise<void> {
    this.listeners.delete(symbol);
  }

  async getLatestPrice(symbol: string): Promise<Tick | null> {
    const last = this.lastTicks.get(symbol);
    // Freshness measured from LOCAL receive time, not the exchange event
    // timestamp — host clock skew made cached ticks look wrongly fresh/stale.
    if (last && Date.now() - (last.receivedAt ?? last.timestamp) < 10_000) return last;
    try {
      const res = await fetch(`${this.restUrl}/api/v3/ticker/bookTicker?symbol=${toExchangeSymbol(symbol)}`);
      if (!res.ok) return null;
      const data = (await res.json()) as { s: string; b: string; a: string };
      const tick = mapBookTicker(data);
      if (tick) {
        tick.receivedAt = Date.now();
        this.lastTicks.set(symbol, tick);
      }
      return tick;
    } catch (err) {
      logger.warn('binance bookTicker failed', { symbol, err: String(err) });
      return null;
    }
  }

  async getBidAsk(symbol: string): Promise<{ bid: number; ask: number } | null> {
    const t = await this.getLatestPrice(symbol);
    return t ? { bid: t.bid, ask: t.ask } : null;
  }

  async getSpread(symbol: string): Promise<number | null> {
    const t = await this.getLatestPrice(symbol);
    return t ? t.spread : null;
  }

  async getHistoricalCandles(symbol: string, timeframe: Timeframe, from: number, to: number): Promise<Candle[]> {
    // Binance caps a single klines request at 1000 rows — without cursor
    // pagination a year of 15m candles (~35k bars) came back as the FIRST
    // 1000 with no indication. Loop forward until `to` is covered.
    const tfMs = TIMEFRAME_MS[timeframe];
    const now = Date.now();
    const cappedTo = Math.min(to, now - tfMs);
    const out: Candle[] = [];
    try {
      let cursor = from;
      while (cursor <= cappedTo) {
        const url = `${this.restUrl}/api/v3/klines?symbol=${toExchangeSymbol(symbol)}&interval=${binanceInterval(timeframe)}&startTime=${cursor}&endTime=${cappedTo}&limit=1000`;
        const res = await fetch(url);
        if (!res.ok) {
          logger.warn('binance klines failed', { symbol, timeframe, status: res.status });
          return out;
        }
        const rows = (await res.json()) as unknown[][];
        if (!rows.length) break;
        for (const row of rows) {
          const candle = mapKline(row);
          if (!candle) continue;
          if (candle.closeTime > now) continue; // still-open bar
          out.push({ ...candle, symbol, timeframe });
        }
        const lastOpenTime = (rows[rows.length - 1] as unknown[])[0] as number;
        const next = lastOpenTime + tfMs;
        if (next <= cursor) break; // provider returned no progress — avoid spinning
        cursor = next;
        if (rows.length < 1000) break;
      }
      return out;
    } catch (err) {
      logger.warn('binance klines error', { symbol, timeframe, err: String(err) });
      return out;
    }
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    const fresh = this.lastMessageAt > 0 && Date.now() - this.lastMessageAt < 60_000;
    if (this.connected && fresh) {
      return { ok: true, detail: `ws connected, ${this.symbols.length} symbols streaming (fresh ${Math.round((Date.now() - this.lastMessageAt) / 1000)}s)` };
    }
    // REST probe so a dead socket does not permanently flag the feed DOWN.
    try {
      const res = await fetch(`${this.restUrl}/api/v3/ping`);
      if (res.ok) return { ok: true, detail: this.connected ? 'ws stale, REST reachable' : 'ws reconnecting, REST reachable' };
    } catch {
      /* unreachable */
    }
    return { ok: false, detail: this.connected ? 'ws stale and REST unreachable' : 'ws disconnected and REST unreachable' };
  }
}
