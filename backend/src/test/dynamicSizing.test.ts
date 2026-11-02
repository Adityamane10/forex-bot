/**
 * Dynamic lot sizing (spec §1–§13, §16): the engine must pick the LARGEST
 * valid lot under margin + capital + risk + broker constraints — never a
 * default 0.01, never rounded UP past a limit, and TRADE BLOCKED (not forced
 * to minLot) when capacity is insufficient.
 */
import { describe, it, expect } from 'vitest';
import { computeDynamicLots, DynamicSizingInput } from '../forex/dynamic-sizing';
import { CurrencyConversionService, TickLike } from '../forex/currency-conversion';

const RATES: Record<string, number> = {
  'USD/INR': 95.73,
  'USD/JPY': 159.0,
  'GBP/USD': 1.3645,
  'EUR/USD': 1.17,
};

const fx = new CurrencyConversionService((symbol) => (
  RATES[symbol] != null
    ? { mid: RATES[symbol], source: 'TEST', timestamp: Date.now() - 1_000 }
    : undefined
), { maxAgeMs: 60_000 });

function baseInput(overrides: Partial<DynamicSizingInput> = {}): DynamicSizingInput {
  return {
    symbol: 'EUR/USD',
    accountCurrency: 'INR',
    balanceAccount: 10_000,
    equityAccount: 10_000,
    usedMarginAccount: 0,
    allocatedAccount: 10_000,
    maxMarginPercent: 50,
    maxRiskAccount: 1_000,
    entryPrice: 1.17,
    stopLossPrice: 1.1650, // 50 pips
    direction: 'BUY',
    fx,
    ...overrides,
  };
}

// Per-lot economics at these rates: pip value $10/lot ⇒ ₹957.30/pip/lot;
// margin/lot = 1.17 × 100,000 × 95.73 ÷ 100 ≈ ₹112,004.
const MARGIN_PER_LOT = (1.17 * 100_000 * 95.73) / 100;
const RISK_PER_LOT = 50 * 10 * 95.73; // 50 pips × $10 × USDINR

describe('dynamic lot sizing — limits compose by MIN (§2)', () => {
  it('Test 1: healthy wallet sizes well above 0.01 when constraints allow', () => {
    const r = computeDynamicLots(baseInput());
    expect(r.valid).toBe(true);
    expect(r.finalLots).toBeGreaterThan(0.01);
  });

  it('Test 2: margin is the binding constraint → final = marginMax', () => {
    // Margin allows ~0.088 (₹4k cap? use free margin small), risk allows more.
    const r = computeDynamicLots(baseInput({
      equityAccount: 5_000,
      allocatedAccount: 5_000,
      maxMarginPercent: 20,          // cap = ₹1,000
      maxRiskAccount: 100_000,       // risk effectively unlimited
    }));
    const marginMax = 1_000 / MARGIN_PER_LOT;
    expect(r.limits.riskBasedLots).toBeGreaterThan(r.limits.marginBasedLots);
    expect(r.finalLots).toBeCloseTo(Math.floor(marginMax * 100) / 100, 6);
  });

  it('Test 3: risk is the binding constraint → risk overrides margin (§4)', () => {
    const r = computeDynamicLots(baseInput({
      balanceAccount: 1_000_000,
      equityAccount: 1_000_000,
      allocatedAccount: 1_000_000,
      maxMarginPercent: 100,         // margin allows plenty
      maxRiskAccount: 300,           // but risk caps hard
    }));
    const riskMax = 300 / RISK_PER_LOT;
    expect(r.limits.marginBasedLots).toBeGreaterThan(riskMax);
    expect(r.finalLots).toBeCloseTo(Math.floor(riskMax * 100) / 100, 6);
    expect(r.finalLots).toBeLessThan(0.01 * 30); // sanity: far below margin headroom
  });

  it('Test 4: 0.167 raw floors DOWN to the 0.01 step — never up (§7)', () => {
    // Risk exactly permits 0.167 lots.
    const r = computeDynamicLots(baseInput({
      balanceAccount: 1_000_000,
      equityAccount: 1_000_000,
      allocatedAccount: 1_000_000,
      maxMarginPercent: 100,
      maxRiskAccount: 0.167 * RISK_PER_LOT,
    }));
    expect(r.limits.riskBasedLots).toBeGreaterThan(0.166);
    expect(r.limits.riskBasedLots).toBeLessThan(0.168);
    expect(r.finalLots).toBeCloseTo(0.16, 8);
  });
});

describe('zero-capacity blocks instead of forcing minLot (§8)', () => {
  it('Test 5: below-minimum capacity → TRADE BLOCKED with explicit reason', () => {
    const r = computeDynamicLots(baseInput({
      equityAccount: 500,
      allocatedAccount: 500,
      maxMarginPercent: 10,          // ₹50 margin cap ⇒ far below one lot's ₹112k
      maxRiskAccount: 100_000,
    }));
    expect(r.valid).toBe(false);
    expect(r.finalLots).toBe(0);
    expect(r.reason).toContain('TRADE BLOCKED');
    expect(r.reason.toLowerCase()).toContain('insufficient margin');
  });

  it('risk cap below one minimum lot also blocks, naming risk as the binder', () => {
    const r = computeDynamicLots(baseInput({
      balanceAccount: 1_000_000,
      equityAccount: 1_000_000,
      allocatedAccount: 1_000_000,
      maxMarginPercent: 100,
      maxRiskAccount: 300,           // allows only ~0.003 lots < 0.01 min
    }));
    expect(r.valid).toBe(false);
    expect(r.reason).toContain('TRADE BLOCKED');
    expect(r.reason).toContain('risk');
  });
});

describe('fresh recalculation per trade (§11/§12)', () => {
  it('Test 6: after an open position eats margin, trade 2 sizes smaller', () => {
    const first = computeDynamicLots(baseInput());
    expect(first.finalLots).toBeGreaterThan(0);

    // Same wallet AFTER an open position consumed margin so that FREE margin
    // (not risk) becomes the binding constraint:
    const second = computeDynamicLots(baseInput({
      equityAccount: 3_000,
      usedMarginAccount: 1_500,      // free margin drops to ₹1,500
      maxMarginPercent: 50,
      allocatedAccount: 10_000,      // pct cap stays ₹5,000 — min() picks 1,500
      maxRiskAccount: 100_000,       // remove risk as a binder for this case
    }));
    expect(second.freeMarginAccount).toBe(1_500);
    expect(second.limits.marginBasedLots).toBeLessThan(second.limits.riskBasedLots);
    expect(second.finalLots).toBeLessThan(first.finalLots);
  });

  it('a disabled constraint does not artificially limit (maxMarginPct=0 → allocation bounds)', () => {
    const r = computeDynamicLots(baseInput({
      maxMarginPercent: 0,           // disabled per §2
      maxRiskAccount: 0,             // risk cap disabled too
      allocatedAccount: 200_000,
    }));
    // Only allocation (as full margin ceiling) and broker max bind now.
    expect(r.finalLots).toBeGreaterThan(computeDynamicLots(baseInput()).finalLots);
  });
});

describe('leverage divides margin, never multiplies P&L (§6/§14/§16 T7)', () => {
  it('halving marginRequirement halves required margin and leaves quote P&L identical', () => {
    const { FOREX_ASSETS } = require('@fx/shared') as typeof import('@fx/shared');
    const asset = FOREX_ASSETS['EUR/USD'];
    const original = asset.marginRequirement;
    try {
      const before = computeDynamicLots(baseInput({ entryPrice: 1.17, stopLossPrice: 1.169 }));
      asset.marginRequirement = original / 2;
      const after = computeDynamicLots(baseInput({ entryPrice: 1.17, stopLossPrice: 1.169 }));

      expect(after.marginPerLotAccount).toBeCloseTo(before.marginPerLotAccount / 2, 4);
      expect(after.leverage).toBe(before.leverage * 2);
      // P&L driver (risk per lot at the same SL) is untouched.
      expect(after.riskPerLotAccount).toBeCloseTo(before.riskPerLotAccount, 6);
    } finally {
      asset.marginRequirement = original;
    }
  });
});

describe('non-USD quote currencies size through the same engine', () => {
  it('USD/JPY SELL converts its JPY margin/risk through the hub', () => {
    const r = computeDynamicLots(baseInput({
      symbol: 'USD/JPY',
      direction: 'SELL',
      entryPrice: 159.099,
      stopLossPrice: 159.599,        // 50 pips at 0.01 pipSize
    }));
    // margin/lot = ¥159,099 converted at the LIVE hub (USD/JPY=159): ÷159 × 95.73
    const jpyInr = 95.73 / 159.0;
    expect(r.valid).toBe(true);
    expect(r.marginPerLotAccount).toBeCloseTo(159_099 * jpyInr, 0);
    expect(r.riskPerLotAccount).toBeCloseTo(50_000 * jpyInr, 0);
    expect(r.finalLots).toBeGreaterThan(0.01);
  });
});
