import { describe, it, expect } from 'vitest';
import { CircuitBreakerEngine } from '../engines/circuitBreakerEngine';
import { CorrelationEngine, pearson, rollingCorrelation, alignCloses } from '../engines/correlationEngine';
import { classifyRisk } from '../engines/riskClassificationEngine';
import { PortfolioRiskEngine } from '../engines/portfolioRiskEngine';
import { UserSettings } from '@fx/shared';

const settings: UserSettings = {
  minimumProfit: 0,
  availableCapital: 10000,
  accountCurrency: 'USD',
  maxRiskPercent: 1,
  minRr: 1.5,
  minConfidence: 0.55,
  maxDailyLossPercent: 3,
  maxWeeklyLossPercent: 6,
  maxDrawdownPercent: 10,
  maxConsecutiveLosses: 5,
  maxOpenPositions: 5,
  maxCorrelatedPositions: 3,
  maxLeverage: 50,
  selectedPairs: [],
  selectedTimeframes: [],
  preferredSessions: [],
  newsTrading: true,
  highImpactNewsRestriction: true,
  paperStartingCapital: 10000,
};

describe('circuit breakers', () => {
  const cb = new CircuitBreakerEngine();

  it('no breakers when all within limits', () => {
    const out = cb.evaluate({
      settings,
      dailyPnlPct: -1,
      weeklyPnlPct: -2,
      drawdownPct: 4,
      consecutiveLosses: 2,
      openPositions: 2,
      correlatedPositions: 1,
      leverage: 20,
      currencyExposurePct: 10,
    });
    expect(out.triggered).toBe(false);
  });

  it('daily loss limit trips', () => {
    const out = cb.evaluate({
      settings,
      dailyPnlPct: -3.5,
      weeklyPnlPct: -2,
      drawdownPct: 4,
      consecutiveLosses: 2,
      openPositions: 2,
      correlatedPositions: 1,
      leverage: 20,
      currencyExposurePct: 10,
    });
    expect(out.triggered).toBe(true);
    expect(out.activeBreakers).toContain('MAX_DAILY_LOSS');
  });

  it('drawdown limit trips', () => {
    const out = cb.evaluate({
      settings,
      dailyPnlPct: -1,
      weeklyPnlPct: -1,
      drawdownPct: 11,
      consecutiveLosses: 2,
      openPositions: 2,
      correlatedPositions: 1,
      leverage: 20,
      currencyExposurePct: 10,
    });
    expect(out.triggered).toBe(true);
    expect(out.activeBreakers).toContain('MAX_DRAWDOWN');
  });

  it('consecutive loss limit trips', () => {
    const out = cb.evaluate({
      settings,
      dailyPnlPct: -1,
      weeklyPnlPct: -1,
      drawdownPct: 2,
      consecutiveLosses: 6,
      openPositions: 2,
      correlatedPositions: 1,
      leverage: 20,
      currencyExposurePct: 10,
    });
    expect(out.activeBreakers).toContain('MAX_CONSECUTIVE_LOSSES');
  });

  it('countCorrelated finds correlated cluster', () => {
    const matrix = {
      'EUR/USD': { 'EUR/USD': 1, 'GBP/USD': 0.9, 'USD/JPY': 0.1 },
      'GBP/USD': { 'EUR/USD': 0.9, 'GBP/USD': 1, 'USD/JPY': 0.05 },
      'USD/JPY': { 'EUR/USD': 0.1, 'GBP/USD': 0.05, 'USD/JPY': 1 },
    };
    const count = cb.countCorrelated(['EUR/USD', 'GBP/USD', 'USD/JPY'], matrix, 0.7);
    expect(count).toBe(1); // EUR/USD correlates with GBP/USD only
  });
});

describe('correlation engine', () => {
  it('pearson: perfectly correlated series -> 1', () => {
    const a = [1, 2, 3, 4, 5];
    const b = [2, 4, 6, 8, 10];
    expect(pearson(a, b)).toBeCloseTo(1, 6);
  });
  it('pearson: inverse series -> -1', () => {
    const a = [1, 2, 3, 4, 5];
    const b = [5, 4, 3, 2, 1];
    expect(pearson(a, b)).toBeCloseTo(-1, 6);
  });
  it('pearson: unrelated series -> near 0', () => {
    const a = [1, 2, 3, 4, 5, 6, 7, 8];
    const b = [5, 3, 1, 7, 2, 8, 4, 6];
    expect(Math.abs(pearson(a, b))).toBeLessThan(0.5);
  });
  it('rollingCorrelation returns period-aligned series', () => {
    const a = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const b = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20];
    const out = rollingCorrelation(a, b, 5);
    expect(out).toHaveLength(6);
    expect(out[out.length - 1]).toBeCloseTo(1, 6);
  });
  it('alignCloses aligns by openTime', () => {
    const a = [{ openTime: 1, close: 10 }, { openTime: 2, close: 11 }, { openTime: 3, close: 12 }];
    const b = [{ openTime: 2, close: 21 }, { openTime: 3, close: 22 }, { openTime: 4, close: 23 }];
    const { a: aa, b: bb } = alignCloses(a, b);
    expect(aa).toEqual([11, 12]);
    expect(bb).toEqual([21, 22]);
  });
  it('checkNewPosition blocks excessive correlation', () => {
    const engine = new CorrelationEngine(new Map());
    const common = Array.from({ length: 100 }, (_, i) => ({ openTime: i, close: 100 + i * 0.01 }));
    engine.setCandles('EUR/USD', common);
    engine.setCandles('GBP/USD', common.map((c) => ({ ...c, close: c.close * 1.6 })));
    engine.setCandles('USD/JPY', common.map((c) => ({ ...c, close: 150 - c.close * 0.01 })));
    const ok = engine.checkNewPosition('EUR/USD', ['GBP/USD', 'USD/JPY'], 3, 50, 0.7);
    expect(ok.allowed).toBe(true);
    const blocked = engine.checkNewPosition('EUR/USD', ['GBP/USD'], 1, 50, 0.7);
    expect(blocked.allowed).toBe(false);
  });
});

describe('risk classification', () => {
  it('GREEN for low risk components', () => {
    const out = classifyRisk({
      symbol: 'EUR/USD',
      timestamp: Date.now(),
      components: { volatility: 0.2, spread: 0.1, news: 0, economicEvents: 0, mlUncertainty: 0.2, rr: 0.2, regime: 0.2, dataQuality: 0.05, portfolioExposure: 0, correlation: 0, drawdown: 0, modelHealth: 0 },
      critical: [],
    });
    expect(out.level).toBe('GREEN');
    expect(out.blocked).toBe(false);
  });

  it('RED + blocked when critical flag present', () => {
    const out = classifyRisk({
      symbol: 'EUR/USD',
      timestamp: Date.now(),
      components: { mlUncertainty: 0.5 },
      critical: ['RED: high-impact event approaching'],
    });
    expect(out.level).toBe('RED');
    expect(out.critical.some((c) => c.startsWith('BLOCK:'))).toBe(true);
    expect(out.blocked).toBe(true);
  });
});

describe('portfolio exposure', () => {
  it('detects overlapping USD exposure', () => {
    const engine = new PortfolioRiskEngine(settings);
    const positions = [
      { id: '1', symbol: 'EUR/USD', direction: 'BUY', lots: 1, entryPrice: 1.1, stopLoss: 1.09, status: 'OPEN' },
      { id: '2', symbol: 'GBP/USD', direction: 'BUY', lots: 1, entryPrice: 1.27, stopLoss: 1.26, status: 'OPEN' },
    ] as never;
    const report = engine.assess(positions, 10000, 0, 0, 10000);
    expect(report.maxCurrencyExposure.currency).toBe('USD');
  });

  it('preflight blocks at max open positions', () => {
    const engine = new PortfolioRiskEngine(settings);
    const positions = Array.from({ length: 5 }, (_, i) => ({
      id: String(i), symbol: 'EUR/USD', direction: 'BUY', lots: 0.1, entryPrice: 1.1, stopLoss: 1.09, status: 'OPEN',
    })) as never;
    const out = engine.preflightCheck(positions, 1, 10000);
    expect(out.allowed).toBe(false);
  });
});
