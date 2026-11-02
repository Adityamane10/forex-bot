/**
 * Manual paper trading (user-initiated, no signal required). Verifies on the
 * full container (demo feed):
 *   - manual BUY/SELL opens a real managed position with auto sizing
 *   - explicit lots/SL/TP are honoured
 *   - invalid symbols, wrong-side SL and leverage abuse are rejected
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Container } from '../core/container';
import { PaperPosition } from '@fx/shared';

describe('paper manual trade', () => {
  let container: Container;

  beforeAll(async () => {
    process.env.SCANNER_INTERVAL_MS = '60000';
    container = new Container();
    await container.init();
    await container.start();
  }, 90_000);

  afterAll(async () => {
    await container.stop();
  });

  it('opens a BUY with auto sizing and sensible SL/TP around the entry', async () => {
    const res = await container.paper.openManual('EUR/USD', 'BUY');
    expect(res.ok).toBe(true);
    const pos = res.position as PaperPosition;
    expect(pos.direction).toBe('BUY');
    expect(pos.lots).toBeGreaterThan(0);
    expect(pos.stopLoss).toBeLessThan(pos.entryPrice);
    expect(pos.takeProfit1).toBeGreaterThan(pos.entryPrice);
    expect(pos.entryLots).toBe(pos.lots);
    // managed by the engine like any position
    const found = container.paper.getOpenPositions().find((p) => p.id === pos.id);
    expect(found?.id).toBe(pos.id);
  });

  it('honours explicit lots, SL and TP', async () => {
    // close the position from the previous test: the entry gate applies the
    // same circuit breakers as automatic entries (MAX_CURRENCY_EXPOSURE etc.)
    const prev = container.paper.getOpenPositions();
    for (const p of prev) {
      await container.paper.closePosition(p, p.currentPrice, 'MANUAL');
    }
    const tick = container.marketData.getLatest('GBP/USD')!;
    const fill = tick.ask ?? tick.mid;
    const sl = fill * 1.005;
    const tp = fill * 0.99;
    const res = await container.paper.openManual('GBP/USD', 'SELL', { lots: 0.2, sl, tp });
    expect(res.ok).toBe(true);
    const pos = res.position as PaperPosition;
    expect(pos.lots).toBe(0.2);
    expect(pos.stopLoss).toBe(sl);
    expect(pos.takeProfit1).toBe(tp);
    expect(pos.direction).toBe('SELL');
  });

  it('rejects an unknown symbol', async () => {
    const res = await container.paper.openManual('USD/XYZ', 'BUY');
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('unknown symbol');
  });

  it('rejects a wrong-side SL for BUY', async () => {
    const tick = container.marketData.getLatest('USD/JPY')!;
    const fill = tick.ask ?? tick.mid;
    const res = await container.paper.openManual('USD/JPY', 'BUY', { sl: fill * 1.01 });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('below entry');
  });

  it('rejects lots beyond the leverage limit', async () => {
    const res = await container.paper.openManual('EUR/USD', 'BUY', { lots: 999 });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('leverage');
  });
});
