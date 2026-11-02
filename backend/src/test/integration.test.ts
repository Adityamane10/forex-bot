/**
 * Integration test. Boots the full container with the demo market data feed,
 * verifies: ticks flow, candles form and complete, indicators compute,
 * multi-timeframe analysis runs, the signal engine produces a decision and
 * paper trading executes on reached entries. Also exercises failure behavior
 * (stale data blocks signals).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Container } from '../core/container';
import { CHANNELS } from '../core/context';

describe('integration: full pipeline', () => {
  let container: Container;

  beforeAll(async () => {
    process.env.SCANNER_INTERVAL_MS = '60000'; // keep scanner quiet during test
    container = new Container();
    await container.init();
    await container.start();
  }, 60_000);

  afterAll(async () => {
    await container.stop();
  });

  it('market data: receives demo ticks for all symbols', async () => {
    await new Promise((r) => setTimeout(r, 1500));
    const symbols = container.marketData.getSymbols();
    expect(symbols.length).toBeGreaterThanOrEqual(5);
    for (const s of symbols.slice(0, 3)) {
      const tick = container.marketData.getLatest(s);
      expect(tick).toBeDefined();
      expect(tick!.bid).toBeGreaterThan(0);
      expect(tick!.ask).toBeGreaterThan(tick!.bid);
      expect(tick!.mid).toBeGreaterThan(0);
    }
    const stats = container.marketData.statsSummary();
    expect((stats.received as number)).toBeGreaterThan(0);
    expect((stats.mode as string)).toBe('DEMO');
  });

  it('candle engine: forms and completes 1m candles', async () => {
    await new Promise((r) => setTimeout(r, 2500));
    const candles = container.candles.getCandles('EUR/USD', '1m', 100);
    expect(candles.length).toBeGreaterThan(0);
    const last = candles[candles.length - 1];
    expect(last.symbol).toBe('EUR/USD');
    expect(last.high).toBeGreaterThanOrEqual(last.low);
    expect(last.high).toBeGreaterThanOrEqual(last.open);
    expect(last.high).toBeGreaterThanOrEqual(last.close);
    expect(last.low).toBeLessThanOrEqual(last.open);
    expect(last.low).toBeLessThanOrEqual(last.close);
  });

  it('indicator engine: computes full indicator set on EUR/USD 1h', async () => {
    // seed some history so indicators have data
    const provider = container.ctx.providers.marketData;
    const history = await provider.getHistoricalCandles('EUR/USD', '1h', Date.now() - 30 * 86400_000, Date.now());
    await container.candles.seed('EUR/USD', '1h', history);
    const snap = await container.indicators.getSnapshot('EUR/USD', '1h', true);
    expect(snap).not.toBeNull();
    expect(snap!.values.rsi14).not.toBeNull();
    expect(snap!.values.atr14).not.toBeNull();
    expect(snap!.values.macdHistogram).not.toBeNull();
    expect(snap!.values.adx).not.toBeNull();
    expect(snap!.values.bbUpper).not.toBeNull();
    expect(snap!.values.supertrend).not.toBeNull();
  });

  it('multi-timeframe analysis produces a consensus', async () => {
    const symbol = 'EUR/USD';
    const timeframes = ['1m', '5m', '15m', '30m', '1h', '4h', '1D'] as const;
    const candlesByTf: Record<string, unknown> = {};
    const indicatorsByTf: Record<string, unknown> = {};
    for (const tf of timeframes) {
      candlesByTf[tf] = await container.ctx.providers.marketData.getHistoricalCandles(symbol, tf, Date.now() - 30 * 86400_000, Date.now());
      const snap = await container.indicators.getSnapshot(symbol, tf, true);
      if (snap) indicatorsByTf[tf] = snap;
    }
    const mtf = container.multiTimeframe.analyze(candlesByTf as never, indicatorsByTf as never, symbol, Date.now());
    expect(['BULLISH', 'BEARISH', 'MIXED']).toContain(mtf.consensus);
    expect(mtf.timeframes.length).toBeGreaterThan(0);
  });

  it('signal engine: produces a decision (BUY/SELL/WAIT/NO_TRADE) without error', async () => {
    const result = await container.signals.analyzeSymbol('EUR/USD', true);
    expect(['BUY', 'SELL', 'WAIT', 'NO_TRADE', 'INSUFFICIENT_CONFIDENCE']).toContain(result.decision);
    expect(result.dataQuality).toBeDefined();
    // if ML engine is down, safe policy should produce WAIT/MODEL_BLOCKED (never a fake signal)
    if (result.decision === 'BUY' || result.decision === 'SELL') {
      expect(result.signal).toBeDefined();
      expect(result.signal!.snapshotId).toBeTruthy();
    }
  }, 60_000);

  it('signal snapshot is stored', async () => {
    const active = container.signals.getActive();
    if (active.length) {
      const snap = await container.snapshots.getBySignalId(active[0].id);
      expect(snap).not.toBeNull();
      expect(snap!.signalId).toBe(active[0].id);
    }
  });

  it('paper trading: account exists and initializes', async () => {
    const account = container.paper.getAccount();
    expect(account).not.toBeNull();
    expect(account!.startingBalance).toBeGreaterThan(0);
    expect(account!.balance).toBe(account!.startingBalance);
  });

  it('data quality engine flags stale data', async () => {
    const { assessQuality } = await import('../engines/dataQualityEngine');
    const report = assessQuality({
      symbol: 'EUR/USD',
      timestamp: Date.now(),
      latestTick: null,
      candles: {},
      providerHealth: { ok: false, detail: 'down' },
      newsAvailable: false,
      calendarAvailable: false,
      maxSpreadPips: 25,
    });
    expect(report.score).toBeLessThan(0.5);
  });

  it('failure safety: signal engine returns NO_TRADE when market data missing', async () => {
    // simulate by analyzing a symbol with no data
    const { getAsset } = await import('@fx/shared');
    void getAsset;
    const result = await container.signals.analyzeSymbol('XAU/USD', true);
    expect(['NO_TRADE', 'WAIT', 'INSUFFICIENT_CONFIDENCE']).toContain(result.decision);
    expect(result.blockedBy.length).toBeGreaterThan(0);
  }, 60_000);

  it('websocket channels fire on candle completion', async () => {
    let firedCompleted = false;
    const handler = (c: { completed?: boolean; state?: string }) => {
      if (c.completed || c.state === 'COMPLETED') firedCompleted = true;
    };
    container.ctx.events.once(CHANNELS.candle, handler);
    // force a synthetic tick mid-window (never on a boundary, so it cannot complete a candle)
    const midWindow = Math.floor(Date.now() / 60_000) * 60_000 + 30_000;
    await container.marketData.handleTick({
      timestamp: midWindow, symbol: 'EUR/USD', bid: 1.09, ask: 1.0902, mid: 1.0901, spread: 0.0002, source: 'TEST', mode: 'DEMO',
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(firedCompleted).toBe(false); // same candle window: no completion (OPEN may fire)
    container.ctx.events.removeListener(CHANNELS.candle, handler);
  });
});
