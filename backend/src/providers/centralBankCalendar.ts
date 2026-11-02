/**
 * Central-bank economic calendar provider.
 *
 * Combines free, official/public sources into one calendar:
 *
 *   1. ForexFactory weekly JSON (public, no key)  — detailed events with
 *      forecast/previous, including rate decisions, CPI, NFP, GDP, PMI...
 *   2. Federal Reserve FOMC calendar  — official meeting dates
 *      (federalreserve.gov/monetarypolicy/fomccalendars.htm).
 *   3. Bank of England MPC dates      — official decision dates
 *      (bankofengland.co.uk/monetary-policy/upcoming-mpc-dates).
 *   4. Bank of Japan Monetary Policy Meetings — official schedule
 *      (boj.or.jp/en/mopo/mpmsche_minu/index.htm).
 *   5. ECB monetary policy calendar  — official calendar
 *      (ecb.europa.eu) — best effort; may be unreachable from some networks.
 *
 * Every source is independent and fail-safe: one source being down never
 * breaks the calendar. If ALL sources fail the calendar is DOWN and the
 * event engine treats event risk as unknown (news-sensitive strategies stay
 * blocked per policy). We only publish what official pages state (dates);
 * times are the documented typical announcement times and are labeled.
 * No data is fabricated: events come from the feeds or not at all.
 */
import { EconomicEvent, ImpactLevel } from '@fx/shared';
import { EconomicCalendarProvider } from './types';
import { config } from '../config';
import * as cheerio from 'cheerio';
import { parseForexFactoryJson, FfEvent, ForexFactoryCalendarProvider, NoopCalendarProvider } from './calendarProvider';

const FF_URLS = [
  'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
  'https://nfs.faireconomy.media/ff_calendar_nextweek.json',
];

const FED_URL = 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm';
const BOE_URL = 'https://www.bankofengland.co.uk/monetary-policy/upcoming-mpc-dates';
const BOJ_URL = 'https://www.boj.or.jp/en/mopo/mpmsche_minu/index.htm';
const ECB_URL = 'https://www.ecb.europa.eu/press/calendars/monetary-policy/html/index.en.html';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTH_ABBR: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, june: 5, jul: 6, aug: 7, sept: 8, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** "January 27-28" -> [start day, end day] of that month. */
export function parseMonthDayRange(text: string): { month: number; start: number; end: number } | null {
  const m = text.match(/^([A-Z][a-z]+)\s+(\d{1,2})(?:\s*[-–—]\s*(\d{1,2}))?/);
  if (!m) return null;
  const month = MONTHS.findIndex((x) => x.toLowerCase() === m[1].toLowerCase());
  if (month < 0) return null;
  return { month, start: Number(m[2]), end: Number(m[3] ?? m[2]) };
}

// ---- DST-aware local→UTC announcement times --------------------------------
// Announcement instants are fixed in LOCAL time (2pm New York, noon London,
// 14:15 Frankfurt) and shift in UTC twice a year. Hardcoding the summer UTC
// offset moved every event ±1h for half the year.

function nthSundayUtcDay(year: number, month: number, n: number): number {
  const firstDay = new Date(Date.UTC(year, month, 1)).getUTCDay();
  return 1 + ((7 - firstDay) % 7) + (n - 1) * 7;
}

function lastSundayUtcDay(year: number, month: number): number {
  const last = new Date(Date.UTC(year, month + 1, 0));
  return last.getUTCDate() - last.getUTCDay();
}

/** US daylight saving: 2nd Sunday March → 1st Sunday November (±1h boundary). */
export function usDstActive(ts: number): boolean {
  const d = new Date(ts);
  const year = d.getUTCFullYear();
  const start = Date.UTC(year, 2, nthSundayUtcDay(year, 2, 2), 7);
  const end = Date.UTC(year, 10, nthSundayUtcDay(year, 10, 1), 6);
  return ts >= start && ts < end;
}

/** EU/UK daylight saving: last Sunday March → last Sunday October. */
export function euDstActive(ts: number): boolean {
  const d = new Date(ts);
  const year = d.getUTCFullYear();
  const start = Date.UTC(year, 2, lastSundayUtcDay(year, 2), 1);
  const end = Date.UTC(year, 9, lastSundayUtcDay(year, 9), 1);
  return ts >= start && ts < end;
}

/** "2pm New York" in UTC (EDT 18:00 / EST 19:00). */
export function nyLocalToUtc(year: number, month: number, day: number, hourUtcEdt: number): number {
  const naive = Date.UTC(year, month, day, hourUtcEdt, 0, 0);
  return usDstActive(naive) ? naive : naive + 3_600_000;
}

/** Parse Fed FOMC calendar HTML -> events (statement day at 18:00 UTC, typical 2pm ET). */
export function parseFedFomc(html: string): EconomicEvent[] {
  const $ = cheerio.load(html);
  const out: EconomicEvent[] = [];
  $('.panel').each((_, panel) => {
    const heading = $(panel).find('.panel-heading').first().text().replace(/\s+/g, ' ').trim();
    const year = Number(heading.match(/\b(20\d\d)\b/)?.[1] ?? NaN);
    if (!Number.isFinite(year)) return;
    $(panel).find('.fomc-meeting').each((__, meet) => {
      const text = $(meet).text().replace(/\s+/g, ' ').trim();
      const parsed = parseMonthDayRange(text);
      if (!parsed) return;
      const endDay = parsed.end;
      // 2pm ET: 18:00 UTC in summer (EDT), 19:00 UTC in winter (EST).
      const ts = nyLocalToUtc(year, parsed.month, endDay, 18);
      out.push({
        id: `FED-FOMC-${ts}`,
        event: 'FOMC Rate Decision',
        currency: 'USD',
        timestamp: ts,
        impact: 'HIGH' as ImpactLevel,
        forecast: null,
        previous: null,
        actual: null,
        source: 'FED',
      });
    });
  });
  return out;
}

/** Parse BoE upcoming MPC dates HTML -> events (decision day at 12:00 UTC, typical noon UK). */
export function parseBoeMpc(html: string): EconomicEvent[] {
  const $ = cheerio.load(html);
  const out: EconomicEvent[] = [];
  $('h2').each((_, h) => {
    const heading = $(h).text().replace(/\s+/g, ' ').trim();
    const year = Number(heading.match(/\b(20\d\d)\b/)?.[1] ?? NaN);
    if (!Number.isFinite(year)) return;
    const table = $(h).nextAll('table').first();
    table.find('tr').each((__, tr) => {
      const cell = $(tr).find('td').first().text().replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
      const m = cell.match(/^[A-Z][a-z]+\s+(\d{1,2})\s+([A-Z][a-z]+)/);
      if (!m) return;
      const month = MONTHS.findIndex((x) => x.toLowerCase() === m[2].toLowerCase());
      if (month < 0) return;
      // noon London: 12:00 UTC in winter (GMT), 11:00 UTC in summer (BST).
      const naive = Date.UTC(year, month, Number(m[1]), 12, 0, 0);
      const ts = euDstActive(naive) ? naive - 3_600_000 : naive;
      out.push({
        id: `BOE-MPC-${ts}`,
        event: 'BoE Interest Rate Decision (MPC)',
        currency: 'GBP',
        timestamp: ts,
        impact: 'HIGH' as ImpactLevel,
        forecast: null,
        previous: null,
        actual: null,
        source: 'BOE',
      });
    });
  });
  return out;
}

/** Parse BoJ Monetary Policy Meetings HTML -> events (end day at 03:00 UTC, typical 12:00 JST). */
export function parseBojMpm(html: string): EconomicEvent[] {
  const $ = cheerio.load(html);
  const out: EconomicEvent[] = [];
  $('h2').each((_, h) => {
    const heading = $(h).text().replace(/\s+/g, ' ').trim();
    const year = Number(heading.match(/\b(20\d\d)\b/)?.[1] ?? NaN);
    if (!Number.isFinite(year)) return;
    // The year's table is usually a sibling of the h2, but some layouts wrap it
    // in a child div — fall back to the first table inside the same parent.
    const table = $(h).nextAll('table').first().length
      ? $(h).nextAll('table').first()
      : $(h).parent().find('table').first();
    table.find('tr').each((__, tr) => {
      const cell = $(tr).find('td').first().text().replace(/\s+/g, ' ').trim();
      // "Mar. 17 (Wed.), 18 (Thurs.)" — first cell lists the MPM meeting days.
      const m = cell.match(/^([A-Z][a-z]+)\.?\s+(\d{1,2})\s*\([^)]*\)\s*,\s*(\d{1,2})\s*\(/);
      if (!m) return;
      const month = MONTH_ABBR[m[1].toLowerCase()];
      if (month === undefined) return;
      const endDay = Number(m[3]);
      const ts = Date.UTC(year, month, endDay, 3, 0, 0); // decision ~12:00 JST
      out.push({
        id: `BOJ-MPM-${ts}`,
        event: 'BoJ Monetary Policy Meeting Decision',
        currency: 'JPY',
        timestamp: ts,
        impact: 'HIGH' as ImpactLevel,
        forecast: null,
        previous: null,
        actual: null,
        source: 'BOJ',
      });
    });
  });
  return out;
}

/** Parse ECB monetary policy calendar HTML -> events (decision 13:15 CET typical).
 *  ECB pages use day-first dates like "12 March 2026". */
export function parseEcbMpc(html: string): EconomicEvent[] {
  const $ = cheerio.load(html);
  const out: EconomicEvent[] = [];
  $('tbody tr, .calendar tbody tr').each((_, tr) => {
    const text = $(tr).text().replace(/\s+/g, ' ').trim();
    // day-first: "12 March 2026"
    const m = text.match(/(\d{1,2})\s+([A-Z][a-z]+)\s+(20\d\d)/);
    if (!m) return;
    const month = MONTHS.findIndex((x) => x.toLowerCase() === m[2].toLowerCase());
    if (month < 0) return;
    // 14:15 Frankfurt: 13:15 UTC in winter (CET), 12:15 UTC in summer (CEST).
    const naive = Date.UTC(Number(m[3]), month, Number(m[1]), 13, 15, 0);
    const ts = euDstActive(naive) ? naive - 3_600_000 : naive;
    out.push({
      id: `ECB-MPC-${ts}`,
      event: 'ECB Monetary Policy Decision',
      currency: 'EUR',
      timestamp: ts,
      impact: 'HIGH' as ImpactLevel,
      forecast: null,
      previous: null,
      actual: null,
      source: 'ECB',
    });
  });
  return out;
}

async function fetchText(url: string, timeoutMs = 10_000): Promise<string> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/xml' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function fetchForexFactory(): Promise<EconomicEvent[]> {
  const out: EconomicEvent[] = [];
  for (const url of FF_URLS) {
    try {
      // The feed serves JSON only to a browser-like UA; a bare fetch gets an HTML block page.
      const res = await fetch(url, {
        signal: AbortSignal.timeout(8000),
        headers: { 'User-Agent': UA, Accept: 'application/json' },
      });
      if (!res.ok) continue;
      const text = await res.text();
      if (!text.trim().startsWith('[')) continue; // not the JSON calendar
      out.push(...parseForexFactoryJson(JSON.parse(text) as FfEvent[]));
    } catch {
      /* independent source */
    }
  }
  return out;
}

const RATE_DECISION_HINTS = ['rate decision', 'fomc', 'mpc', 'monetary policy', 'interest rate', 'boj', 'ecb', 'fed'];

export class CentralBankCalendarProvider implements EconomicCalendarProvider {
  readonly name = 'CENTRALBANK';
  readonly description =
    'Official central-bank calendars (Fed FOMC, BoE MPC, BoJ MPM, ECB) merged with the free ForexFactory weekly JSON. No API key. Each source fails independently; nothing is fabricated.';
  private connected = false;
  private cache: EconomicEvent[] = [];
  private cacheTime = 0;
  private readonly cacheTtlMs = 15 * 60 * 1000;

  async connect(): Promise<void> {
    this.connected = true;
  }

  private async fetchAll(): Promise<EconomicEvent[]> {
    if (this.cache.length && Date.now() - this.cacheTime < this.cacheTtlMs) return this.cache;
    const [ff, fed, boe, boj, ecb] = await Promise.allSettled([
      fetchForexFactory(),
      fetchText(FED_URL).then(parseFedFomc),
      fetchText(BOE_URL).then(parseBoeMpc),
      fetchText(BOJ_URL).then(parseBojMpm),
      fetchText(ECB_URL).then(parseEcbMpc),
    ]);
    const merged: EconomicEvent[] = [];
    if (ff.status === 'fulfilled') merged.push(...ff.value);
    if (fed.status === 'fulfilled') merged.push(...fed.value);
    if (boe.status === 'fulfilled') merged.push(...boe.value);
    if (boj.status === 'fulfilled') merged.push(...boj.value);
    if (ecb.status === 'fulfilled') merged.push(...ecb.value);

    // Dedupe: one event per currency + 30-minute time bucket. The old
    // currency+DAY key silently deleted DISTINCT same-day events (a US CPI
    // morning release vanished when the FOMC entry arrived, or vice versa).
    // Within the same bucket the richer ForexFactory detail wins over a bare
    // official rate-decision stub.
    const bySlot = new Map<string, EconomicEvent>();
    const isRateHint = (e: EconomicEvent): boolean => RATE_DECISION_HINTS.some((h) => e.event.toLowerCase().includes(h));
    for (const e of merged) {
      const slot = Math.round(e.timestamp / (30 * 60_000));
      const key = `${e.currency}-${slot}`;
      const existing = bySlot.get(key);
      if (!existing) {
        bySlot.set(key, e);
        continue;
      }
      if (existing.source === 'FOREXFACTORY' && e.source !== 'FOREXFACTORY') continue;
      if (isRateHint(e) && !isRateHint(existing)) {
        bySlot.set(key, e);
      }
    }
    this.cache = [...bySlot.values()].sort((a, b) => a.timestamp - b.timestamp);
    this.cacheTime = Date.now();
    return this.cache;
  }

  async getEvents(from: number, to: number): Promise<EconomicEvent[]> {
    const all = await this.fetchAll();
    return all.filter((e) => e.timestamp >= from && e.timestamp <= to);
  }

  async getUpcomingEvents(limit = 30): Promise<EconomicEvent[]> {
    const all = await this.fetchAll();
    const now = Date.now();
    return all.filter((e) => e.timestamp >= now).slice(0, limit);
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    if (!this.connected) return { ok: false, detail: 'not connected' };
    try {
      const items = await this.fetchAll();
      const sources = [...new Set(items.map((e) => e.source))];
      return { ok: items.length > 0, detail: items.length ? `${items.length} events from ${sources.join(', ')}` : 'no calendar events received' };
    } catch {
      return { ok: false, detail: 'all calendar sources unreachable' };
    }
  }
}

export function createCalendarProvider(): EconomicCalendarProvider {
  switch (config.economicCalendarProvider) {
    case 'CENTRALBANK':
      return new CentralBankCalendarProvider();
    case 'FOREXFACTORY':
      return new ForexFactoryCalendarProvider();
    case 'TWELVEDATA':
      throw new Error('TWELVEDATA calendar provider not implemented in this build; use CENTRALBANK');
    default:
      return new NoopCalendarProvider();
  }
}
