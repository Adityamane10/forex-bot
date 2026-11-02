/**
 * Lifecycle + paper-execution integration tests (spec §34, §40-41, §44, §48,
 * §70, §71, §93). Boots the full container on the demo feed and verifies:
 *   - paper fills apply slippage and record the signal's prediction state
 *   - duplicate-order protection: one order/position per signalId
 *   - dynamic exits: opposite signal / structural invalidation close positions
 *   - real account state (daily P&L, consecutive losses) feeds the breakers
 *   - load smoke: indicator + MTF compute across all symbols/timeframes
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Container } from '../core/container';
import { CHANNELS } from '../core/context';
import { PaperPosition, Signal } from '@fx/shared';

describe('lifecycle + paper execution', () => {
  let container: Container;

  beforeAll(async () => {
    process.env.SCANNER_INTERVAL_MS = '60000'; // keep the scanner quiet
    container = new Container();
    await container.init();
    await container.start();
  }, 90_000);

  afterAll(async () => {
    await container.stop();
  });

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  function makeSignal(symbol: string, direction: 'BUY' | 'SELL'): Signal {
    const now = Date.now();
    const id = `sig-${symbol}-${direction}-${now}`;
    return {
      id,
      signalId: id,
      symbol,
      direction,
      state: 'WAITING_FOR_ENTRY',
      decision: direction,
      timestamp: now,
      expiresAt: now + 7200_000,
      updatedAt: now,
      price: 1,
      entry: { entryMin: 0, entryMax: 0, preferredEntry: 0, status: 'READY', reason: 'test' },
      stopLoss: { price: 0, pips: 0, basis: 'test' },
      takeProfit: { tp1: 0, tp2: 0, tp3: null, rr1: 2, rr2: 3, rr3: null },
      confidence: 0.65,
      probability: 0.65,
      risk: { symbol, timestamp: now, level: 'YELLOW', score: 30, components: {}, critical: [], blocked: false },
      expectedValue: {
        evPerTrade: 5, evPerRisk: 0.5, probabilityWin: 0.65, probabilityLoss: 0.35,
        averageWin: 10, averageLoss: 5, tradingCosts: 1, positive: true,
        breakdown: { spread: 1, commission: 0, slippage: 0, swap: 0 },
      },
      regime: { symbol, timeframe: '1h', timestamp: now, regime: 'RANGING', adx: null, atrPct: null, volatility: 'MEDIUM', description: 'test' },
      rr: 2,
      evidence: { technical: [], multiTimeframe: [], priceAction: [], historical: [], ml: [], news: [], risk: [], opposing: [] },
      snapshotId: id,
      modelVersion: 'test-model',
      featureVersion: 'features-v1',
      strategy: 'TREND_FOLLOWING',
      strategyVersion: '1',
      mode: 'DEMO',
      events: [],
    };
  }

  async function open(symbol: string, direction: 'BUY' | 'SELL', slippageBps = 0): Promise<PaperPosition> {
    const signal = makeSignal(symbol, direction);
    const tick = container.marketData.getLatest(symbol);
    const fill = (direction === 'BUY' ? tick?.ask : tick?.bid) ?? tick?.mid ?? 1;
    const pos = await container.paper.openPosition(signal, 1, fill, 10, { slippageBps });
    if (!pos) throw new Error('position not opened');
    return pos;
  }

  async function pollClosed(signalId: string, ms = 3000): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const open = container.paper.getOpenPositions().some((p) => p.signalId === signalId);
      if (!open) return true;
      await sleep(50);
    }
    return false;
  }

  it('paper fill: applies slippage and records the signal prediction state (spec §40-41, §48)', async () => {
    const symbol = 'EUR/USD';
    const signal = makeSignal(symbol, 'BUY');
    const tick = container.marketData.getLatest(symbol);
    const fill = tick?.ask ?? tick?.mid ?? 1;
    const pos = await container.paper.openPosition(signal, 1, fill, 10, { slippageBps: 100 });
    expect(pos).not.toBeNull();
    // 100 bps = 1% above the ask for a BUY — never a perfect execution.
    expect(pos!.entryPrice).toBeCloseTo(fill * 1.01, 4);
    expect(pos!.confidence).toBe(0.65);
    expect(pos!.probability).toBe(0.65);
    expect(pos!.expectedValue).toBe(5);
    expect(pos!.modelVersion).toBe('test-model');
    expect(pos!.strategy).toBe('TREND_FOLLOWING');
    expect(pos!.slippageBps).toBe(100);
    await container.paper.closePositionForSignal(signal.id, 'MANUAL');
  });

  it('duplicate-order protection: one order + one position per signalId (spec §71/§123)', async () => {
    const symbol = 'EUR/USD';
    const signal = makeSignal(symbol, 'BUY');
    const tick = container.marketData.getLatest(symbol);
    const fill = tick?.ask ?? tick?.mid ?? 1;
    const first = await container.paper.openPosition(signal, 1, fill, 10, { slippageBps: 0 });
    const second = await container.paper.openPosition(signal, 1, fill, 10, { slippageBps: 0 });
    expect(second!.id).toBe(first!.id); // same position, never duplicated
    const orders = await container.store.find('paperOrders', { signalId: signal.id });
    expect(orders.length).toBe(1);
    expect(orders[0].clientOrderId).toBe(signal.id); // idempotency key
    await container.paper.closePositionForSignal(signal.id, 'MANUAL');
  });

  it('dynamic exit: an opposite signal closes the open position (spec §44)', async () => {
    const symbol = 'GBP/USD';
    const pos = await open(symbol, 'BUY');
    const opposite = makeSignal(symbol, 'SELL');
    container.ctx.events.emit(CHANNELS.signalCreated, opposite);
    expect(await pollClosed(pos.signalId)).toBe(true);
    const trades = await container.store.find<any>('paperTrades', { signalId: pos.signalId });
    expect(trades.length).toBe(1);
    expect(trades[0].exitReason).toBe('OPPOSITE_SIGNAL');
  });

  it('dynamic exit: structural signal invalidation closes with REGIME_REVERSAL (spec §44)', async () => {
    const symbol = 'USD/JPY';
    const pos = await open(symbol, 'SELL');
    container.ctx.events.emit(CHANNELS.signalInvalidated, { signalId: pos.signalId, symbol, state: 'INVALIDATED', note: 'direction changed — regime reversal' });
    expect(await pollClosed(pos.signalId)).toBe(true);
    const trades = await container.store.find<any>('paperTrades', { signalId: pos.signalId });
    expect(trades[0].exitReason).toBe('REGIME_REVERSAL');
  });

  it('account state: daily P&L and consecutive losses update on close (spec §34)', async () => {
    const symbol = 'AUD/USD';
    // 100 bps slippage on a BUY guarantees a loss when closing at the bid —
    // the daily/weekly P&L and consecutive-loss counters must move.
    const pos = await open(symbol, 'BUY', 100);
    // Snapshot values: getAccount() returns a live reference.
    const before = { ...container.paper.getAccount()! };
    await container.paper.closePositionForSignal(pos.signalId, 'REGIME_REVERSAL');
    const after = { ...container.paper.getAccount()! };
    expect(after.dailyPnl).not.toBe(before.dailyPnl);
    expect(after.consecutiveLosses).toBeGreaterThanOrEqual(before.consecutiveLosses + 1);
    expect(after.weeklyPnl).not.toBe(before.weeklyPnl);
  });

  it('goal mode: multiple positions open while aggregate margin has room (margin-aware multi-position)', async () => {
    // Old behavior: singlePositionMode hard-blocked every entry after the
    // first. New behavior: entries open while the AGGREGATE margin/leverage
    // caps (open positions + candidate) still have room, and defer only when
    // a cap would be exceeded.
    await container.store.updateOne('userSettings', {}, { $set: {
      singlePositionMode: true,
      maxMarginUsedPct: 30,
      maxLeverage: 1000,
      availableCapital: 10000,
      accountCurrency: 'USD',
      maxOpenPositions: 10,
      maxCorrelatedPositions: 10,
      maxCurrencyExposurePercent: 100000,
      maxConsecutiveLosses: 100,
      maxDailyLossPercent: 100,
      maxWeeklyLossPercent: 100,
      maxDrawdownPercent: 100,
    } as never }, true);
    const settings = await container.signals.loadSettings();

    // First position: 1 lot EUR/USD (~10.8% margin at 1:100 on the demo feed).
    const pos1 = await open('EUR/USD', 'BUY');

    // Second goal signal on another symbol, 1 lot GBP/USD: aggregate margin
    // ~23% < 30% → ALLOWED even with singlePositionMode on (the requested
    // "go for multiple positions while margin is available").
    const goal1 = makeSignal('GBP/USD', 'BUY');
    goal1.plannedLots = 1;
    const gate1 = await container.signals.evaluateEntryGate('GBP/USD', goal1, settings);
    expect(gate1.ok).toBe(true);

    // Third goal signal sized to push aggregate margin past the cap → blocked.
    const goal2 = makeSignal('USD/JPY', 'BUY');
    goal2.plannedLots = 2; // 2 × 150k notional = 30% margin + 23.5% open = 53.5%
    const gate2 = await container.signals.evaluateEntryGate('USD/JPY', goal2, settings);
    expect(gate2.ok).toBe(false);
    expect(gate2.reason).toContain('exceeds max 30%');

// Real-broker semantics: leverage is PER POSITION (broker offering), never
    // summed across the portfolio — only free margin caps the total. With the
    // margin cap raised, a 2-lot GBP/USD (per-position leverage 27.2 < 50)
    // opens even though the AGGREGATE leverage (10.9 + 13.6 + 27.2 = 51.7) exceeds 50.
    await container.store.updateOne('userSettings', {}, { $set: { maxMarginUsedPct: 100, maxLeverage: 50 } as never }, true);
    const settings2 = await container.signals.loadSettings();
    const goal3 = makeSignal('GBP/USD', 'BUY');
    goal3.plannedLots = 2;
    const gate3 = await container.signals.evaluateEntryGate('GBP/USD', goal3, settings2);
    expect(gate3.ok).toBe(true);

    // restore defaults so other tests are unaffected
    await container.store.updateOne('userSettings', {}, { $set: {
      singlePositionMode: false,
      maxMarginUsedPct: 0,
      maxLeverage: 50,
      maxCurrencyExposurePercent: 30,
      maxCorrelatedPositions: 3,
      availableCapital: 10000,
      accountCurrency: 'USD',
    } as never }, true);
    await container.paper.closePositionForSignal(pos1.signalId, 'MANUAL');
  });

  it('circuit breakers read REAL account state — consecutive losses block new entries at fill (spec §34, §70)', async () => {
    // Give the account at least one consecutive loss (guaranteed by the
    // slippage close above) and set the limit to 1.
    await container.store.updateOne(
      'userSettings', {},
      { $set: { maxConsecutiveLosses: 1 } as never },
      true,
    );
    // accountRiskState has a 5s TTL cache — wait it out so the breaker sees
    // the freshly persisted consecutive-loss count, not a stale zero.
    await sleep(5_200);
    const settings = await container.signals.loadSettings();
    const gate = await container.signals.evaluateEntryGate('EUR/USD', makeSignal('EUR/USD', 'BUY'), settings);
    expect(gate.ok).toBe(false);
    expect(gate.reason).toContain('MAX_CONSECUTIVE_LOSSES');
    // restore the default so other tests are unaffected
    await container.store.updateOne('userSettings', {}, { $set: { maxConsecutiveLosses: 5 } as never }, true);
  });

  it('candle resync: back-fills missed history after a gap (spec §5)', async () => {
    const symbol = 'EUR/USD';
    const tf = '1m' as const;
    const tfMs = 60_000;
    const now = Date.now();
    // Seed a stale buffer that ends 10 minutes ago — a gap the live feed missed.
    const old = Array.from({ length: 10 }, (_, i) => {
      const openTime = now - 20 * tfMs + i * tfMs;
      return {
        symbol, timeframe: tf, open: 1.08, high: 1.081, low: 1.079, close: 1.0805, volume: 5,
        openTime, closeTime: openTime + tfMs, state: 'COMPLETED', completed: true, updatedAt: openTime + tfMs,
      };
    });
    await container.candles.seed(symbol, tf, old);
    const before = container.candles.getCandles(symbol, tf, 500).length;
    const added = await container.candles.resyncMissing(symbol, tf);
    const after = container.candles.getCandles(symbol, tf, 500);
    expect(added).toBeGreaterThan(0);
    expect(after.length).toBeGreaterThan(before);
    // strictly ascending, never a duplicate window
    const times = after.map((c) => c.openTime);
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThan(times[i - 1]);
  }, 30_000);

  it('pipeline latency: engine stamps receivedAt on ticks (spec §1)', async () => {
    const tick = {
      timestamp: Date.now(), symbol: 'EUR/USD', bid: 1.08, ask: 1.0802, mid: 1.0801,
      spread: 0.0002, source: 'TEST', mode: 'DEMO',
    } as const;
    await container.marketData.handleTick(tick);
    expect(tick.receivedAt).toBeGreaterThanOrEqual(tick.timestamp);
    const health = container.marketData.health();
    expect(health.medianLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it('load smoke: indicator + MTF + pattern compute across all symbols/timeframes stays responsive (spec §90)', async () => {
    const symbols = container.marketData.getSymbols();
    const tfs = ['1m', '5m', '15m', '30m', '1h', '4h', '1D'] as const;
    const t0 = Date.now();
    let sets = 0;
    for (const symbol of symbols) {
      const candlesByTf: Record<string, unknown> = {};
      const indicatorsByTf: Record<string, unknown> = {};
      for (const tf of tfs) {
        candlesByTf[tf] = container.candles.getCandles(symbol, tf, 260);
        const snap = await container.indicators.getSnapshot(symbol, tf, true);
        if (snap) indicatorsByTf[tf] = snap;
        sets++;
      }
      container.multiTimeframe.analyze(candlesByTf as never, indicatorsByTf as never, symbol, Date.now());
    }
    const ms = Date.now() - t0;
    console.log(`load smoke: ${symbols.length} symbols × ${tfs.length} TFs (${sets} indicator sets + MTF + pattern) in ${ms}ms`);
    expect(ms).toBeLessThan(30_000);
  }, 60_000);
});
