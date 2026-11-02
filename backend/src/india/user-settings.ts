/**
 * IndiaUserSettingsService (spec §56 extension). Persists the values the USER
 * sets in the dashboard — capital, minimum profit, max risk/trade, max margin %,
 * portfolio caps — and hands them to the engines, so auto-trading follows the
 * user's numbers instead of compiled-in defaults.
 *
 * Stored under a single document id in the IndiaUserSettings collection; every
 * read goes through the cache so the 10-second scan loop never hits Mongo.
 */
import { INDIA_COLLECTIONS } from '@fx/shared';
import { DataStore } from '../db/store';
import { Cache } from '../db/cache';

export interface IndiaUserSettings {
  /** Capital the engine may deploy (INR). Margin limit = amountInr × maxMarginPercent/100. */
  amountInr: number;
  /** Minimum profit per goal/run (INR) — also used as the per-position profit-taking exit. */
  minimumProfitInr: number;
  /** Maximum risk (SL distance × quantity) allowed PER trade (INR). */
  maxRiskInr: number;
  /** Maximum margin as percent of amountInr for ONE trade. */
  maxMarginPercent: number;
  /** Portfolio caps for the universal book. */
  maxOpenPositions: number;
  /** Total concurrent margin ceiling across open positions (INR). */
  maxConcurrentMarginInr: number;
  updatedAt: number;
}

export const INDIA_USER_SETTINGS_DEFAULTS: IndiaUserSettings = {
  amountInr: 10_000,
  minimumProfitInr: 200,
  maxRiskInr: 2_000,
  maxMarginPercent: 50,
  maxOpenPositions: 3,
  maxConcurrentMarginInr: 30_000,
  updatedAt: 0,
};

const DOC_ID = 'user-settings';
const CACHE_TTL_MS = 5_000;

function sanitize(raw: Partial<IndiaUserSettings> | null | undefined): IndiaUserSettings {
  const num = (v: unknown, min: number, fallback: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n >= min ? n : fallback;
  };
  const out: IndiaUserSettings = {
    amountInr: num(raw?.amountInr, 1000, INDIA_USER_SETTINGS_DEFAULTS.amountInr),
    minimumProfitInr: num(raw?.minimumProfitInr, 1, INDIA_USER_SETTINGS_DEFAULTS.minimumProfitInr),
    maxRiskInr: num(raw?.maxRiskInr, 100, INDIA_USER_SETTINGS_DEFAULTS.maxRiskInr),
    maxMarginPercent: Math.min(100, Math.max(1, num(raw?.maxMarginPercent, 1, INDIA_USER_SETTINGS_DEFAULTS.maxMarginPercent))),
    maxOpenPositions: Math.min(50, Math.max(1, Math.round(num(raw?.maxOpenPositions, 1, INDIA_USER_SETTINGS_DEFAULTS.maxOpenPositions)))),
    maxConcurrentMarginInr: num(raw?.maxConcurrentMarginInr, 1000, INDIA_USER_SETTINGS_DEFAULTS.maxConcurrentMarginInr),
    updatedAt: Date.now(),
  };
  return out;
}

export class IndiaUserSettingsService {
  private cached: IndiaUserSettings | null = null;
  private cachedAt = 0;

  constructor(private store: DataStore, private cache: Cache) {}

  async init(): Promise<void> {
    try {
      const stored = await this.store.find<IndiaUserSettings & { settingsId?: string }>(
        'IndiaUserSettings', {}, {}, 1,
      );
      if (stored.length) this.cached = sanitize(stored[0]);
    } catch {
      /* collection may not exist yet — defaults apply until the user saves */
    }
  }

  async get(): Promise<IndiaUserSettings> {
    if (this.cached && Date.now() - this.cachedAt < CACHE_TTL_MS) return this.cached;
    try {
      const stored = await this.store.find<IndiaUserSettings & { settingsId?: string }>(
        'IndiaUserSettings', {}, {}, 1,
      );
      if (stored.length) this.cached = sanitize(stored[0]);
      else if (!this.cached) this.cached = { ...INDIA_USER_SETTINGS_DEFAULTS };
      // Also mirror into the shared cache for cross-process reads.
      void this.cache.set('india:user-settings', JSON.stringify(this.cached), 60_000).catch(() => undefined);
    } catch {
      if (!this.cached) this.cached = { ...INDIA_USER_SETTINGS_DEFAULTS };
    }
    this.cachedAt = Date.now();
    return this.cached;
  }

  /** Synchronous read of the last-known settings (defaults before first load). */
  sync(): IndiaUserSettings {
    return this.cached ?? { ...INDIA_USER_SETTINGS_DEFAULTS };
  }

  prime(): void {
    void this.get().catch(() => undefined);
  }

  async save(patch: Partial<IndiaUserSettings>): Promise<IndiaUserSettings> {
    const current = await this.get();
    const next = sanitize({ ...current, ...patch });
    next.updatedAt = Date.now();
    try {
      await this.store.updateOne(
        'IndiaUserSettings',
        { settingsId: DOC_ID },
        { $set: { ...next, settingsId: DOC_ID } },
        true,
      );
    } catch {
      /* keep memory truth even if persistence hiccups */
    }
    this.cached = next;
    this.cachedAt = Date.now();
    void this.cache.set('india:user-settings', JSON.stringify(next), 60_000).catch(() => undefined);
    return next;
  }
}
