/**
 * CurrencyConversionService (spec §7/§8/§26).
 *
 * Converts money between a pair's QUOTE currency and the account currency
 * (INR) using only LIVE rates from the market-data engine — never a hardcoded
 * table, never a silent wrong fallback.
 *
 *   Path: direct traded pair when one exists ('USD/INR'), otherwise through
 *   the USD hub (JPY→USD→INR). Every result carries rate + source + timestamp
 *   so callers can prove freshness, and a stale feed degrades in exactly one
 *   honest way: to the LAST-KNOWN-GOOD rate flagged `stale: true`. If there is
 *   never been a usable rate, conversion throws instead of inventing one.
 *
 * Pair orientation handled explicitly:
 *   'USD/INR' mid = INR per 1 USD → multiply
 *   'EUR/USD' mid = USD per 1 EUR → invert for USD→EUR
 */
import { getAsset } from '@fx/shared';

export interface RateQuote {
  /** Units of `to` per 1 unit of `from` after orientation fix. */
  rate: number;
  source: string;
  timestamp: number;
}

export interface ConversionResult {
  amount: number;
  /** Units of `to` per 1 unit of `from`. */
  rate: number;
  path: string[];
  rateTimestamp: number;
  source: string;
  /** True when a last-known-good rate past its freshness window was used. */
  stale: boolean;
}

export class StaleRateError extends Error {
  constructor(public readonly from: string, public readonly to: string) {
    super(`no ${from}->${to} conversion rate has ever been available`);
    this.name = 'StaleRateError';
  }
}

export interface TickLike {
  mid: number;
  source: string;
  timestamp: number;
  receivedAt?: number;
}

export type TickLookup = (symbol: string) => TickLike | undefined;

const HUB = 'USD';

/**
 * Stablecoin parity: USDT-quoted pairs convert through USD at 1:1 — the same
 * convention the rest of the money math has always assumed.
 */
function canonicalCurrency(c: string): string {
  return c === 'USDT' ? 'USD' : c;
}

interface Leg {
  key: string;
  quote: RateQuote;
  stale: boolean;
}

export class CurrencyConversionService {
  private maxAgeMs: number;
  private lookup: TickLookup;
  /** Last-known-good rate per conversion path ('JPY>INR'). */
  private lastGood = new Map<string, { rate: number; path: string[]; timestamp: number; source: string }>();

  constructor(lookup: TickLookup, opts: { maxAgeMs?: number } = {}) {
    this.lookup = lookup;
    this.maxAgeMs = opts.maxAgeMs ?? 300_000;
  }

  /** Live oriented rate for one market pair symbol ('USD/INR'). */
  private pairRate(pairSymbol: string): RateQuote | null {
    const t = this.lookup(pairSymbol);
    if (!t || !Number.isFinite(t.mid) || t.mid <= 0) return null;
    return { rate: t.mid, source: t.source, timestamp: t.receivedAt ?? t.timestamp };
  }

  /**
   * Rate converting `from` → `to` through a single traded pair, honouring the
   * asset master's orientation (base/quote). Null when no such pair trades.
   */
  private directRate(from: string, to: string): RateQuote | null {
    if (from === to) return { rate: 1, source: 'identity', timestamp: Date.now() };
    const q = this.pairRate(`${from}/${to}`);
    if (q) return q;
    const inv = this.pairRate(`${to}/${from}`);
    if (inv) return { ...inv, rate: 1 / inv.rate };
    return null;
  }

  private leg(from: string, to: string): Leg | null {
    const q = this.directRate(from, to);
    if (!q) return null;
    const stale = Date.now() - q.timestamp > this.maxAgeMs;
    return { key: `${from}>${to}`, quote: q, stale };
  }

  convert(amount: number, from: string, to: string): ConversionResult {
    if (!Number.isFinite(amount)) throw new Error('conversion amount must be finite');
    if (from === to) {
      return { amount, rate: 1, path: [`${from}=${to}`], rateTimestamp: Date.now(), source: 'identity', stale: false };
    }

    // Path 1: a single traded pair converts directly ('GBP'>'INR' via GBP/INR
    // when the broker carries it). Path 2: through the USD hub (JPY>USD>INR).
    const direct = this.leg(from, to);
    const hubA = this.leg(from, HUB);
    const hubB = this.leg(HUB, to);
    const legs: Leg[] | null = direct ? [direct] : hubA && hubB ? [hubA, hubB] : null;
    if (!legs) throw new StaleRateError(from, to);

    const path = legs.map((l) => l.key);
    const anyStale = legs.some((l) => l.stale);

    if (!anyStale) {
      const rate = legs.reduce((r, l) => r * l.quote.rate, 1);
      const ts = Math.min(...legs.map((l) => l.quote.timestamp));
      const src = legs.map((l) => l.quote.source).join('+');
      this.lastGood.set(path.join('|'), { rate, path, timestamp: ts, source: src });
      return { amount: amount * rate, rate, path, rateTimestamp: ts, source: src, stale: false };
    }

    // Some leg is stale/quiet: fall back to the last-known-good rate for this
    // exact path, honestly flagged. Fail closed when there never was one.
    const last = this.lastGood.get(path.join('|'));
    if (!last) throw new StaleRateError(from, to);
    return {
      amount: amount * last.rate,
      rate: last.rate,
      path,
      rateTimestamp: last.timestamp,
      source: `${last.source} (STALE)`,
      stale: true,
    };
  }

  /** Quote-currency amount of `symbol` → account currency. */
  quoteToAccount(symbol: string, accountCurrency: string, quoteAmount: number): ConversionResult {
    return this.convert(quoteAmount, canonicalCurrency(getAsset(symbol).quoteCurrency), canonicalCurrency(accountCurrency));
  }

  /** USD-denominated amount (commissions) → account currency. */
  usdToAccount(accountCurrency: string, usdAmount: number): ConversionResult {
    return this.convert(usdAmount, HUB, canonicalCurrency(accountCurrency));
  }

  /** True when `from→to` currently converts from FRESH data (gates execution). */
  hasFresh(from: string, to: string): boolean {
    try {
      return !this.convert(1, from, to).stale;
    } catch {
      return false;
    }
  }
}
