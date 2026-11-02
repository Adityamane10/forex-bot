import { describe, it, expect } from 'vitest';
import { calculateSizing, expectedValue, breakevenProbability, pnlForPosition, toAccountCurrency, accountQuoteRate, goalFeasibility } from '../math/forexMath';
import { getAsset, pipValueInQuote, priceToPips, roundLot, roundLotUp, pipsToPrice } from '@fx/shared';

const rates = (s: string): number | undefined => {
  const table: Record<string, number> = {
    'USD/INR': 84,      // 1 USD = ₹84
    'USD/JPY': 145,     // 1 USD = 145 JPY
    'USD/CHF': 0.87,    // 1 USD = 0.87 CHF
    'GBP/USD': 1.36,    // 1 GBP = $1.36
  };
  return table[s];
};

describe('forex math', () => {
  it('pip value: EUR/USD 1 pip = $10 per standard lot', () => {
    expect(pipValueInQuote('EUR/USD')).toBeCloseTo(10, 6);
  });
  it('pip value: USD/JPY 1 pip = 1000 JPY per standard lot', () => {
    expect(pipValueInQuote('USD/JPY')).toBeCloseTo(1000, 6);
  });
  it('pip conversions are inverse', () => {
    expect(priceToPips('EUR/USD', pipsToPrice('EUR/USD', 25))).toBeCloseTo(25, 6);
  });
  it('lot rounding respects step and min', () => {
    expect(roundLot('EUR/USD', 0.1234)).toBeCloseTo(0.12, 2);
    expect(roundLot('EUR/USD', 0.001)).toBeCloseTo(0.01, 2);
    expect(roundLot('EUR/USD', 5000)).toBeCloseTo(100, 2);
  });
  it('lot rounding up respects step and min (never below minimum)', () => {
    expect(roundLotUp('EUR/USD', 0.1234)).toBeCloseTo(0.13, 2);
    expect(roundLotUp('EUR/USD', 0.001)).toBeCloseTo(0.01, 2);
    expect(roundLotUp('EUR/USD', 0.011)).toBeCloseTo(0.02, 2);
    expect(roundLotUp('EUR/USD', 0.02)).toBeCloseTo(0.02, 2); // exact step unchanged
    expect(roundLotUp('EUR/USD', 287.7)).toBeCloseTo(287.7, 2); // no max clamp here
  });

  it('position sizing: 1% of $10k with 50 pip SL on EUR/USD -> 0.2 lots', () => {
    const out = calculateSizing({
      symbol: 'EUR/USD',
      accountCurrency: 'USD',
      capital: 10000,
      riskPercent: 1,
      entryPrice: 1.1,
      stopLossPrice: 1.095,
      usdRate: 1,
      maxLeverage: 50,
    });
    expect(out.valid).toBe(true);
    expect(out.pipDistance).toBeCloseTo(50, 2);
    expect(out.lots).toBeCloseTo(0.2, 2);
    expect(out.riskAmount).toBeCloseTo(100, 2);
    expect(out.expectedLoss).toBeCloseTo(100, 2);
  });

  it('position sizing: JPY pair pip value uses quote conversion', () => {
    const out = calculateSizing({
      symbol: 'USD/JPY',
      accountCurrency: 'USD',
      capital: 10000,
      riskPercent: 1,
      entryPrice: 150,
      stopLossPrice: 149.5, // 50 pips
      usdRate: 150, // 1 USD = 150 JPY
      maxLeverage: 500,
    });
    expect(out.valid).toBe(true);
    // 1 pip = 1000 JPY = 1000/150 USD per lot; risk 100 over 50 pips
    expect(out.lots).toBeCloseTo(100 / (50 * (1000 / 150)), 2);
    // effective leverage measured on ACCOUNT-currency notional:
    // lots × $100k notional / $10k capital (quote notional ÷ rate = USD)
    expect(out.leverageUsed).toBeCloseTo(out.lots * 100000 / 10000, 1);
    // margin is account-currency too (1% requirement)
    expect(out.marginRequired).toBeCloseTo(out.lots * 100000 * 0.01, 4);
  });

  it('position sizing: rejects leverage beyond max', () => {
    const out = calculateSizing({
      symbol: 'USD/JPY',
      accountCurrency: 'USD',
      capital: 10000,
      riskPercent: 1,
      entryPrice: 150,
      stopLossPrice: 149.5,
      usdRate: 150,
      maxLeverage: 2, // real leverage here is ~3× account-currency notional
    });
    expect(out.valid).toBe(false);
    expect(out.reason).toContain('leverage');
  });

  it('production wiring: accountQuoteRate feeds calculateSizing with true quote-per-account rate', () => {
    // Regression: accountQuoteRate used to return 1 for USD accounts on every
    // pair, so JPY pip values were treated as USD (~145× oversized pip value →
    // ~145× undersized lots clamped to minimum).
    const usdRate = accountQuoteRate('USD/JPY', 'USD', rates);
    expect(usdRate).toBeCloseTo(145, 6);
    const out = calculateSizing({
      symbol: 'USD/JPY',
      accountCurrency: 'USD',
      capital: 10000,
      riskPercent: 1,
      entryPrice: 150,
      stopLossPrice: 149.5,
      usdRate,
      maxLeverage: 500,
    });
    expect(out.valid).toBe(true);
    expect(out.pipValuePerLotAccount).toBeCloseTo(1000 / 145, 4);
    expect(out.lots).toBeGreaterThan(0.05); // NOT pinned at minimum lot
    // INR accounts get quote-per-₹ (JPY per ₹)
    expect(accountQuoteRate('EUR/JPY', 'INR', rates)).toBeCloseTo(145 / 84, 6);
  });

  it('position sizing fails closed when no live conversion rate exists', () => {
    const out = calculateSizing({
      symbol: 'USD/JPY',
      accountCurrency: 'USD',
      capital: 10000,
      riskPercent: 1,
      entryPrice: 150,
      stopLossPrice: 149.5,
      usdRate: NaN, // feed silent (accountQuoteRate returns NaN)
      maxLeverage: 500,
    });
    expect(out.valid).toBe(false);
    expect(out.reason).toContain('conversion rate');
  });

  it('position sizing: rejects zero capital / invalid SL', () => {
    expect(calculateSizing({
      symbol: 'EUR/USD', accountCurrency: 'USD', capital: 0, riskPercent: 1,
      entryPrice: 1.1, stopLossPrice: 1.09, usdRate: 1, maxLeverage: 50,
    }).valid).toBe(false);
    expect(calculateSizing({
      symbol: 'EUR/USD', accountCurrency: 'USD', capital: 10000, riskPercent: 1,
      entryPrice: 1.1, stopLossPrice: 1.1, usdRate: 1, maxLeverage: 50,
    }).valid).toBe(false);
  });

  it('position sizing: min lot respected when risk is tiny', () => {
    const out = calculateSizing({
      symbol: 'EUR/USD', accountCurrency: 'USD', capital: 10000, riskPercent: 0.01,
      entryPrice: 1.1, stopLossPrice: 1.09, usdRate: 1, maxLeverage: 50,
    });
    // risk too small for min lot -> either clamped to min or rejected; must be consistent
    expect(out.lots).toBeLessThanOrEqual(getAsset('EUR/USD').minimumLot);
  });

  it('expected value: positive case', () => {
    const ev = expectedValue({
      probabilityWin: 0.6,
      averageWin: 100,
      averageLoss: 50,
      spread: 1, commission: 7, slippage: 2, swap: -0.5, // swap rebate
      riskReward: 2,
      positionLots: 1,
    });
    // costs = 1 + 7 + 2 - 0.5 = 9.5 ; EV = 60 - 20 - 9.5
    expect(ev).toBeCloseTo(30.5, 6);
    expect(ev).toBeGreaterThan(0);
  });

  it('expected value: negative costs flip EV', () => {
    const ev = expectedValue({
      probabilityWin: 0.4,
      averageWin: 50,
      averageLoss: 60,
      spread: 10, commission: 20, slippage: 5, swap: 0,
      riskReward: 1,
      positionLots: 1,
    });
    expect(ev).toBeLessThan(0);
  });

  it('breakeven probability: fair coin at R:R 1:1 with zero cost', () => {
    expect(breakevenProbability(1, 0)).toBeCloseTo(0.5, 6);
  });
  it('breakeven probability: higher R:R lowers required win rate', () => {
    expect(breakevenProbability(2, 0)).toBeCloseTo(1 / 3, 6);
  });

  it('P&L: long position gains when price rises', () => {
    const asset = getAsset('EUR/USD');
    expect(pnlForPosition(asset, 1, 'BUY', 1.1, 1.105)).toBeCloseTo(500, 2);
    expect(pnlForPosition(asset, 1, 'SELL', 1.1, 1.105)).toBeCloseTo(-500, 2);
  });

  it('toAccountCurrency: USD-quoted pair converts via USD/INR only', () => {
    // EUR/USD P&L is already in USD; ₹ = USD × 84 (quotePerUsd = 1).
    expect(toAccountCurrency('EUR/USD', 'INR', 30, rates)).toBeCloseTo(2520, 6);
  });

  it('toAccountCurrency: JPY-quoted pair converts ÷ USD/JPY × USD/INR (dimensions)', () => {
    // 1 USD = 145 JPY and 1 USD = ₹84 → ₹ = JPY ÷ 145 × 84.
    expect(toAccountCurrency('EUR/JPY', 'INR', 1450, rates)).toBeCloseTo(840, 6);
    expect(toAccountCurrency('EUR/JPY', 'INR', 1000, rates)).toBeCloseTo(1000 / 145 * 84, 6);
  });

  it('toAccountCurrency: GBP-quoted pair uses inverse GBP/USD', () => {
    // 1 USD = 0.7353 GBP (1/1.36); ₹ = GBP ÷ 0.7353 × 84.
    expect(toAccountCurrency('EUR/GBP', 'INR', 0.735294, rates)).toBeCloseTo(84, 3);
  });

  it('toAccountCurrency: USD account passes through unchanged', () => {
    expect(toAccountCurrency('EUR/JPY', 'USD', 1450, rates)).toBeCloseTo(1450, 6);
  });

  it('toAccountCurrency: unknown rate falls back to raw amount (never invents prices)', () => {
    expect(toAccountCurrency('EUR/JPY', 'INR', 1450, () => undefined)).toBeCloseTo(1450, 6);
  });

  it('accountQuoteRate: JPY-quoted pair sizes against real wallet value', () => {
    // units of quote per 1 unit of account = (JPY per USD) / (INR per USD).
    expect(accountQuoteRate('EUR/JPY', 'INR', rates)).toBeCloseTo(145 / 84, 6);
    expect(accountQuoteRate('EUR/USD', 'INR', rates)).toBeCloseTo(1 / 84, 6);
  });

  describe('goal feasibility (goal-driven sizing)', () => {
    const base = {
      accountCurrency: 'INR' as const,
      capital: 5000,
      riskPercent: 20,
      goalProfit: 50,
      entryPrice: 184.5,
      stopLossPrice: 184.8, // SELL, 30 pips SL
      takeProfitPrice: 183.9, // 60 pips TP → R:R 2
      usdRate: 145 / 84, // JPY per ₹
      maxLeverage: 50,
      maxMarginUsedPct: 100,
      getMid: rates,
    };

    it('sizes to the goal and reports the exact plan (EUR/JPY, ₹50 goal)', () => {
      const f = goalFeasibility({ symbol: 'EUR/JPY', ...base });
      expect(f.achievable).toBe(true);
      // pip value = 1000 JPY / (145/84) = ₹579.3 per pip per lot
      // lots for ₹50 over 60 pips = 50 / (60 × 579.3) = 0.0014 → min lot 0.01
      // With max-margin scaling (85% margin → leverage caps at 0.02 lots) the
      // engine now uses max allowed (0.02) to reach the goal faster.
      expect(f.lots).toBeCloseTo(0.02, 2);
      // risk at 0.02 lots over 30 pips = 30 × 579.3 × 0.02 = ₹347.6 → 6.9%
      expect(f.riskPctRequired).toBeCloseTo((30 * (1000 / (145 / 84)) * 0.02) / 5000 * 100, 1);
      expect(f.expectedProfit).toBeGreaterThanOrEqual(50);
      expect(f.rr).toBeCloseTo(2, 2);
    });

    it('reports how much MORE risk the goal needs instead of raising it', () => {
      const f = goalFeasibility({ symbol: 'EUR/JPY', ...base, goalProfit: 2400 });
      // 2400/(60×579.3) = 0.069 → 0.07 lots → risk = 30×579.3×0.07 = ₹1217 = 24.3%
      expect(f.achievable).toBe(false);
      expect(f.reason).toContain('risk');
    });

    it('rounds UP to the next lot step so the goal is actually covered (uses more margin)', () => {
      const f = goalFeasibility({ symbol: 'EUR/JPY', ...base, goalProfit: 400 });
      // 400/(60×579.3) = 0.0115 → rounds up to 0.02 lots → ₹695 expected (42.7% margin)
      expect(f.achievable).toBe(true);
      expect(f.lots).toBeCloseTo(0.02, 2);
      expect(f.expectedProfit).toBeGreaterThanOrEqual(400);
    });

    it('goals beyond the maximum lot are reported unreachable', () => {
      const f = goalFeasibility({ symbol: 'EUR/JPY', ...base, goalProfit: 10000000 });
      // 0.0115×10000000/400 = 287.7 lots > max 100 — honest max-profit reason
      expect(f.achievable).toBe(false);
      expect(f.reason).toContain('unreachable');
    });

    it('margin cap blocks oversized goals for the wallet', () => {
      const f = goalFeasibility({ symbol: 'EUR/JPY', ...base, goalProfit: 2000, riskPercent: 50 });
      // 0.06 lots (rounded up): risk 20.9% (under 50%) but margin 128.2% > 100% — the honest binder.
      expect(f.achievable).toBe(false);
      expect(f.reason).toContain('margin');
    });

    it('leverage cap rejects goal positions that exceed max leverage', () => {
      const f = goalFeasibility({ symbol: 'EUR/JPY', ...base, maxLeverage: 10 });
      expect(f.achievable).toBe(false);
      expect(f.reason).toContain('leverage');
    });

    it('non-USD account without a live USD rate refuses to price margin', () => {
      const f = goalFeasibility({ symbol: 'EUR/JPY', ...base, getMid: () => undefined });
      expect(f.achievable).toBe(false);
      expect(f.reason).toContain('rate');
    });

    it('USD account needs no cross-rate feed', () => {
      const f = goalFeasibility({
        symbol: 'EUR/USD',
        accountCurrency: 'USD',
        capital: 10000,
        riskPercent: 1,
        goalProfit: 100,
        entryPrice: 1.1,
        stopLossPrice: 1.09, // 100 pips
        takeProfitPrice: 1.11, // 100 pips, R:R 1
        usdRate: 1,
        maxLeverage: 50,
        maxMarginUsedPct: 0,
      });
      expect(f.achievable).toBe(true);
      expect(f.lots).toBeCloseTo(0.1, 2); // 100 / (100 × 10)
    });

    it('take profit on the wrong side is rejected', () => {
      const f = goalFeasibility({ symbol: 'EUR/JPY', ...base, takeProfitPrice: 184.9 });
      expect(f.achievable).toBe(false);
    });
  });
});
