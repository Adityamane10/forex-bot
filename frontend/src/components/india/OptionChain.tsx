/**
 * Option chain ladder — open interest as a shape, not a spreadsheet.
 *
 * The backend has been computing per-strike OI, solved IV, greeks and spreads for
 * a while; nothing rendered them, so the only way to see where the book was
 * positioned was to read five "top strikes" as text. Here the OI profile is a
 * mirrored bar chart around the strike column, which is how a trader actually
 * reads a chain: the tall bars are where writers have committed, and price tends
 * to respect them.
 *
 * Max Pain and spot are drawn onto the same ladder rather than quoted next to it.
 * That is the point of the endpoint returning the summary and the strikes from a
 * single fetch — the marker cannot come from a later snapshot than the bars.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { IndiaEnrichedStrike, IndiaOptionAnalytics, IndiaOptionLeg } from '@fx/shared';
import { IndiaApi } from '../../api';
import { fmtTime } from '../../format';
import { compactOi, level, signedOi } from './optionFormat';

const cls = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(' ');

/** Strikes shown either side of ATM before "show all". Eleven rows covers the
 *  range that actually trades on an index expiry without needing a scrollbar. */
const WINDOW = 5;

function premium(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return n.toFixed(n >= 100 ? 1 : 2);
}

/** IV in the ladder drops the % sign: the column header carries it once, and
 *  nine tracks of numbers are easier to compare without repeated punctuation. */
function ivText(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(1)}`;
}

/** A leg's tooltip carries what the row has no room for: greeks and spread. */
function legTitle(leg: IndiaOptionLeg, kind: 'Call' | 'Put'): string {
  const g = leg.greeks;
  const parts = [`${kind} ${leg.tradingSymbol}`];
  if (leg.bid != null && leg.ask != null) parts.push(`bid ${leg.bid.toFixed(2)} / ask ${leg.ask.toFixed(2)}`);
  if (leg.spreadPct != null) parts.push(`spread ${(leg.spreadPct * 100).toFixed(2)}% of premium`);
  if (leg.volume != null) parts.push(`volume ${compactOi(leg.volume)}`);
  if (g) {
    parts.push(
      `delta ${g.delta.toFixed(3)} · gamma ${g.gamma.toFixed(5)} · theta ${g.theta.toFixed(2)}/day · vega ${g.vega.toFixed(2)}/vol pt`,
    );
  }
  return parts.join('\n');
}

/** Nine tracks: ΔOI · bar · LTP · IV | STRIKE | IV · LTP · bar · ΔOI. */
const GRID = 'grid grid-cols-[3.25rem_minmax(0,1fr)_3.25rem_2.25rem_4.5rem_2.25rem_3.25rem_minmax(0,1fr)_3.25rem] items-center gap-x-1';

function ChainRow({
  row, maxOi, isAtm, isMaxPain, spotBelow,
}: {
  row: IndiaEnrichedStrike;
  maxOi: number;
  isAtm: boolean;
  isMaxPain: boolean;
  /** Spot sits between this strike and the one below it — draw the price line here. */
  spotBelow: boolean;
}) {
  const callOi = row.call.oi ?? 0;
  const putOi = row.put.oi ?? 0;
  const callW = maxOi > 0 ? (callOi / maxOi) * 100 : 0;
  const putW = maxOi > 0 ? (putOi / maxOi) * 100 : 0;
  const callBuild = (row.callOIChange ?? 0) > 0;
  const putBuild = (row.putOIChange ?? 0) > 0;

  return (
    <>
      <div
        className={cls(
          GRID,
          'relative py-[3px] font-mono text-[10px]',
          isMaxPain && 'bg-warn/[0.07]',
          isAtm && 'bg-blue-400/[0.06]',
        )}
      >
        {isMaxPain && <span className="absolute inset-y-0 left-0 w-[2px] bg-warn" aria-hidden />}

        <span className={cls('text-right', callBuild ? 'text-slate-400' : 'text-slate-600')}>{signedOi(row.callOIChange)}</span>
        <span className="flex h-3 items-center justify-end" title={`Call OI ${compactOi(callOi)}`}>
          <span className="h-2 rounded-l bg-emerald-500/30" style={{ width: `${callW}%` }} />
        </span>
        <span className="text-right text-slate-300" title={legTitle(row.call, 'Call')}>{premium(row.call.ltp)}</span>
        <span className="text-right text-slate-600">{ivText(row.call.iv)}</span>

        <span className={cls('text-center', isAtm ? 'font-semibold text-slate-100' : 'text-slate-400')}>
          {level(row.strike)}
        </span>

        <span className="text-slate-600">{ivText(row.put.iv)}</span>
        <span className="text-slate-300" title={legTitle(row.put, 'Put')}>{premium(row.put.ltp)}</span>
        <span className="flex h-3 items-center" title={`Put OI ${compactOi(putOi)}`}>
          <span className="h-2 rounded-r bg-red-500/30" style={{ width: `${putW}%` }} />
        </span>
        <span className={cls(putBuild ? 'text-slate-400' : 'text-slate-600')}>{signedOi(row.putOIChange)}</span>
      </div>
      {spotBelow && (
        <div className="relative h-0" aria-hidden>
          <div className="absolute inset-x-0 -top-[1px] border-t border-dashed border-accent/70" />
        </div>
      )}
    </>
  );
}

export function OptionChainPanel({ underlying }: { underlying: string }) {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [strikes, setStrikes] = useState<IndiaEnrichedStrike[]>([]);
  const [analytics, setAnalytics] = useState<IndiaOptionAnalytics | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const view = await IndiaApi.getOptionChain(underlying);
      setStrikes(view.strikes ?? []);
      setAnalytics(view.analytics ?? null);
      setFetchedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load option chain');
    } finally {
      setBusy(false);
    }
  }, [underlying]);

  // Lazy: a full ladder is the heaviest request this view can make, so it is only
  // fetched once the panel is actually open, and only refreshed on request.
  useEffect(() => {
    setStrikes([]);
    setAnalytics(null);
    setFetchedAt(null);
    if (open) void load();
  }, [open, load]);

  const spot = analytics?.spotPrice ?? null;
  const maxPain = analytics?.maxPain.strike ?? null;
  const atmStrike = analytics?.atm.strike ?? null;

  const rows = useMemo(() => {
    const sorted = [...strikes].sort((a, b) => a.strike - b.strike);
    if (showAll || sorted.length <= WINDOW * 2 + 1) return sorted;
    const anchor = atmStrike ?? spot;
    if (anchor == null) return sorted.slice(0, WINDOW * 2 + 1);
    let nearest = 0;
    for (let i = 1; i < sorted.length; i += 1) {
      if (Math.abs(sorted[i].strike - anchor) < Math.abs(sorted[nearest].strike - anchor)) nearest = i;
    }
    return sorted.slice(Math.max(0, nearest - WINDOW), nearest + WINDOW + 1);
  }, [strikes, showAll, atmStrike, spot]);

  // Scale the bars to what is on screen. Scaling to the whole chain would make
  // the visible rows uniformly tiny whenever one far strike carries huge OI.
  const maxOi = useMemo(
    () => rows.reduce((m, r) => Math.max(m, r.call.oi ?? 0, r.put.oi ?? 0), 0),
    [rows],
  );

  const totals = useMemo(() => {
    let call = 0;
    let put = 0;
    for (const r of rows) {
      call += r.call.oi ?? 0;
      put += r.put.oi ?? 0;
    }
    return { call, put };
  }, [rows]);

  return (
    <div className="rounded-lg border border-border bg-panel">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 border-b border-border px-3 py-2 text-left hover:bg-panel2 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
      >
        <span className="text-xs font-semibold uppercase tracking-eyebrow text-slate-400">
          Option chain · {underlying}
        </span>
        <span className="flex items-center gap-2 text-[10px] text-slate-600">
          {open && fetchedAt && <span className="font-mono">{fmtTime(fetchedAt)}</span>}
          <span>{open ? 'hide ladder ▾' : 'show ladder ▸'}</span>
        </span>
      </button>

      {open && (
        <div className="p-3">
          {error && <p className="py-3 text-center text-[11px] text-down">{error}</p>}
          {!error && busy && strikes.length === 0 && (
            <p className="py-3 text-center text-[11px] text-slate-500">Loading chain…</p>
          )}
          {!error && !busy && strikes.length === 0 && (
            <p className="py-3 text-center text-[11px] text-slate-500">
              No strikes returned. The chain needs an active option expiry and a broker feed carrying quotes.
            </p>
          )}

          {rows.length > 0 && (
            <>
              <div className={cls(GRID, 'pb-1 text-[9px] uppercase tracking-eyebrow text-slate-600')}>
                <span className="text-right">ΔOI</span>
                <span className="text-right text-emerald-500/80">calls · OI</span>
                <span className="text-right">LTP</span>
                <span className="text-right">IV</span>
                <span className="text-center text-slate-500">strike</span>
                <span>IV</span>
                <span>LTP</span>
                <span className="text-red-500/80">puts · OI</span>
                <span>ΔOI</span>
              </div>

              <div className="border-t border-border/60">
                {rows.map((r, i) => {
                  const next = rows[i + 1];
                  return (
                    <ChainRow
                      key={r.strike}
                      row={r}
                      maxOi={maxOi}
                      isAtm={atmStrike != null && r.strike === atmStrike}
                      isMaxPain={maxPain != null && r.strike === maxPain}
                      spotBelow={spot != null && next != null && spot > r.strike && spot <= next.strike}
                    />
                  );
                })}
              </div>

              <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-2 text-[10px] text-slate-600">
                <span className="flex flex-wrap items-center gap-2">
                  <span>
                    Visible OI — calls <span className="font-mono text-slate-400">{compactOi(totals.call)}</span> · puts{' '}
                    <span className="font-mono text-slate-400">{compactOi(totals.put)}</span>
                  </span>
                  {maxPain != null && (
                    <span className="flex items-center gap-1">
                      <span className="inline-block h-2 w-[2px] bg-warn" aria-hidden /> max pain{' '}
                      <span className="font-mono text-slate-400">{level(maxPain)}</span>
                    </span>
                  )}
                  {spot != null && (
                    <span className="flex items-center gap-1">
                      <span className="inline-block h-0 w-3 border-t border-dashed border-accent/70" aria-hidden /> spot{' '}
                      <span className="font-mono text-slate-400">{level(spot, 2)}</span>
                    </span>
                  )}
                </span>
                <span className="flex items-center gap-2">
                  {strikes.length > WINDOW * 2 + 1 && (
                    <button
                      type="button"
                      onClick={() => setShowAll((v) => !v)}
                      className="text-slate-500 hover:text-slate-300 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
                    >
                      {showAll ? `near ATM only` : `all ${strikes.length} strikes`}
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void load()}
                    className="text-slate-500 hover:text-slate-300 disabled:opacity-50 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
                  >
                    {busy ? 'refreshing…' : 'refresh'}
                  </button>
                </span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
