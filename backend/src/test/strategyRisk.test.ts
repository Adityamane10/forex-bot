import { describe, it, expect } from 'vitest';
import { selectStrategy } from '../engines/strategyEngine';
import { EmergencyStopEngine } from '../engines/emergencyStopEngine';
import { computeTrailingStop } from '../engines/trailingStopEngine';
import { computeMetrics } from '../engines/metricsEngine';
import { CcxtCryptoExchangeAdapter, ohlcvToCandles } from '../providers/cryptoExchangeAdapter';
import type { MarketRegime, PaperTrade } from '@fx/shared';

describe('strategy router (spec §28)', () => {
  const pa = { patterns: [] as string[] } as never;
  it('maps trending regimes to trend-following', () => {
    expect(selectStrategy('TRENDING_BULLISH', null, pa).strategy).toBe('TREND_FOLLOWING');
    expect(selectStrategy('TRENDING_BEARISH', null, pa).strategy).toBe('TREND_FOLLOWING');
  });
  it('maps breakout/breakdown/ranging/high-vol regimes', () => {
    expect(selectStrategy('BREAKOUT', null, pa).strategy).toBe('BREAKOUT');
    expect(selectStrategy('BREAKDOWN', null, pa).strategy).toBe('MOMENTUM');
    expect(selectStrategy('RANGING', null, pa).strategy).toBe('MEAN_REVERSION');
    expect(selectStrategy('HIGH_VOLATILITY', null, pa).strategy).toBe('RISK_CONTROLLED');
    expect(selectStrategy('UNCERTAIN', null, pa).strategy).toBe('RISK_CONTROLLED');
    expect(selectStrategy('LIQUIDITY_STRESSED', null, pa).strategy).toBe('RISK_CONTROLLED');
  });
  it('trend + pullback selects the pullback strategy', () => {
    const pa2 = { patterns: ['PULLBACK'] } as never;
    expect(selectStrategy('TRENDING_BULLISH', { rsi14: 55 } as never, pa2).strategy).toBe('PULLBACK');
  });
  it('trend + strong RSI selects momentum', () => {
    expect(selectStrategy('TRENDING_BULLISH', { rsi14: 72 } as never, pa).strategy).toBe('MOMENTUM');
  });
  it('records a strategy version for reproducibility', () => {
    const s = selectStrategy('BREAKOUT', null, pa);
    expect(s.strategyVersion).toBeTruthy();
    expect(s.reason).toBeTruthy();
  });
});

describe('global emergency stop (spec §90)', () => {
  it('blocks after trigger and resumes after release', async () => {
    const e = new EmergencyStopEngine(null);
    expect(e.isTriggered()).toBe(false);
    await e.trigger('test reason');
    expect(e.isTriggered()).toBe(true);
    expect(e.status().triggeredAt).not.toBeNull();
    await e.release('test release');
    expect(e.isTriggered()).toBe(false);
  });
  it('records a trigger/release history', async () => {
    const e = new EmergencyStopEngine(null);
    await e.trigger('market data down');
    await e.release('feed recovered');
    const h = e.status().history;
    expect(h).toHaveLength(2);
    expect(h[0].action).toBe('TRIGGER');
    expect(h[1].action).toBe('RELEASE');
  });
});

describe('trailing stop (spec §63)', () => {
  it('does not trail before activation threshold', () => {
    const r = computeTrailingStop({ direction: 'BUY', entry: 100, mid: 100.8, currentStop: 99, atr: 0.5, atrMultiplier: 2, activateR: 1 });
    expect(r.stop).toBeNull();
  });
  it('ratchets the SL up behind price after 1R profit (BUY)', () => {
    const r = computeTrailingStop({ direction: 'BUY', entry: 100, mid: 102, currentStop: 99, atr: 0.5, atrMultiplier: 2, activateR: 1 });
    expect(r.activated).toBe(true);
    expect(r.stop).toBeCloseTo(102 - 1, 6); // mid - 2*ATR
  });
  it('never moves the SL below entry (profit locked)', () => {
    const r = computeTrailingStop({ direction: 'BUY', entry: 100, mid: 100.6, currentStop: 99, atr: 0.5, atrMultiplier: 2, activateR: 1 });
    // mid - trail(1) = 99.6 < entry -> rejected (candidate must be >= entry)
    expect(r.stop).toBeNull();
  });
  it('only ratchets in the profitable direction — never loosens', () => {
    const r1 = computeTrailingStop({ direction: 'BUY', entry: 100, mid: 102, currentStop: 101.5, atr: 0.5, atrMultiplier: 2, activateR: 1 });
    // candidate 101 < currentStop 101.5 -> keep tighter stop (no move)
    expect(r1.stop).toBeNull();
  });
  it('mirrors for SELL (ratchets down)', () => {
    const r = computeTrailingStop({ direction: 'SELL', entry: 100, mid: 98, currentStop: 101, atr: 0.5, atrMultiplier: 2, activateR: 1 });
    expect(r.activated).toBe(true);
    expect(r.stop).toBeCloseTo(99, 6); // mid + 2*ATR
  });
});

describe('backtest metrics — CAGR & recovery factor (spec §66)', () => {
  const trades = [
    { pnl: 100, symbol: 'EUR/USD', session: 'LONDON', regime: 'TRENDING_BULLISH', durationMs: 3600_000 },
    { pnl: -50, symbol: 'BTC/USDT', session: 'OFF_HOURS', regime: 'RANGING', durationMs: 3600_000 },
  ] as unknown as PaperTrade[];
  const equity = [
    { time: Date.now() - 365 * 86400_000, equity: 10000 },
    { time: Date.now() - 180 * 86400_000, equity: 10100 },
    { time: Date.now(), equity: 10050 },
  ];

  it('computes CAGR from the equity-curve span', () => {
    const m = computeMetrics({ trades, equityCurve: equity, startingCapital: 10000 });
    // final equity 10050 over ~1 year -> ~0.5% CAGR
    expect(m.cagrPct).toBeGreaterThan(0);
    expect(m.cagrPct).toBeLessThan(1);
  });
  it('computes recovery factor = net profit / max drawdown', () => {
    const m = computeMetrics({ trades, equityCurve: equity, startingCapital: 10000 });
    // net profit 50; max drawdown peak 10100 -> 10000? actually peak 10100 then 10050 => dd 50
    expect(m.recoveryFactor).toBeGreaterThan(0);
  });
  it('infinity recovery factor when never in drawdown and profitable', () => {
    const flat = [
      { time: Date.now() - 86400_000, equity: 10000 },
      { time: Date.now(), equity: 10050 },
    ];
    const m = computeMetrics({ trades, equityCurve: flat, startingCapital: 10000 });
    expect(m.recoveryFactor).toBe(Infinity);
  });
});

describe('crypto exchange adapter (spec §9, CCXT-backed)', () => {
  // Hermetic: inject a fake CCXT-like exchange so no network is touched.
  function fakeExchange(overrides: Record<string, unknown> = {}) {
    return {
      id: 'binance',
      loadMarkets: async () => ({
        'BTC/USDT': { symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', precision: { price: 0.01, amount: 0.00001 }, limits: { amount: { min: 0.00001, max: 9000 } }, maker: 0.001, taker: 0.001, active: true, spot: true, swap: false, margin: false },
        'ETH/USDT': { symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', precision: { price: 0.01, amount: 0.00001 }, limits: { amount: { min: 0.00001, max: 100000 } }, maker: 0.001, taker: 0.001, active: true, spot: true, swap: false, margin: false },
      }),
      fetchTicker: async () => ({ timestamp: 1700000000000, bid: 60000, ask: 60001 }),
      fetchOHLCV: async () => [[1700000000000, 59900, 60100, 59800, 60000, 12.5]],
      fetchOrderBook: async () => ({ timestamp: 1700000000000, bids: [[60000, 1]], asks: [[60001, 2]] }),
      ...overrides,
    } as never;
  }

  it('normalizes market metadata', async () => {
    const adapter = new CcxtCryptoExchangeAdapter(fakeExchange());
    const markets = await adapter.getMarkets();
    expect(markets.length).toBe(2);
    const btc = markets.find((m) => m.symbol === 'BTC/USDT');
    expect(btc!.tickSize).toBe(0.01);
    expect(btc!.quantityStep).toBe(0.00001);
    expect(btc!.minQuantity).toBe(0.00001);
    expect(btc!.takerFee).toBe(0.001);
    expect(btc!.spot).toBe(true);
  });

  it('normalizes quotes with real bid/ask', async () => {
    const adapter = new CcxtCryptoExchangeAdapter(fakeExchange());
    const q = await adapter.getQuote('BTC/USDT');
    expect(q!.bid).toBe(60000);
    expect(q!.ask).toBe(60001);
    expect(q!.spread).toBe(1);
    expect(q!.mid).toBe(60000.5);
  });

  it('normalizes OHLCV and converts to candles', async () => {
    const adapter = new CcxtCryptoExchangeAdapter(fakeExchange());
    const rows = await adapter.getOHLCV('BTC/USDT', '1h', 0, 1e15);
    expect(rows.length).toBe(1);
    const candles = ohlcvToCandles('BTC/USDT', '1h', rows);
    expect(candles[0].open).toBe(59900);
    expect(candles[0].close).toBe(60000);
    expect(candles[0].completed).toBe(true);
  });

  it('normalizes the order book', async () => {
    const adapter = new CcxtCryptoExchangeAdapter(fakeExchange());
    const ob = await adapter.getOrderBook('BTC/USDT', 5);
    expect(ob!.bids[0][0]).toBe(60000);
    expect(ob!.asks[0][1]).toBe(2);
  });

  it('refuses execution methods (live trading disabled)', async () => {
    const adapter = new CcxtCryptoExchangeAdapter(fakeExchange());
    await expect(adapter.createOrder()).rejects.toThrow(/live execution is disabled/);
    await expect(adapter.cancelOrder()).rejects.toThrow(/live execution is disabled/);
    await expect(adapter.getOrder()).rejects.toThrow(/live execution is disabled/);
  });

  it('returns empty balance/positions without keys', async () => {
    const adapter = new CcxtCryptoExchangeAdapter(fakeExchange());
    expect(await adapter.getBalance()).toEqual({});
    expect(await adapter.getPositions()).toEqual([]);
  });
});
