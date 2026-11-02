import { describe, it, expect } from 'vitest';
import { fmt, fmtPct, fmtPrice } from './format';

describe('format helpers', () => {
  it('fmt: fixed digits and dash for null', () => {
    expect(fmt(1.23456, 2)).toBe('1.23');
    expect(fmt(null, 2)).toBe('—');
    expect(fmt(undefined, 2)).toBe('—');
  });

  it('fmtPct: signs and digits', () => {
    expect(fmtPct(3.456, 1)).toBe('+3.5%');
    expect(fmtPct(-2.1, 1)).toBe('-2.1%');
  });

  it('fmtPrice: pair-appropriate precision', () => {
    expect(fmtPrice(1.08512345, 'EUR/USD')).toBe('1.08512');
    expect(fmtPrice(154.512345, 'USD/JPY')).toBe('154.512');
    expect(fmtPrice(2380.1234, 'XAU/USD')).toBe('2380.12');
  });
});
