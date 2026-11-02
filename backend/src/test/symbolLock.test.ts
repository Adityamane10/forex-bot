/**
 * Symbol lock (XM/MT5 pattern): when the user locks the platform to one
 * symbol (e.g. XAU/USD), signals are scanned for that symbol ONLY and every
 * entry — auto or manual — is refused for any other symbol. The lock travels
 * to the terminal too: the MT5 mirror never dispatches an OPEN outside the
 * locked symbol (demo or real), while CLOSE always passes so an exit can
 * never be blocked.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Container } from '../core/container';
import { Mt5MirrorService } from '../engines/mt5Mirror';
import { Signal } from '@fx/shared';

describe('symbol lock confines signals, entries and MT5 dispatch', () => {
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

  /** Persist the lock the way the settings PUT does, then apply it realtime. */
  async function setLock(lock: string | null): Promise<void> {
    await container.store.updateOne('userSettings', {}, { $set: { symbolLock: lock } as never }, true);
    container.noteSymbolLock(lock);
  }

  function makeSignal(symbol: string, direction: 'BUY' | 'SELL'): Signal {
    const now = Date.now();
    const id = `sig-lock-${symbol}-${direction}-${now}-${Math.random().toString(36).slice(2, 8)}`;
    return {
      id, signalId: id, symbol, direction,
      state: 'WAITING_FOR_ENTRY', decision: direction,
      timestamp: now, expiresAt: now + 7200_000, updatedAt: now, price: 1,
      entry: { entryMin: 0, entryMax: 0, preferredEntry: 0, status: 'READY', reason: 'test' },
      stopLoss: { price: 0, pips: 0, basis: 'test' },
      takeProfit: { tp1: 0, tp2: 0, tp3: null, rr1: 2, rr2: 3, rr3: null },
      confidence: 0.65, probability: 0.65,
      risk: { symbol, timestamp: now, level: 'YELLOW', score: 30, components: {}, critical: [], blocked: false },
      expectedValue: {
        evPerTrade: 5, evPerRisk: 0.5, probabilityWin: 0.65, probabilityLoss: 0.35,
        averageWin: 10, averageLoss: 5, tradingCosts: 1, positive: true,
        breakdown: { spread: 1, commission: 0, slippage: 0, swap: 0 },
      },
      regime: { symbol, timeframe: '1h', timestamp: now, regime: 'RANGING', adx: null, atrPct: null, volatility: 'MEDIUM', description: 'test' },
      rr: 2,
      evidence: { technical: [], multiTimeframe: [], priceAction: [], historical: [], ml: [], news: [], risk: [], opposing: [] },
      snapshotId: id, modelVersion: 'test-model', featureVersion: 'features-v1',
      strategy: 'TREND_FOLLOWING', strategyVersion: '1', mode: 'DEMO', events: [],
    };
  }

  it('scanner sweeps ONLY the locked symbol', async () => {
    await setLock('XAU/USD');
    const symbols = await container.signals.enabledSymbols();
    expect(symbols).toEqual(['XAU/USD']);
    await setLock(null);
    const all = await container.signals.enabledSymbols();
    expect(all.length).toBeGreaterThan(1);
  });

  it('auto/manual entries outside the lock are refused; the locked symbol trades', async () => {
    await setLock('EUR/USD');
    // Auto path: openPosition is the single choke point for auto + manual.
    const refused = await container.paper.openPosition(makeSignal('USD/JPY', 'BUY'), 1, 155.0, 0.01, {});
    expect(refused).toBeNull();
    // Manual path reports the reason clearly instead of a generic failure.
    const manual = await container.paper.openManual('XAU/USD', 'BUY', { lots: 0.01 });
    expect(manual.ok).toBe(false);
    expect(manual.reason).toContain('symbol lock');
    // The locked symbol itself is NOT blocked by the lock (tick feed exists).
    const allowed = await container.paper.openPosition(makeSignal('EUR/USD', 'BUY'), 1, 1.15, 0.01, {});
    expect(allowed).not.toBeNull();
    if (allowed) await container.paper.closePosition(allowed, 1.1501, 'MANUAL').catch(() => undefined);
    await setLock(null);
  });

  it('MT5 mirror dispatches OPENs for the locked symbol only; CLOSE always passes', async () => {
    const mirror = new Mt5MirrorService(container.store, container.events, {
      isEnabled: () => true,
      getOpenPaperPositions: () => [],
    });
    const seed = (commandId: string, over: Record<string, unknown>) =>
      container.store.insertOne('Mt5MirrorCommands', {
        commandId, positionId: `pos-${commandId}`, signalId: null,
        symbol: 'EUR/USD', direction: 'BUY', lots: 0.1,
        action: 'OPEN', status: 'PENDING', createdAt: Date.now(),
        ...over,
      } as never);
    await seed('lock-eur-open', {});
    await seed('lock-xau-open', { symbol: 'XAU/USD' });
    await seed('lock-close', { action: 'CLOSE', mt5Ticket: 424242, symbol: 'EUR/USD' });

    mirror.setSymbolLock('XAU/USD');
    let cmds = await mirror.pollCommands('worker-test');
    expect(cmds.find((c) => c.id === 'lock-eur-open')).toBeUndefined(); // held
    expect(cmds.find((c) => c.id === 'lock-xau-open')).toBeDefined();  // passes
    expect(cmds.find((c) => c.id === 'lock-close')).toBeDefined();     // exits always pass

    // Clearing the lock releases the held command — nothing was lost.
    mirror.setSymbolLock(null);
    await sleep(20);
    cmds = await mirror.pollCommands('worker-test');
    expect(cmds.find((c) => c.id === 'lock-eur-open')).toBeDefined();
  });
});
