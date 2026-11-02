/**
 * Economic calendar providers.
 *
 * FOREXFACTORY: uses the publicly accessible weekly JSON calendar published
 * by ForexFactory (free, no API key). Data is cached; if the feed is
 * unreachable the calendar is marked DOWN and event-sensitive strategies
 * increase uncertainty / block per policy.
 *
 * NONE: explicit no-calendar mode. Never fabricates events.
 */
import { EconomicEvent, ImpactLevel } from '@fx/shared';
import { EconomicCalendarProvider } from './types';
import { config } from '../config';

const FF_URLS = [
  'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
  'https://nfs.faireconomy.media/ff_calendar_nextweek.json',
];

export interface FfEvent {
  title: string;
  country: string;
  date: string; // "2026-08-14T08:30:00"
  impact: string; // "High"/"Medium"/"Low"
  forecast: string;
  previous: string;
  actual?: string;
}

function parseNumber(s: string | undefined): number | null {
  if (s === undefined || s === null || s === '') return null;
  const cleaned = s.replace(/,/g, '').replace('%', '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Parse the ForexFactory weekly JSON into EconomicEvents (shared by providers). */
export function parseForexFactoryJson(json: FfEvent[]): EconomicEvent[] {
  const out: EconomicEvent[] = [];
  for (const e of json) {
    const ts = new Date(e.date).getTime();
    if (Number.isNaN(ts)) continue;
    const impact = (e.impact?.toUpperCase() as ImpactLevel) ?? 'LOW';
    out.push({
      id: `${e.title}-${e.country}-${ts}`,
      event: e.title,
      currency: e.country,
      timestamp: ts,
      impact: impact === 'HIGH' || impact === 'MEDIUM' || impact === 'LOW' ? impact : 'LOW',
      forecast: parseNumber(e.forecast),
      previous: parseNumber(e.previous),
      actual: parseNumber(e.actual),
      source: 'FOREXFACTORY',
    });
  }
  return out;
}

export class ForexFactoryCalendarProvider implements EconomicCalendarProvider {
  readonly name = 'FOREXFACTORY';
  readonly description =
    'Free public ForexFactory weekly JSON calendar. No API key required. Cached; subject to publisher availability.';
  private connected = false;
  private cache: EconomicEvent[] = [];
  private cacheTime = 0;
  private readonly cacheTtlMs = 10 * 60 * 1000;

  async connect(): Promise<void> {
    this.connected = true;
  }

  private async fetchAll(): Promise<EconomicEvent[]> {
    if (this.cache.length && Date.now() - this.cacheTime < this.cacheTtlMs) return this.cache;
    const out: EconomicEvent[] = [];
    for (const url of FF_URLS) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) continue;
        const json = (await res.json()) as FfEvent[];
        out.push(...parseForexFactoryJson(json));
      } catch {
        /* calendar down is handled by the event engine */
      }
    }
    out.sort((a, b) => a.timestamp - b.timestamp);
    this.cache = out;
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
    try {
      const items = await this.fetchAll();
      return { ok: items.length > 0, detail: items.length ? `${items.length} events cached` : 'calendar returned no events' };
    } catch {
      return { ok: false, detail: 'ForexFactory feed unreachable' };
    }
  }
}

export class NoopCalendarProvider implements EconomicCalendarProvider {
  readonly name = 'NONE';
  readonly description = 'Economic calendar disabled. Event risk is treated as unknown.';
  async connect(): Promise<void> {
    /* noop */
  }
  async getEvents(_from: number, _to: number): Promise<EconomicEvent[]> {
    return [];
  }
  async getUpcomingEvents(_limit = 30): Promise<EconomicEvent[]> {
    return [];
  }
  async health(): Promise<{ ok: boolean; detail: string }> {
    return { ok: false, detail: 'no calendar provider configured (ECONOMIC_CALENDAR_PROVIDER=NONE)' };
  }
}
