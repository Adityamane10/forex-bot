/**
 * Paper-exit management tests (Phase 17 partial TP, Phase 19 breakeven).
 * Verifies on the full container (demo feed):
 *   - entryLots recorded at open and normalized on reload
 *   - TP1/TP2 close the configured % of the ORIGINAL size; position stays open
 *   - 100% closes fully; 0% skips the level
 *   - breakeven moves SL to entry after N×R and never re-applies/loosens
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Container } from '../core/container';
import { PaperPosition, Signal } from '@fx/shared';

describe('paper exits: partial TP + breakeven', () => {
  let container: Container;

  beforeAll(async () => {
    process.env.SCANNER_INTERVAL_MS = '60000'; // keep the scanner quiet
    container = new Container();
    await container.init();
    await container.start();
    // These tests exercise exit MECHANICS (partial TP / breakeven / trailing),
    // not the weekend flatten — disable it so the suite is day-independent
    // (it runs on real weekends too, where the flatten would close positions).
    await setSettings({ weekendFlattenEnabled: false });
  }, 90_000);

  afterAll(async () => {
    await container.stop();
  });

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** Push new settings into the store AND refresh the paper engine's cache. */
  async function setSettings(patch: Record<string, unknown>): Promise<void> {
    await container.store.updateOne('userSettings', {}, { $set: patch as never }, true);
    await container.paper.init(await container.signals.loadSettings());
  }

  function makeSignal(symbol: string, direction: 'BUY' | 'SELL'): Signal {
    const now = Date.now();
    const id = `sig-exit-${symbol}-${direction}-${now}-${Math.random().toString(36).slice(2, 8)}`;
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

  async function open(symbol: string, direction: 'BUY' | 'SELL', atr = 10): Promise<PaperPosition> {
    const signal = makeSignal(symbol, direction);
    const tick = container.marketData.getLatest(symbol);
    const fill = (direction === 'BUY' ? tick?.ask : tick?.bid) ?? tick?.mid ?? 1;
    // Overwrite TP/SL with a wide stop so crafted ticks in the tests control
    // which level triggers (risk ~30 pips; TP1 at +1.5R, TP2 at +2.2R).
    signal.stopLoss = { price: fill * (direction === 'BUY' ? 0.995 : 1.005), pips: 50, basis: 'test' };
    const risk = Math.abs(fill - signal.stopLoss.price);
    signal.takeProfit = {
      tp1: Number((fill + (direction === 'BUY' ? 1.5 : -1.5) * risk).toFixed(5)),
      tp2: Number((fill + (direction === 'BUY' ? 2.2 : -2.2) * risk).toFixed(5)),
      tp3: null, rr1: 1.5, rr2: 2.2, rr3: null,
    };
    const pos = await container.paper.openPosition(signal, 1, fill, atr, { slippageBps: 0 });
    if (!pos) throw new Error('position not opened');
    return pos;
  }

  /** Fire a crafted tick that crosses the given price for the symbol. */
  async function pushTick(symbol: string, crossPrice: number, above: boolean): Promise<void> {
    const latest = container.marketData.getLatest(symbol)!;
    // Fixed tiny spread: the DEMO feed's own spread can balloon to hundreds of
    const offset = 0.0002;
    const mid = above ? crossPrice + offset : crossPrice - offset;
    await container.marketData.handleTick({
      ...latest,
      bid: Number((mid - offset / 2).toFixed(5)),
      ask: Number((mid + offset / 2).toFixed(5)),
      mid: Number(mid.toFixed(5)),
      spread: offset,
      timestamp: Date.now(),
    } as never);
  }

  async function pollUntil(fn: () => boolean, ms = 4000): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (fn()) return true;
      await sleep(50);
    }
    return fn();
  }

  it('openPosition records entryLots = original size (Phase 17)', async () => {
    const pos = await open('EUR/USD', 'BUY');
    expect(pos.entryLots).toBe(1);
    await container.paper.closePositionForSignal(pos.signalId, 'MANUAL');
  });

  it('TP1 closes the configured % of ORIGINAL size; position stays open (Phase 17)', async () => {
    await setSettings({ tp1ClosePct: 50, tp2ClosePct: 40 });
    const pos = await open('EUR/USD', 'BUY');
    await pushTick('EUR/USD', pos.takeProfit1!, true);
    const partial = await pollUntil(() => {
      const p = container.paper.getOpenPositions().find((x) => x.signalId === pos.signalId);
      return p !== undefined && p.lots < pos.entryLots;
    });
    expect(partial).toBe(true);
    const after = container.paper.getOpenPositions().find((x) => x.signalId === pos.signalId)!;
    expect(after.lots).toBeCloseTo(0.5, 2); // 50% of original remains
    const trades = await container.store.find<any>('paperTrades', { signalId: pos.signalId });
    expect(trades.length).toBe(1);
    expect(trades[0].exitReason).toBe('TP1');
    expect(trades[0].lots).toBeCloseTo(0.5, 2); // closed half of the original lot
    await container.paper.closePositionForSignal(pos.signalId, 'MANUAL');
  });

  it('TP2 closes its % of the ORIGINAL size on the remainder (Phase 17)', async () => {
    await setSettings({ tp1ClosePct: 50, tp2ClosePct: 40 });
    const pos = await open('EUR/USD', 'BUY');
    await pushTick('EUR/USD', pos.takeProfit1!, true);
    await pollUntil(() => container.paper.getOpenPositions().some((x) => x.signalId === pos.signalId && x.lots < pos.entryLots));
    // TP1 closed 0.5; TP2 then closes 0.4 of the ORIGINAL size → 0.1 remains.
    await pushTick('EUR/USD', pos.takeProfit2!, true);
    const p2 = await pollUntil(() => {
      const p = container.paper.getOpenPositions().find((x) => x.signalId === pos.signalId);
      return p !== undefined && p.lots < 0.5 - 1e-6;
    });
    expect(p2).toBe(true);
    const trades = await container.store.find<any>('paperTrades', { signalId: pos.signalId });
    const tp2Trade = trades.find((t: any) => t.exitReason === 'TP2');
    expect(tp2Trade).toBeDefined();
    expect(tp2Trade.lots).toBeCloseTo(0.4, 2); // 40% of ORIGINAL size
    await container.paper.closePositionForSignal(pos.signalId, 'MANUAL');
  });

  it('tp1ClosePct 100 closes fully at TP1 (Phase 17)', async () => {
    await setSettings({ tp1ClosePct: 100, tp2ClosePct: 0 });
    const pos = await open('EUR/USD', 'BUY');
    await pushTick('EUR/USD', pos.takeProfit1!, true);
    const closed = await pollUntil(() => !container.paper.getOpenPositions().some((x) => x.signalId === pos.signalId));
    expect(closed).toBe(true);
    const trades = await container.store.find<any>('paperTrades', { signalId: pos.signalId });
    expect(trades.length).toBe(1);
    expect(trades[0].exitReason).toBe('TP1');
    expect(trades[0].lots).toBeCloseTo(1, 2);
  });

  it('tp1ClosePct 0 skips TP1; SL still closes the position (Phase 17)', async () => {
    await setSettings({ tp1ClosePct: 0, tp2ClosePct: 0 });
    const pos = await open('EUR/USD', 'BUY');
    await pushTick('EUR/USD', pos.takeProfit1!, true);
    await sleep(300);
    // No TP1 trade, position still open.
    expect(container.paper.getOpenPositions().some((x) => x.signalId === pos.signalId)).toBe(true);
    const trades = await container.store.find<any>('paperTrades', { signalId: pos.signalId });
    expect(trades.length).toBe(0);
    // Now hit the SL.
    await pushTick('EUR/USD', pos.stopLoss, false);
    const closed = await pollUntil(() => !container.paper.getOpenPositions().some((x) => x.signalId === pos.signalId));
    expect(closed).toBe(true);
    const trades2 = await container.store.find<any>('paperTrades', { signalId: pos.signalId });
    expect(trades2.length).toBe(1);
    expect(trades2[0].exitReason).toBe('SL');
  });

  it('breakeven: SL moves to entry after N×R and is not re-applied (Phase 19)', async () => {
    await setSettings({ breakevenEnabled: true, breakevenActivateR: 0.5, tp1ClosePct: 100 });
    const pos = await open('EUR/USD', 'BUY');
    expect(pos.stopLoss).toBeLessThan(pos.entryPrice);
    const risk = Math.abs(pos.entryPrice - pos.stopLoss);
    // Push 1.2R into profit — past the 0.5R activation, below TP1 (1.5R).
    await pushTick('EUR/USD', pos.entryPrice + risk * 1.2, true);
    const moved = await pollUntil(() => {
      const p = container.paper.getOpenPositions().find((x) => x.signalId === pos.signalId);
      return p !== undefined && p.breakevenApplied === true;
    });
    expect(moved).toBe(true);
    const p = container.paper.getOpenPositions().find((x) => x.signalId === pos.signalId)!;
    expect(p.stopLoss).toBeCloseTo(pos.entryPrice, 5);
    // Further profit must not re-trigger or move the stop away from entry.
    await pushTick('EUR/USD', pos.entryPrice + risk * 2.4, true);
    await sleep(300);
    const p2 = container.paper.getOpenPositions().find((x) => x.signalId === pos.signalId);
    if (p2) expect(p2.stopLoss).toBeCloseTo(pos.entryPrice, 5);
    await container.paper.closePositionForSignal(pos.signalId, 'MANUAL');
  });

  it('breakeven: never loosens a stop that is already past entry (Phase 19)', async () => {
    await setSettings({ breakevenEnabled: true, breakevenActivateR: 0.5 });
    const pos = await open('EUR/USD', 'SELL');
    // SELL: SL above entry; move the stop BELOW entry first (a better stop).
    const risk = Math.abs(pos.entryPrice - pos.stopLoss);
    const betterStop = pos.entryPrice - risk * 0.3;
    pos.stopLoss = Number(betterStop.toFixed(5));
    await container.paper.closePositionForSignal(pos.signalId, 'MANUAL').catch(() => undefined);
    // Re-open and simulate: SL already better than entry → breakeven must not fire.
    const pos2 = await open('EUR/USD', 'SELL');
    const risk2 = Math.abs(pos2.entryPrice - pos2.stopLoss);
    pos2.stopLoss = Number((pos2.entryPrice - risk2 * 0.3).toFixed(5));
    await pushTick('EUR/USD', pos2.entryPrice - risk2 * 1.2, false);
    await sleep(400);
    const p = container.paper.getOpenPositions().find((x) => x.signalId === pos2.signalId);
    if (p) {
      // stop stays BETTER than entry (below it) — breakeven did not pull it back up
      expect(p.stopLoss).toBeLessThan(pos2.entryPrice - 1e-6);
    }
    await container.paper.closePositionForSignal(pos2.signalId, 'MANUAL');
  });

  it('combined: trailing + breakeven + partial TP all enabled interplay (Phases 17+19+63)', async () => {
    // Trailing activates at 0.5R with a 2×ATR ratchet; breakeven (also 0.5R)
    // must NEVER pull the ratcheted stop back to entry; TP1/TP2 close % of the
    // ORIGINAL size; the trailing stop catches the final pullback.
    await setSettings({
      trailingStopEnabled: true,
      trailingStopActivateR: 0.5,
      trailingStopAtrMultiplier: 2,
      breakevenEnabled: true,
      breakevenActivateR: 0.5,
      tp1ClosePct: 50,
      tp2ClosePct: 40,
    });
    // ATR small enough (10 pips) that the ratchet trailDist (20 pips) stays
    // inside the position's risk window while price is between TP levels.
    const pos = await open('EUR/USD', 'BUY', 0.001);
    const risk = Math.abs(pos.entryPrice - pos.stopLoss);

    // 1) Push 1.2R into profit: trailing ratchets the stop ABOVE entry;
    //    breakeven must not drag it back to entry.
    await pushTick('EUR/USD', pos.entryPrice + risk * 1.2, true);
    const ratcheted = await pollUntil(() => {
      const p = container.paper.getOpenPositions().find((x) => x.signalId === pos.signalId);
      return p !== undefined && p.trailingActive === true && p.stopLoss > p.entryPrice;
    });
    expect(ratcheted).toBe(true);
    const after1 = container.paper.getOpenPositions().find((x) => x.signalId === pos.signalId)!;
    expect(after1.breakevenApplied).not.toBe(true); // never loosened to entry
    expect(after1.stopLoss).toBeGreaterThan(after1.entryPrice);

    // 2) TP1: closes 50% of ORIGINAL size, position stays open.
    await pushTick('EUR/USD', pos.takeProfit1!, true);
    const t1 = await pollUntil(() => {
      const p = container.paper.getOpenPositions().find((x) => x.signalId === pos.signalId);
      return p !== undefined && p.lots <= 0.5 + 1e-6;
    });
    expect(t1).toBe(true);
    expect(container.paper.getOpenPositions().find((x) => x.signalId === pos.signalId)!.lots).toBeCloseTo(0.5, 2);

    // 3) TP2: closes 40% of ORIGINAL size → 0.1 lots remain.
    await pushTick('EUR/USD', pos.takeProfit2!, true);
    const t2 = await pollUntil(() => {
      const p = container.paper.getOpenPositions().find((x) => x.signalId === pos.signalId);
      return p !== undefined && p.lots <= 0.1 + 1e-6;
    });
    expect(t2).toBe(true);

    // 4) Pull back below the ratcheted stop → the TRAILING stop (not breakeven)
    //    exits the remainder.
    await pushTick('EUR/USD', pos.entryPrice + risk * 0.5, false);
    const closed = await pollUntil(() => !container.paper.getOpenPositions().some((x) => x.signalId === pos.signalId));
    expect(closed).toBe(true);

    const trades = await container.store.find<any>('paperTrades', { signalId: pos.signalId });
    const reasons = trades.map((t: any) => t.exitReason);
    expect(reasons.sort()).toEqual(['TP1', 'TP2', 'TRAILING']);
    const totalClosed = trades.reduce((sum: number, t: any) => sum + t.lots, 0);
    expect(totalClosed).toBeCloseTo(1, 2);
    const trail = trades.find((t: any) => t.exitReason === 'TRAILING');
    expect(trail.lots).toBeCloseTo(0.1, 2); // only the remainder was still at risk
  });

  it('tp1/tp2 = 0 (disabled sentinel) never fires an exit at price 0 (regression)', async () => {
    // Goal-hunt signals carry tp2: 0 (disabled). Before the normalization a
    // position stored takeProfit2 = 0, so "ask >= 0" closed it instantly at
    // price 0 → catastrophic PnL. The disabled sentinel must become null, and
    // no exit may ever realize at price 0 (the feed's live signal engine may
    // still close it via OPPOSITE_SIGNAL/etc — that close must use a real price).
    await setSettings({ tp1ClosePct: 100, tp2ClosePct: 40, trailingStopEnabled: false, breakevenEnabled: false });
    const signal = makeSignal('EUR/USD', 'BUY');
    const tick = container.marketData.getLatest('EUR/USD');
    const fill = tick?.ask ?? tick?.mid ?? 1;
    signal.stopLoss = { price: fill * 0.99, pips: 100, basis: 'test' }; // wide SL
    const pos = await container.paper.openPosition(signal, 1, fill, undefined, { slippageBps: 0 });
    expect(pos).not.toBeNull();
    expect(pos!.takeProfit1).toBeNull();
    expect(pos!.takeProfit2).toBeNull();
    // Push far above any sane TP — the TP path must NOT be what closes it.
    await pushTick('EUR/USD', fill * 1.02, true);
    await sleep(800);
    await container.paper.closePositionForSignal(signal.id, 'MANUAL').catch(() => undefined);
    const trades = await container.store.find<any>('paperTrades', { signalId: signal.id });
    for (const t of trades) {
      expect(t.exitPrice).toBeGreaterThan(0); // never realized at price 0
      expect(Math.abs(t.pnl)).toBeLessThan(fill * 10000); // no catastrophic PnL (bug = ~59k USD)
    }
  });

  it('weekend flatten: closes FX positions inside the Fri 20:00 UTC → Sun reopen window (FXBot adoption)', async () => {
    await setSettings({ weekendFlattenEnabled: true });
    const pos = await open('EUR/USD', 'BUY');
    // Next Saturday 12:00 UTC — deep inside the flatten window, whatever day
    // the suite runs on. Fed straight to the paper engine so the test does not
    // depend on market-data tick-freshness validation.
    const sat = new Date();
    sat.setUTCDate(sat.getUTCDate() + (((6 - sat.getUTCDay()) % 7 + 7) % 7 || 7));
    sat.setUTCHours(12, 0, 0, 0);
    const latest = container.marketData.getLatest('EUR/USD')!;
    await container.paper.onTick({ ...latest, timestamp: sat.getTime() } as never);
    const closed = await pollUntil(() => !container.paper.getOpenPositions().some((x) => x.id === pos.id));
    expect(closed).toBe(true);
    const trades = await container.paper.recentTrades(5);
    expect(trades.some((t) => t.positionId === pos.id && t.exitReason === 'WEEKEND_FLATTEN')).toBe(true);
    await setSettings({ weekendFlattenEnabled: false });
  });
});

