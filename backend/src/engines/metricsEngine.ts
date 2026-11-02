/**
 * Backtest metrics engine. Computes the full metric set from trades and an
 * equity curve, including breakdowns by pair, timeframe, session, regime and
 * signal type. Pure and unit-testable.
 */
import { BacktestMetrics, PaperTrade, Timeframe } from '@fx/shared';

/** Nearest standard timeframe for a realized holding duration (attribution). */
function inferTimeframeBucket(durationMs: number): Timeframe | string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 'UNKNOWN';
  const buckets: Array<[Timeframe, number]> = [
    ['1m', 60_000], ['5m', 300_000], ['15m', 900_000], ['30m', 1_800_000],
    ['1h', 3_600_000], ['4h', 14_400_000], ['1D', 86_400_000],
  ];
  let best = buckets[buckets.length - 1][0];
  let bestDiff = Infinity;
  for (const [tf, ms] of buckets) {
    const diff = Math.abs(durationMs - ms);
    if (diff < bestDiff) { bestDiff = diff; best = tf; }
  }
  return best;
}

export interface MetricsInput {
  trades: PaperTrade[];
  equityCurve: Array<{ time: number; equity: number }>;
  startingCapital: number;
}

export function computeMetrics(input: MetricsInput): BacktestMetrics {
  const { trades, equityCurve, startingCapital } = input;
  const byPair: BacktestMetrics['byPair'] = {};
  const bySession: BacktestMetrics['bySession'] = {};
  const byRegime: BacktestMetrics['byRegime'] = {};
  const byTimeframe: BacktestMetrics['byTimeframe'] = {};
  const byStrategy: BacktestMetrics['byStrategy'] = {};
  const byDirection: BacktestMetrics['byDirection'] = {};

  const wins: number[] = [];
  const losses: number[] = [];
  let totalPnl = 0;
  let maxWinStreak = 0;
  let maxLossStreak = 0;
  let curWinStreak = 0;
  let curLossStreak = 0;
  let maxLoss = 0;
  let totalDuration = 0;

  const addBreakdown = (map: Record<string, { trades: number; winRate: number; pnl: number }>, key: string, pnl: number, won: boolean) => {
    const e = map[key] ?? { trades: 0, winRate: 0, pnl: 0 };
    e.trades++;
    e.pnl += pnl;
    if (won) e.winRate = (e.winRate * (e.trades - 1) + 1) / e.trades;
    else e.winRate = (e.winRate * (e.trades - 1)) / e.trades;
    map[key] = e;
  };

  for (const t of trades) {
    totalPnl += t.pnl;
    totalDuration += t.durationMs;
    if (t.pnl > 0) {
      wins.push(t.pnl);
      curWinStreak++;
      curLossStreak = 0;
      maxWinStreak = Math.max(maxWinStreak, curWinStreak);
    } else if (t.pnl < 0) {
      losses.push(t.pnl);
      curLossStreak++;
      curWinStreak = 0;
      maxLossStreak = Math.max(maxLossStreak, curLossStreak);
      maxLoss = Math.min(maxLoss, t.pnl);
    }
    const won = t.pnl > 0;
    addBreakdown(byPair, t.symbol, t.pnl, won);
    addBreakdown(bySession, t.session, t.pnl, won);
    addBreakdown(byRegime, t.regime ?? 'UNKNOWN', t.pnl, won);
    // Timeframe attribution inferred from realized holding time (trades do
    // not carry the decision timeframe) — never a hardcoded bucket.
    addBreakdown(byTimeframe, inferTimeframeBucket(t.durationMs), t.pnl, won);
    // Performance attribution (spec §24): which strategy/direction works.
    addBreakdown(byStrategy, t.strategy ?? 'UNKNOWN', t.pnl, won);
    addBreakdown(byDirection, t.direction, t.pnl, won);
  }

  const n = trades.length;
  const winRate = n ? wins.length / n : 0;
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;
  const expectancy = n ? totalPnl / n : 0;
  const averageWin = wins.length ? grossWin / wins.length : 0;
  const averageLoss = losses.length ? grossLoss / losses.length : 0;

  // Sharpe / Sortino from equity curve returns. Annualization uses the ACTUAL
  // sampling interval of the curve (√periods-per-year): a fixed √365 assumed
  // daily samples, but the curve is sampled every N bars — two backtests with
  // different lengths produced arbitrarily scaled Sharpe ratios.
  let sharpe = 0;
  let sortino = 0;
  if (equityCurve.length > 2) {
    const returns: number[] = [];
    for (let i = 1; i < equityCurve.length; i++) {
      const prev = equityCurve[i - 1].equity;
      if (prev > 0) returns.push(equityCurve[i].equity / prev - 1);
    }
    // median sampling interval (robust to a stray gap)
    const gaps: number[] = [];
    for (let i = 1; i < equityCurve.length; i++) gaps.push(equityCurve[i].time - equityCurve[i - 1].time);
    gaps.sort((a, b) => a - b);
    const medianGapMs = gaps.length ? Math.max(1, gaps[Math.floor(gaps.length / 2)]) : 86_400_000;
    const periodsPerYear = (365 * 86_400_000) / medianGapMs;
    const annFactor = Math.sqrt(Math.max(1, periodsPerYear));
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const std = Math.sqrt(returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length);
    sharpe = std > 0 ? (mean / std) * annFactor : 0;
    const downside = returns.filter((r) => r < 0);
    const downsideStd = Math.sqrt(downside.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, downside.length));
    sortino = downsideStd > 0 ? (mean / downsideStd) * annFactor : 0;
  }

  // max drawdown from equity curve
  let maxDrawdownPct = 0;
  let maxDrawdownAbs = 0;
  let peak = startingCapital;
  for (const point of equityCurve) {
    peak = Math.max(peak, point.equity);
    if (peak > 0) maxDrawdownPct = Math.max(maxDrawdownPct, (peak - point.equity) / peak * 100);
    maxDrawdownAbs = Math.max(maxDrawdownAbs, peak - point.equity);
  }

  // CAGR (spec §66): annualized compounding over the equity-curve span.
  let cagrPct = 0;
  if (equityCurve.length > 1 && startingCapital > 0) {
    const first = equityCurve[0].time;
    const last = equityCurve[equityCurve.length - 1].time;
    const years = (last - first) / (365 * 86400_000);
    const finalEquity = equityCurve[equityCurve.length - 1].equity;
    if (years > 0.01 && finalEquity > 0) {
      cagrPct = (Math.pow(finalEquity / startingCapital, 1 / years) - 1) * 100;
    }
  }
  // Recovery factor (spec §66): net profit / max absolute drawdown.
  const recoveryFactor = maxDrawdownAbs > 0 ? totalPnl / maxDrawdownAbs : totalPnl > 0 ? Infinity : 0;

  return {
    totalReturnPct: startingCapital > 0 ? (totalPnl / startingCapital) * 100 : 0,
    cagrPct: Number(cagrPct.toFixed(2)),
    recoveryFactor: Number.isFinite(recoveryFactor) ? Number(recoveryFactor.toFixed(2)) : Infinity,
    winRate,
    profitFactor,
    expectancy,
    sharpe: Number(sharpe.toFixed(3)),
    sortino: Number(sortino.toFixed(3)),
    maxDrawdownPct: Number(maxDrawdownPct.toFixed(2)),
    averageWin,
    averageLoss,
    maxLoss,
    maxWinStreak,
    maxLossStreak,
    tradeCount: n,
    averageTradeDurationMs: n ? totalDuration / n : 0,
    byPair,
    byTimeframe,
    bySession,
    byRegime,
    byStrategy,
    byDirection,
  };
}
