/**
 * Performance analytics for the Indian paper-trading book.
 *
 * Two things were wrong here, and the first one made the second one moot.
 *
 * It read a collection called `indiaTrades`. Nothing has ever written to that
 * name — `paper-execution.ts` persists to `INDIA_COLLECTIONS.trades`, which is
 * `IndiaTrade`. So the query matched nothing, `calculateMetrics` took the
 * zero-length branch on every call, and the analytics panel showed a clean sheet
 * of zeros no matter how many trades had closed. A panel that reports "0 trades,
 * 0% win rate" after a full session is worse than one that reports nothing,
 * because it looks like an answer.
 *
 * It also described a `TradeRecord` shape that no writer produces: `entryTime`,
 * `exitTime`, `holdTimeMinutes`, `pnlPercent`, `fees`, a five-value `exitReason`
 * union. The real record has `openedAt`/`closedAt`, no hold time (it is a
 * subtraction), `charges`, and the full `IndiaTradeExitReason` union. Every
 * derived figure was reading a field that would have been `undefined` had any
 * document arrived. Both are now the real names, read from the real collection.
 *
 * On the segmentation: the three cuts that matter for index options are the
 * underlying, days to expiry, and where in the session the trade was entered.
 * The old "best time of day" used `new Date(...).getHours()` — the *server's*
 * local hour — so on any host not set to IST it reported the wrong window, and
 * silently. It also bucketed by clock hour, which fits a 09:15–15:30 session
 * badly: the 09:00 bucket holds 45 minutes and the 15:00 bucket holds 30. The
 * buckets here are the session phases the engine already reasons about, computed
 * in IST regardless of where the process runs.
 *
 * The payload shape itself lives in `@fx/shared`, not here. It was previously
 * declared twice — once in this file and once by hand in the React panel — and
 * the copies drifted, which is the same class of mistake as the collection name.
 */
import { logger } from '../core/logger';
import type { DataStore } from '../db/store';
import { daysToExpiry } from './options-math';
import type {
  IndiaDteBucket,
  IndiaPerformanceMetrics,
  IndiaRecentPerformance,
  IndiaSegmentBreakdown,
  IndiaSegmentExtreme,
  IndiaSegmentMetrics,
  IndiaSessionPhase,
  IndiaTrade,
} from '@fx/shared';
import { INDIA_COLLECTIONS, INDIA_ENTRY_WINDOW, INDIA_SESSION_CLOSE_MIN, INDIA_SESSION_OPEN_MIN } from '@fx/shared';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Trades are read exactly as they were written. No adapter shape in between —
 *  that is what drifted out of sync in the first place. */
export type TradeRecord = IndiaTrade;

/**
 * Where in the session a trade was entered, and the rest of the payload shape.
 *
 * Re-exported rather than redeclared: the phase edges are `INDIA_ENTRY_WINDOW`,
 * the same constants the pre-trade session gate enforces and the UI's session arc
 * draws. So "the engine loses money in the first half hour" and "the engine is
 * not supposed to trade in the first quarter hour" are statements about the same
 * boundary, and a change to the rule moves all three.
 */
export type SessionPhase = IndiaSessionPhase;
export type DteBucket = IndiaDteBucket;
export type SegmentMetrics = IndiaSegmentMetrics;
export type RecentPerformance = IndiaRecentPerformance;
export type PerformanceMetrics = IndiaPerformanceMetrics;

/** Below this many trades a win rate is an anecdote, so the best/worst callouts
 *  refuse to name a segment. */
const MIN_SEGMENT_TRADES = 5;

/** Minute of the IST day for an instant, independent of the host's timezone. */
function istMinuteOfDay(at: number): number {
  const ist = new Date(at + IST_OFFSET_MS);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

/** IST calendar date, `YYYY-MM-DD`. Daily buckets have to be IST days: a
 *  UTC-dated bucket would be right only by the accident that NSE hours fall
 *  inside one UTC day, and would break the moment a pre-open or after-hours
 *  timestamp appeared. */
function istDate(at: number): string {
  return new Date(at + IST_OFFSET_MS).toISOString().slice(0, 10);
}

export function sessionPhaseOf(enteredAt: number): SessionPhase {
  const minute = istMinuteOfDay(enteredAt);
  const sinceOpen = minute - INDIA_SESSION_OPEN_MIN;
  const toClose = INDIA_SESSION_CLOSE_MIN - minute;
  if (sinceOpen < 0 || toClose <= 0) return 'OFF_SESSION';
  if (sinceOpen < INDIA_ENTRY_WINDOW.openBlockMinutes) return 'OPENING';
  if (sinceOpen < INDIA_ENTRY_WINDOW.openWarnMinutes) return 'SETTLING';
  if (toClose < INDIA_ENTRY_WINDOW.closeWarnMinutes) return 'PRE_CLOSE';
  return 'MIDDAY';
}

export function dteBucketOf(trade: IndiaTrade): DteBucket {
  // `undefined` and `null` are different answers. Undefined means the trade was
  // closed before the contract facts were being recorded; null means the
  // contract genuinely has no expiry.
  if (trade.expiry === undefined) return 'UNRECORDED';
  if (trade.expiry === null) return 'NOT_DATED';
  // Via `daysToExpiry`, not `(expiry - openedAt) / MS_PER_DAY`. The broker's
  // instrument master gives expiry as a bare date, which parses to UTC midnight
  // — 05:30 IST on expiry day, ten hours before the contract actually dies at
  // 15:30. Every entry in a 09:15–15:30 session is after that instant, so the
  // raw subtraction put the whole of the day-before session at 0.58–0.84 days
  // and bucketed it `EXPIRY_DAY`. That is the one bucket whose entire purpose is
  // to isolate expiry-day gamma and theta, and it was reading as contaminated
  // while looking perfectly plausible; every bucket above it was shifted a day
  // too. `daysToExpiry` rebuilds the expiry at 15:30 IST first.
  const days = daysToExpiry(trade.expiry, trade.openedAt);
  if (days < 1) return 'EXPIRY_DAY';
  if (days < 2) return '1D';
  if (days < 4) return '2-3D';
  if (days < 8) return '4-7D';
  return '8D_PLUS';
}

export class PerformanceAnalyticsEngine {
  constructor(private store: DataStore) {}

  /** Every closed trade in the window, oldest first — the drawdown walk and the
   *  "last 10" slice both depend on that order. */
  async calculateMetrics(startDate: number, endDate: number): Promise<PerformanceMetrics> {
    let trades: IndiaTrade[] = [];
    try {
      trades = await this.store.find<IndiaTrade>(
        INDIA_COLLECTIONS.trades,
        { closedAt: { $gte: startDate, $lte: endDate } },
        { closedAt: 1 },
        10_000,
      );
    } catch (err) {
      // A missing collection is the normal state before the first trade closes.
      logger.warn('india: performance query failed', { err: String(err) });
    }

    if (trades.length === 0) return emptyMetrics(startDate, endDate);

    const totalTrades = trades.length;
    const winners = trades.filter((t) => t.netPnl > 0);
    const losers = trades.filter((t) => t.netPnl < 0);
    const breakEvenTrades = totalTrades - winners.length - losers.length;
    const winRate = winners.length / totalTrades;

    const totalProfit = sum(winners, (t) => t.netPnl);
    const totalLoss = Math.abs(sum(losers, (t) => t.netPnl));
    const netProfit = sum(trades, (t) => t.netPnl);
    const totalCharges = sum(trades, (t) => t.charges ?? 0);

    const averageWin = winners.length > 0 ? totalProfit / winners.length : 0;
    const averageLoss = losers.length > 0 ? totalLoss / losers.length : 0;
    const largestWin = winners.length > 0 ? Math.max(...winners.map((t) => t.netPnl)) : 0;
    const largestLoss = losers.length > 0 ? Math.abs(Math.min(...losers.map((t) => t.netPnl))) : 0;

    const expectancy = netProfit / totalTrades;
    const avgRiskPerTrade = meanRisk(trades);
    // R-multiple rather than a percentage of notional. The old
    // `expectancyPercent` divided by summed notional and then multiplied by the
    // trade count, which is not a percentage of anything.
    const expectancyR = avgRiskPerTrade != null && avgRiskPerTrade > 0 ? expectancy / avgRiskPerTrade : null;

    const { maxDrawdown, maxDrawdownPercent, currentDrawdown } = drawdown(trades);
    const holdTimes = trades.map((t) => Math.max(0, (t.closedAt - t.openedAt) / 60_000));

    const bySessionPhase = segment(trades, (t) => sessionPhaseOf(t.openedAt));
    const { best: bestPhase, worst: worstPhase } = extremes(bySessionPhase);

    return {
      startDate,
      endDate,
      daysTraded: new Set(trades.map((t) => istDate(t.closedAt))).size,
      totalTrades,
      winningTrades: winners.length,
      losingTrades: losers.length,
      breakEvenTrades,
      winRate,
      winRatePercent: `${(winRate * 100).toFixed(1)}%`,
      totalProfit,
      totalLoss,
      netProfit,
      totalCharges,
      profitFactor: profitFactorOf(totalProfit, totalLoss),
      averageWin,
      averageLoss,
      largestWin,
      largestLoss,
      expectancy,
      expectancyR,
      maxDrawdown,
      maxDrawdownPercent,
      currentDrawdown,
      avgRiskPerTrade,
      avgRewardRisk: averageLoss > 0 ? averageWin / averageLoss : 0,
      averageHoldTime: sum(holdTimes, (h) => h) / totalTrades,
      shortestTrade: Math.min(...holdTimes),
      longestTrade: Math.max(...holdTimes),
      ...dailyExtremes(trades),
      // Explicit `string` key on these two: a strategy name or an underlying is
      // whatever the record carries, not a closed set the type system knows, so
      // the breakdown stays open-keyed. The three below infer their own unions.
      byStrategy: segment<string>(trades, (t) => t.strategy ?? 'UNKNOWN'),
      byUnderlying: segment<string>(trades, (t) => t.underlying),
      byExitReason: segment(trades, (t) => t.exitReason),
      bySessionPhase,
      byDte: segment(trades, dteBucketOf),
      bySide: {
        BUY: metricsFor(trades.filter((t) => t.side === 'BUY')),
        SELL: metricsFor(trades.filter((t) => t.side === 'SELL')),
      },
      bestPhase,
      worstPhase,
      last10Trades: recent(trades.slice(-10)),
      last20Trades: recent(trades.slice(-20)),
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers — free functions, so each is independently testable
// ---------------------------------------------------------------------------

function sum<T>(items: T[], of: (item: T) => number): number {
  return items.reduce((acc, item) => acc + of(item), 0);
}

/**
 * Profit factor, or null when there are no losses to divide by.
 *
 * The previous version returned a 999 sentinel here, which then flowed into
 * formatting, sorting and the UI as if it were a measurement of something.
 */
function profitFactorOf(totalProfit: number, totalLoss: number): number | null {
  if (!(totalLoss > 0)) return null;
  return totalProfit / totalLoss;
}

/** Mean risk actually recorded, ignoring trades that carry none. Null when that
 *  leaves nothing — the old version invented a 2% stop and averaged that. */
function meanRisk(trades: IndiaTrade[]): number | null {
  const withRisk = trades.filter((t) => Number.isFinite(t.riskInr) && t.riskInr > 0);
  if (withRisk.length === 0) return null;
  return sum(withRisk, (t) => t.riskInr) / withRisk.length;
}

function metricsFor(trades: IndiaTrade[]): SegmentMetrics {
  if (trades.length === 0) {
    return { trades: 0, wins: 0, losses: 0, winRate: 0, totalPnl: 0, avgPnl: 0, profitFactor: null, expectancyR: null };
  }
  const wins = trades.filter((t) => t.netPnl > 0);
  const losses = trades.filter((t) => t.netPnl < 0);
  const totalPnl = sum(trades, (t) => t.netPnl);
  const grossProfit = sum(wins, (t) => t.netPnl);
  const grossLoss = Math.abs(sum(losses, (t) => t.netPnl));
  const avgPnl = totalPnl / trades.length;
  const risk = meanRisk(trades);
  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: wins.length / trades.length,
    totalPnl,
    avgPnl,
    profitFactor: profitFactorOf(grossProfit, grossLoss),
    expectancyR: risk != null && risk > 0 ? avgPnl / risk : null,
  };
}

/** Group by a key function and reduce each group to the same metric shape, so
 *  every breakdown in the payload is directly comparable to every other.
 *
 *  Generic in the key so `byDte` comes back keyed by `IndiaDteBucket` rather than
 *  by bare `string`: the caller then cannot look up a bucket that does not exist,
 *  and the result is `Partial` because empty buckets are omitted rather than
 *  filled with zeros. */
function segment<K extends string>(trades: IndiaTrade[], keyOf: (t: IndiaTrade) => K): IndiaSegmentBreakdown<K> {
  const groups = new Map<K, IndiaTrade[]>();
  for (const trade of trades) {
    const key = keyOf(trade);
    const bucket = groups.get(key);
    if (bucket) bucket.push(trade);
    else groups.set(key, [trade]);
  }
  const out: IndiaSegmentBreakdown<K> = {};
  for (const [key, group] of groups) out[key] = metricsFor(group);
  return out;
}

function extremes<K extends string>(bySegment: IndiaSegmentBreakdown<K>): {
  best: IndiaSegmentExtreme<K> | null;
  worst: IndiaSegmentExtreme<K> | null;
} {
  // The cast is only to get `Object.entries` to admit a generic key: every key in
  // the record came from `keyOf`, so it is a K by construction.
  const entries = Object.entries(bySegment as Record<string, SegmentMetrics>) as Array<[K, SegmentMetrics]>;
  const eligible = entries.filter(([, m]) => m.trades >= MIN_SEGMENT_TRADES);
  if (eligible.length === 0) return { best: null, worst: null };
  let best = eligible[0];
  let worst = eligible[0];
  for (const entry of eligible) {
    if (entry[1].winRate > best[1].winRate) best = entry;
    if (entry[1].winRate < worst[1].winRate) worst = entry;
  }
  return {
    best: { phase: best[0], winRate: best[1].winRate, trades: best[1].trades },
    worst: { phase: worst[0], winRate: worst[1].winRate, trades: worst[1].trades },
  };
}

/**
 * Peak-to-trough of the realised equity curve, in closing order.
 *
 * The peak starts at 0, so a book that is down from its first trade reports the
 * loss as the drawdown, which is correct: the high-water mark of a new account
 * is its starting balance.
 */
function drawdown(trades: IndiaTrade[]): { maxDrawdown: number; maxDrawdownPercent: number; currentDrawdown: number } {
  let peak = 0;
  let cumulative = 0;
  let maxDrawdown = 0;
  let maxDrawdownPercent = 0;

  for (const trade of trades) {
    cumulative += trade.netPnl;
    if (cumulative > peak) peak = cumulative;
    const dd = peak - cumulative;
    if (dd > maxDrawdown) {
      maxDrawdown = dd;
      maxDrawdownPercent = peak > 0 ? (dd / peak) * 100 : 0;
    }
  }
  return { maxDrawdown, maxDrawdownPercent, currentDrawdown: peak - cumulative };
}

function dailyExtremes(trades: IndiaTrade[]): {
  bestDay?: { date: string; pnl: number };
  worstDay?: { date: string; pnl: number };
} {
  const daily = new Map<string, number>();
  for (const trade of trades) {
    const date = istDate(trade.closedAt);
    daily.set(date, (daily.get(date) ?? 0) + trade.netPnl);
  }
  const days = [...daily.entries()];
  if (days.length === 0) return {};
  let best = days[0];
  let worst = days[0];
  for (const day of days) {
    if (day[1] > best[1]) best = day;
    if (day[1] < worst[1]) worst = day;
  }
  return {
    bestDay: { date: best[0], pnl: best[1] },
    worstDay: { date: worst[0], pnl: worst[1] },
  };
}

function recent(trades: IndiaTrade[]): RecentPerformance {
  if (trades.length === 0) return { wins: 0, losses: 0, winRate: 0, pnl: 0 };
  const wins = trades.filter((t) => t.netPnl > 0).length;
  return {
    wins,
    losses: trades.length - wins,
    winRate: wins / trades.length,
    pnl: sum(trades, (t) => t.netPnl),
  };
}

function emptyMetrics(startDate: number, endDate: number): PerformanceMetrics {
  return {
    startDate,
    endDate,
    daysTraded: 0,
    totalTrades: 0,
    winningTrades: 0,
    losingTrades: 0,
    breakEvenTrades: 0,
    winRate: 0,
    winRatePercent: '—',
    totalProfit: 0,
    totalLoss: 0,
    netProfit: 0,
    totalCharges: 0,
    profitFactor: null,
    averageWin: 0,
    averageLoss: 0,
    largestWin: 0,
    largestLoss: 0,
    expectancy: 0,
    expectancyR: null,
    maxDrawdown: 0,
    maxDrawdownPercent: 0,
    currentDrawdown: 0,
    avgRiskPerTrade: null,
    avgRewardRisk: 0,
    averageHoldTime: 0,
    shortestTrade: 0,
    longestTrade: 0,
    byStrategy: {},
    byUnderlying: {},
    byExitReason: {},
    bySessionPhase: {},
    byDte: {},
    bySide: { BUY: metricsFor([]), SELL: metricsFor([]) },
    bestPhase: null,
    worstPhase: null,
    last10Trades: { wins: 0, losses: 0, winRate: 0, pnl: 0 },
    last20Trades: { wins: 0, losses: 0, winRate: 0, pnl: 0 },
  };
}
