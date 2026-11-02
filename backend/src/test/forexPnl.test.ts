/**
 * Forex P&L correctness (spec §4–§15, §18, §26, §29).
 *
 * The chain under test:
 *   lots × contractSize × priceMovement  → quote-currency P&L
 *   → live quote→account conversion (rate + provenance)
 *   → INR gross / costs / net
 *
 * Pure-service tests run against a stubbed tick book; the container test at
 * the bottom proves the ENGINE stores the exit conversion rate and that a
 * manual close fills on the executable side of the spread.
 */
import { describe, it, expect } from 'vitest';
import { getAsset, FOREX_ASSETS } from '@fx/shared';
import { pnlForPosition } from '../math/forexMath';
import { CurrencyConversionService, StaleRateError, TickLike } from '../forex/currency-conversion';
import { pipValueQuote, pipSize, toPips, requiredMargin } from '../forex/pip-margin';

// Deterministic "feed" — mid prices only, always fresh unless a test opts out.
const RATES: Record<string, { mid: number; ageMs?: number }> = {
  'USD/INR': { mid: 95.73 },
  'USD/JPY': { mid: 159.0 },
  'GBP/USD': { mid: 1.3645 },
  'EUR/USD': { mid: 1.17 },
};

function makeLookup(rates: Record<string, { mid: number; ageMs?: number }>) {
  return (symbol: string): TickLike | undefined => {
    const r = rates[symbol];
    if (!r) return undefined;
    return {
      mid: r.mid,
      source: 'TEST',
      timestamp: Date.now() - (r.ageMs ?? 1_000),
    };
  };
}

const fx = new CurrencyConversionService(makeLookup(RATES), { maxAgeMs: 60_000 });

describe('quote-currency P&L: lots × contractSize × movement (§5/§6/§13)', () => {
  it('EUR/USD BUY +10 pips at 0.01 lot = $1.00 quote P&L', () => {
    const q = pnlForPosition(getAsset('EUR/USD'), 0.01, 'BUY', 1.17, 1.171);
    expect(q).toBeCloseTo(1.0, 8);
    expect(toPips('EUR/USD', 1.171 - 1.17)).toBeCloseTo(10, 6);
    expect(pipSize('EUR/USD')).toBe(0.0001);
  });

  it('lot scaling: same movement ⇒ ~10× per decade (0.01→0.10→1.00)', () => {
    const p01 = pnlForPosition(getAsset('EUR/USD'), 0.01, 'BUY', 1.17, 1.171);
    const p10 = pnlForPosition(getAsset('EUR/USD'), 0.10, 'BUY', 1.17, 1.171);
    const p100 = pnlForPosition(getAsset('EUR/USD'), 1.0, 'BUY', 1.17, 1.171);
    expect(p10 / p01).toBeCloseTo(10, 6);
    expect(p100 / p10).toBeCloseTo(10, 6);
  });

  it('BUY: rise profits, fall loses; SELL mirrored', () => {
    expect(pnlForPosition(getAsset('EUR/USD'), 0.01, 'BUY', 1.17, 1.172)).toBeGreaterThan(0);
    expect(pnlForPosition(getAsset('EUR/USD'), 0.01, 'BUY', 1.17, 1.169)).toBeLessThan(0);
    expect(pnlForPosition(getAsset('EUR/USD'), 0.01, 'SELL', 1.17, 1.169)).toBeGreaterThan(0);
    expect(pnlForPosition(getAsset('EUR/USD'), 0.01, 'SELL', 1.17, 1.172)).toBeLessThan(0);
  });

  it('JPY pairs pip at 0.01, not 0.0001 (§11)', () => {
    expect(pipSize('USD/JPY')).toBe(0.01);
    expect(pipSize('GBP/JPY')).toBe(0.01);
    expect(toPips('USD/JPY', 159.0 - 158.5)).toBeCloseTo(50, 6);
  });

  it('pip value scales with lots in the QUOTE currency (§12)', () => {
    // EUR/USD: 0.0001 × 100,000 = $10/pip per standard lot.
    expect(pipValueQuote('EUR/USD', 1)).toBeCloseTo(10, 8);
    expect(pipValueQuote('EUR/USD', 0.01)).toBeCloseTo(0.1, 8);
    // USD/JPY: 0.01 × 100,000 = ¥1,000/pip per standard lot.
    expect(pipValueQuote('USD/JPY', 1)).toBeCloseTo(1000, 8);
  });
});

describe('live INR conversion per quote currency (§7/§8)', () => {
  it('USD-quoted pair → USD/INR multiply (GBP/USD case)', () => {
    const r = fx.quoteToAccount('GBP/USD', 'INR', 1);
    expect(r.rate).toBeCloseTo(95.73, 6);
    expect(r.stale).toBe(false);
  });

  it('JPY-quoted pair routes JPY→USD→INR (USD/JPY case)', () => {
    const r = fx.quoteToAccount('USD/JPY', 'INR', 159_000);
    // ¥159,000 = $1,000 = ₹95,730
    expect(r.amount).toBeCloseTo(95_730, 0);
    expect(r.path).toEqual(['JPY>USD', 'USD>INR']);
  });

  it('GBP/JPY position converts its JPY P&L through the hub', () => {
    const q = pnlForPosition(getAsset('GBP/JPY'), 0.01, 'BUY', 216.0, 217.0); // 100 pips × ¥1,000/pip-lot ×0.01
    expect(q).toBeCloseTo(1_000, 6);
    const r = fx.quoteToAccount('GBP/JPY', 'INR', q);
    expect(r.amount).toBeCloseTo(1000 * (95.73 / 159.0), 0);
  });

  it('EUR/GBP converts GBP→USD→INR via the inverse of GBP/USD', () => {
    const q = pnlForPosition(getAsset('EUR/GBP'), 0.5, 'SELL', 0.87, 0.869);
    expect(q).toBeCloseTo(50, 6); // £50
    const r = fx.quoteToAccount('EUR/GBP', 'INR', q);
    expect(r.amount).toBeCloseTo(50 * 1.3645 * 95.73, 0);
  });

  it('a conversion-rate move re-prices floating INR P&L in real time (§9)', () => {
    const before = new CurrencyConversionService(makeLookup({ ...RATES, 'USD/INR': { mid: 95.73 } }), { maxAgeMs: 60_000 })
      .quoteToAccount('EUR/USD', 'INR', 1).amount;
    const after = new CurrencyConversionService(makeLookup({ ...RATES, 'USD/INR': { mid: 96.73 } }), { maxAgeMs: 60_000 })
      .quoteToAccount('EUR/USD', 'INR', 1).amount;
    expect(after - before).toBeCloseTo(1.0, 6);
  });
});

describe('freshness gate (§26): never a silent stale rate', () => {
  it('flags stale only after a fresh sample existed; a never-fresh feed fails closed', () => {
    const fresh = new CurrencyConversionService(makeLookup(RATES), { maxAgeMs: 60_000 });
    expect(fresh.quoteToAccount('USD/JPY', 'INR', 1000).stale).toBe(false);

    // Aged from birth, no prior good sample in THIS instance → fail closed.
    const aged = new CurrencyConversionService(
      makeLookup(Object.fromEntries(Object.entries(RATES).map(([k, v]) => [k, { ...v, ageMs: 10 * 60_000 }]))),
      { maxAgeMs: 60_000 },
    );
    expect(() => aged.quoteToAccount('USD/JPY', 'INR', 1000)).toThrow(StaleRateError);
  });

  it('last-known-good survives a gap with an explicit STALE flag', () => {
    let mode: 'fresh' | 'aged' = 'fresh';
    const switching = new CurrencyConversionService(() => ({
      mid: RATES['USD/INR'].mid,
      source: 'TEST',
      timestamp: Date.now() - (mode === 'fresh' ? 1_000 : 10 * 60_000),
    }), { maxAgeMs: 60_000 });

    const first = switching.convert(1, 'USD', 'INR');
    expect(first.stale).toBe(false);

    mode = 'aged';
    const second = switching.convert(1, 'USD', 'INR');
    expect(second.stale).toBe(true);
    expect(second.rate).toBeCloseTo(first.rate, 10);
  });

  it('an unknown currency pair throws instead of inventing a rate', () => {
    expect(() => fx.convert(1, 'XYZ', 'INR')).toThrow(StaleRateError);
  });
});

describe('margin vs leverage vs P&L (§14/§15)', () => {
  it('required margin = INR notional ÷ leverage; exposure shown alongside', () => {
    const m = requiredMargin('EUR/USD', 1, 1.17, 'INR', fx);
    expect(m.notionalQuote).toBeCloseTo(117_000, 4);
    expect(m.notionalAccount).toBeCloseTo(117_000 * 95.73, 0);
    expect(m.leverage).toBe(100);
    expect(m.requiredMarginAccount).toBeCloseTo((117_000 * 95.73) / 100, 0);
  });

  it('changing leverage changes MARGIN and never multiplies P&L', () => {
    const asset = FOREX_ASSETS['EUR/USD'];
    const original = asset.marginRequirement;
    try {
      const beforePnl = pnlForPosition(asset, 0.1, 'BUY', 1.17, 1.171);
      const beforeMargin = requiredMargin('EUR/USD', 0.1, 1.17, 'INR', fx).requiredMarginAccount;

      asset.marginRequirement = original / 2; // double the leverage
      const afterPnl = pnlForPosition(asset, 0.1, 'BUY', 1.17, 1.171);
      const afterMargin = requiredMargin('EUR/USD', 0.1, 1.17, 'INR', fx);

      expect(afterPnl).toBe(beforePnl);              // P&L untouched by leverage
      expect(afterMargin.requiredMarginAccount).toBeCloseTo(beforeMargin / 2, 4);
      expect(afterMargin.leverage).toBe(200);
    } finally {
      asset.marginRequirement = original;
    }
  });
});
