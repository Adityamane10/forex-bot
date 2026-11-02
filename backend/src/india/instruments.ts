/**
 * IndiaInstrumentService (spec §11). Loads the REAL broker instrument master,
 * selects the currently-valid contracts (indices, futures, options) and keeps
 * the metadata available via in-memory index + Redis cache + Mongo persistence.
 * Contracts are NEVER hard-coded — actual broker metadata drives everything.
 */
import type { IndiaInstrument, IndiaSegment, IndiaUnderlying } from '@fx/shared';
import { IndiaContractType, INDIA_COLLECTIONS, INDIA_REDIS_KEYS, INDIA_DEFAULT_UNDERLYINGS } from '@fx/shared';
import { DataStore } from '../db/store';
import { Cache } from '../db/cache';
import { IndiaBrokerAdapter } from './brokers/types';
import { indiaConfig } from './config';
import { expiryInstant } from './options-math';
import { logger } from '../core/logger';

export class IndiaInstrumentService {
  private byToken = new Map<string, IndiaInstrument>();
  /** Secondary lookup by broker instrument_key (e.g. 'NSE_INDEX|26000') for Upstox. */
  private byKey = new Map<string, IndiaInstrument>();
  private instruments: IndiaInstrument[] = [];
  private refreshedAt = 0;
  private refreshInFlight: Promise<IndiaInstrument[]> | null = null;

  constructor(
    private store: DataStore,
    private cache: Cache,
    private adapter: IndiaBrokerAdapter,
  ) {}

  /** Fetch the instrument master from the broker and cache/persist it. */
  async refresh(): Promise<IndiaInstrument[]> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = (async () => {
      const master = await this.adapter.getInstruments();
      const filtered = this.selectRelevant(master);
      this.instruments = filtered;
      this.byToken = new Map(filtered.map((i) => [i.instrumentToken, i]));
      this.byKey = new Map(filtered.filter((i) => i.instrumentKey).map((i) => [i.instrumentKey!, i]));
      this.refreshedAt = Date.now();
      await this.cache
        .set(INDIA_REDIS_KEYS.instrument + 'master', JSON.stringify(filtered), 12 * 3600_000)
        .catch(() => undefined);
      for (const instr of filtered) {
        await this.store.insertOne(INDIA_COLLECTIONS.instruments, { ...instr, syncedAt: Date.now() }).catch(() => undefined);
      }
      logger.info('india: instrument master loaded', { count: filtered.length });
      return filtered;
    })().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  /** Load the master from Redis/Mongo without hitting the broker (recovery). */
  async loadCached(): Promise<IndiaInstrument[]> {
    try {
      const raw = await this.cache.get(INDIA_REDIS_KEYS.instrument + 'master');
      if (raw) {
        const list = JSON.parse(raw) as IndiaInstrument[];
        this.instruments = list;
        this.byToken = new Map(list.map((i) => [i.instrumentToken, i]));
        this.byKey = new Map(list.filter((i) => i.instrumentKey).map((i) => [i.instrumentKey!, i]));
        return list;
      }
    } catch {
      /* fall through to store */
    }
    try {
      const stored = await this.store.find<IndiaInstrument>(INDIA_COLLECTIONS.instruments, {}, { syncedAt: -1 }, 500);
      if (stored.length) {
        const seen = new Map<string, IndiaInstrument>();
        for (const s of stored) seen.set(s.instrumentToken, s);
        this.instruments = [...seen.values()];
        this.byToken = seen;
        this.byKey = new Map(this.instruments.filter((i) => i.instrumentKey).map((i) => [i.instrumentKey!, i]));
        return this.instruments;
      }
    } catch {
      /* no persisted master yet */
    }
    return [];
  }

  /** Normalise broker-specific underlying strings to canonical short names.
   *  Upstox: "NIFTY 50" → "NIFTY", "NIFTY BANK" → "BANKNIFTY", etc.
   *  Zerodha: same broker names come from the `name` CSV column. */
  /** Normalise broker-specific underlying strings to canonical short names.
   *  Only the three primary trading indices are normalised. All other instrument
   *  names (e.g. "NIFTY100 Qualty30", "NIFTY REALTY") are returned as-is so
   *  they don't pollute the NIFTY universe and get filtered out by selectRelevant.
   */
  static normalizeUnderlying(raw: string): string {
    const u = (raw ?? '').toUpperCase().trim();
    // NIFTY 50 — exact matches only
    if (u === 'NIFTY 50' || u === 'NIFTY50' || u === 'NIFTY') return 'NIFTY';
    // BANK NIFTY — exact matches only
    if (u === 'NIFTY BANK' || u === 'BANKNIFTY' || u === 'BANK NIFTY') return 'BANKNIFTY';
    // FIN NIFTY — exact matches only
    if (u === 'FINNIFTY' || u === 'NIFTY FIN SERVICE' || u === 'NIFTY FINANCIAL SERVICES' || u === 'NIFTY FIN SERVICES') return 'FINNIFTY';
    // MIDCAP — exact matches only
    if (u === 'MIDCPNIFTY' || u === 'NIFTY MIDCAP SELECT' || u === 'NIFTY MID SELECT' || u.includes('MIDCP')) return 'MIDCPNIFTY';
    // Return raw — do NOT bucket "NIFTY100 XYZ", "NIFTY REALTY" etc. under NIFTY
    return raw.trim();
  }

  /** Keep only the F&O universe relevant to the intraday engine. */
  private selectRelevant(master: IndiaInstrument[]): IndiaInstrument[] {
    const underlyings = new Set<string>(indiaConfig.underlyings.length ? indiaConfig.underlyings : INDIA_DEFAULT_UNDERLYINGS);
    const now = Date.now();
    const cutoff = now + indiaConfig.expiryLookaheadDays * 24 * 3600_000;

    // First pass: normalise the underlying field on every instrument so that
    // all downstream comparisons use canonical names (NIFTY, BANKNIFTY, …).
    const normalised = master.map((i) => ({
      ...i,
      underlying: IndiaInstrumentService.normalizeUnderlying(i.underlying),
    }));

    const relevant = normalised.filter((i) => {
      const name = i.underlying.toUpperCase();
      // EXACT match only: substring matching admitted 'NIFTY NEXT 50' (and
      // other NIFTY-suffixed indices with their own F&O chains) into the
      // NIFTY universe, corrupting ATM selection and OI analytics.
      if (![...underlyings].some((u) => name === u.toUpperCase())) return false;
      // Expiry comparisons go through expiryInstant(): raw bare-date epochs
      // are IST/UTC midnight, so `expiry < now` was true at 05:30 IST on
      // expiry day and dropped today-expiring contracts for the whole session.
      if (i.expiry && expiryInstant(i.expiry) <= now) return false; // already expired
      if (i.expiry && i.expiry > cutoff) return false; // too far out
      if (i.contractType === 'INDEX') return i.segment === 'NSE_INDEX' || i.segment === 'BSE_INDEX';
      if (i.contractType === 'FUT') return indiaConfig.includeFutures;
      if (i.contractType === 'OPT') return indiaConfig.includeOptions;
      return false;
    });
    return relevant;
  }

  /** Instruments eligible for live subscription + trading right now.
   *  Always includes INDEX instruments (they are the price reference for charts
   *  and options analysis even when market is closed). */
  executionInstruments(): IndiaInstrument[] {
    const now = Date.now();
    return this.instruments.filter((i) => {
      // INDEX instruments are always included — needed for chart seeding and
      // tick subscription regardless of tradable flag or time-of-day.
      if (i.contractType === 'INDEX') return true;
      if (!i.tradable || i.status !== 'ACTIVE') return false;
      if (i.expiry && expiryInstant(i.expiry) <= now) return false;
      return true;
    });
  }

  /** All index instruments (NSE_INDEX + BSE_INDEX). */
  indexInstruments(): IndiaInstrument[] {
    return this.instruments.filter((i) => i.contractType === 'INDEX' && (i.segment === 'NSE_INDEX' || i.segment === 'BSE_INDEX'));
  }

  /** Primary index instruments — exactly ONE per configured underlying.
   *  Matches by tradingSymbol first (most reliable), falls back to underlying+segment.
   *  NIFTY 50 tradingSymbol = "NIFTY", BANKNIFTY = "BANKNIFTY", FINNIFTY = "FINNIFTY". */
  primaryIndexInstruments(): IndiaInstrument[] {
    // Maps underlying canonical name → known tradingSymbol values from broker
    const targets: Record<string, string[]> = {
      NIFTY:     ['NIFTY'],
      BANKNIFTY: ['BANKNIFTY'],
      FINNIFTY:  ['FINNIFTY'],
    };
    const result: IndiaInstrument[] = [];
    for (const [underlying, syms] of Object.entries(targets)) {
      // Priority 1: NSE_INDEX instrument whose tradingSymbol exactly matches
      const bySymbol = this.instruments.find(i =>
        i.contractType === 'INDEX' &&
        i.segment === 'NSE_INDEX' &&
        syms.some(s => i.tradingSymbol.toUpperCase() === s)
      );
      if (bySymbol) { result.push(bySymbol); continue; }
      // Priority 2: NSE_INDEX whose underlying exactly matches (in case symbol differs)
      const byUnderlying = this.instruments.find(i =>
        i.contractType === 'INDEX' &&
        i.segment === 'NSE_INDEX' &&
        i.underlying === underlying
      );
      if (byUnderlying) result.push(byUnderlying);
    }
    return result;
  }

  getByToken(token: string): IndiaInstrument | null {
    return this.byToken.get(token) ?? this.byKey.get(token) ?? null;
  }

  /** Lookup by broker instrument_key (Upstox format: 'NSE_INDEX|26000'). */
  getByKey(key: string): IndiaInstrument | null {
    return this.byKey.get(key) ?? null;
  }

  all(): IndiaInstrument[] {
    return this.instruments;
  }

  /** Underlyings currently present in the master. */
  underlyings(): string[] {
    const set = new Set<string>();
    for (const i of this.instruments) set.add(i.underlying);
    return [...set];
  }

  /**
   * Futures contracts for an underlying, nearest expiry first. Used by the
   * contract/expiry lifecycle (spec §12).
   */
  futuresFor(underlying: string): IndiaInstrument[] {
    return this.instruments
      .filter((i) => i.contractType === 'FUT' && (i.underlying ?? '').toUpperCase() === underlying.toUpperCase() && (!i.expiry || expiryInstant(i.expiry) > Date.now()))
      .sort((a, b) => (a.expiry ?? 0) - (b.expiry ?? 0));
  }

  /**
   * Option contracts for an underlying on a given expiry, sorted by strike.
   */
  optionsFor(underlying: string, expiry: number): IndiaInstrument[] {
    return this.instruments
      .filter((i) => i.contractType === 'OPT' && (i.underlying ?? '').toUpperCase() === underlying.toUpperCase() && i.expiry === expiry)
      .sort((a, b) => (a.strike ?? 0) - (b.strike ?? 0));
  }

  /**
   * Expand the option universe around the live index price: ATM strikes ±
   * configured band (spec §2). Re-run whenever the underlying moves far.
   */
  optionStrikesAround(underlying: string, expiry: number, spotPrice: number, band: number): IndiaInstrument[] {
    const all = this.optionsFor(underlying, expiry);
    const atm = all.reduce((best, cur) => {
      const d = Math.abs((cur.strike ?? 0) - spotPrice);
      return d < best.d ? { strike: cur.strike ?? 0, d } : best;
    }, { strike: spotPrice, d: Number.MAX_SAFE_INTEGER });
    return all.filter((i) => Math.abs((i.strike ?? 0) - atm.strike) <= band * (i.tickSize || 1) * 50);
  }

  segmentFor(token: string): IndiaSegment | null {
    return this.byToken.get(token)?.segment ?? null;
  }

  contractTypeFor(token: string): IndiaContractType | null {
    return this.byToken.get(token)?.contractType ?? null;
  }
}

/** Parse an IndiaUnderlying from a master `underlying` string. */
export function underlyingOf(underlying: string): IndiaUnderlying | null {
  const u = (underlying ?? '').toUpperCase();
  for (const name of INDIA_DEFAULT_UNDERLYINGS) {
    if (u === name) return name;
  }
  if (u.includes('MID') && u.includes('SELECT')) return 'MIDCPNIFTY';
  return null;
}