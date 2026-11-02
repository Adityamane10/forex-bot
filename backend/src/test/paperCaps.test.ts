/**
 * Portfolio-level execution caps (spec §46).
 *
 * Sizing caps are PER TRADE; nothing bounded how many positions the universal
 * engine could stack concurrently — every fresh signal re-entered every cooldown
 * expiry and total margin/risk grew far past the configured envelope. These
 * tests pin the new hard caps inside the paper execution engine itself:
 *   - maxOpenPositions      → concurrent position COUNT per engine book
 *   - maxConcurrentMarginInr→ TOTAL estimated margin per engine book
 *   - same-instrument       → no stacking repeated entries on one contract
 */
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import type { IndiaInstrument, IndiaSignal } from '@fx/shared';
import { INDIA_CHANNELS } from '@fx/shared';
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

let seq = 0;
function makeSignal(token: string): IndiaSignal {
  const now = Date.now();
  seq += 1;
  return {
    signalId: `sig-caps-${now}-${seq}`,
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

const session = { marketOpen: true, status: 'OPEN' } as never;

function buildEngine(caps: { maxOpenPositions?: number; maxConcurrentMarginInr?: number } = {}) {
  const events = new EventEmitter();
  const rejections: Array<{ reason: string; detail: string }> = [];
  events.on(INDIA_CHANNELS.reconciliation as never, (e: { reason?: string; detail?: string }) => {
    if (e?.reason) rejections.push({ reason: e.reason, detail: e.detail ?? '' });
  });
  const store = { find: async () => [], insertOne: async () => ({}), updateOne: async () => ({}) } as never;
  const cache = { set: async () => undefined, get: async () => null } as never;
  const instrumentsByToken: Record<string, IndiaInstrument> = {};
  for (let i = 0; i < 20; i++) {
    const tok = `tok-${i}`;
    instrumentsByToken[tok] = makeInstrument(tok);
  }
  const instruments = { getByToken: (t: string) => instrumentsByToken[t] ?? null } as never;
  const engine = new IndiaPaperExecutionEngine(store, cache, events, instruments, {});
  return { engine, rejections };
}

describe('portfolio caps in IndiaPaperExecutionEngine.execute', () => {
  it('rejects entries beyond maxOpenPositions (count cap)', async () => {
    const { engine, rejections } = buildEngine();
    for (let i = 0; i < 3; i++) {
      const pos = await engine.execute(makeSignal(`tok-${i}`), session, {
        owner: 'UNIVERSAL',
        caps: { maxOpenPositions: 3 },
      });
      expect(pos).not.toBeNull();
    }
    const fourth = await engine.execute(makeSignal('tok-4'), session, {
      owner: 'UNIVERSAL',
      caps: { maxOpenPositions: 3 },
    });
    expect(fourth).toBeNull();
    expect(engine.openPositions().length).toBe(3);
    expect(rejections.some((r) => r.reason === 'PORTFOLIO_LIMIT')).toBe(true);
  });

  it('rejects entries that would push TOTAL margin past maxConcurrentMarginInr', async () => {
    const { engine, rejections } = buildEngine();
    // OPT BUY margin is full premium: qty 65 × entry 100 = ₹6500 per lot (+ slippage ~₹3)
    // Short would be SPAN ≈ strike × lot × 15%. Two fit under ₹14k, third needs ~₹19.5k.
    const caps = { maxConcurrentMarginInr: 14000 };
    const p1 = await engine.execute(makeSignal('tok-0'), session, { owner: 'UNIVERSAL', caps });
    const p2 = await engine.execute(makeSignal('tok-1'), session, { owner: 'UNIVERSAL', caps });
    expect(p1).not.toBeNull();
    expect(p2).not.toBeNull();
    const p3 = await engine.execute(makeSignal('tok-2'), session, { owner: 'UNIVERSAL', caps });
    expect(p3).toBeNull();
    expect(rejections.some((r) => r.reason === 'MARGIN_BUDGET_EXHAUSTED')).toBe(true);
  });

  it('refuses a second concurrent position on the SAME instrument', async () => {
    const { engine, rejections } = buildEngine();
    const first = await engine.execute(makeSignal('tok-0'), session, { owner: 'UNIVERSAL' });
    expect(first).not.toBeNull();
    const again = await engine.execute(makeSignal('tok-0'), session, { owner: 'UNIVERSAL' });
    expect(again).toBeNull();
    expect(engine.openPositions().length).toBe(1);
    expect(rejections.some((r) => r.reason === 'SAME_INSTRUMENT_OPEN')).toBe(true);
  });

  it('stays unlimited when no caps are supplied (back-compat)', async () => {
    const { engine } = buildEngine();
    for (let i = 0; i < 5; i++) {
      const pos = await engine.execute(makeSignal(`tok-${i}`), session, { owner: 'UNIVERSAL' });
      expect(pos).not.toBeNull();
    }
    expect(engine.openPositions().length).toBe(5);
  });

  it('counts only the owning engine’s book toward its caps', async () => {
    const { engine } = buildEngine();
    // Universal fills two positions.
    await engine.execute(makeSignal('tok-0'), session, { owner: 'UNIVERSAL', caps: { maxOpenPositions: 2 } });
    await engine.execute(makeSignal('tok-1'), session, { owner: 'UNIVERSAL', caps: { maxOpenPositions: 2 } });
    // GOAL's book is separate: its own count cap of 1 still admits its first trade.
    const goalSig = { ...makeSignal('tok-2'), owner: 'GOAL' as const, executionMode: 'AUTO' as const };
    const goalPos = await engine.execute(goalSig, session, { owner: 'GOAL', caps: { maxOpenPositions: 1 } });
    expect(goalPos).not.toBeNull();
    // …but a second GOAL entry hits ITS OWN cap despite universal holding two.
    const goalSig2 = { ...makeSignal('tok-3'), owner: 'GOAL' as const, executionMode: 'AUTO' as const };
    const blocked = await engine.execute(goalSig2, session, { owner: 'GOAL', caps: { maxOpenPositions: 1 } });
    expect(blocked).toBeNull();
  });
});
