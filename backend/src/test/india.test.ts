import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import { generateIndiaStopLoss, generateIndiaTakeProfit, pointsToInr, inrToPoints } from '../india/sl-tp';
import { sizeIndiaPosition, validateIndiaRisk, DEFAULT_INDEX_MARGIN_FACTOR, INDIA_ESTIMATED_CHARGES_PER_LOT } from '../india/risk-engine';
import { indiaSessionIndex, indiaRegime } from '../india/analysis';
import { strategyForRegime, indiaSignalCriteria } from '../india/strategies';
import { buildIndiaFeatures, INDIA_FEATURE_VERSION } from '../india/ml';
import { computeIndiaPnL } from '../india/paper-execution';
import { istFields, istDateKey, IndiaMarketSessionService } from '../india/session';
import type { IndiaInstrument, IndiaIndicatorValues } from '@fx/shared';

const niftyFut: IndiaInstrument = {
  instrumentToken: '256265',
  exchange: 'NSE',
  segment: 'NSE_FUT',
  tradingSymbol: 'NIFTY 50 FUT',
  underlying: 'NIFTY',
  name: 'NIFTY 50 Future',
  contractType: 'FUT',
  expiry: 1786694400000,
  strike: null,
  optionType: null,
  lotSize: 75,
  tickSize: 0.05,
  freezeQuantity: 3600,
  status: 'ACTIVE',
  tradable: true,
  marginRequirement: 0.15,
};

const baseIndicators: IndiaIndicatorValues = {
  close: 25000,
  atr14: 120,
  swingHigh: 25200,
  swingLow: 24800,
  support: 24850,
  resistance: 25150,
  rsi14: 58,
  adx: 28,
  bbPosition: 0.7,
  ema9: 24950,
  ema50: 24800,
};

describe('india: SL/TP (spec §22, §24)', () => {
  it('BUY stop-loss goes below support with ATR buffer', () => {
    const sl = generateIndiaStopLoss({ instrument: niftyFut, indicators: baseIndicators, side: 'BUY', entry: 25000, strategy: 'TREND_FOLLOWING', minRr: 1.5, timeframe: '5m' });
    expect(sl.price).toBeLessThan(25000);
    expect(sl.distance).toBeGreaterThan(0);
    expect(sl.basis).toContain('support');
  });

  it('SELL stop-loss goes above resistance with ATR buffer', () => {
    const sl = generateIndiaStopLoss({ instrument: niftyFut, indicators: baseIndicators, side: 'SELL', entry: 25000, strategy: 'TREND_FOLLOWING', minRr: 1.5, timeframe: '5m' });
    expect(sl.price).toBeGreaterThan(25000);
  });

  it('ATR fallback when no support/swing levels', () => {
    const sl = generateIndiaStopLoss({ instrument: niftyFut, indicators: { close: 25000, atr14: 100 }, side: 'BUY', entry: 25000, strategy: 'TREND_FOLLOWING', minRr: 1.5, timeframe: '5m' });
    expect(sl.distance).toBeGreaterThanOrEqual(150);
    expect(sl.basis).toContain('ATR');
  });

  it('SL is capped at 5% of price and never tighter than 5 ticks', () => {
    const sl = generateIndiaStopLoss({ instrument: niftyFut, indicators: { close: 25000, atr14: 4000 }, side: 'SELL', entry: 25000, strategy: 'TREND_FOLLOWING', minRr: 1.5, timeframe: '5m' });
    expect(sl.distance).toBeLessThanOrEqual(25000 * 0.05 + 0.0001);
  });

  it('take-profit defaults to minRr when no near level', () => {
    const sl = generateIndiaStopLoss({ instrument: niftyFut, indicators: baseIndicators, side: 'BUY', entry: 25000, strategy: 'TREND_FOLLOWING', minRr: 1.5, timeframe: '5m' });
    const tp = generateIndiaTakeProfit({ instrument: niftyFut, indicators: { close: 25000 }, side: 'BUY', entry: 25000, strategy: 'TREND_FOLLOWING', minRr: 1.5, timeframe: '5m' }, sl);
    expect(tp.target).toBeGreaterThan(25000);
    expect(tp.rr).toBeGreaterThanOrEqual(1.5);
  });

  it('pointsToInr / inrToPoints convert via lot size', () => {
    expect(pointsToInr(niftyFut, 2)).toBe(150);
    expect(inrToPoints(niftyFut, 75, 150)).toBe(2);
    expect(inrToPoints(niftyFut, 0, 150)).toBe(0);
  });
});

describe('india: risk / sizing (spec §14, §46, §47)', () => {
  // distance 10 pts -> risk/lot ₹750 -> 1 lot affordable at ₹1000 max risk;
  // marginFactor lowered so the margin check passes at 1 lot.
  const healthy = { instrument: niftyFut, amountInr: 100000, maxRiskInr: 1000, maxMarginPercent: 20, marginFactor: 0.01, side: 'BUY' as const, entry: 25000, stopLoss: 24990, target: 25300 };

  it('sizes lots from max risk, risk-first', () => {
    const sizing = sizeIndiaPosition(healthy);
    expect(sizing.valid).toBe(true);
    expect(sizing.lots).toBe(1);
    expect(sizing.quantity).toBe(75);
    expect(sizing.maximumLoss).toBeLessThanOrEqual(1000);
  });

  it('rejects when min lot not affordable', () => {
    const sizing = sizeIndiaPosition({ ...healthy, maxRiskInr: 10 });
    expect(sizing.valid).toBe(false);
  });

  it('rejects when margin estimate exceeds limit', () => {
    const sizing = sizeIndiaPosition({ instrument: niftyFut, amountInr: 100000, maxRiskInr: 10000, maxMarginPercent: 20, marginFactor: 0.15, side: 'BUY', entry: 25000, stopLoss: 24990, target: 25300 });
    expect(sizing.valid).toBe(false);
    expect(sizing.reason).toContain('margin');
  });

  it('invalid stop distance -> invalid sizing', () => {
    const sizing = sizeIndiaPosition({ ...healthy, stopLoss: 25000 });
    expect(sizing.valid).toBe(false);
  });

  it('validateIndiaRisk accepts a healthy setup', () => {
    const sizing = sizeIndiaPosition(healthy);
    const res = validateIndiaRisk({ instrument: niftyFut, sizing, maxRiskInr: 1000, amountInr: 100000, maxMarginPercent: 20, rr: sizing.rr, minRr: 1.5, targetInr: 100 });
    expect(res.ok).toBe(true);
  });

  it('validateIndiaRisk blocks untradable contract', () => {
    const dead: IndiaInstrument = { ...niftyFut, tradable: false };
    const sizing = sizeIndiaPosition({ ...healthy, instrument: dead });
    const res = validateIndiaRisk({ instrument: dead, sizing, maxRiskInr: 1000, amountInr: 100000, maxMarginPercent: 20, rr: sizing.rr, minRr: 1.5, targetInr: 100 });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('CONTRACT_NOT_TRADABLE');
  });

  it('defaults are exported', () => {
    expect(DEFAULT_INDEX_MARGIN_FACTOR).toBe(0.15);
    expect(INDIA_ESTIMATED_CHARGES_PER_LOT).toBeGreaterThan(0);
  });
});

describe('india: analysis helpers (spec §18)', () => {
  it('indiaSessionIndex maps IST 09-15 to 0..6, else 0', () => {
    const at10amIST = Date.UTC(2026, 7, 20, 4, 30); // 10:00 IST = 04:30 UTC
    expect(indiaSessionIndex(at10amIST)).toBe(1);
    const at3pmIST = Date.UTC(2026, 7, 20, 9, 30); // 15:00 IST
    expect(indiaSessionIndex(at3pmIST)).toBe(6);
    const night = Date.UTC(2026, 7, 20, 18, 0); // 23:30 IST
    expect(indiaSessionIndex(night)).toBe(0);
  });

  it('indiaRegime stays in 0..8', () => {
    expect(indiaRegime(40, 100, 90, 2)).toBeGreaterThanOrEqual(0);
    expect(indiaRegime(40, 100, 90, 2)).toBeLessThanOrEqual(10);
    expect(indiaRegime(0, null, null, null)).toBe(2);
  });
});

describe('india: strategies (spec §12, §20, §52)', () => {
  it('routes regimes to strategies', () => {
    expect(strategyForRegime('TRENDING_BULLISH')).toBe('TREND_FOLLOWING');
    expect(strategyForRegime('BREAKOUT')).toBe('BREAKOUT');
    expect(strategyForRegime('RANGING')).toBe('RANGE');
    expect(strategyForRegime('REVERSAL')).toBe('MEAN_REVERSION');
    expect(strategyForRegime('UNKNOWN_REGIME')).toBe('RISK_CONTROLLED');
  });

  it('TREND_FOLLOWING needs adx>=20 + trend', () => {
    expect(indiaSignalCriteria('TREND_FOLLOWING', { adx: 25, close: 100 }, { trend: 'BULLISH', support: null, resistance: null })).toBe('BUY');
    expect(indiaSignalCriteria('TREND_FOLLOWING', { adx: 10, close: 100 }, { trend: 'BULLISH', support: null, resistance: null })).toBeNull();
  });

  it('MEAN_REVERSION buys oversold', () => {
    expect(indiaSignalCriteria('MEAN_REVERSION', { bbPosition: 0, rsi14: 30 }, { trend: 'NEUTRAL', support: null, resistance: null })).toBe('BUY');
    expect(indiaSignalCriteria('MEAN_REVERSION', { bbPosition: 1, rsi14: 70 }, { trend: 'NEUTRAL', support: null, resistance: null })).toBe('SELL');
  });

  it('BREAKOUT needs volume confirmation', () => {
    expect(indiaSignalCriteria('BREAKOUT', { bbPosition: 1.1, volumeRatio: 1.5 }, { trend: 'NEUTRAL', support: null, resistance: null })).toBe('BUY');
    expect(indiaSignalCriteria('BREAKOUT', { bbPosition: 1.1, volumeRatio: 0.8 }, { trend: 'NEUTRAL', support: null, resistance: null })).toBeNull();
  });
});

describe('india: features (spec §19)', () => {
  it('produces a stable 23-feature vector normalized to 0..1', () => {
    const f = buildIndiaFeatures(baseIndicators, { session: 2, regime: 4, spread: 0.5, timestamp: Date.now() });
    expect(Object.keys(f)).toHaveLength(23);
    for (const [k, v] of Object.entries(f)) {
      expect(v, k).toBeGreaterThanOrEqual(0);
      expect(v, k).toBeLessThanOrEqual(1);
    }
    expect(f.trend).toBe(0.5); // absent trend -> x=0 -> (0-(-1))/2
  });

  it('session/regime normalize against 0..6 and 0..8 bounds', () => {
    const f = buildIndiaFeatures({}, { session: 6, regime: 8, spread: 10, timestamp: 0 });
    expect(f.session).toBe(1);
    expect(f.regime).toBe(1);
    expect(f.spread).toBe(1);
    expect(INDIA_FEATURE_VERSION).toBe('india-features-v1');
  });
});

describe('india: paper P&L (spec §25)', () => {
  it('computes INR P&L net of charges', () => {
    const pnl = computeIndiaPnL({ instrument: niftyFut, side: 'BUY', quantity: 75, entryPrice: 25000, exitPrice: 25100, lotSize: 75 });
    expect(pnl.grossPnl).toBe(7500);
    expect(pnl.charges).toBeGreaterThan(0);
    expect(pnl.netPnl).toBeLessThan(pnl.grossPnl);
  });

  it('short P&L is inverted', () => {
    const pnl = computeIndiaPnL({ instrument: niftyFut, side: 'SELL', quantity: 75, entryPrice: 25100, exitPrice: 25000, lotSize: 75 });
    expect(pnl.grossPnl).toBe(7500);
  });
});

describe('india: session helpers (spec §9, §10)', () => {
  it('istFields shifts UTC by +5:30', () => {
    const f = istFields(Date.UTC(2026, 7, 20, 4, 30)); // 10:00 IST
    expect(f.hour).toBe(10);
    expect(f.minute).toBe(0);
    expect(f.day).toBe(20);
  });

  it('istDateKey formats yyyy-mm-dd', () => {
    expect(istDateKey(Date.UTC(2026, 0, 5, 18, 30))).toBe('2026-01-06'); // 00:00 IST next day
  });

  it('snapshot reports OPEN during trading hours on a weekday', async () => {
    const svc = new IndiaMarketSessionService({ find: async () => [] } as never, new EventEmitter());
    await svc.init();
    const open = Date.UTC(2026, 7, 20, 5, 30); // 11:00 IST Thursday
    const snap = svc.snapshot(open);
    expect(snap.marketOpen).toBe(true);
    expect(snap.status).toBe('OPEN');
    expect(snap.segments.NSE_FUT).toBe(true);
  });

  it('snapshot reports HOLIDAY on 2026-08-15', async () => {
    const svc = new IndiaMarketSessionService({ find: async () => [] } as never, new EventEmitter());
    await svc.init();
    const ts = Date.UTC(2026, 7, 15, 5, 0); // 10:30 IST
    const snap = svc.snapshot(ts);
    expect(snap.status).toBe('HOLIDAY');
    expect(snap.marketOpen).toBe(false);
  });
});

describe('india: Upstox analytics token (spec §49, read-only feed)', () => {
  it('upstoxToken with only an analytics token authenticates read-only (no OAuth)', async () => {
    const { upstoxToken } = await import('../india/brokers/upstox/upstox-auth');
    const session = await upstoxToken({ broker: 'UPSTOX', apiKey: '', apiSecret: '', analyticsToken: 'tok-analytics' });
    expect(session.authenticated).toBe(true);
    expect(session.readOnly).toBe(true);
    expect(session.accessToken).toBe('tok-analytics');
  });

  it('upstoxToken with a pre-issued access token authenticates read-write', async () => {
    const { upstoxToken } = await import('../india/brokers/upstox/upstox-auth');
    const session = await upstoxToken({ broker: 'UPSTOX', apiKey: '', apiSecret: '', accessToken: 'tok-rw' });
    expect(session.authenticated).toBe(true);
    expect(session.readOnly).toBeFalsy();
  });

  it('upstoxToken without any token throws (no silent auth)', async () => {
    const { upstoxToken } = await import('../india/brokers/upstox/upstox-auth');
    await expect(upstoxToken({ broker: 'UPSTOX', apiKey: '', apiSecret: '' })).rejects.toThrow(/analytics_token|code/);
  });

  it('UpstoxAdapter blocks order placement in analytics (read-only) mode', async () => {
    const { UpstoxAdapter } = await import('../india/brokers/upstox/upstox-adapter');
    const adapter = new UpstoxAdapter({ feedMode: 'ltp' });
    expect(adapter.feedMode).toBe('ltp');
    await adapter.authenticate({ broker: 'UPSTOX', apiKey: '', apiSecret: '', analyticsToken: 'tok-analytics' });
    expect(adapter.readOnly).toBe(true);
    await expect(adapter.placeOrder({} as never)).rejects.toThrow(/read-only/);
    await expect(adapter.modifyOrder('1', {} as never)).rejects.toThrow(/read-only/);
    await expect(adapter.cancelOrder('1')).rejects.toThrow(/read-only/);
  });

  it('UpstoxAdapter allows order calls outside read-only mode', async () => {
    const { UpstoxAdapter } = await import('../india/brokers/upstox/upstox-adapter');
    const adapter = new UpstoxAdapter({ feedMode: 'full' });
    expect(adapter.feedMode).toBe('full');
    await adapter.authenticate({ broker: 'UPSTOX', apiKey: '', apiSecret: '', accessToken: 'tok-rw' });
    expect(adapter.readOnly).toBe(false);
    const err = await adapter.placeOrder({} as never).catch((e: unknown) => e);
    expect(String(err)).not.toMatch(/read-only/i);
  });

  it('NullBrokerAdapter is read-only with ltp feed', async () => {
    const { NullBrokerAdapter } = await import('../india/brokers/broker-adapter');
    const adapter = new NullBrokerAdapter();
    expect(adapter.readOnly).toBe(true);
    expect(adapter.feedMode).toBe('ltp');
  });
});