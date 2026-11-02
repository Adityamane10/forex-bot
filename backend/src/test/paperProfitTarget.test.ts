/**
 * Spec §38/§39/§90: backend-enforced PROFIT-TARGET auto-exit. The engine must
 * close an open paper position on its own the moment NET P&L (mark-to-market
 * + swap − commission) in ACCOUNT currency reaches the configured minimum
 * profit — no frontend, no cron, no TP price level needed.
 *   - net-profit semantics: gross profit below target must NOT close
 *   - a USD/INR rate tick re-marks and can itself trigger the ₹-target exit
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Container } from '../core/container';
import { PaperPosition, Signal } from '@fx/shared';

describe('paper exits: INR profit-target auto-close (spec §38)', () => {
    let container: Container;

    beforeAll(async () => {
      process.env.SCANNER_INTERVAL_MS = '60000'; // keep the scanner quiet
      container = new Container();
      await container.init();
      await container.start();
      // Exit-mechanics suite (profit-target auto-close) — keep it day-
      // independent by disabling the weekend flatten (FXBot adoption).
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
      const id = `sig-target-${symbol}-${direction}-${now}-${Math.random().toString(36).slice(2, 8)}`;
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

    /** Open a position whose SL/TP sit FAR away so only the profit target can exit. */
    async function open(symbol: string, direction: 'BUY' | 'SELL', targetProfit?: number): Promise<PaperPosition> {
      const signal = makeSignal(symbol, direction);
      const tick = container.marketData.getLatest(symbol);
      const fill = (direction === 'BUY' ? tick?.ask : tick?.bid) ?? tick?.mid ?? 1;
      signal.stopLoss = { price: fill * (direction === 'BUY' ? 0.97 : 1.03), pips: 300, basis: 'test' };
      const risk = Math.abs(fill - signal.stopLoss.price);
      // TP levels FAR away (3R/4R) so ONLY the profit target can exit the position.
      signal.takeProfit = { tp1: fill + (direction === 'BUY' ? 3 : -3) * risk, tp2: fill + (direction === 'BUY' ? 4 : -4) * risk, tp3: null, rr1: 3, rr2: 4, rr3: null };
      const pos = await container.paper.openPosition(signal, 1, fill, 0.01, { slippageBps: 0, targetProfit });
      if (!pos) throw new Error('position not opened');
      return pos;
    }

    /** Fire a crafted tick that crosses the given price for the symbol. */
    async function pushTick(symbol: string, crossPrice: number, above: boolean): Promise<void> {
      const latest = container.marketData.getLatest(symbol)!;
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

    async function pollUntil(fn: () => boolean, ms = 5000): Promise<boolean> {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (fn()) return true;
        await sleep(50);
      }
      return fn();
    }

  it('auto-closes at PROFIT_TARGET_REACHED once net P&L (mark − commission) hits the target', async () => {
      await setSettings({ minimumProfit: 200 });
      // 1 lot EUR/USD: ~$10/pip gross; $7/lot commission → need ~21 pips for
      // net ≥ $200 (TP1 is 450 pips away, SL 300 — only the target can exit).
      const pos = await open('EUR/USD', 'BUY', 200);
      await sleep(400); // DEMO feed noise must NOT close a sub-target position
      expect(container.paper.getOpenPositions().some((x) => x.signalId === pos.signalId)).toBe(true);
      await pushTick('EUR/USD', pos.entryPrice + 0.0022, true); // +22 pips
      const closed = await pollUntil(() => !container.paper.getOpenPositions().some((x) => x.signalId === pos.signalId));
      expect(closed).toBe(true);
      const trades = await container.store.find<any>('paperTrades', { signalId: pos.signalId });
      expect(trades.length).toBe(1);
      expect(trades[0].exitReason).toBe('PROFIT_TARGET_REACHED');
      expect(trades[0].pnl).toBeGreaterThanOrEqual(200 - 1e-6);
      expect(container.paper.getAccount()!.balance).toBeGreaterThanOrEqual(10000 + 200);
    });

  it('net-profit semantics (spec §90): gross above target but net below does NOT close', async () => {
      await setSettings({ minimumProfit: 60 });
      const pos = await open('EUR/USD', 'BUY', 60);
      // pushTick adds its offset to the mid: crossPrice +4 pips → mid +6, exit
      // bid +5 → gross $50, net $43 after $7 commission < 60 → must stay open.
      await pushTick('EUR/USD', pos.entryPrice + 0.0004, true);
      await sleep(600);
      expect(container.paper.getOpenPositions().some((x) => x.signalId === pos.signalId)).toBe(true);
      // +8 pips cross → mid +10, exit bid +9 → gross $90, net $83 ≥ 60 → close.
      await pushTick('EUR/USD', pos.entryPrice + 0.0008, true);
      const closed = await pollUntil(() => !container.paper.getOpenPositions().some((x) => x.signalId === pos.signalId));
      expect(closed).toBe(true);
      const trades = await container.store.find<any>('paperTrades', { signalId: pos.signalId });
      expect(trades.length).toBe(1);
      expect(trades[0].exitReason).toBe('PROFIT_TARGET_REACHED');
      expect(trades[0].pnl).toBeGreaterThanOrEqual(60 - 1e-6);
    });

  it('a USD/INR rate tick re-marks and closes the position once INR P&L reaches the target (spec §38/§41)', async () => {
    await setSettings({ accountCurrency: 'INR', paperStartingCapital: 5000, availableCapital: 5000, minimumProfit: 2400 });
    // Mirrors the settings PUT path: switching currency resets the wallet.
      await container.paper.reinitAccount();
      const acc = container.paper.getAccount()!;
      expect(acc.currency).toBe('INR');
      expect(acc.balance).toBe(5000);

      // PIN the conversion rate to the real value so the arithmetic below is
      // deterministic. Before, a race between init-time DEMO noise and the real
      // Yahoo poll decided whether the fallback rate 1 or ~96 applied.
      const base = container.marketData.getLatest('USD/INR')?.mid ?? 95.93;
      await container.marketData.handleTick({
        symbol: 'USD/INR', timestamp: Date.now(),
        bid: Number((base - 0.01).toFixed(5)), ask: Number((base + 0.01).toFixed(5)),
        mid: Number(base.toFixed(5)), spread: 0.02, source: 'DEMO', mode: 'LIVE',
      } as never);

      // 1 lot: +3 pips = $30 gross, ~$23 net; at rate 95.93 that is ~INR 2206.
      // Target 2400 INR is ABOVE it, so the price move alone can never close —
      // only a RISING USD/INR rate can push net P&L over the target.
      const pos = await open('EUR/USD', 'BUY', 2400);
      await pushTick('EUR/USD', pos.entryPrice + 0.0001, true); // hold +3 pips
      await sleep(500);
      expect(container.paper.getOpenPositions().some((x) => x.signalId === pos.signalId)).toBe(true);

      // Walk the USD/INR rate up in ≤5% steps (jump guard). Each iteration FIRST
      // re-holds EUR/USD at +3 pips (the DEMO feed reverts it), then bumps the
      // rate: 95.93 → 99.77 (₹2294) → 103.76 (₹2386) → 107.91 (₹2482 ≥ 2400) —
      // the rate tick itself must trigger the auto-exit.
      let rate = base;
      let closed = false;
      for (let k = 1; k <= 30 && !closed; k++) {
        await pushTick('EUR/USD', pos.entryPrice + 0.0001, true);
        rate = Math.min(rate * 1.04, 200);
        const mid = Number(rate.toFixed(5));
        await container.marketData.handleTick({
          symbol: 'USD/INR', timestamp: Date.now(),
          bid: Number((mid - 0.01).toFixed(5)), ask: Number((mid + 0.01).toFixed(5)),
          mid, spread: 0.02, source: 'DEMO', mode: 'LIVE',
        } as never);
        await sleep(80);
        if (!container.paper.getOpenPositions().some((x) => x.signalId === pos.signalId)) closed = true;
      }
      expect(closed).toBe(true);
      const trades = await container.store.find<any>('paperTrades', { signalId: pos.signalId });
      expect(trades.length).toBe(1);
      expect(trades[0].exitReason).toBe('PROFIT_TARGET_REACHED');
      expect(trades[0].pnl).toBeGreaterThanOrEqual(2400 - 1e-6);
      const after = container.paper.getAccount()!;
      expect(after.currency).toBe('INR');
      expect(after.balance).toBeGreaterThanOrEqual(5000 + 2400);
    });

  it('stores the exit conversion rate and reconciles net INR P&L (§18/§30)', async () => {
      await setSettings({ accountCurrency: 'INR', paperStartingCapital: 5000, availableCapital: 5000, minimumProfit: 0 });
      await container.paper.reinitAccount();
      const opened = await container.paper.openManual('EUR/USD', 'BUY', { lots: 0.01 });
      expect(opened.ok).toBe(true);
      const pos = opened.position!;
      const tick = container.marketData.getLatest('EUR/USD')!;

      // BUY entry filled on the ASK (slippage may add on top — never below it).
      expect(pos.entryPrice).toBeGreaterThanOrEqual(tick.ask ?? tick.mid);
      expect(pos.entryPrice).toBeLessThan((tick.ask ?? tick.mid) * 1.001);

      // Manual close mirrors the route: a BUY exits at the BID.
      const exit = tick.bid ?? tick.mid;
      const trade = await container.paper.closePosition(pos, exit, 'MANUAL');
      expect(trade).not.toBeNull();

      const usdInr = container.marketData.getLatest('USD/INR')?.mid;
      expect(trade!.fxRate!).toBeGreaterThan(0);
      if (usdInr) expect(trade!.fxRate!).toBeCloseTo(usdInr, 1);
      expect(trade!.fxRateAt!).toBeGreaterThan(0);

      // Net reconciliation: grossQuote × fxRate − fees + swap = recorded pnl.
      const expectedNet = trade!.grossQuotePnl! * trade!.fxRate! - trade!.fees + trade!.swap;
      expect(trade!.pnl).toBeCloseTo(expectedNet, 1);
      expect(trade!.grossQuotePnl!).toBeCloseTo((exit - pos.entryPrice) * 1000, 4);
    });
  });
