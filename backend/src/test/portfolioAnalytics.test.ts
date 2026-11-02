/**
 * PortfolioAnalytics engine: aligns candle closes across the symbols that have
 * open positions, converts to returns and forwards notional weights to the AI
 * engine. Unit-tested with stubs (no AI engine required) — the /api/risk merge
 * is covered end-to-end separately.
 */
import { describe, it, expect } from 'vitest';
import { PortfolioAnalytics } from '../engines/portfolioAnalytics';
import { AiClient } from '../ai/aiClient';
import { CandleEngine } from '../engines/candleEngine';
import { PaperTradingEngine } from '../engines/paperTradingEngine';

function stubCandles(symbols: string[], baseOpen: number, bars: number, step: number) {
  const engine = {
    getCandles: (sym: string) => {
      const s = symbols.indexOf(sym);
      const out: Array<{ openTime: number; close: number }> = [];
      for (let i = 0; i < bars; i++) {
        out.push({ openTime: baseOpen + i * 3600_000, close: 100 + s * 10 + i * step });
      }
      return out;
    },
  } as unknown as CandleEngine;
  return engine;
}

function stubPaper(symbols: string[]) {
  const positions = symbols.map((s, i) => ({
    symbol: s,
    lots: 0.1 * (i + 1),
    entryPrice: 100 + i * 10,
    id: `p${i}`,
  }));
  return { getOpenPositions: () => positions } as unknown as PaperTradingEngine;
}

describe('portfolioAnalytics', () => {
  it('aligns closes by openTime and sends returns + notional weights to the AI client', async () => {
    const sent: Record<string, unknown> = {};
    const ai = {
      portfolioRisk: async (req: { symbols: string[]; returns: Record<string, number[]>; weights?: Record<string, number> }) => {
        Object.assign(sent, req);
        return { status: 'OK', engine: 'SKFOLIO' };
      },
    } as unknown as AiClient;
    const pa = new PortfolioAnalytics(ai, stubCandles(['EUR/USD', 'GBP/USD'], 1_700_000_000_000, 40, 1), stubPaper(['EUR/USD', 'GBP/USD']));
    const out = await pa.get('1h', 0);
    expect(out).toEqual({ status: 'OK', engine: 'SKFOLIO' });
    expect(sent.symbols).toEqual(['EUR/USD', 'GBP/USD']);
    expect((sent.returns as Record<string, number[]>)['EUR/USD']).toHaveLength(39);
    expect((sent.returns as Record<string, number[]>)['EUR/USD'][0]).toBeCloseTo(1 / 100, 9);
    // weights: notional lots*contractSize*entry normalized by the client engine
    expect((sent.weights as Record<string, number>)['EUR/USD']).toBeGreaterThan(0);
    expect((sent.weights as Record<string, number>)['GBP/USD']).toBeGreaterThan(0);
  });

  it('returns NO_POSITIONS without open positions', async () => {
    const ai = { portfolioRisk: async () => ({ status: 'OK' }) } as unknown as AiClient;
    const pa = new PortfolioAnalytics(ai, stubCandles(['EUR/USD'], 1, 40, 1), stubPaper([]));
    const out = await pa.get('1h', 0);
    expect(out?.status).toBe('NO_POSITIONS');
  });

  it('returns INSUFFICIENT_DATA when aligned history is thin', async () => {
    const ai = { portfolioRisk: async () => ({ status: 'OK' }) } as unknown as AiClient;
    const pa = new PortfolioAnalytics(ai, stubCandles(['EUR/USD'], 1, 5, 1), stubPaper(['EUR/USD']));
    const out = await pa.get('1h', 0);
    expect(out?.status).toBe('INSUFFICIENT_DATA');
  });
});