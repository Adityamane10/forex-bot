/**
 * Angel One SmartAPI market data (spec §3, §11, §13).
 *
 * REST-poll transport: the quote endpoint accepts up to 50 tokens per call in
 * LTP/OHLC modes, which slots straight into the feed service's existing
 * fallback-poll design (the same mode the Upstox analytics credential runs in).
 *
 * Instrument master: Angel's public OpenAPIScripMaster.json — no auth needed.
 *   NSE + instrumenttype AMXIDX        → indices      (NIFTY 99926000 …)
 *   NFO + OPTIDX / FUTIDX              → options/futures
 *   strikes arrive ×100 ("2615000" = ₹26150), expiry as DDMMMYYYY.
 */
import gunzipSync from 'node:zlib';
import type { IndiaCandle, IndiaInstrument, IndiaTick, IndiaTimeframe } from '@fx/shared';
import { IndiaSegment, IndiaContractType, INDIA_TIMEFRAME_MS, INDIA_IST_OFFSET_MS, indiaBucketStart } from '@fx/shared';
import type { AngelSession } from './angelone-auth';
import { angelHeaders } from './angelone-auth';
import { INDIA_LOT_SIZE_REFERENCE } from '../../lot-size';
import { logger } from '../../../core/logger';

const API_ROOT = 'https://apiconnect.angelone.in';
const MASTER_URL = 'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json';

// ---------------------------------------------------------------------------
// Instrument master
// ---------------------------------------------------------------------------

export interface AngelScripRow {
  token: string;
  symbol: string;
  name: string;
  expiry?: string;
  strike?: string;
  lotsize?: string | null;
  instrumenttype?: string;
  exch_seg: string;
  tick_size?: string;
}

/** "01SEP2026" → epoch ms of that date's IST midnight. */
export function parseAngelExpiry(raw: string | undefined): number | null {
  if (!raw || raw.length < 9) return null;
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const dd = raw.slice(0, 2);
  const mon = raw.slice(2, 5).toUpperCase();
  const yyyy = raw.slice(5, 9);
  const m = months.indexOf(mon);
  if (m === -1) return null;
  return Date.UTC(Number(yyyy), m, Number(dd)) - INDIA_IST_OFFSET_MS;
}

/** Underlying canonicalisation for the names this master actually emits. */
export function angelUnderlying(nameOrSymbol: string): string {
  const up = nameOrSymbol.trim().toUpperCase();
  if (up === 'NIFTY' || up.startsWith('NIFTY 50') || up === 'NIFTY 50') return 'NIFTY';
  if (up.includes('BANKNIFTY') || up.includes('NIFTY BANK')) return 'BANKNIFTY';
  if (up.includes('FINNIFTY') || up.includes('FIN SERVICE')) return 'FINNIFTY';
  if (up.includes('MIDCPNIFTY') || up.includes('MIDCAP SELECT')) return 'MIDCPNIFTY';
  return up.replace(/\s+/g, '');
}

/** Pure mapper: scrip-master rows → IndiaInstruments. Split from the fetch so
 *  the (large, versioned) master's shape can be tested offline. */
export function mapAngelRows(rows: AngelScripRow[]): IndiaInstrument[] {
  const out: IndiaInstrument[] = [];
  for (const d of rows) {
    // Indices: cash segment flagged AMXIDX. Derivatives: NFO OPTIDX/FUTIDX on
    // the underlyings we trade. Everything else is out of scope for this engine.
    const isIndex = d.exch_seg === 'NSE' && d.instrumenttype === 'AMXIDX';
    const isOpt = d.exch_seg === 'NFO' && d.instrumenttype === 'OPTIDX';
    const isFut = d.exch_seg === 'NFO' && d.instrumenttype === 'FUTIDX';
    if (!isIndex && !isOpt && !isFut) continue;

    const underlying = angelUnderlying(d.name);
    if (isIndex) {
      const keep = underlying === 'NIFTY' || underlying === 'BANKNIFTY' || underlying === 'FINNIFTY' || underlying === 'MIDCPNIFTY';
      if (!keep) continue;
    } else {
      // Options/futures rows carry the underlying inside `name` (e.g. NIFTY,
      // BANKNIFTY); anything outside the traded set would only waste scans.
      const keep = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY'].includes(underlying);
      if (!keep) continue;
    }

    const contractType: IndiaContractType = isIndex ? 'INDEX' : isFut ? 'FUT' : 'OPT';
    const segment: IndiaSegment = isIndex ? 'NSE_INDEX' : isFut ? 'NSE_FUT' : 'NSE_OPT';
    const optionType = isOpt ? ((d.symbol.endsWith('CE') ? 'CE' : 'PE') as IndiaInstrument['optionType']) : null;
    const strike = isOpt ? Number(d.strike ?? 0) / 100 : null;
    // A blank FO lot means "no data" — writing the reference table's value
    // here masked master drift and sized positions at a stale mandated size.
    // Fail closed instead: the lot-validation layer rejects trading on any
    // instrument whose master carries no explicit lot size.
    const rawLot = Math.floor(Number(d.lotsize) || 0);
    const lotSize = rawLot > 0 ? rawLot : 0;
    void INDIA_LOT_SIZE_REFERENCE;
    // Angel stores tick in paise (5 = 0.05, 10 = 0.10) for OPT/FUT. Keep index ticks as-is.
    const rawTick = Number(d.tick_size);
    let tickSize: number;
    if (rawTick > 0) {
      if ((isOpt || isFut) && rawTick >= 1) tickSize = rawTick / 100;
      else tickSize = rawTick;
    } else {
      tickSize = 0.05;
    }

    out.push({
      instrumentToken: d.token, // Angel's own token id — the single id downstream
      instrumentKey: `${d.exch_seg}|${d.token}`,
      exchange: 'NSE',
      segment,
      tradingSymbol: d.symbol,
      underlying,
      name: d.name,
      contractType,
      expiry: parseAngelExpiry(d.expiry),
      strike,
      optionType,
      lotSize,
      tickSize,
      freezeQuantity: null,
      status: 'ACTIVE',
      tradable: true,
    });
  }
  return out;
}

export async function fetchAngelInstruments(): Promise<IndiaInstrument[]> {
  const res = await fetch(MASTER_URL);
  if (!res.ok) throw new Error(`angelone master fetch failed: HTTP ${res.status}`);
  const raw = await res.json() as AngelScripRow[];
  return mapAngelRows(raw);
}

// ---------------------------------------------------------------------------
// Quotes (batched LTP / OHLC)
// ---------------------------------------------------------------------------

const MAX_TOKENS_PER_CALL = 50;

/** HTTP-level failure with its status — the adapter's re-login path keys off
 *  it. Swallowing statuses into `null` made JWT expiry (daily ~05:00 IST)
 *  permanently silent: no re-login ever fired and the feed flatlined. */
export class AngelHttpError extends Error {
  constructor(public readonly status: number, path: string) {
    super(`angelone HTTP ${status} on ${path}`);
    this.name = 'AngelHttpError';
  }
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function angelPost(session: AngelSession, path: string, body: unknown): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${API_ROOT}${path}`, {
    method: 'POST',
    headers: angelHeaders(session),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new AngelHttpError(res.status, path);
  const json = (await res.json().catch(() => null)) as { status?: boolean; data?: Record<string, unknown>; message?: string } | null;
  if (!json?.status || !json.data) return null;
  return json.data;
}

/** Fetch last-traded prices for up to N tokens across NFO/NSE in batched calls. */
export async function fetchAngelLtpBatch(
  session: AngelSession,
  instruments: IndiaInstrument[],
): Promise<IndiaTick[]> {
  if (!instruments.length) return [];
  const byExchange = new Map<string, IndiaInstrument[]>();
  for (const i of instruments) {
    const exch = i.segment === 'NSE_INDEX' ? 'NSE' : 'NFO';
    if (!byExchange.has(exch)) byExchange.set(exch, []);
    byExchange.get(exch)!.push(i);
  }

  const now = Date.now();
  const ticks: IndiaTick[] = [];
  for (const [exchange, list] of byExchange) {
    for (const group of chunk(list, MAX_TOKENS_PER_CALL)) {
      let data: Record<string, unknown> | null;
      try {
        data = await angelPost(session, '/rest/secure/angelbroking/market/v1/quote/', {
          mode: 'LTP',
          exchangeTokens: { [exchange]: group.map((i) => i.instrumentToken) },
        });
      } catch (err) {
        // Auth failures MUST propagate so the adapter re-logs in; other HTTP
        // errors degrade this batch to empty (same as the old null path).
        if (err instanceof AngelHttpError && (err.status === 401 || err.status === 403)) throw err;
        continue;
      }
      if (!data) continue;
      const fetched = (data.fetched ?? []) as Array<{ symbolToken?: string; ltp?: number; tradingSymbol?: string }>;
      const feeds = (data.feeds ?? data.data ?? {}) as Record<string, { ltp?: number } | undefined>;
      for (const instr of group) {
        let ltp: number | undefined =
          fetched.find((f) => f.symbolToken === instr.instrumentToken)?.ltp ??
          feeds[`${exchange}:${instr.instrumentToken}`]?.ltp;
        if (ltp == null) continue;
        ticks.push({
          exchange: instr.exchange,
          segment: instr.segment,
          instrumentToken: instr.instrumentToken,
          tradingSymbol: instr.tradingSymbol,
          underlying: instr.underlying,
          marketTimestamp: now,
          receivedAt: now,
          timestamp: now,
          ltp: Number(ltp),
          bid: null, ask: null, bidQuantity: null, askQuantity: null,
          volume: null, openInterest: null,
          dayOpen: null, dayHigh: null, dayLow: null,
          previousClose: null, lastTradeQuantity: null,
          source: 'ANGELONE',
          tradable: true,
        });
      }
    }
  }
  return ticks;
}

// ---------------------------------------------------------------------------
// Historical candles (v1 getCandleData — covers today via ONE_MINUTE too)
// ---------------------------------------------------------------------------

const ANGEL_INTERVAL: Record<IndiaTimeframe, string> = {
  '1m': 'ONE_MINUTE',
  '3m': 'THREE_MINUTE',
  '5m': 'FIVE_MINUTE',
  '15m': 'FIFTEEN_MINUTE',
  '30m': 'THIRTY_MINUTE',
  '1h': 'ONE_HOUR',
};

const istDate = (t: number): string => new Date(t + INDIA_IST_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ');

const candleErrorLogged = new Set<string>();

/**
 * Historical-endpoint pacing. SmartAPI answers `403 exceeding access rate` to
 * bursts — and the boot seed plus route top-ups can easily fire three calls in
 * half a second. A global minimum gap between historical calls, plus
 * exponential retry on rate rejections, turns those hard failures into a few
 * hundred extra milliseconds.
 */
let lastHistoricalCallAt = 0;
const HIST_MIN_GAP_MS = 500;

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/** Candles for a window. Aggregates from 1-minute bars so every timeframe sits
 *  on the same session-anchored grid the live candle engine builds. */
export async function fetchAngelHistoricalCandles(
  session: AngelSession,
  instr: IndiaInstrument,
  timeframe: IndiaTimeframe,
  from: number,
  to: number,
): Promise<IndiaCandle[]> {
  const exchange = instr.segment === 'NSE_INDEX' ? 'NSE' : 'NFO';
  // Angel's date grammar is "YYYY-MM-DD HH:MM" — WITH seconds it answers 400
  // with a generic error, which used to surface here as a silent empty buffer
  // and a chart with no history at all.
  const body = {
    exchange,
    symboltoken: instr.instrumentToken,
    interval: ANGEL_INTERVAL['1m'],
    fromdate: istDate(from),
    todate: istDate(to),
  };

  let rows: Array<[string, number, number, number, number, number]> = [];
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const gap = Date.now() - lastHistoricalCallAt;
    if (gap < HIST_MIN_GAP_MS) await sleep(HIST_MIN_GAP_MS - gap);
    lastHistoricalCallAt = Date.now();

    const res = await fetch(`${API_ROOT}/rest/secure/angelbroking/historical/v1/getCandleData`, {
      method: 'POST',
      headers: angelHeaders(session),
      body: JSON.stringify(body),
    });
    if ((res.status === 403 || res.status === 429) && attempt < 3) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (res.status === 401) {
      // Expired JWT — must reach the adapter so it can transparently re-login.
      throw new AngelHttpError(401, '/historical/v1/getCandleData');
    }
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      if (!candleErrorLogged.has(instr.instrumentToken)) {
        candleErrorLogged.add(instr.instrumentToken);
        logger.warn('angelone: historical candles failed', { token: instr.instrumentToken, status: res.status, err: errBody.slice(0, 200) });
      }
      return [];
    }
    const json = (await res.json().catch(() => null)) as
      | { status?: boolean; data?: unknown }
      | null;
    if (!json?.status || !json.data) return [];
    // getCandleData puts the row array DIRECTLY under `data`
    // ("data":[[ts,o,h,l,c,v],…]) — not nested under a `candles` key.
    const rowsRaw = Array.isArray(json.data)
      ? json.data
      : ((json.data as { candles?: Array<[string, number, number, number, number, number]> }).candles ?? []);
    rows = rowsRaw as Array<[string, number, number, number, number, number]>;
    break;
  }
  if (!rows.length) return [];

  // 1-minute bars ascending → aggregate onto the shared bucket grid.
  const bucketMs = INDIA_TIMEFRAME_MS[timeframe];
  const buckets = new Map<number, { o: number; h: number; l: number; c: number; v: number }>();
  for (const r of rows) {
    const t = new Date(r[0]).getTime();
    if (!Number.isFinite(t)) continue;
    const b = indiaBucketStart(t, timeframe);
    const cur = buckets.get(b);
    if (!cur) buckets.set(b, { o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] ?? 0 });
    else {
      cur.h = Math.max(cur.h, r[2]);
      cur.l = Math.min(cur.l, r[3]);
      cur.c = r[4];
      cur.v += r[5] ?? 0;
    }
  }
  void bucketMs;

  const candles: IndiaCandle[] = [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([openTime, agg]) => ({
      id: `${instr.instrumentToken}:${timeframe}:${openTime}`,
      exchange: instr.exchange,
      segment: instr.segment,
      instrumentToken: instr.instrumentToken,
      tradingSymbol: instr.tradingSymbol,
      underlying: instr.underlying,
      timeframe,
      open: agg.o,
      high: agg.h,
      low: agg.l,
      close: agg.c,
      volume: agg.v,
      openInterest: null,
      openTime,
      closeTime: openTime + INDIA_TIMEFRAME_MS[timeframe],
      state: openTime + INDIA_TIMEFRAME_MS[timeframe] <= Date.now() ? ('COMPLETED' as const) : ('OPEN' as const),
      completed: openTime + INDIA_TIMEFRAME_MS[timeframe] <= Date.now(),
      updatedAt: Date.now(),
    }));
  return candles;
}
