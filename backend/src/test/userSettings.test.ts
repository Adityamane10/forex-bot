/**
 * User-settings driven behavior (spec §56 extension):
 *   - the paper engine closes a position whose unrealized P&L reaches the
 *     user's minimumProfitInr (PROFIT_TARGET), reading the threshold LIVE.
 */
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import type { IndiaInstrument, IndiaSignal, IndiaTick } from '@fx/shared';
import { IndiaPaperExecutionEngine } from '../india/paper-execution';

function makeInstrument(token: string): IndiaInstrument {
  return {
    instrumentToken: token,
    instrumentKey: `NSE_OPT|${token}`,
    exchange: 'NSE',
    segment: 'NSE_OPT',
    tradingSymbol: `NIFTY25000CE-${token}`,
    underlying: 'NIFTY',
    name: `NIFTY 25000 CE ${token}`,
    contractType: 'OPT',
    expiry: Date.now() + 3 * 86_400_000,
    strike: 25000,
    optionType: 'CE',
    lotSize: 65,
    tickSize: 0.05,
    freezeQuantity: null,
    status: 'ACTIVE',
    tradable: true,
  };
}

function makeSignal(token: string): IndiaSignal {
  const now = Date.now();
  return {
    signalId: `sig-mp-${now}`,
    instrumentToken: token,
    tradingSymbol: `NIFTY25000CE-${token}`,
    underlying: 'NIFTY',
    exchange: 'NSE',
    segment: 'NSE_OPT',
    contractType: 'OPT',
    side: 'BUY',
    entry: 100,
    stopLoss: 97,
    target: 106,
    quantity: 65,
    lotSize: 65,
    riskInr: 195,
    expectedProfitInr: 390,
    rr: 2,
    confidence: 0.8,
    strategy: 'TREND_FOLLOWING',
    timeframe: '5m',
    createdAt: now,
    marketTimestamp: now,
    expiresAt: now + 300_000,
    status: 'READY',
    owner: 'UNIVERSAL',
    executionMode: 'AUTO',
    invalidatedReason: null,
  } as IndiaSignal;
}

function tickAt(ltp: number): IndiaTick {
  return {
    instrumentToken: 'tok-0',
    tradingSymbol: 'NIFTY25000CE-tok-0',
    ltp,
    bid: ltp,
    ask: ltp + 0.05,
    marketTimestamp: Date.now(),
    receivedAt: Date.now(),
    source: 'TEST',
  } as unknown as IndiaTick;
}

const session = { marketOpen: true, status: 'OPEN' } as never;

function buildEngine(minProfit: () => { enabled: boolean; targetInr: number }) {
  const events = new EventEmitter();
  const store = { find: async () => [], insertOne: async () => ({}), updateOne: async () => ({}) } as never;
  const cache = { set: async () => undefined, get: async () => null } as never;
  const instrument = makeInstrument('tok-0');
  const instruments = { getByToken: (t: string) => (t === instrument.instrumentToken ? instrument : null) } as never;
  const engine = new IndiaPaperExecutionEngine(store, cache, events, instruments, { minProfitExit: minProfit });
  return engine;
}

describe('user minimum-profit exit', () => {
  it('closes the position when unrealized PnL reaches the user target', async () => {
    // qty 65 × entry 100 → ₹1 profit per +1.0 of LTP. Target: ₹200 → close at ~103.1.
    const engine = buildEngine(() => ({ enabled: true, targetInr: 200 }));
    const pos = await engine.execute(makeSignal('tok-0'), session, { owner: 'UNIVERSAL' });
    expect(pos).not.toBeNull();

    const closed = await engine.monitor(tickAt(103.2));
    expect(closed.length).toBe(1);
    expect(closed[0].trade.exitReason).toBe('PROFIT_TARGET');
    // Net of charges (brokerage + 1-tick exit slippage): gross 65×3.2 = ₹208.
    expect(closed[0].trade.netPnl).toBeGreaterThan(150);
  });

  it('holds while below the target and follows live changes to the setting', async () => {
    let target = { enabled: true, targetInr: 500 }; // higher than first tick's P&L
    const engine = buildEngine(() => target);
    await engine.execute(makeSignal('tok-0'), session, { owner: 'UNIVERSAL' });

    let closed = await engine.monitor(tickAt(103.5)); // PnL ≈ 227 < 500
    expect(closed.length).toBe(0);

    // User lowers the min-profit target mid-session — next tick applies it.
    target = { enabled: true, targetInr: 150 };
    closed = await engine.monitor(tickAt(103.6)); // PnL ≈ 234 ≥ 150
    expect(closed.length).toBe(1);
    expect(closed[0].trade.exitReason).toBe('PROFIT_TARGET');
  });

  it('does not interfere when the exit is disabled or target is zero', async () => {
    const engine = buildEngine(() => ({ enabled: false, targetInr: 0 }));
    await engine.execute(makeSignal('tok-0'), session, { owner: 'UNIVERSAL' });
    const closed = await engine.monitor(tickAt(105));
    expect(closed.length).toBe(0); // no SL/TP hit at 105 (target is 106)
    expect(engine.openPositions().length).toBe(1);
  });
});
