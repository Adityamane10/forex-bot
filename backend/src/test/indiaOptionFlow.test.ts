import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { IndiaOptionFlowEngine } from '../india/option-flow';
import { INDIA_COLLECTIONS } from '@fx/shared';
import type { IndiaInstrument, IndiaCandle, IndiaOptionFlowSnapshot } from '@fx/shared';

// ---------------------------------------------------------------------------
// Option-flow analytics (spec §18): PCR, Max Pain, OI change. Uses fake store /
// cache / candles — no broker, no network. Real OI numbers only.
// ---------------------------------------------------------------------------

// A month out, always unexpired: the engine drops expired contracts, so this
// fixture must never hard-code a calendar date (a fixed 2026-09-24 expiry
// silently "expired" on 2026-09-25 and nulled every snapshot — time-bomb).
const EXPIRY = Date.now() + 30 * 24 * 60 * 60 * 1000;

function makeStrike(underlying: string, strike: number, type: 'CE' | 'PE'): IndiaInstrument {
  return {
    instrumentToken: `${underlying}-${strike}-${type}`,
    exchange: 'NSE',
    segment: 'NSE_FO',
    tradingSymbol: `${underlying} ${strike} ${type}`,
    underlying,
    name: `${underlying} Option`,
    contractType: 'OPT',
    expiry: EXPIRY,
    strike,
    optionType: type,
    lotSize: 75,
    tickSize: 0.05,
    freezeQuantity: 3600,
    status: 'ACTIVE',
    tradable: true,
  };
}

interface FakeCandles {
  oiBy: Map<string, { latest: number; prev: number }>;
  getCandles(token: string, _tf: string, limit: number): IndiaCandle[];
}

function makeFakeCandles(): FakeCandles {
  const oiBy = new Map<string, { latest: number; prev: number }>();
  return {
    oiBy,
    getCandles(token: string, _tf: string, limit: number): IndiaCandle[] {
      const oi = oiBy.get(token) ?? { latest: 0, prev: 0 };
      const out: IndiaCandle[] = [];
      // The engine reads candles[len-1] as latest and, for a full window,
      // candles[len-1-lookback] as the OI "lookback ago" value; with a 1-candle
      // window it only reads latest from index 0.
      for (let i = 0; i < limit; i++) {
        const v = i === limit - 1 ? oi.latest : i === 0 && limit > 1 ? oi.prev : oi.latest;
        out.push({
          symbol: token,
          timeframe: '5m' as never,
          openTime: i * 300_000,
          open: 25000,
          high: 25100,
          low: 24900,
          close: 25050,
          volume: 100,
          openInterest: v,
          completed: false,
        });
      }
      return out;
    },
  };
}

class FakeInstrumentService {
  constructor(private list: IndiaInstrument[]) {}
  all() { return this.list; }
  executionInstruments() {
    return this.list.filter((i) => i.contractType === 'INDEX');
  }
  underlyings() {
    return [...new Set(this.list.map((i) => i.underlying))];
  }
  futuresFor(_u: string) { return []; }
  optionsFor(underlying: string, expiry: number) {
    return this.list.filter((i) => i.underlying === underlying && i.expiry === expiry && i.contractType === 'OPT');
  }
}

class FakeCache {
  private m = new Map<string, string>();
  async get(k: string) { return this.m.get(k) ?? null; }
  async set(k: string, v: string) { this.m.set(k, v); }
}

class FakeStore {
  backend = 'in-memory' as const;
  status = 'HEALTHY' as const;
  docs: Record<string, unknown[]> = {};
  async connect() {}
  async disconnect() {}
  async insertOne<T>(collection: string, doc: T) { (this.docs[collection] ??= []).push(doc); }
  async insertMany<T>(collection: string, docs: T[]) { for (const d of docs) await this.insertOne(collection, d); }
  async find<T>(collection: string) { return (this.docs[collection] ?? []) as T[]; }
  async findOne<T>(collection: string) { return ((this.docs[collection] ?? [])[0] as T) ?? null; }
  async updateOne() {}
  async deleteMany() { return 0; }
  async count() { return 0; }
  async distinct() { return []; }
}

const NIFTY = 'NIFTY';
const strikes: IndiaInstrument[] = [
  makeStrike(NIFTY, 24800, 'CE'),
  makeStrike(NIFTY, 24800, 'PE'),
  makeStrike(NIFTY, 25000, 'CE'),
  makeStrike(NIFTY, 25000, 'PE'),
  makeStrike(NIFTY, 25200, 'CE'),
  makeStrike(NIFTY, 25200, 'PE'),
];

function buildEngine(oiBy: Map<string, { latest: number; prev: number }>, list: IndiaInstrument[] = strikes) {
  const candles = makeFakeCandles();
  for (const [k, v] of oiBy) candles.oiBy.set(k, v);
  const store = new FakeStore();
  const cache = new FakeCache();
  const events = new EventEmitter();
  const instruments = new FakeInstrumentService([...list, {
    instrumentToken: 'IDX-NIFTY', exchange: 'NSE', segment: 'NSE_INDEX',
    tradingSymbol: 'NIFTY 50', underlying: NIFTY, name: 'NIFTY 50',
    contractType: 'INDEX', expiry: null, strike: null, optionType: null,
    lotSize: 1, tickSize: 0.05, freezeQuantity: 0, status: 'ACTIVE', tradable: true,
  }]);
  const engine = new IndiaOptionFlowEngine({
    store: store as never,
    cache: cache as never,
    events,
    instruments: instruments as never,
    candles: candles as never,
    primaryTimeframe: '5m',
  });
  return { engine, store, cache, events };
}

describe('india: option flow (spec §18)', () => {
  it('computes PCR from total call/put OI', async () => {
    const oi = new Map<string, { latest: number; prev: number }>();
    oi.set('NIFTY-24800-CE', { latest: 1000, prev: 1000 });
    oi.set('NIFTY-24800-PE', { latest: 2000, prev: 2000 });
    oi.set('NIFTY-25000-CE', { latest: 500, prev: 500 });
    oi.set('NIFTY-25000-PE', { latest: 500, prev: 500 });
    oi.set('NIFTY-25200-CE', { latest: 500, prev: 500 });
    oi.set('NIFTY-25200-PE', { latest: 500, prev: 500 });
    const { engine } = buildEngine(oi);
    const snap = await engine.snapshot(NIFTY);
    expect(snap).not.toBeNull();
    expect(snap!.totalCallOI).toBe(2000);
    expect(snap!.totalPutOI).toBe(3000);
    expect(snap!.pcr).toBeCloseTo(1.5);
    expect(snap!.strikes).toHaveLength(3);
    expect(snap!.strikes[0].strike).toBe(24800);
  });

  it('max pain = strike minimizing total writer payout', async () => {
    // Heavy put+call OI at 25200: both directions bleed writers hardest when
    // the market settles at 25200, so max pain sits exactly there.
    const oi = new Map<string, { latest: number; prev: number }>();
    oi.set('NIFTY-24800-CE', { latest: 100, prev: 100 });
    oi.set('NIFTY-24800-PE', { latest: 100, prev: 100 });
    oi.set('NIFTY-25000-CE', { latest: 100, prev: 100 });
    oi.set('NIFTY-25000-PE', { latest: 100, prev: 100 });
    oi.set('NIFTY-25200-CE', { latest: 5000, prev: 5000 });
    oi.set('NIFTY-25200-PE', { latest: 5000, prev: 5000 });
    const { engine } = buildEngine(oi);
    const snap = await engine.snapshot(NIFTY);
    expect(snap!.maxPain).toBe(25200);
    expect(snap!.strikes.find((s) => s.maxPainCandidate)!.strike).toBe(25200);
  });

  it('symmetric OI pins max pain at the middle strike', async () => {
    const oi = new Map<string, { latest: number; prev: number }>();
    oi.set('NIFTY-24800-CE', { latest: 100, prev: 100 });
    oi.set('NIFTY-24800-PE', { latest: 1000, prev: 1000 });
    oi.set('NIFTY-25000-CE', { latest: 500, prev: 500 });
    oi.set('NIFTY-25000-PE', { latest: 500, prev: 500 });
    oi.set('NIFTY-25200-CE', { latest: 1000, prev: 1000 });
    oi.set('NIFTY-25200-PE', { latest: 100, prev: 100 });
    const { engine } = buildEngine(oi);
    const snap = await engine.snapshot(NIFTY);
    expect(snap!.maxPain).toBe(25000);
  });

  it('posture: high PCR = BULLISH, low PCR = BEARISH', async () => {
    const bull = new Map<string, { latest: number; prev: number }>();
    bull.set('NIFTY-24800-CE', { latest: 100, prev: 100 });
    bull.set('NIFTY-24800-PE', { latest: 400, prev: 400 });
    bull.set('NIFTY-25000-CE', { latest: 100, prev: 100 });
    bull.set('NIFTY-25000-PE', { latest: 200, prev: 200 });
    bull.set('NIFTY-25200-CE', { latest: 100, prev: 100 });
    bull.set('NIFTY-25200-PE', { latest: 100, prev: 100 });
    const { engine: bullEngine } = buildEngine(bull);
    expect((await bullEngine.snapshot(NIFTY))!.posture).toBe('BULLISH');

    const bear = new Map<string, { latest: number; prev: number }>();
    bear.set('NIFTY-24800-CE', { latest: 400, prev: 400 });
    bear.set('NIFTY-24800-PE', { latest: 100, prev: 100 });
    bear.set('NIFTY-25000-CE', { latest: 200, prev: 200 });
    bear.set('NIFTY-25000-PE', { latest: 100, prev: 100 });
    bear.set('NIFTY-25200-CE', { latest: 100, prev: 100 });
    bear.set('NIFTY-25200-PE', { latest: 100, prev: 100 });
    const { engine: bearEngine } = buildEngine(bear);
    expect((await bearEngine.snapshot(NIFTY))!.posture).toBe('BEARISH');
  });

  it('OI change vs lookback + PCR change are reported', async () => {
    const oi = new Map<string, { latest: number; prev: number }>();
    oi.set('NIFTY-24800-CE', { latest: 600, prev: 100 });
    oi.set('NIFTY-24800-PE', { latest: 400, prev: 200 });
    oi.set('NIFTY-25000-CE', { latest: 100, prev: 100 });
    oi.set('NIFTY-25000-PE', { latest: 100, prev: 100 });
    oi.set('NIFTY-25200-CE', { latest: 100, prev: 100 });
    oi.set('NIFTY-25200-PE', { latest: 100, prev: 100 });
    const { engine } = buildEngine(oi);
    const snap = await engine.snapshot(NIFTY);
    expect(snap!.callOIChange).toBe(500);
    expect(snap!.putOIChange).toBe(200);
    expect(snap!.netOiDelta).toBe(-300);
    expect(snap!.pcrChange).toBeCloseTo(0.75 - 400 / 300, 4); // current 0.75 vs hist 1.333
  });

  it('no option contracts -> null snapshot', async () => {
    const { engine } = buildEngine(new Map(), []);
    expect(await engine.snapshot(NIFTY)).toBeNull();
  });

  it('persists to store + cache and emits on the option-flow channel', async () => {
    const oi = new Map<string, { latest: number; prev: number }>();
    oi.set('NIFTY-24800-CE', { latest: 100, prev: 100 });
    oi.set('NIFTY-24800-PE', { latest: 100, prev: 100 });
    oi.set('NIFTY-25000-CE', { latest: 100, prev: 100 });
    oi.set('NIFTY-25000-PE', { latest: 100, prev: 100 });
    oi.set('NIFTY-25200-CE', { latest: 100, prev: 100 });
    oi.set('NIFTY-25200-PE', { latest: 100, prev: 100 });
    const { engine, store, cache, events } = buildEngine(oi);
    let emitted: IndiaOptionFlowSnapshot | null = null;
    events.on('india:option-flow', (s: IndiaOptionFlowSnapshot) => { emitted = s; });
    const snap = await engine.snapshot(NIFTY);
    expect(store.docs[INDIA_COLLECTIONS.optionFlow]).toHaveLength(1);
    expect((await cache.get('india:option-flow:NIFTY:nearest'))).toBeTruthy();
    expect(emitted).toEqual(snap);
  });

  it('cached() returns the freshest snapshot synchronously', async () => {
    const oi = new Map<string, { latest: number; prev: number }>();
    oi.set('NIFTY-24800-CE', { latest: 100, prev: 100 });
    oi.set('NIFTY-24800-PE', { latest: 100, prev: 100 });
    oi.set('NIFTY-25000-CE', { latest: 100, prev: 100 });
    oi.set('NIFTY-25000-PE', { latest: 100, prev: 100 });
    oi.set('NIFTY-25200-CE', { latest: 100, prev: 100 });
    oi.set('NIFTY-25200-PE', { latest: 100, prev: 100 });
    const { engine } = buildEngine(oi);
    expect(engine.cached(NIFTY, null)).toBeNull();
    const snap = await engine.snapshot(NIFTY);
    expect(engine.cached(NIFTY, null)).toEqual(snap);
  });
});