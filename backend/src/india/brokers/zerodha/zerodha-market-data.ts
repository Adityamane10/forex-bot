/**
 * Zerodha Kite Connect market data: official instrument master (CSV), official
 * historical-candle REST API and the official WebSocket tick feed. The broker
 * WebSocket is the authoritative live price source (spec §3). Nothing here
 * fabricates prices.
 */
import WebSocket from 'ws';
import type { IndiaCandle, IndiaInstrument, IndiaTick, IndiaTimeframe } from '@fx/shared';
import { IndiaSegment, IndiaOptionType, IndiaContractType, IndiaExchange, INDIA_IST_OFFSET_MS } from '@fx/shared';
import { IndiaInstrumentService } from '../../instruments';
import { authHeaders } from './zerodha-auth';
import { logger } from '../../../core/logger';

const API = 'https://api.kite.trade';

// ---------------------------------------------------------------------------
// Instrument master (spec §11)
// ---------------------------------------------------------------------------

/**
 * Kite publishes derivatives under /instruments/NFO (NSE F&O) and
 * /instruments/BFO (BSE F&O). The cash-segment dumps (/instruments/NSE|BSE)
 * carry only equities + index rows — fetching those alone left the entire
 * options/futures universe EMPTY on this broker.
 */
export async function fetchKiteInstruments(): Promise<IndiaInstrument[]> {
  const [nfo, bfo, nse, bse] = await Promise.allSettled([
    fetch(`${API}/instruments/NFO`).then((r) => r.text()),
    fetch(`${API}/instruments/BFO`).then((r) => r.text()),
    fetch(`${API}/instruments/NSE`).then((r) => r.text()),
    fetch(`${API}/instruments/BSE`).then((r) => r.text()),
  ]);
  const instruments: IndiaInstrument[] = [];
  if (nfo.status === 'fulfilled') instruments.push(...parseInstrumentCsv(nfo.value, 'NSE'));
  if (bfo.status === 'fulfilled') instruments.push(...parseInstrumentCsv(bfo.value, 'BSE'));
  if (nse.status === 'fulfilled') instruments.push(...parseIndexCsv(nse.value, 'NSE'));
  if (bse.status === 'fulfilled') instruments.push(...parseIndexCsv(bse.value, 'BSE'));
  return instruments;
}

/** Index rows only from the cash-segment dump (F&O comes from NFO/BFO above). */
export function parseIndexCsv(csv: string, exchange: IndiaExchange): IndiaInstrument[] {
  const lines = csv.split(/\r?\n/);
  const out: IndiaInstrument[] = [];
  for (const line of lines) {
    const c = line.split(',');
    if (c.length < 12) continue;
    const [instrumentToken, , tradingSymbol, name, , , strikeRaw, tickSizeRaw, lotSizeRaw, instrumentType, segment] = c;
    if (!instrumentToken || !tradingSymbol) continue;
    const seg = (segment ?? '').toUpperCase();
    if (!seg.includes('INDEX')) continue;
    const underlying = IndiaInstrumentService.normalizeUnderlying((name ?? tradingSymbol).trim());
    out.push({
      instrumentToken,
      exchange,
      segment: exchange === 'BSE' ? 'BSE_INDEX' : 'NSE_INDEX',
      tradingSymbol,
      underlying,
      name: (name ?? tradingSymbol).trim(),
      contractType: 'INDEX',
      expiry: null,
      strike: strikeRaw ? Number(strikeRaw) : null,
      optionType: null,
      lotSize: Number(lotSizeRaw) || 1,
      tickSize: Number(tickSizeRaw) || 0.05,
      freezeQuantity: null,
      status: 'ACTIVE',
      tradable: true,
    });
    void instrumentType;
  }
  return out;
}

/**
 * Parse the Kite instrument CSV into normalized IndiaInstrument records.
 * Columns: instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,
 *          strike,tick_size,lot_size,instrument_type,segment,exchange
 */
export function parseInstrumentCsv(csv: string, exchange: IndiaExchange): IndiaInstrument[] {
  const lines = csv.split(/\r?\n/);
  const out: IndiaInstrument[] = [];
  for (const line of lines) {
    const c = line.split(',');
    if (c.length < 12) continue;
    const [instrumentToken, , tradingSymbol, name, , expiryRaw, strikeRaw, tickSizeRaw, lotSizeRaw, instrumentType, segment, ex] = c;
    if (ex && ex !== exchange) continue;
    if (!instrumentToken || !tradingSymbol) continue;
    const instrumentTypeUpper = (instrumentType ?? '').toUpperCase();
    const seg = (segment ?? '').toUpperCase();
    const contractType: IndiaContractType = instrumentTypeUpper === 'FUT' ? 'FUT' : instrumentTypeUpper === 'CE' || instrumentTypeUpper === 'PE' ? 'OPT' : 'INDEX';
    const isIndex = contractType === 'INDEX' || seg.includes('INDEX');
    const isFo = seg.includes('FO');
    let segmentOut: IndiaSegment;
    if (isIndex && !isFo) segmentOut = exchange === 'BSE' ? 'BSE_INDEX' : 'NSE_INDEX';
    else if (isFo && contractType === 'FUT') segmentOut = exchange === 'BSE' ? 'BSE_FUT' : 'NSE_FUT';
    else if (isFo && contractType === 'OPT') segmentOut = exchange === 'BSE' ? 'BSE_OPT' : 'NSE_OPT';
    else continue; // cash equities are out of scope for the F&O intraday engine
    // Expiry is a bare date ("2026-09-29") in current Kite dumps. Parsing it as
    // UTC produced Invalid Date → NaN (or a 5.5h-shifted instant for datetime
    // variants); rebuild at IST MIDNIGHT like every other adapter — consumers
    // normalize to the 15:30 close via expiryInstant().
    const expiry = parseKiteExpiry(expiryRaw);
    const strike = strikeRaw ? Number(strikeRaw) : null;
    const tickSize = Number(tickSizeRaw) || 0.05;
    const lotSize = Number(lotSizeRaw) || 1;
    // Normalise the underlying: Zerodha uses 'NIFTY 50', 'NIFTY BANK', etc. in the name column
    const rawUnderlying = (name ?? tradingSymbol).trim();
    const underlying = IndiaInstrumentService.normalizeUnderlying(rawUnderlying);
    out.push({
      instrumentToken,
      exchange,
      segment: segmentOut,
      tradingSymbol,
      underlying,
      name: rawUnderlying,
      contractType,
      expiry,
      strike,
      optionType: (instrumentTypeUpper === 'CE' || instrumentTypeUpper === 'PE' ? instrumentTypeUpper : null) as IndiaOptionType | null,
      lotSize,
      tickSize,
      freezeQuantity: null,
      status: 'ACTIVE',
      tradable: true,
    });
  }
  return out;
}

/** Bare-date / datetime expiry → epoch at IST midnight of that date. */
export function parseKiteExpiry(raw: string | undefined): number | null {
  if (!raw) return null;
  const dateOnly = raw.trim().slice(0, 10);
  const m = dateOnly.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const ts = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - INDIA_IST_OFFSET_MS;
  return Number.isFinite(ts) ? ts : null;
}

// ---------------------------------------------------------------------------
// Historical candles (spec §13)
// ---------------------------------------------------------------------------

const KITE_INTERVAL: Record<IndiaTimeframe, string> = {
  '1m': 'minute',
  '3m': '3minute',
  '5m': '5minute',
  '15m': '15minute',
  '30m': '30minute',
  '1h': '60minute',
};

export function kiteInterval(timeframe: IndiaTimeframe): string {
  return KITE_INTERVAL[timeframe];
}

export interface KiteHistoricalMeta {
  exchange: IndiaExchange;
  segment: IndiaSegment;
  tradingSymbol: string;
  underlying: string;
}

export async function fetchKiteHistoricalCandles(
  apiKey: string,
  accessToken: string,
  instrumentToken: string,
  timeframe: IndiaTimeframe,
  from: number,
  to: number,
  meta?: Partial<KiteHistoricalMeta>,
): Promise<IndiaCandle[]> {
  const interval = kiteInterval(timeframe);
  // Kite's `from`/`to` are IST wall-clock dates: format in IST, not UTC.
  // The UTC slice silently dropped the newest session for 00:00-05:30 IST.
  const fmt = (t: number) => new Date(t + INDIA_IST_OFFSET_MS).toISOString().slice(0, 10);
  const url = `${API}/instruments/historical/${instrumentToken}/${interval}?from=${fmt(from)}&to=${fmt(to)}&continuous=0&oi=1`;
  const res = await fetch(url, { headers: authHeaders(apiKey, accessToken) });
  if (!res.ok) throw new Error(`kite historical failed: ${res.status}`);
  const json = (await res.json()) as { data?: { candles?: Array<[number, number, number, number, number, number, number]> } };
  const rows = json.data?.candles ?? [];
  return rows.map((r) => {
    const openTime = r[0] * 1000;
    const timeframeMs = tfMs(timeframe);
    return {
      id: `${instrumentToken}:${timeframe}:${openTime}`,
      exchange: meta?.exchange ?? ('NSE' as IndiaExchange),
      segment: meta?.segment ?? ('NSE_FUT' as IndiaSegment),
      instrumentToken,
      tradingSymbol: meta?.tradingSymbol ?? '',
      underlying: meta?.underlying ?? '',
      timeframe,
      open: r[1],
      high: r[2],
      low: r[3],
      close: r[4],
      volume: r[5],
      openInterest: r.length > 6 ? r[6] : null,
      openTime,
      closeTime: openTime + timeframeMs,
      state: 'COMPLETED' as const,
      completed: true,
      updatedAt: openTime + timeframeMs,
    };
  });
}

function tfMs(tf: IndiaTimeframe): number {
  const m: Record<IndiaTimeframe, number> = { '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000, '1h': 3_600_000 };
  return m[tf];
}

// ---------------------------------------------------------------------------
// One-shot quote (spec §3 getQuote)
// ---------------------------------------------------------------------------

export async function fetchKiteQuote(
  apiKey: string,
  accessToken: string,
  exchange: string,
  tradingSymbol: string,
): Promise<IndiaTick | null> {
  const key = `${exchange}:${tradingSymbol}`;
  const res = await fetch(`${API}/quote?i=${encodeURIComponent(key)}`, { headers: authHeaders(apiKey, accessToken) });
  if (!res.ok) return null;
  const json = (await res.json()) as {
    data?: Record<string, {
      instrument_token: number;
      last_price: number;
      volume: number;
      buy_quantity: number;
      sell_quantity: number;
      timestamp: string;
      ohlc?: { open: number; high: number; low: number; close: number };
      oi?: number;
      depth?: { buy?: Array<{ price: number; quantity: number }>; sell?: Array<{ price: number; quantity: number }> };
    }>;
  };
  const d = json.data?.[key];
  if (!d) return null;
  const buy = d.depth?.buy?.[0];
  const sell = d.depth?.sell?.[0];
  const ts = d.timestamp ? new Date(d.timestamp).getTime() : Date.now();
  return {
    exchange: exchange === 'BSE' ? 'BSE' : 'NSE',
    segment: 'NSE_INDEX',
    instrumentToken: String(d.instrument_token),
    tradingSymbol,
    underlying: tradingSymbol,
    marketTimestamp: ts,
    receivedAt: Date.now(),
    timestamp: ts,
    ltp: d.last_price,
    bid: buy?.price ?? null,
    ask: sell?.price ?? null,
    bidQuantity: buy?.quantity ?? null,
    askQuantity: sell?.quantity ?? null,
    volume: d.volume ?? null,
    openInterest: d.oi ?? null,
    dayOpen: d.ohlc?.open ?? null,
    dayHigh: d.ohlc?.high ?? null,
    dayLow: d.ohlc?.low ?? null,
    previousClose: d.ohlc?.close ?? null,
    // REST quotes do not carry last-traded qty — leave null rather than
    // mislabeling cumulative day buy_quantity.
    lastTradeQuantity: null,
    source: 'ZERODHA',
    tradable: true,
  };
}

/**
 * Batch LTP/quote via Kite's MULTI-instrument endpoint (`i=` repeated).
 * The old loop fired one request per token — with ltpPollMax=40 that was
 * ~4 req/s against a ~1 req/s quota, guaranteeing rolling 429s.
 */
export async function fetchKiteQuotes(
  apiKey: string,
  accessToken: string,
  keys: string[],
): Promise<Map<string, IndiaTick>> {
  const out = new Map<string, IndiaTick>();
  if (keys.length === 0) return out;
  const qs = keys.map((k) => `i=${encodeURIComponent(k)}`).join('&');
  const res = await fetch(`${API}/quote?${qs}`, { headers: authHeaders(apiKey, accessToken) });
  if (!res.ok) throw new Error(`kite quote failed: ${res.status}`);
  const json = (await res.json()) as {
    data?: Record<string, {
      instrument_token: number;
      last_price: number;
      volume?: number;
      ohlc?: { open: number; high: number; low: number; close: number };
      timestamp?: string;
      depth?: { buy?: Array<{ price: number; quantity: number }>; sell?: Array<{ price: number; quantity: number }> };
      oi?: number;
    }>;
  };
  const data = json.data ?? {};
  for (const key of Object.keys(data)) {
    const d = data[key];
    if (!d || !Number.isFinite(d.last_price) || d.last_price <= 0) continue;
    const [exchange, tradingSymbol] = key.split(':');
    const buy = d.depth?.buy?.[0];
    const sell = d.depth?.sell?.[0];
    const ts = d.timestamp ? new Date(d.timestamp).getTime() : Date.now();
    out.set(key, {
      exchange: exchange === 'BSE' ? 'BSE' : 'NSE',
      segment: 'NSE_INDEX',
      instrumentToken: String(d.instrument_token),
      tradingSymbol: tradingSymbol ?? '',
      underlying: tradingSymbol ?? '',
      marketTimestamp: ts,
      receivedAt: Date.now(),
      timestamp: ts,
      ltp: d.last_price,
      bid: buy?.price ?? null,
      ask: sell?.price ?? null,
      bidQuantity: buy?.quantity ?? null,
      askQuantity: sell?.quantity ?? null,
      volume: d.volume ?? null,
      openInterest: d.oi ?? null,
      dayOpen: d.ohlc?.open ?? null,
      dayHigh: d.ohlc?.high ?? null,
      dayLow: d.ohlc?.low ?? null,
      previousClose: d.ohlc?.close ?? null,
      lastTradeQuantity: null,
      source: 'ZERODHA',
      tradable: true,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// WebSocket live feed (spec §4) — authoritative price source
//
// Official Kite Connect binary protocol:
//   • Auth via URL params: wss://ws.kite.trade?api_key=..&access_token=..
//     (there is NO JSON "connect" control frame).
//   • Subscribe/mode are JSON text frames: {"a":"subscribe","v":[tokens]}
//     and {"a":"mode","v":["full",[tokens]]}.
//   • Ticks arrive as BINARY frames: a little-endian envelope
//     [u16 packet count][u16 packet length per packet], each packet holding
//     BIG-ENDIAN fields with prices as int32 paise (÷100):
//       LTP   = 8 bytes   (token, ltp)
//       QUOTE = 44 bytes  (token..close)
//       FULL  = 184 bytes (quote fields + ltq + ts + oi×3 + 5-level depth ×2)
// ---------------------------------------------------------------------------

interface KiteWsHandlers {
  onTick: (tick: IndiaTick) => void;
  onConnect: () => void;
  onDisconnect: (err?: Error) => void;
  onError: (err: Error) => void;
}

export class KiteWebSocket {
  private ws: WebSocket | null = null;
  private apiKey: string;
  private accessToken: string;
  private subscribed: number[] = [];

  constructor(apiKey: string, accessToken: string) {
    this.apiKey = apiKey;
    this.accessToken = accessToken;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(handlers: KiteWsHandlers): void {
    const url = `wss://ws.kite.trade?api_key=${encodeURIComponent(this.apiKey)}&access_token=${encodeURIComponent(this.accessToken)}`;
    this.ws = new WebSocket(url);
    this.ws.on('open', () => {
      // Authorization happened during the handshake (URL params). Send the
      // subscription batch immediately; applySubscriptions() also sets full mode.
      this.applySubscriptions();
      handlers.onConnect();
    });
    this.ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        // Text frames are server error/status messages.
        const text = data.toString();
        logger.debug(`[kite-ws] server message: ${text.slice(0, 200)}`);
        return;
      }
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      for (const tick of parseKitePacket(buf)) handlers.onTick(tick);
    });
    this.ws.on('close', () => handlers.onDisconnect());
    this.ws.on('error', (err) => handlers.onError(err));
  }

  private send(msg: Record<string, unknown>): void {
    try {
      this.ws?.send(JSON.stringify(msg));
    } catch (err) {
      logger.warn(`[kite-ws] send failed: ${String(err)}`);
    }
  }

  private applySubscriptions(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (!this.subscribed.length) return;
    this.send({ a: 'subscribe', v: this.subscribed });
    // Full mode must follow EVERY subscribe batch — new tokens otherwise sit
    // in default LTP mode producing short packets forever.
    this.send({ a: 'mode', v: ['full', this.subscribed] });
  }

  subscribe(tokens: number[]): void {
    for (const t of tokens) if (!this.subscribed.includes(t)) this.subscribed.push(t);
    if (this.connected) this.applySubscriptions();
  }

  unsubscribe(tokens: number[]): void {
    this.subscribed = this.subscribed.filter((t) => !tokens.includes(t));
    if (this.connected) this.send({ a: 'unsubscribe', v: tokens });
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }
}

/** Split the LE envelope and parse every contained BE tick packet. */
export function parseKitePacket(buf: Buffer): IndiaTick[] {
  const out: IndiaTick[] = [];
  if (buf.length < 4) return out;
  const count = buf.readUInt16LE(0);
  let pos = 2;
  for (let i = 0; i < count && pos + 2 <= buf.length; i++) {
    const len = buf.readUInt16LE(pos);
    pos += 2;
    if (pos + len > buf.length) break;
    const tick = parseKiteTick(buf.subarray(pos, pos + len));
    if (tick) out.push(tick);
    pos += len;
  }
  return out;
}

/** Parse ONE binary tick packet (mode inferred from its byte length). */
export function parseKiteTick(pkt: Buffer): IndiaTick | null {
  if (pkt.length < 8) return null;
  const dv = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
  const token = dv.getUint32(0); // big-endian by default

  if (pkt.length === 8) {
    // LTP mode: token(4) + ltp int32 (/100)
    const ltp = dv.getInt32(4) / 100;
    return baseTick(token, ltp, {});
  }

  if (pkt.length === 44 || pkt.length === 184) {
    const ltp = dv.getInt32(4) / 100;
    const lastQty = dv.getUint32(8);
    const avgPrice = dv.getInt32(12) / 100;
    void avgPrice;
    const volume = dv.getUint32(16);
    const buyQty = dv.getUint32(20);
    const sellQty = dv.getUint32(24);
    const open = dv.getInt32(28) / 100;
    const high = dv.getInt32(32) / 100;
    const low = dv.getInt32(36) / 100;
    const close = dv.getInt32(40) / 100;

    if (pkt.length === 44) {
      return baseTick(token, ltp, {
        lastQty, volume, buyQty, sellQty,
        open: finitePrice(open), high: finitePrice(high), low: finitePrice(low), close: finitePrice(close),
      });
    }

    // ---- FULL mode (184 bytes) -------------------------------------------
    const lastTradeQty = dv.getUint32(44);
    const exchangeTs = dv.getUint32(48); // epoch seconds (0 when unknown)
    const oi = dv.getUint32(52);
    const oiHigh = dv.getUint32(56);
    const oiLow = dv.getUint32(60);

    // Depth: 5 levels/side starting at 64 (buy) and 124 (sell); each level is
    // qty u32 @+0, price u32/100 @+4, orders u16 @+8, pad u16 @+10.
    const bestBuy = pkt.length >= 70 ? readLevel(dv, 64) : null;
    const bestSell = pkt.length >= 130 ? readLevel(dv, 124) : null;

    return baseTick(token, ltp, {
      lastQty: lastTradeQty || lastQty,
      volume, buyQty, sellQty,
      open: finitePrice(open), high: finitePrice(high), low: finitePrice(low), close: finitePrice(close),
      bid: bestBuy?.price, bidQty: bestBuy?.qty,
      ask: bestSell?.price, askQty: bestSell?.qty,
      oi: oi || undefined, oiHigh: oiHigh || undefined, oiLow: oiLow || undefined,
      exchangeTs: exchangeTs > 0 ? exchangeTs * 1000 : undefined,
      lastTradeQty,
    });
  }

  logger.warn(`[kite-ws] unexpected packet length ${pkt.length} — skipped`);
  return null;
}

function readLevel(dv: DataView, off: number): { price: number; qty: number } | null {
  const qty = dv.getUint32(off);
  const price = dv.getInt32(off + 4) / 100;
  if (qty <= 0 || price <= 0) return null;
  return { price, qty };
}

function finitePrice(v: number): number | undefined {
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

function baseTick(
  token: number,
  ltp: number,
  extra: {
    lastQty?: number; volume?: number; buyQty?: number; sellQty?: number;
    open?: number; high?: number; low?: number; close?: number;
    bid?: number; bidQty?: number; ask?: number; askQty?: number;
    oi?: number; oiHigh?: number; oiLow?: number; exchangeTs?: number; lastTradeQty?: number;
  },
): IndiaTick | null {
  if (!Number.isFinite(ltp) || ltp <= 0) return null;
  const ts = extra.exchangeTs ?? Date.now();
  return {
    exchange: 'NSE',
    segment: 'NSE_FUT',
    instrumentToken: String(token),
    tradingSymbol: '',
    underlying: '',
    marketTimestamp: ts,
    receivedAt: Date.now(),
    timestamp: ts,
    ltp,
    bid: extra.bid ?? null,
    ask: extra.ask ?? null,
    bidQuantity: extra.bidQty ?? extra.buyQty ?? null,
    askQuantity: extra.askQty ?? extra.sellQty ?? null,
    volume: extra.volume ?? null,
    openInterest: extra.oi ?? null,
    dayOpen: extra.open ?? null,
    dayHigh: extra.high ?? null,
    dayLow: extra.low ?? null,
    previousClose: extra.close ?? null,
    lastTradeQuantity: extra.lastTradeQty ?? null,
    source: 'ZERODHA-WS',
    tradable: true,
  };
}
