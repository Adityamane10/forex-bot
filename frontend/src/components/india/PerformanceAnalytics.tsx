/**
 * What the closed book actually did.
 *
 * This panel used to declare its own copy of the payload interface, by hand, and
 * the fetch was typed `unknown` and cast — so when the server's shape changed the
 * component kept compiling and quietly rendered fields nobody was sending. It now
 * imports `IndiaPerformanceMetrics` from `@fx/shared`, the same type the engine
 * returns, so a change on either side is a compile error rather than a blank
 * figure. Two display bugs went with the old copy: a profit factor that assumed a
 * number where the server now sends null for a book with no losses, and a win rate
 * held as a 0..1 fraction but compared against 50 and printed as a percentage, so
 * a 62% win rate rendered "1% WR" and coloured red.
 *
 * On the colour: win rate is not coloured here, only P&L and profit factor are. A
 * 40% win rate with a 3:1 payoff is a good system and a 70% win rate that gives it
 * all back on the losers is not, so painting win rate green invites exactly the
 * wrong read. Money is the thing that is green or red.
 *
 * The six breakdowns share one row renderer because the server gives them all the
 * same shape. Each row's win rate is drawn as a fill behind the row itself, tinted
 * by whether the slice made money, so the table scans as a chart without becoming
 * one.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  IndiaDteBucket,
  IndiaPerformanceMetrics,
  IndiaSegmentBreakdown,
  IndiaSegmentMetrics,
  IndiaSessionPhase,
  IndiaTradeExitReason,
} from '@fx/shared';
import {
  INDIA_DTE_BUCKETS,
  INDIA_DTE_BUCKET_LABEL,
  INDIA_SESSION_PHASES,
  INDIA_SESSION_PHASE_LABEL,
  INDIA_TRADE_EXIT_REASONS,
} from '@fx/shared';
import { IndiaApi } from '../../api';

const cls = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(' ');

/** Rupees, grouped the Indian way — ₹1,23,456 rather than ₹123,456.00. Whole
 *  rupees: paise on a P&L total is noise, and the extra digits cost width this
 *  column does not have. */
const RUPEES = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

function inr(n: number | null | undefined, signed = false): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const sign = signed && n > 0 ? '+' : n < 0 ? '−' : '';
  return `${sign}₹${RUPEES.format(Math.abs(Math.round(n)))}`;
}

/** A ratio, or an em dash when the server said it has no answer. Null here always
 *  means "the sample cannot support this figure", never zero. */
function ratio(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}

/** Fractions arrive on 0..1 and are shown as percentages. The old component
 *  skipped this step and compared the fraction against 50. */
function pct(fraction: number, digits = 0): string {
  if (!Number.isFinite(fraction)) return '—';
  return `${(fraction * 100).toFixed(digits)}%`;
}

/** `STOP_LOSS` → `Stop loss`. Derived rather than kept as a lookup table, so a new
 *  exit reason in the shared union appears here readable without a second edit. */
function humanize(token: string): string {
  const words = token.replace(/_/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function mins(m: number): string {
  if (!Number.isFinite(m) || m <= 0) return '—';
  if (m < 60) return `${Math.round(m)}m`;
  return `${Math.floor(m / 60)}h ${Math.round(m % 60)}m`;
}

function pnlTone(n: number): string {
  return n > 0 ? 'text-up' : n < 0 ? 'text-down' : 'text-slate-400';
}

/** Below 1.0 the book loses money; 1.5 is the point where costs and a bad streak
 *  stop being fatal. Null is uncoloured — it is an absence, not a grade. */
function factorTone(pf: number | null): string {
  if (pf === null) return 'text-slate-400';
  return pf >= 1.5 ? 'text-up' : pf >= 1 ? 'text-warn' : 'text-down';
}

function Figure({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="rounded bg-panel2/60 px-2.5 py-2">
      <div className="text-micro uppercase tracking-eyebrow text-slate-500">{label}</div>
      <div className={cls('mt-0.5 font-mono text-sm font-semibold tracking-numeric', tone ?? 'text-slate-200')}>{value}</div>
      {sub && <div className="mt-0.5 text-[10px] leading-snug text-slate-600">{sub}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Breakdowns
// ---------------------------------------------------------------------------

interface SegmentRow {
  key: string;
  label: string;
  metrics: IndiaSegmentMetrics;
}

/**
 * Rows in the order the buckets are defined, skipping buckets with no trades.
 *
 * Canonical order matters for the typed cuts: session phases should read
 * chronologically and expiry buckets from expiry outward, because the shape of
 * the curve across them is the finding. Sorting those by trade count would
 * scramble it.
 */
function ordered<K extends string>(
  breakdown: IndiaSegmentBreakdown<K>,
  order: readonly K[],
  label: (key: K) => string,
): SegmentRow[] {
  const rows: SegmentRow[] = [];
  for (const key of order) {
    const metrics = breakdown[key];
    if (metrics && metrics.trades > 0) rows.push({ key, label: label(key), metrics });
  }
  return rows;
}

/** Rows for open-keyed cuts — strategy, underlying — busiest first, since there is
 *  no inherent order and the biggest sample is the most trustworthy. */
function byVolume(breakdown: IndiaSegmentBreakdown): SegmentRow[] {
  return Object.entries(breakdown)
    .filter((entry): entry is [string, IndiaSegmentMetrics] => entry[1] !== undefined && entry[1].trades > 0)
    .sort((a, b) => b[1].trades - a[1].trades)
    .map(([key, metrics]) => ({ key, label: key, metrics }));
}

function SegmentTableRow({ row }: { row: SegmentRow }) {
  const m = row.metrics;
  return (
    <div className="relative overflow-hidden rounded bg-panel2/50">
      {/* Win rate as the row's own fill, tinted by whether the slice made money.
          Aria-hidden: the same numbers are in the text beside it. */}
      <div
        className={cls('absolute inset-y-0 left-0', m.totalPnl > 0 ? 'bg-up/10' : m.totalPnl < 0 ? 'bg-down/10' : 'bg-slate-700/20')}
        style={{ width: `${Math.max(0, Math.min(100, m.winRate * 100))}%` }}
        aria-hidden
      />
      <div className="relative flex items-baseline justify-between gap-2 px-2 py-1.5">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-[11px] font-medium text-slate-300">{row.label}</span>
          <span className="shrink-0 font-mono text-[10px] text-slate-600">
            {m.trades} · {pct(m.winRate)}
          </span>
        </div>
        <div className="flex shrink-0 items-baseline gap-2.5 font-mono text-[10px]">
          {m.expectancyR !== null && (
            <span className={m.expectancyR >= 0 ? 'text-slate-500' : 'text-slate-600'} title="Average P&L per unit of risk">
              {m.expectancyR >= 0 ? '+' : '−'}{Math.abs(m.expectancyR).toFixed(2)}R
            </span>
          )}
          <span className={cls('font-semibold tracking-numeric', pnlTone(m.totalPnl))}>{inr(m.totalPnl, true)}</span>
        </div>
      </div>
    </div>
  );
}

function SegmentTable({ rows, empty }: { rows: SegmentRow[]; empty: string }) {
  if (rows.length === 0) {
    return <div className="px-0.5 py-2 text-[11px] leading-relaxed text-slate-600">{empty}</div>;
  }
  return (
    <div className="space-y-1">
      {rows.map((row) => <SegmentTableRow key={row.key} row={row} />)}
    </div>
  );
}

const CUTS = ['Underlying', 'Session', 'Expiry', 'Exit', 'Strategy', 'Side'] as const;
type Cut = (typeof CUTS)[number];

// ---------------------------------------------------------------------------

const RANGES = [7, 30, 90, 180] as const;
const RANGE_LABEL: Record<number, string> = { 7: 'Last 7 days', 30: 'Last 30 days', 90: 'Last 90 days', 180: 'Last 6 months' };

/** Trades close throughout a session, so a panel that loads once at mount goes
 *  stale by lunchtime. One lightweight request a minute, and none at all while the
 *  tab is in the background. */
const REFRESH_MS = 60_000;

export function PerformanceAnalyticsDashboard({ days = 30 }: { days?: number }) {
  const [metrics, setMetrics] = useState<IndiaPerformanceMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedDays, setSelectedDays] = useState<number>(days);
  const [cut, setCut] = useState<Cut>('Underlying');
  /** Which request the panel is still interested in. Changing the range while a
   *  fetch is in the air would otherwise let the slower response land last and
   *  show the wrong window. Tokening the requests is also why overlapping fetches
   *  are allowed at all: dropping them instead would mean a range change during a
   *  poll silently kept the old numbers. */
  const latest = useRef(0);
  const alive = useRef(true);

  const load = useCallback(async (showSpinner: boolean) => {
    const id = ++latest.current;
    if (showSpinner) setLoading(true);
    try {
      const endDate = Date.now();
      const startDate = endDate - selectedDays * 86_400_000;
      const data = (await IndiaApi.getPerformanceAnalytics(startDate, endDate)) as IndiaPerformanceMetrics;
      // The endpoint returns `unknown`, so this is the one place the shape is
      // taken on trust; check the field every downstream figure depends on.
      if (!data || typeof data.totalTrades !== 'number') throw new Error('Unexpected response shape');
      if (!alive.current || id !== latest.current) return;
      setMetrics(data);
      setError(null);
    } catch (err) {
      if (!alive.current || id !== latest.current) return;
      setError(err instanceof Error ? err.message : 'Could not load performance');
    } finally {
      if (alive.current && id === latest.current) setLoading(false);
    }
  }, [selectedDays]);

  useEffect(() => {
    alive.current = true;
    void load(true);
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load(false);
    }, REFRESH_MS);
    return () => { alive.current = false; clearInterval(timer); };
  }, [load]);

  const header = (
    <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
      <div className="min-w-0">
        <span className="text-xs font-semibold uppercase tracking-eyebrow text-slate-400">Performance</span>
        {metrics && metrics.totalTrades > 0 && (
          <span className="ml-2 font-mono text-[10px] text-slate-600">
            {metrics.totalTrades} closed · {metrics.daysTraded} {metrics.daysTraded === 1 ? 'day' : 'days'} traded
          </span>
        )}
      </div>
      <select
        value={selectedDays}
        onChange={(e) => setSelectedDays(Number(e.target.value))}
        aria-label="Date range"
        className="shrink-0 rounded border border-border bg-panel2 px-2 py-1 text-[10px] text-slate-300 outline-none transition-colors hover:border-hairline focus-visible:border-accent"
      >
        {RANGES.map((r) => <option key={r} value={r}>{RANGE_LABEL[r]}</option>)}
      </select>
    </div>
  );

  if (loading && !metrics) {
    return (
      <div className="rounded-lg border border-border bg-panel">
        {header}
        <div className="px-3 py-4 text-[11px] text-slate-600">Reading the closed-trade book…</div>
      </div>
    );
  }

  if (error && !metrics) {
    return (
      <div className="rounded-lg border border-border bg-panel">
        {header}
        <div className="px-3 py-4 text-[11px] leading-relaxed text-down">{error}</div>
      </div>
    );
  }

  if (!metrics) return null;

  if (metrics.totalTrades === 0) {
    return (
      <div className="rounded-lg border border-border bg-panel">
        {header}
        <div className="px-3 py-4 text-[11px] leading-relaxed text-slate-500">
          No trades closed in this window. Figures appear once the paper engine closes its first position — open
          positions are not counted here, only settled ones.
        </div>
      </div>
    );
  }

  const gross = metrics.netProfit + metrics.totalCharges;
  const costDrag = gross > 0 ? metrics.totalCharges / gross : null;
  const noLosses = metrics.profitFactor === null && metrics.losingTrades === 0;

  const rows: Record<Cut, { rows: SegmentRow[]; empty: string }> = {
    Underlying: { rows: byVolume(metrics.byUnderlying), empty: 'No underlying recorded.' },
    Session: {
      rows: ordered<IndiaSessionPhase>(metrics.bySessionPhase, INDIA_SESSION_PHASES, (k) => INDIA_SESSION_PHASE_LABEL[k]),
      empty: 'No entries bucketed yet.',
    },
    Expiry: {
      rows: ordered<IndiaDteBucket>(metrics.byDte, INDIA_DTE_BUCKETS, (k) => INDIA_DTE_BUCKET_LABEL[k]),
      empty: 'No expiry recorded on these trades.',
    },
    Exit: {
      rows: ordered<IndiaTradeExitReason>(metrics.byExitReason, INDIA_TRADE_EXIT_REASONS, humanize),
      empty: 'No exits recorded.',
    },
    Strategy: { rows: byVolume(metrics.byStrategy), empty: 'No strategy tagged on these trades.' },
    Side: {
      rows: (['BUY', 'SELL'] as const)
        .filter((side) => metrics.bySide[side].trades > 0)
        .map((side) => ({ key: side, label: side === 'BUY' ? 'Long' : 'Short', metrics: metrics.bySide[side] })),
      empty: 'No trades on either side.',
    },
  };

  return (
    <div className="rounded-lg border border-border bg-panel">
      {header}

      <div className="space-y-3 p-3">
        <div className="grid grid-cols-4 gap-2">
          <Figure
            label="Net P&L"
            value={inr(metrics.netProfit, true)}
            sub={costDrag !== null ? `${pct(costDrag)} of gross to costs` : `${inr(metrics.totalCharges)} costs`}
            tone={pnlTone(metrics.netProfit)}
          />
          <Figure
            label="Win rate"
            value={metrics.winRatePercent}
            sub={`${metrics.winningTrades}W / ${metrics.losingTrades}L${metrics.breakEvenTrades > 0 ? ` / ${metrics.breakEvenTrades}BE` : ''}`}
          />
          <Figure
            label="Profit factor"
            value={ratio(metrics.profitFactor)}
            sub={noLosses ? 'no losing trades yet' : metrics.profitFactor !== null && metrics.profitFactor >= 1 ? 'net positive' : 'net negative'}
            tone={factorTone(metrics.profitFactor)}
          />
          <Figure
            label="Expectancy"
            value={inr(metrics.expectancy, true)}
            sub={metrics.expectancyR !== null ? `${metrics.expectancyR >= 0 ? '+' : '−'}${Math.abs(metrics.expectancyR).toFixed(2)}R per trade` : 'risk not recorded'}
            tone={pnlTone(metrics.expectancy)}
          />
        </div>

        <div className="grid grid-cols-4 gap-2">
          <Figure label="Avg win" value={inr(metrics.averageWin)} sub={`best ${inr(metrics.largestWin)}`} tone="text-up" />
          <Figure label="Avg loss" value={inr(metrics.averageLoss)} sub={`worst ${inr(metrics.largestLoss)}`} tone="text-down" />
          <Figure
            label="Reward : risk"
            value={metrics.avgRewardRisk > 0 ? `${metrics.avgRewardRisk.toFixed(2)}×` : '—'}
            sub={metrics.avgRiskPerTrade !== null ? `risking ${inr(metrics.avgRiskPerTrade)}/trade` : 'risk not recorded'}
          />
          <Figure
            label="Hold time"
            value={mins(metrics.averageHoldTime)}
            sub={`${mins(metrics.shortestTrade)} – ${mins(metrics.longestTrade)}`}
          />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Figure
            label="Max drawdown"
            value={inr(metrics.maxDrawdown)}
            sub={metrics.maxDrawdownPercent > 0 ? `${metrics.maxDrawdownPercent.toFixed(1)}% off peak` : 'never below the high-water mark'}
            tone={metrics.maxDrawdown > 0 ? 'text-down' : undefined}
          />
          <Figure
            label="Now"
            value={metrics.currentDrawdown > 0 ? inr(metrics.currentDrawdown) : 'at peak'}
            sub={metrics.currentDrawdown > 0 ? 'below the high-water mark' : 'equity at its best'}
            tone={metrics.currentDrawdown > 0 ? 'text-warn' : 'text-up'}
          />
        </div>

        {(metrics.bestDay || metrics.worstDay) && (
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 rounded bg-panel2/40 px-2.5 py-2 text-[11px]">
            {metrics.bestDay && (
              <span className="text-slate-500">
                Best day <span className="font-mono text-slate-400">{metrics.bestDay.date}</span>{' '}
                <span className={cls('font-mono font-semibold', pnlTone(metrics.bestDay.pnl))}>{inr(metrics.bestDay.pnl, true)}</span>
              </span>
            )}
            {metrics.worstDay && (
              <span className="text-slate-500">
                Worst <span className="font-mono text-slate-400">{metrics.worstDay.date}</span>{' '}
                <span className={cls('font-mono font-semibold', pnlTone(metrics.worstDay.pnl))}>{inr(metrics.worstDay.pnl, true)}</span>
              </span>
            )}
          </div>
        )}

        {/* The one line worth acting on: when in the day the engine earns its
            money. Only named once a phase has enough trades to mean it, which is
            the server's judgement, not this component's. */}
        {metrics.bestPhase && metrics.worstPhase && metrics.bestPhase.phase !== metrics.worstPhase.phase && (
          <p className="text-[11px] leading-relaxed text-slate-500">
            Strongest in <span className="text-slate-300">{INDIA_SESSION_PHASE_LABEL[metrics.bestPhase.phase]}</span> at{' '}
            <span className="font-mono text-up">{pct(metrics.bestPhase.winRate)}</span> over {metrics.bestPhase.trades} trades;
            weakest in <span className="text-slate-300">{INDIA_SESSION_PHASE_LABEL[metrics.worstPhase.phase]}</span> at{' '}
            <span className="font-mono text-down">{pct(metrics.worstPhase.winRate)}</span> over {metrics.worstPhase.trades}.
          </p>
        )}

        <div>
          <div className="mb-1.5 flex flex-wrap gap-1">
            {CUTS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setCut(c)}
                aria-pressed={cut === c}
                className={cls(
                  'rounded px-1.5 py-0.5 text-micro uppercase tracking-eyebrow transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent',
                  cut === c ? 'bg-panel2 text-slate-200' : 'text-slate-600 hover:text-slate-400',
                )}
              >
                {c}
              </button>
            ))}
          </div>
          <SegmentTable rows={rows[cut].rows} empty={rows[cut].empty} />
        </div>

        <div className="flex items-baseline justify-between gap-2 text-[10px] text-slate-600">
          <span>
            Last 10: <span className={cls('font-mono', pnlTone(metrics.last10Trades.pnl))}>{inr(metrics.last10Trades.pnl, true)}</span>
            {' · '}{pct(metrics.last10Trades.winRate)}
            <span className="mx-1.5 text-slate-700">|</span>
            Last 20: <span className={cls('font-mono', pnlTone(metrics.last20Trades.pnl))}>{inr(metrics.last20Trades.pnl, true)}</span>
            {' · '}{pct(metrics.last20Trades.winRate)}
          </span>
          {metrics.totalTrades < 10 && <span className="shrink-0 text-warn/70">small sample</span>}
        </div>

        {error && <div className="text-[10px] text-warn">Showing the last good read — {error}</div>}
      </div>
    </div>
  );
}
