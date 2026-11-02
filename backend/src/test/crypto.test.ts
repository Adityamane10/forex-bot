import { describe, it, expect } from 'vitest';
import { calculateSizing } from '../math/forexMath';
import { calculateExpectedValue } from '../engines/expectedValueEngine';
import { buildEntry } from '../engines/entryEngine';
import { buildStopLoss } from '../engines/stopLossEngine';
import { buildTakeProfit } from '../engines/takeProfitEngine';
import { sizePosition } from '../engines/positionSizingEngine';
import { DisabledExecutionProvider } from '../providers/types';
import {
  CRYPTO_ASSETS, assetClassFor, cryptoFee, cryptoFundingPerDay, getAsset,
  getCryptoAsset, priceToPips, roundQuantity, DEFAULT_SYMBOLS,
} from '@fx/shared';
import {
  binanceInterval, mapBookTicker, mapKline, toExchangeSymbol, toInternalSymbol,
} from '../providers/binanceCryptoMarketData';
import type { UserSettings } from '@fx/shared';

const settings: UserSettings = {
  minimumProfit: 0, availableCapital: 10000, accountCurrency: 'USD',
  maxRiskPercent: 1, minRr: 1.5, minConfidence: 0.55,
  maxDailyLossPercent: 3, maxWeeklyLossPercent: 6, maxDrawdownPercent: 10,
  maxConsecutiveLosses: 5, maxOpenPositions: 5, maxCorrelatedPositions: 3,
  maxLeverage: 50, maxCurrencyExposurePercent: 30,
  selectedPairs: [], selectedTimeframes: ['1h'], preferredSessions: [],
  newsTrading: false, highImpactNewsRestriction: true, paperStartingCapital: 10000,
};

describe('crypto asset model', () => {
  it('classifies symbols by asset class', () => {
    expect(assetClassFor('BTC/USDT')).toBe('CRYPTO');
    expect(assetClassFor('EUR/USD')).toBe('FOREX');
    expect(() => assetClassFor('NOTHING/XXX')).toThrow();
  });

  it('maps crypto assets onto the unified spec (tick = pip, contract = 1)', () => {
    const a = getAsset('BTC/USDT');
    expect(a.assetClass).toBe('CRYPTO');
    expect(a.pipSize).toBe(CRYPTO_ASSETS['BTC/USDT'].tickSize);
    expect(a.contractSize).toBe(1);
    expect(a.minimumLot).toBe(CRYPTO_ASSETS['BTC/USDT'].minQuantity);
    expect(a.maxSpreadPips).toBe(CRYPTO_ASSETS['BTC/USDT'].maxSpreadTicks);
    expect(a.takerFee).toBe(0.001);
  });

  it('quantity rounding respects step, min and max', () => {
    expect(roundQuantity('BTC/USDT', 0.123456)).toBeCloseTo(0.12345, 5);
    expect(roundQuantity('BTC/USDT', 0.0000001)).toBeCloseTo(0.00001, 5); // min qty
    expect(roundQuantity('DOGE/USDT', 1234.5)).toBe(1234); // step 1, precision 0
    expect(roundQuantity('BTC/USDT', 1e12)).toBe(9000); // max qty
  });

  it('crypto fees are percentage of notional', () => {
    expect(cryptoFee('BTC/USDT', 60000, 0.1, 'taker')).toBeCloseTo(6, 6); // 0.1% of $6000
    expect(cryptoFee('EUR/USD', 1.1, 1, 'taker')).toBe(0); // not crypto
  });

  it('funding is zero for spot but computable for futures-like metadata', () => {
    expect(cryptoFundingPerDay('BTC/USDT', 60000, 1, 'BUY')).toBe(0); // spot
  });
});

describe('crypto position sizing (spec §30)', () => {
  it('risk-based quantity: 1% of $10k with $1000 SL on BTC -> 0.1 BTC', () => {
    const out = calculateSizing({
      symbol: 'BTC/USDT', accountCurrency: 'USD', capital: 10000, riskPercent: 1,
      entryPrice: 60000, stopLossPrice: 59000, usdRate: 1, maxLeverage: 50,
    });
    expect(out.valid).toBe(true);
    expect(out.lots).toBeCloseTo(0.1, 5); // 100 / 1000
    expect(out.riskAmount).toBeCloseTo(100, 2);
    expect(out.leverageUsed).toBeCloseTo(6000 / 10000, 2); // spot notional < capital
  });

  it('rejects leverage beyond max for crypto', () => {
    const out = calculateSizing({
      symbol: 'BTC/USDT', accountCurrency: 'USD', capital: 1000, riskPercent: 100,
      entryPrice: 60000, stopLossPrice: 59500, usdRate: 1, maxLeverage: 2,
    });
    expect(out.valid).toBe(false);
    expect(out.reason).toContain('leverage');
  });

  it('sizePosition wrapper works for crypto through the unified asset', () => {
    const out = sizePosition({
      symbol: 'BTC/USDT', entryPrice: 60000, stopLossPrice: 59000,
      settings, usdRate: 1,
    });
    expect(out.valid).toBe(true);
    expect(out.units).toBeCloseTo(0.1, 5);
    expect(out.marginRequirement).toBe(1); // spot fully collateralized
  });
});

describe('crypto expected value (spec §25)', () => {
  it('EV includes percentage taker fee and funding for crypto', () => {
    const entry = 60000;
    const ev = calculateExpectedValue({
      symbol: 'BTC/USDT',
      probabilityWin: 0.6,
      averageWinPerLot: 3000, // |tp1 - entry| * 1
      averageLossPerLot: 1000,
      spreadPerLot: 0.01,
      commissionPerLot: entry * 0.001, // taker fee on notional
      swapPerDayPerLot: 0, // spot funding = 0
      daysHeld: 1,
    });
    expect(ev.positive).toBe(true);
    // gross = 0.6*3000 - 0.4*1000 = 1400 ; costs = 0.01 + 60 + slippage(0.2*0.01*1)
    expect(ev.evPerTrade).toBeCloseTo(1400 - 60.012, 1);
  });
});

describe('crypto entry/SL/TP (spec §13, §14)', () => {
  const levels = {
    support: [58000], resistance: [64000], pivot: 60000,
    prevDayHigh: 60500, prevDayLow: 59500, prevWeekHigh: 62000, prevWeekLow: 59000,
    distanceToSupportPips: 1000, distanceToResistancePips: 1000,
    nearestSupport: 58000, nearestResistance: 64000,
  };

  it('entry zone uses tick-based bounds, not forex pip bounds', () => {
    const entry = buildEntry({
      symbol: 'BTC/USDT', direction: 'BUY', currentPrice: 60000,
      atr: 400, levels, structure: 'UPTREND', timestamp: Date.now(),
    });
    // zone width bounded by 30..200 ticks (0.01) — not the forex 6..12 pips
    const width = entry.entryMax - entry.entryMin;
    expect(width).toBeGreaterThanOrEqual(30 * 0.01);
    expect(width).toBeLessThanOrEqual(200 * 0.01);
    expect(entry.preferredEntry).toBeLessThan(60000); // pullback
  });

  it('stop loss respects crypto tick buffer and minimum', () => {
    const sl = buildStopLoss({
      symbol: 'BTC/USDT', direction: 'BUY', entry: 60000,
      atr: 400, levels, bufferPips: 10,
    });
    expect(sl.valid).toBe(true);
    expect(sl.plan.price).toBeLessThan(60000);
    expect(sl.plan.pips).toBeGreaterThanOrEqual(30); // slMinTicks
  });

  it('take profit derives R:R from ATR-scaled risk', () => {
    const tp = buildTakeProfit({
      symbol: 'BTC/USDT', direction: 'BUY', entry: 60000,
      stopLoss: 59000, atr: 400, levels,
    });
    expect(tp.rr1).toBeGreaterThanOrEqual(1.5);
    expect(tp.tp1).toBeGreaterThan(60000);
  });
});

describe('binance provider mapping', () => {
  it('converts internal symbols to exchange symbols and back', () => {
    expect(toExchangeSymbol('BTC/USDT')).toBe('BTCUSDT');
    expect(toInternalSymbol('BTCUSDT')).toBe('BTC/USDT');
    expect(toInternalSymbol('ethusdt')).toBe('ETH/USDT');
    expect(toInternalSymbol('NONSENSE')).toBeNull();
  });

  it('maps timeframes to binance intervals', () => {
    expect(binanceInterval('1m')).toBe('1m');
    expect(binanceInterval('1D')).toBe('1d');
    expect(binanceInterval('4h')).toBe('4h');
  });

  it('maps a bookTicker payload to a LIVE tick with real bid/ask', () => {
    const tick = mapBookTicker({ s: 'BTCUSDT', b: '59999.00', a: '60001.00', E: 1700000000000 });
    expect(tick).not.toBeNull();
    expect(tick!.symbol).toBe('BTC/USDT');
    expect(tick!.bid).toBe(59999);
    expect(tick!.ask).toBe(60001);
    expect(tick!.spread).toBe(2);
    expect(tick!.mode).toBe('LIVE');
    expect(tick!.assetClass).toBe('CRYPTO');
  });

  it('rejects malformed book tickers', () => {
    expect(mapBookTicker({ s: 'XXX', b: '1', a: '2' })).toBeNull();
    expect(mapBookTicker({ s: 'BTCUSDT', b: '3', a: '1' })).toBeNull(); // ask < bid
    expect(mapBookTicker({})).toBeNull();
  });

  it('maps kline rows to candles', () => {
    const c = mapKline([1700000000000, '59900', '60100', '59800', '60000', '12.5', 1700000060000]);
    expect(c).not.toBeNull();
    expect(c!.open).toBe(59900);
    expect(c!.high).toBe(60100);
    expect(c!.low).toBe(59800);
    expect(c!.close).toBe(60000);
    expect(c!.volume).toBe(12.5);
    expect(c!.completed).toBe(true);
  });

  it('rejects malformed klines', () => {
    expect(mapKline([1, 'a', 'b', 'c', 'd', 'e', 7])).toBeNull();
    expect(mapKline([])).toBeNull();
  });
});

describe('execution provider (spec §43) — live trading off by default', () => {
  it('refuses orders unless live is enabled AND risk approves', async () => {
    const p = new DisabledExecutionProvider(false);
    const res = await p.placeOrder(
      { symbol: 'EUR/USD', direction: 'BUY', quantity: 0.1, orderType: 'MARKET' },
      { riskApproved: true, liveEnabled: false },
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('live trading disabled');
    expect(p.liveCapable).toBe(false);
  });

  it('even with live enabled the safety stub still refuses', async () => {
    const p = new DisabledExecutionProvider(true);
    const res = await p.placeOrder(
      { symbol: 'BTC/USDT', direction: 'BUY', quantity: 0.1, orderType: 'MARKET' },
      { riskApproved: true, liveEnabled: true },
    );
    expect(res.ok).toBe(false);
  });
});

describe('crypto + forex coexistence', () => {
  it('DEFAULT_SYMBOLS stays forex-only for backward compatibility', () => {
    expect(DEFAULT_SYMBOLS.every((s) => assetClassFor(s) === 'FOREX')).toBe(true);
  });
  it('pip math works for crypto in tick units', () => {
    expect(priceToPips('BTC/USDT', 1)).toBeCloseTo(100, 6); // 1 USD = 100 ticks
    expect(getCryptoAsset('BTC/USDT').exchange).toBe('BINANCE');
  });
});
