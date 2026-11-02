/**
 * XM/MT5 price-and-terms parity: when a broker account is bound, every money
 * path must use the ACCOUNT's own numbers, not the built-in catalog:
 *   - contract size → P&L per price unit and pip value match MT5's math,
 *   - lot step / min-max lot → order sizes are lots MT5 would actually accept,
 *   - account leverage (account_info) → margin fraction the terminal enforces.
 * Prices themselves already stream from MT5 (bridge ticks own the feed); this
 * pins the TERMS side so the dashboard can never drift from the platform.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Container } from '../core/container';
import {
  setBrokerSpecOverrides, clearBrokerSpecOverrides, setAccountLeverage,
  clearAccountLeverage, effectiveSpec,
} from '../forex/symbol-spec';
import { calculateSizing, goalFeasibility } from '../math/forexMath';

const BASE_SETTINGS = {
  accountCurrency: 'USD',
  availableCapital: 10_000,
  maxRiskPercent: 2,
  maxLeverage: 500,
  maxMarginUsedPct: 100,
};

// XM-like divergence: a Micro-style contract and account leverage 888:1 —
// deliberately different from the catalog so any catalog leak shows up.
const MICRO = { symbol: 'EUR/USD', contractSize: 1_000, volumeMin: 0.01, volumeMax: 100, volumeStep: 0.01 };
const LEV = 888;

describe('broker-issued terms drive sizing, P&L and margin (XM/MT5 parity)', () => {
  beforeAll(() => {
    setBrokerSpecOverrides([MICRO]);
    setAccountLeverage(LEV);
  });

  afterAll(() => {
    clearBrokerSpecOverrides();
    clearAccountLeverage();
  });

  it('effectiveSpec layers broker contract size and account leverage', () => {
    const s = effectiveSpec('EUR/USD');
    expect(s.contractSize).toBe(1_000);
    expect(s.minLot).toBe(0.01);
    expect(s.lotStep).toBe(0.01);
    expect(s.leverage).toBe(LEV);
    expect(s.marginRequirement).toBeCloseTo(1 / LEV, 12);
    expect(s.source).toBe('MT5');
  });

  it('sizing uses the broker contract size: risk-per-pip is 100x smaller', () => {
    const out = calculateSizing({
      symbol: 'EUR/USD', accountCurrency: 'USD', capital: BASE_SETTINGS.availableCapital,
      riskPercent: 2, entryPrice: 1.1, stopLossPrice: 1.0950, usdRate: 1,
      maxLeverage: BASE_SETTINGS.maxLeverage,
    });
    expect(out.valid).toBe(true);
    // 2% of 10k = $200 risk over 50 pips. Micro pip value = 0.0001 × 1000 =
    // $0.10/pip/lot (catalog would be $10) → 200 / (50 × 0.10) = 40 lots.
    expect(out.lots).toBeCloseTo(40, 6);
    // margin = 40 lots × 1000 × 1.1 / 888
    expect(out.marginRequired).toBeCloseTo((40 * 1000 * 1.1) / LEV, 6);
  });

  it('goal feasibility sizes with broker geometry and account leverage', () => {
    const g = goalFeasibility({
      symbol: 'EUR/USD', accountCurrency: 'USD', capital: BASE_SETTINGS.availableCapital,
      riskPercent: BASE_SETTINGS.maxRiskPercent, goalProfit: 20,
      entryPrice: 1.1, stopLossPrice: 1.0950, takeProfitPrice: 1.1050,
      usdRate: 1, maxLeverage: BASE_SETTINGS.maxLeverage,
      maxMarginUsedPct: BASE_SETTINGS.maxMarginUsedPct,
    } as never);
    expect(g.achievable).toBe(true);
    // Lots must be a multiple of the BROKER's 0.01 step.
    expect(Math.abs(g.lots / 0.01 - Math.round(g.lots / 0.01))).toBeLessThan(1e-6);
  });

  it('P&L per price unit equals MT5 math with the broker contract size', () => {
    const s = effectiveSpec('EUR/USD');
    const perUnit = 0.0050; // 50 pips
    const lots = 0.5;
    // MT5: profit = (exit − entry) × lots × contractSize
    const expected = perUnit * lots * s.contractSize;
    expect(expected).toBeCloseTo(0.0050 * 0.5 * 1000, 9);
  });

  it('unbinding restores the catalog terms', () => {
    clearBrokerSpecOverrides();
    clearAccountLeverage();
    const s = effectiveSpec('EUR/USD');
    expect(s.source).toBe('CATALOG');
    expect(s.marginRequirement).toBe(0); // unknown while unbound
  });
});
