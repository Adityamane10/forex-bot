/**
 * Upstox market data: official instrument-master JSON, official historical-candle
 * REST API and the official WebSocket market-data feed (protobuf). The broker
 * WebSocket is the authoritative live price source (spec §3).
 */
import WebSocket from 'ws';
import { gunzipSync } from 'node:zlib';
import type { IndiaCandle, IndiaInstrument, IndiaTick, IndiaTimeframe } from '@fx/shared';
import { IndiaSegment, IndiaOptionType, IndiaContractType, IndiaExchange, INDIA_TIMEFRAME_MS, INDIA_IST_OFFSET_MS, indiaBucketStart } from '@fx/shared';
import { IndiaInstrumentService } from '../../instruments';
import { upstoxHeaders } from './upstox-auth';
import { logger } from '../../../core/logger';

const API = 'https://api.upstox.com/v2';
const V3_API = 'https://api.upstox.com/v3';

/** IST is a fixed +05:30 and India has never observed daylight saving, so the offset
 *  can be applied arithmetically. Aliased from `@fx/shared` rather than redeclared:
 *  the date arithmetic in this file has to agree with the candle grid in
 *  `indiaBucketStart`, and two copies of a number are two things to keep in step. */
const IST_OFFSET_MS = INDIA_IST_OFFSET_MS;

// ---------------------------------------------------------------------------
// Protobuf wire reader (subset needed for the market-data feed)
// ---------------------------------------------------------------------------

class ProtoReader {
  constructor(private buf: Buffer) {}
  pos = 0;

  readVarint(): number {
    // Protobuf varints are little-endian base-128. Building the value with
    // 32-bit `<<` silently corrupted varints > 2^31 (large cumulative
    // volumes); accumulate with multiplication instead.
    let result = 0;
    let shift = 0;
    while (this.pos < this.buf.length) {
      const b = this.buf[this.pos++];
      result += (b & 0x7f) * Math.pow(2, shift);
      if ((b & 0x80) === 0) break;
      shift += 7;
      if (shift > 63) throw new Error('varint too long');
    }
    return result;
  }

  readTag(): { field: number; wireType: number } {
    const tag = this.readVarint();
    return { field: tag >>> 3, wireType: tag & 7 };
  }

  readLengthDelimited(): Buffer {
    const len = this.readVarint();
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }

  readFixed64(): number {
    // Wire type 1 (fixed64/double) is LITTLE-ENDIAN by protobuf spec. The old
    // readDoubleBE reinterpreted every byte order and produced absurd prices
    // (ltpc.ltp/close, ohlc.*, depth prices are all `double` fields).
    const out = this.buf.readDoubleLE(this.pos);
    this.pos += 8;
    return out;
  }

  get done(): boolean {
    return this.pos >= this.buf.length;
  }
}

interface Ltpc { ltp: number | null; close: number | null }
interface MarketOhlc { open: number | null; high: number | null; low: number | null; close: number | null }
interface BuySell { quantity: number; price: number }
interface Feed {
  instrumentKey: string;
  timestamp: number | null;
  ltpc: Ltpc;
  ohlc: MarketOhlc;
  volume: number | null;
  oi: number | null;
  depth: { buy: BuySell[]; sell: BuySell[] };
}

function decodeLtpc(buf: Buffer): Ltpc {
  const r = new ProtoReader(buf);
  const out: Ltpc = { ltp: null, close: null };
  while (!r.done) {
    const { field, wireType } = r.readTag();
    if (wireType === 1) out[field === 1 ? 'ltp' : 'close'] = r.readFixed64();
    else if (wireType === 2) { const len = r.readLengthDelimited(); void len; }
    else r.readVarint();
  }
  return out;
}

function decodeOhlc(buf: Buffer): MarketOhlc {
  const r = new ProtoReader(buf);
  const out: MarketOhlc = { open: null, high: null, low: null, close: null };
  while (!r.done) {
    const { field, wireType } = r.readTag();
    if (wireType === 1) out[field === 1 ? 'open' : field === 2 ? 'high' : field === 3 ? 'low' : 'close'] = r.readFixed64();
    else if (wireType === 2) { const len = r.readLengthDelimited(); void len; }
    else r.readVarint();
  }
  return out;
}

function decodeDepth(buf: Buffer): { buy: BuySell[]; sell: BuySell[] } {
  const r = new ProtoReader(buf);
  const out: { buy: BuySell[]; sell: BuySell[] } = { buy: [], sell: [] };
  while (!r.done) {
    const { field, wireType } = r.readTag();
    if (wireType === 2) {
      const entry = r.readLengthDelimited();
      if (field === 1 || field === 2) {
        const er = new ProtoReader(entry);
        const item: BuySell = { quantity: 0, price: 0 };
        while (!er.done) {
          const { field: f, wireType: wt } = er.readTag();
          if (f === 1 && wt === 0) item.quantity = er.readVarint();
          else if (f === 2 && wt === 1) item.price = er.readFixed64();
          else if (wt === 2) { const l = er.readLengthDelimited(); void l; }
          else er.readVarint();
        }
        if (field === 1) out.buy.push(item);
        else out.sell.push(item);
      }
    } else r.readVarint();
  }
  return out;
}

function decodeFeed(buf: Buffer): Feed {
  const r = new ProtoReader(buf);
  const out: Feed = { instrumentKey: '', timestamp: null, ltpc: { ltp: null, close: null }, ohlc: { open: null, high: null, low: null, close: null }, volume: null, oi: null, depth: { buy: [], sell: [] } };
  while (!r.done) {
    const { field, wireType } = r.readTag();
    if (field === 1 && wireType === 2) {
      const entry = r.readLengthDelimited();
      const er = new ProtoReader(entry);
      let key = '';
      let feedBuf: Buffer | null = null;
      while (!er.done) {
        const { field: f, wireType: wt } = er.readTag();
        if (f === 1 && wt === 2) key = er.readLengthDelimited().toString('utf8');
        else if (f === 2 && wt === 2) feedBuf = er.readLengthDelimited();
        else if (wt === 2) { const l = er.readLengthDelimited(); void l; }
        else er.readVarint();
      }
      out.instrumentKey = key;
      if (feedBuf) {
        const fr = new ProtoReader(feedBuf);
        while (!fr.done) {
          const { field: f, wireType: wt } = fr.readTag();
          if (f === 1 && wt === 0) out.timestamp = fr.readVarint();
          else if (f === 2 && wt === 2) out.ltpc = decodeLtpc(fr.readLengthDelimited());
          else if (f === 3 && wt === 2) out.ohlc = decodeOhlc(fr.readLengthDelimited());
          else if (f === 5 && wt === 0) out.volume = fr.readVarint();
          else if (f === 6 && wt === 2) { const oiBuf = fr.readLengthDelimited(); out.oi = decodeOhlc(oiBuf).close ?? null; }
          else if (f === 8 && wt === 2) out.depth = decodeDepth(fr.readLengthDelimited());
          else if (wt === 2) { const l = fr.readLengthDelimited(); void l; }
          else fr.readVarint();
        }
      }
    } else if (wireType === 2) { const l = r.readLengthDelimited(); void l; }
    else r.readVarint();
  }
  return out;
}

/** Decode an Upstox market-data-feed binary message into normalized ticks.
 *  Source is tagged `-WS` so downstream can tell socket frames from REST-batch
 *  ticks — "is streaming working" is answered from this, not from the
 *  connected flag, which stays true on sockets that never deliver. */
export function decodeUpstoxFeedMessage(payload: Buffer, segment: IndiaSegment, source = 'UPSTOX-WS'): IndiaTick[] {
  const ticks: IndiaTick[] = [];
  const r = new ProtoReader(payload);
  while (!r.done) {
    const { field, wireType } = r.readTag();
    if (field === 1 && wireType === 2) {
      const entry = r.readLengthDelimited();
      const feed = decodeFeed(entry);
      if (!feed.instrumentKey) continue;
      const ts = feed.timestamp ?? Date.now();
      const ltp = feed.ltpc.ltp ?? 0;
      const bid = feed.depth.buy[0]?.price ?? null;
      const ask = feed.depth.sell[0]?.price ?? null;
      // Emit the full broker key (e.g. 'NSE_INDEX|26000') as instrumentToken so
      // the adapter's instrumentsByKey lookup can rewrite it to the canonical
      // numeric exchange_token before forwarding to downstream consumers.
      ticks.push({
        exchange: 'NSE',
        segment,
        instrumentToken: feed.instrumentKey,   // full key — adapter will rewrite to numeric
        tradingSymbol: feed.instrumentKey,
        underlying: '',
        marketTimestamp: ts,
        receivedAt: Date.now(),
        timestamp: ts,
        ltp,
        bid,
        ask,
        bidQuantity: feed.depth.buy[0]?.quantity ?? null,
        askQuantity: feed.depth.sell[0]?.quantity ?? null,
        volume: feed.volume ?? null,
        openInterest: feed.oi ?? null,
        dayOpen: feed.ohlc.open ?? null,
        dayHigh: feed.ohlc.high ?? null,
        dayLow: feed.ohlc.low ?? null,
        previousClose: feed.ltpc.close ?? null,
        lastTradeQuantity: null,
        source,
        tradable: true,
      });
    } else if (wireType === 2) { const l = r.readLengthDelimited(); void l; }
    else r.readVarint();
  }
  return ticks;
}

// ---------------------------------------------------------------------------
// Instrument master (spec §11)
// ---------------------------------------------------------------------------

const MASTER_FILES: Array<{ url: string; exchange: IndiaExchange }> = [
  { url: 'https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz', exchange: 'NSE' },
  { url: 'https://assets.upstox.com/market-quote/instruments/exchange/BSE.json.gz', exchange: 'BSE' },
];

export async function fetchUpstoxInstruments(): Promise<IndiaInstrument[]> {
  const out: IndiaInstrument[] = [];
  for (const file of MASTER_FILES) {
    try {
      const res = await fetch(file.url);
      if (!res.ok) {
        logger.warn('upstox: instrument master fetch failed', { url: file.url, status: res.status });
        continue;
      }
      const gz = Buffer.from(await res.arrayBuffer());
      const raw = gunzipSync(gz).toString('utf8');
      const rows = JSON.parse(raw) as Array<{
        segment: string;
        name?: string;
        exchange?: string;
        instrument_type?: string;
        instrument_key?: string;
        lot_size?: number;
        exchange_token?: string;
        tick_size?: number;
        trading_symbol?: string;
        underlying_symbol?: string;
        expiry?: number | null;
        strike_price?: number | null;
      }>;
      for (const d of rows) {
        const instrumentType = (d.instrument_type ?? '').toUpperCase();
        const contractType: IndiaContractType =
          instrumentType === 'FUT' ? 'FUT' : instrumentType === 'CE' || instrumentType === 'PE' ? 'OPT' : 'INDEX';

        const rawSeg = (d.segment ?? '').toUpperCase();
        const isBse = rawSeg.startsWith('BSE') || (d.exchange ?? '').toUpperCase() === 'BSE';

        // Derive correct segment from contractType + exchange
        const effectiveSegment: IndiaSegment =
          contractType === 'INDEX' ? (isBse ? 'BSE_INDEX' : 'NSE_INDEX')
          : contractType === 'FUT' ? (isBse ? 'BSE_FUT' : 'NSE_FUT')
          : (isBse ? 'BSE_OPT' : 'NSE_OPT');

        // Upstox expiry strings are bare dates; `new Date(...)` parses them as
        // UTC midnight = 05:30 IST, which made every raw `expiry < now`
        // comparison true at 05:30 on expiry day. Rebuild at IST midnight like
        // the other adapters — consumers normalize via expiryInstant().
        const expiry = parseUpstoxExpiry(d.expiry);
        const strike = d.strike_price == null ? null : Number(d.strike_price);

        // underlying_symbol is the canonical name from Upstox (e.g. 'NIFTY 50', 'NIFTY BANK')
        const rawUnderlying = (d.underlying_symbol || d.name || d.trading_symbol || '').trim();
        const underlying = IndiaInstrumentService.normalizeUnderlying(rawUnderlying);

        // instrument_key = 'NSE_INDEX|26000'; the numeric part is the instrumentToken
        const instrumentKey = (d.instrument_key ?? '').trim();
        const keyParts = instrumentKey.split('|');
        // Use exchange_token if available (more reliable numeric id), else parse from key
        const instrumentToken = d.exchange_token
          ? String(d.exchange_token)
          : keyParts.length === 2 ? keyParts[1] : instrumentKey;

        if (!instrumentToken || !d.trading_symbol) continue;

        out.push({
          instrumentToken,
          instrumentKey,          // full 'NSE_INDEX|26000' — used for WS subscribe
          exchange: file.exchange,
          segment: effectiveSegment,
          tradingSymbol: d.trading_symbol ?? '',
          underlying,
          name: (d.name || d.trading_symbol || '').trim(),
          contractType,
          expiry,
          strike,
          optionType: (instrumentType === 'CE' || instrumentType === 'PE' ? instrumentType : null) as IndiaOptionType | null,
          lotSize: Number(d.lot_size) || 1,
          tickSize: Number(d.tick_size) || 0.05,
          freezeQuantity: null,
          status: 'ACTIVE',
          tradable: true,
        });
      }
    } catch (err) {
      logger.warn('upstox: instrument master parse failed', { url: file.url, err: String(err) });
    }
  }
  return out;
}

/** Bare-date / ISO expiry → epoch at IST midnight of that date (null on garbage). */
export function parseUpstoxExpiry(raw: number | string | null | undefined): number | null {
  if (raw == null || raw === '') return null;
  const dateOnly = String(raw).trim().slice(0, 10);
  const m = dateOnly.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const ts = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - IST_OFFSET_MS;
  return Number.isFinite(ts) ? ts : null;
}

// ---------------------------------------------------------------------------
// Historical candles (spec §13)
// ---------------------------------------------------------------------------

/** Fetch today's intraday candles (1-min resolution) and resample to target timeframe.
 *  Upstox v2 intraday endpoint only supports 1minute and 30minute intervals.
 *  We always fetch 1-minute and aggregate up to any timeframe. */
export async function fetchUpstoxIntradayCandles(
  accessToken: string,
  instrumentKey: string,
  timeframe: IndiaTimeframe,
  canonicalToken?: string,
  canonicalSegment?: string,
  canonicalSymbol?: string,
): Promise<IndiaCandle[]> {
  // Fetch raw 1-minute candles for today
  const url = `${API}/historical-candle/intraday/${encodeURIComponent(instrumentKey)}/1minute`;
  const res = await fetch(url, { headers: { ...upstoxHeaders(accessToken), Accept: 'application/json' } });
  if (!res.ok) return [];
  const json = (await res.json()) as { data?: { candles?: Array<[string, number, number, number, number, number, number]> } };
  const rows = json.data?.candles ?? [];
  if (!rows.length) return [];

  const effectiveToken = canonicalToken ?? (instrumentKey.split('|')[1] ?? instrumentKey);
  const keySegment = instrumentKey.split('|')[0] ?? 'NSE_INDEX';
  const effectiveSegment = (canonicalSegment ?? keySegment) as IndiaSegment;
  const effectiveExchange = effectiveSegment.startsWith('BSE') ? 'BSE' as const : 'NSE' as const;

  // Upstox returns newest-first — sort to ascending
  const oneMin = rows
    .map(r => ({ t: new Date(r[0]).getTime(), o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] ?? 0, oi: r[6] ?? 0 }))
    .sort((a, b) => a.t - b.t);

  // Aggregate 1-min bars into the requested timeframe. The bucket width comes from
  // the shared table rather than a local copy of the same six numbers: this file and
  // the candle engine have to agree about the grid, and two literal tables are two
  // things to keep in step.
  const bucketMs = INDIA_TIMEFRAME_MS[timeframe];

  // Group by timeframe bucket
  const buckets = new Map<number, { o: number; h: number; l: number; c: number; v: number; oi: number }>();
  for (const bar of oneMin) {
    // Session-anchored, not epoch-floored. `Math.floor(t / bucketMs) * bucketMs` put
    // the 30m boundaries at IST :00/:30 and the 1h boundaries at IST :30, so these
    // bars landed on a different grid from the historical endpoint's — different
    // openTime, different id, and both copies survived every dedupe downstream.
    const bucket = indiaBucketStart(bar.t, timeframe);
    const existing = buckets.get(bucket);
    if (!existing) {
      buckets.set(bucket, { o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v, oi: bar.oi });
    } else {
      existing.h = Math.max(existing.h, bar.h);
      existing.l = Math.min(existing.l, bar.l);
      existing.c = bar.c;   // close = last 1m bar's close in this bucket
      existing.v += bar.v;
      existing.oi = bar.oi; // OI = last value in bucket
    }
  }

  const candles: IndiaCandle[] = [];
  for (const [openTime, agg] of buckets) {
    candles.push({
      id: `${effectiveToken}:${timeframe}:${openTime}`,
      exchange: effectiveExchange,
      segment: effectiveSegment,
      instrumentToken: effectiveToken,
      tradingSymbol: canonicalSymbol ?? '',
      underlying: '',
      timeframe,
      open: agg.o,
      high: agg.h,
      low: agg.l,
      close: agg.c,
      volume: agg.v,
      openInterest: agg.oi || null,
      openTime,
      closeTime: openTime + bucketMs,
      state: 'COMPLETED' as const,
      completed: true,
      updatedAt: openTime + bucketMs,
    });
  }
  candles.sort((a, b) => a.openTime - b.openTime);
  return candles;
}

const UPSTOX_INTERVAL: Record<IndiaTimeframe, { unit: 'minutes' | 'hours'; interval: string }> = {
  '1m': { unit: 'minutes', interval: '1' },
  '3m': { unit: 'minutes', interval: '3' },
  '5m': { unit: 'minutes', interval: '5' },
  '15m': { unit: 'minutes', interval: '15' },
  '30m': { unit: 'minutes', interval: '30' },
  '1h': { unit: 'hours', interval: '1' },
};

/** Timeframes already reported as off-grid. The 90-day seed calls the historical
 *  endpoint 6 timeframes × 3 chunks × every index, and one line per timeframe is a
 *  diagnostic while a hundred identical ones are noise. */
const offGridWarned = new Set<IndiaTimeframe>();

export async function fetchUpstoxHistoricalCandles(
  accessToken: string,
  instrumentKey: string,
  timeframe: IndiaTimeframe,
  from: number,
  to: number,
  retries = 2,
  canonicalToken?: string,    // numeric exchange_token e.g. "26000"
  canonicalSegment?: string,  // instrument segment e.g. "NSE_INDEX"
  canonicalSymbol?: string,   // trading symbol e.g. "NIFTY"
): Promise<IndiaCandle[]> {
  // V3 endpoint (current): /v3/historical-candle/{key}/{unit}/{interval}/{to_date}/{from_date}
  const { unit, interval } = UPSTOX_INTERVAL[timeframe];
  // Upstox takes bare dates in the URL and reads them as Indian calendar dates.
  // Building them from the *host's* calendar meant a process running anywhere else
  // asked for the wrong days: 10:00 IST is still the previous date in New York, so
  // `to_date` came out a day early and the newest session was silently missing from
  // every response — no error, just a chart that stops short. Shifting the instant
  // into IST and reading it in UTC gives the Indian date wherever this runs.
  const fmt = (t: number) => new Date(t + IST_OFFSET_MS).toISOString().slice(0, 10);
  const url = `${V3_API}/historical-candle/${encodeURIComponent(instrumentKey)}/${unit}/${interval}/${fmt(to)}/${fmt(from)}`;
  const res = await fetch(url, { headers: { ...upstoxHeaders(accessToken), Accept: 'application/json' } });

  if (res.status === 429 && retries > 0) {
    // Rate limited — back off and retry
    const retryAfterMs = Number(res.headers.get('Retry-After') ?? '2') * 1000;
    await new Promise(r => setTimeout(r, Math.max(retryAfterMs, 2000)));
    return fetchUpstoxHistoricalCandles(accessToken, instrumentKey, timeframe, from, to, retries - 1, canonicalToken, canonicalSegment, canonicalSymbol);
  }
  if (!res.ok) {
    throw new Error(`upstox historical candles failed: HTTP ${res.status} for ${instrumentKey}`);
  }
  const json = (await res.json()) as { data?: { candles?: Array<[string, number, number, number, number, number, number]> } };
  const rows = json.data?.candles ?? [];
  const timeframeMs = INDIA_TIMEFRAME_MS[timeframe];
  // Use canonicalToken (numeric exchange_token like "26000") when provided,
  // otherwise fall back to the string after the pipe in the instrument key.
  const effectiveToken = canonicalToken ?? (instrumentKey.split('|')[1] ?? instrumentKey);
  // Use the instrument's actual segment/exchange; fall back to inferring from the key prefix
  const keySegment = instrumentKey.split('|')[0] ?? 'NSE_INDEX';
  const effectiveSegment = (canonicalSegment ?? keySegment) as IndiaSegment;
  const effectiveExchange = effectiveSegment.startsWith('BSE') ? 'BSE' as const : 'NSE' as const;

  // The broker's own bar timestamps, kept verbatim — with one check.
  //
  // They are deliberately *not* snapped onto `indiaBucketStart`'s lattice. If Upstox
  // anchors its bars to the session (09:15, 09:45, 10:15 …) then snapping would be a
  // no-op and the check below stays silent. But if it anchors hourly bars to the clock
  // (10:00, 11:00 …) then snapping relabels every one of them fifteen minutes early
  // and folds two of them into a single bucket: real prices under invented times, with
  // nothing on screen to give it away. A grid disagreement is at least visible — it
  // draws two interleaved series — and this data is about to be traded on.
  //
  // So keep what the broker sent, and say so when it does not line up with the grid
  // the live and intraday paths build. Then it can be corrected from evidence instead
  // of from a guess about the vendor's convention.
  let offGrid = 0;
  let firstOffGrid = 0;
  const mapped = rows.map((r) => {
    const openTime = new Date(r[0]).getTime();
    if (openTime !== indiaBucketStart(openTime, timeframe)) {
      if (offGrid === 0) firstOffGrid = openTime;
      offGrid += 1;
    }
    return {
      id: `${effectiveToken}:${timeframe}:${openTime}`,
      exchange: effectiveExchange,
      segment: effectiveSegment,
      instrumentToken: effectiveToken,
      tradingSymbol: canonicalSymbol ?? '',
      underlying: '',
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
  if (offGrid && !offGridWarned.has(timeframe)) {
    offGridWarned.add(timeframe);
    logger.warn('india: broker bars sit off the session grid — live and historical bars will not merge on this timeframe', {
      timeframe,
      offGrid,
      of: rows.length,
      firstOffGridIST: new Date(firstOffGrid + IST_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' '),
      expectedIST: new Date(indiaBucketStart(firstOffGrid, timeframe) + IST_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' '),
    });
  }
  // Upstox returns candles newest-first — sort ascending so chart renders correctly
  mapped.sort((a, b) => a.openTime - b.openTime);
  return mapped;
}

// ---------------------------------------------------------------------------
// WebSocket market data feed (protobuf)
// ---------------------------------------------------------------------------

export type UpstoxFeedMode = 'ltp' | 'full';

/** V3 WS subscribe modes (TBT = ltpc: last traded price + close). */
function wsMode(feedMode: UpstoxFeedMode): string {
  return feedMode === 'full' ? 'full' : 'ltpc';
}

export class UpstoxWebSocket {
  private ws: WebSocket | null = null;
  private accessToken: string;
  private instrumentKeys: string[] = [];
  private modeSet = false;
  private guid: string;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private readonly feedMode: UpstoxFeedMode;
  private connecting = false;

  constructor(accessToken: string, opts?: { guid?: string; feedMode?: UpstoxFeedMode }) {
    this.accessToken = accessToken;
    this.feedMode = opts?.feedMode ?? 'ltp';
    this.guid = opts?.guid ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** V3 flow: fetch the one-time authorized socket URI, then connect to it.
   *  Rejects if the authorize endpoint returns an error (e.g. analytics-only token). */
  async connect(handlers: { onTick: (tick: IndiaTick) => void; onConnect: () => void; onDisconnect: (err?: Error) => void; onError: (err: Error) => void }): Promise<void> {
    if (this.connecting) return;
    this.connecting = true;
    try {
      const res = await fetch(`${V3_API}/feed/market-data-feed/authorize`, {
        headers: { Authorization: `Bearer ${this.accessToken}`, Accept: 'application/json' },
      });
      const json = (await res.json().catch(() => ({}))) as { data?: { authorizedRedirectUri?: string; authorized_redirect_uri?: string } };
      const uri = json.data?.authorizedRedirectUri ?? json.data?.authorized_redirect_uri;
      if (!uri) {
        const err = new Error(`upstox: V3 feed authorize failed (${res.status}) — token rejected for streaming`);
        this.connecting = false;
        handlers.onError(err);
        throw err;   // ← propagate so the feed service catches it
      }
      this.connecting = false;
      this.openWs(uri, handlers);
    } catch (err) {
      this.connecting = false;
      const e = err instanceof Error ? err : new Error(String(err));
      // Only call onError if we haven't already thrown (avoid double-calling on the authorize error).
      if (!e.message.startsWith('upstox: V3 feed authorize failed')) {
        handlers.onError(e);
      }
      throw e;       // ← always re-throw so caller sees the failure
    }
  }

  private openWs(uri: string, handlers: { onTick: (tick: IndiaTick) => void; onConnect: () => void; onDisconnect: (err?: Error) => void; onError: (err: Error) => void }): void {
    this.ws = new WebSocket(uri, { headers: { Accept: '*/*' } });
    this.ws.on('open', () => {
      this.applySubscriptions();
      // Keepalive: prevent idle-NAT drops on long TBT sessions.
      this.pingTimer = setInterval(() => {
        if (this.connected) this.ws?.send(JSON.stringify({ guid: this.guid, method: 'ping' }));
      }, 15_000);
      this.pingTimer.unref?.();
      handlers.onConnect();
    });
    this.ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        try {
          const text = JSON.parse(data.toString()) as { type?: string };
          if (text.type === 'success') this.applySubscriptions();
        } catch {
          /* ignore */
        }
        return;
      }
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      if (buf.length < 2) return;
      const len = buf.readUInt16BE(0);
      const payload = buf.subarray(2, 2 + len);
      try {
        const ticks = decodeUpstoxFeedMessage(payload, 'NSE_FUT');
        for (const t of ticks) handlers.onTick(t);
      } catch (err) {
        logger.warn('upstox: protobuf decode failed', { err: String(err) });
      }
    });
    this.ws.on('close', () => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      handlers.onDisconnect();
    });
    this.ws.on('error', (err) => handlers.onError(err));
  }

  private applySubscriptions(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.instrumentKeys.length && !this.modeSet) {
      this.ws.send(JSON.stringify({ guid: this.guid, method: 'sub', data: { instrumentKeys: this.instrumentKeys, mode: wsMode(this.feedMode) } }));
      this.modeSet = true;
    }
  }

  subscribe(keys: string[]): void {
    for (const k of keys) if (!this.instrumentKeys.includes(k)) this.instrumentKeys.push(k);
    if (this.connected) {
      this.ws?.send(JSON.stringify({ guid: this.guid, method: 'sub', data: { instrumentKeys: keys, mode: wsMode(this.feedMode) } }));
    }
  }

  unsubscribe(keys: string[]): void {
    this.instrumentKeys = this.instrumentKeys.filter((k) => !keys.includes(k));
    if (this.connected) {
      this.ws?.send(JSON.stringify({ guid: this.guid, method: 'unsub', data: { instrumentKeys: keys } }));
    }
  }

  close(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.ws?.close();
    this.ws = null;
  }
}

// ---------------------------------------------------------------------------
// Option Chain API
// ---------------------------------------------------------------------------

export async function getOptionChain(accessToken: string, underlying: string, instrumentKeyOverride?: string): Promise<import('../types').OptionChainData | null> {
  try {
    const headers = upstoxHeaders(accessToken);
    if (!headers) {
      logger.warn('upstox: getOptionChain: no auth token available');
      return null;
    }

    // Upstox option chain endpoint requires the master's instrument key
    // ('NSE_INDEX|Nifty 50'). Callers resolve it from the loaded instrument
    // master; without an override we fall back to the legacy concatenation.
    const instrumentKey = instrumentKeyOverride ?? `NSE_INDEX|${underlying}`;
    const url = `${API}/option/chain?instrument_key=${encodeURIComponent(instrumentKey)}`;
    
    const res = await fetch(url, { headers, method: 'GET' });
    if (!res.ok) {
      logger.warn('upstox: getOptionChain: API error', { status: res.status, underlying });
      return null;
    }

    const json = await res.json() as {
      status: string;
      data?: {
        spot_price?: number;
        expiry_dates?: string[];
        strikes?: Array<{
          strike_price: number;
          expiry_date: string;
          call_options?: {
            instrument_key?: string;
            market_data?: {
              ltp?: number;
              oi?: number;
              oi_day_high?: number;
              oi_day_low?: number;
              volume?: number;
              bid_price?: number;
              ask_price?: number;
            };
          };
          put_options?: {
            instrument_key?: string;
            market_data?: {
              ltp?: number;
              oi?: number;
              oi_day_high?: number;
              oi_day_low?: number;
              volume?: number;
              bid_price?: number;
              ask_price?: number;
            };
          };
        }>;
      };
    };

    if (json.status !== 'success' || !json.data?.strikes) {
      logger.warn('upstox: getOptionChain: invalid response', { underlying });
      return null;
    }

    const spotPrice = json.data.spot_price ?? null;
    const strikes: import('../types').OptionStrikeData[] = [];

    for (const strike of json.data.strikes) {
      const callData = strike.call_options?.market_data;
      const putData = strike.put_options?.market_data;
      const expiryDate = new Date(strike.expiry_date).getTime();

      strikes.push({
        strikePrice: strike.strike_price,
        expiryDate,
        call: {
          instrumentToken: strike.call_options?.instrument_key ?? '',
          tradingSymbol: strike.call_options?.instrument_key?.split('|')[1] ?? '',
          ltp: callData?.ltp ?? null,
          oi: callData?.oi ?? null,
          // Upstox returns absolute OI but no change figure, and it returns no
          // implied volatility at all. Both are derived downstream in
          // `india/option-chain.ts`: OI change against a session baseline held
          // by `OptionChainTracker`, IV solved from this leg's own premium by
          // `enrichChain`. They stay null here because the transport layer must
          // not invent values it did not receive.
          oiChange: null,
          volume: callData?.volume ?? null,
          iv: null,
          bid: callData?.bid_price ?? null,
          ask: callData?.ask_price ?? null,
        },
        put: {
          instrumentToken: strike.put_options?.instrument_key ?? '',
          tradingSymbol: strike.put_options?.instrument_key?.split('|')[1] ?? '',
          ltp: putData?.ltp ?? null,
          oi: putData?.oi ?? null,
          // Derived downstream — see the call leg above.
          oiChange: null,
          volume: putData?.volume ?? null,
          iv: null,
          bid: putData?.bid_price ?? null,
          ask: putData?.ask_price ?? null,
        },
      });
    }

    return {
      underlying,
      spotPrice,
      timestamp: Date.now(),
      strikes,
    };
  } catch (err) {
    logger.error('upstox: getOptionChain failed', { underlying, err: String(err) });
    return null;
  }
}