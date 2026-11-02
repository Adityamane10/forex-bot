/**
 * Reports — real trading history, calendar-style.
 *
 * Every number comes from the backend's closed-trade journal (paperTrades —
 * the same records the Paper page's history uses; each trade carries the
 * conversion rate and terms it was actually closed under). Nothing here is
 * synthesized: a day with no closed trades shows as empty, and the calendar
 * only lights up days that really have trades.
 */
import { useEffect, useMemo, useState } from 'react';
import { Card, Table, Badge, Empty, Stat } from '../components/ui';
import { fmt, fmtCur, fmtDateTime, fmtPrice } from '../format';
import { api } from '../api';
import { refreshPaper } from '../socket';
import { PaperTrade } from '@fx/shared';

interface DayBucket {
  date: string; trades: number; wins: number; losses: number;
  pnl: number; fees: number; swap: number; margin: number;
}
interface DailyReport {
  currency: string;
  days: DayBucket[];
  totals: { trades: number; wins: number; losses: number; pnl: number; fees: number; swap: number };
}
interface DayReport {
  currency: string;
  date: string;
  totals: {
    trades: number; wins: number; losses: number; pnl: number; gross: number;
    fees: number; swap: number; margin: number; durationMsAvg: number;
  };
  trades: PaperTrade[];
}

/** Local YYYY-MM-DD for a timestamp — must match the backend's day buckets. */
const dayKey = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function Reports() {
  const [report, setReport] = useState<DailyReport | null>(null);
  const [day, setDay] = useState<DayReport | null>(null);
  const [cursor, setCursor] = useState(() => { const n = new Date(); return { y: n.getFullYear(), m: n.getMonth() }; });
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api<DailyReport>('/reports/daily?days=400')
      .then(setReport)
      .catch((e) => setError(e instanceof Error ? e.message : 'failed to load report'));
  }, []);

  useEffect(() => {
    if (!selected) { setDay(null); return; }
    void api<DayReport>(`/reports/day/${selected}`)
      .then(setDay)
      .catch((e) => setError(e instanceof Error ? e.message : 'failed to load day'));
  }, [selected]);

  /** Calendar grid for the cursor month: Mon-first, real month length. */
  const grid = useMemo(() => {
    const first = new Date(cursor.y, cursor.m, 1);
    const lead = (first.getDay() + 6) % 7; // Mon=0 … Sun=6
    const count = new Date(cursor.y, cursor.m + 1, 0).getDate();
    const cells: (string | null)[] = Array(lead).fill(null);
    for (let d = 1; d <= count; d++) cells.push(`${cursor.y}-${String(cursor.m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
    return cells;
  }, [cursor]);

  const byDate = useMemo(() => new Map((report?.days ?? []).map((d) => [d.date, d])), [report]);
  const monthPnl = useMemo(
    () => (report?.days ?? []).filter((d) => d.date.startsWith(`${cursor.y}-${String(cursor.m + 1).padStart(2, '0')}`)),
    [report, cursor],
  );
  const cur = report?.currency ?? 'USD';
  const money = (n: number | null | undefined, digits = 2) => fmtCur(n, cur, digits);
  const pnlTone = (n: number) => (n > 0 ? 'text-emerald-400' : n < 0 ? 'text-red-400' : 'text-slate-400');

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-slate-100">Reports — trading history by day</h1>

      {error && <div className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</div>}

      <div className="grid gap-4 lg:grid-cols-[minmax(320px,420px)_1fr]">
        <Card title="Trading calendar">
          <div className="flex items-center justify-between">
            <button onClick={() => setCursor((c) => (c.m === 0 ? { y: c.y - 1, m: 11 } : { y: c.y, m: c.m - 1 }))}
              className="rounded border border-border px-2 py-1 text-xs text-slate-300 hover:text-slate-100">‹</button>
            <div className="text-sm font-medium text-slate-200">{MONTHS[cursor.m]} {cursor.y}</div>
            <button onClick={() => setCursor((c) => (c.m === 11 ? { y: c.y + 1, m: 0 } : { y: c.y, m: c.m + 1 }))}
              className="rounded border border-border px-2 py-1 text-xs text-slate-300 hover:text-slate-100">›</button>
          </div>
          <table className="mt-3 w-full text-center text-xs">
            <thead>
              <tr>{WEEKDAYS.map((w) => <th key={w} className="pb-1 font-medium text-slate-500">{w}</th>)}</tr>
            </thead>
            <tbody>
              {[0, 1, 2, 3, 4, 5].map((row) => (
                <tr key={row}>
                  {grid.slice(row * 7, row * 7 + 7).map((key, col) => {
                    if (!key) return <td key={col} />;
                    const b = byDate.get(key);
                    const isSel = selected === key;
                    const isToday = key === dayKey(Date.now());
                    return (
                      <td key={col} className="p-0.5">
                        <button
                          onClick={() => setSelected(key)}
                          title={b ? `${b.trades} trades · ${money(b.pnl)}` : 'no closed trades'}
                          className={`h-11 w-full rounded border px-0.5 py-0.5 transition-colors ${
                            isSel ? 'border-blue-400 bg-blue-500/20'
                              : b ? (b.pnl > 0 ? 'border-emerald-500/40 bg-emerald-500/10 hover:bg-emerald-500/20'
                                : b.pnl < 0 ? 'border-red-500/40 bg-red-500/10 hover:bg-red-500/20'
                                  : 'border-border bg-panel2 hover:bg-panel2/70')
                                : 'border-transparent text-slate-600 hover:bg-panel2'}`}
                        >
                          <span className={`block text-[10px] leading-3 ${isToday ? 'font-bold text-blue-300' : 'text-slate-400'}`}>{Number(key.slice(8))}</span>
                          {b && <span className={`block text-[9px] leading-3 font-mono ${pnlTone(b.pnl)}`}>{b.pnl > 0 ? '+' : ''}{fmt(b.pnl, 0)}</span>}
                          {b && <span className="block text-[8px] leading-3 text-slate-500">{b.trades}t</span>}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-[10px] text-slate-500">
            <span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-emerald-500/60" />profit day</span>
            <span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-red-500/60" />loss day</span>
            <span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-slate-500/40" />flat day</span>
            <span>select a day for its full report →</span>
          </div>
          {monthPnl.length > 0 && (
            <div className="mt-3 rounded border border-border bg-panel2 px-3 py-2 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-slate-400">{MONTHS[cursor.m]} total</span>
                <span className={`font-mono ${pnlTone(monthPnl.reduce((s, d) => s + d.pnl, 0))}`}>
                  {money(monthPnl.reduce((s, d) => s + d.pnl, 0))}
                </span>
              </div>
              <div className="mt-0.5 flex items-center justify-between text-[10px] text-slate-500">
                <span>{monthPnl.reduce((s, d) => s + d.trades, 0)} trades · {monthPnl.reduce((s, d) => s + d.wins, 0)}W / {monthPnl.reduce((s, d) => s + d.losses, 0)}L</span>
                <span>margin used {money(monthPnl.reduce((s, d) => s + d.margin, 0))}</span>
              </div>
            </div>
          )}
        </Card>

        <div className="space-y-4">
          {selected && day ? (
            <>
              <Card title={`Day report — ${day.date} (closed-trade P&L, ${day.currency})`}>
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-7">
                  <Stat label="Trades" value={String(day.totals.trades)} />
                  <Stat label="Wins / Losses" value={`${day.totals.wins} / ${day.totals.losses}`} />
                  <Stat label={`Net P&L (${day.currency})`} value={<span className={pnlTone(day.totals.pnl)}>{money(day.totals.pnl)}</span>} />
                  <Stat label={`Margin used (${day.currency})`} value={money(day.totals.margin)} />
                  <Stat label={`Fees (${day.currency})`} value={money(day.totals.fees)} />
                  <Stat label={`Swap (${day.currency})`} value={money(day.totals.swap)} />
                  <Stat label="Avg hold" value={day.totals.durationMsAvg ? `${Math.round(day.totals.durationMsAvg / 60000)}m` : '—'} />
                </div>
                <p className="mt-2 text-[11px] text-slate-500">
                  Margin is the exposure the closed positions committed at entry (live-converted into {day.currency}, at the account's leverage).
                  P&L is net: quote P&L × the rate stored at exit − fees + swap. Values come only from real closed trades — never estimated or filled in.
                </p>
              </Card>
              <Card title={`Trades closed ${day.date} (${day.totals.trades})`}>
                {day.trades.length === 0 ? (
                  <Empty text="No trades were closed on this day." />
                ) : (
                  <Table head={['Closed at', 'Symbol', 'Dir', 'Lots', 'Entry', 'Exit', 'Reason', `P&L (${day.currency})`, 'Fees', 'Hold']}>
                    {day.trades.map((t) => (
                      <tr key={t.id}>
                        <td className="whitespace-nowrap text-xs text-slate-400">{fmtDateTime(t.closeTime)}</td>
                        <td className="font-medium text-slate-200">{t.symbol}</td>
                        <td><Badge tone={t.direction === 'BUY' ? 'up' : 'down'}>{t.direction}</Badge></td>
                        <td className="font-mono">{fmt(t.lots, 2)}</td>
                        <td className="font-mono">{fmtPrice(t.entryPrice, t.symbol)}</td>
                        <td className="font-mono">{fmtPrice(t.exitPrice, t.symbol)}</td>
                        <td className="text-xs">{t.exitReason}</td>
                        <td className={`font-mono ${pnlTone(t.pnl)}`}>{t.pnl > 0 ? '+' : ''}{money(t.pnl)}</td>
                        <td className="font-mono text-slate-500">{fmt(t.fees ?? 0, 2)}</td>
                        <td className="text-xs text-slate-400">{t.durationMs ? `${Math.round(t.durationMs / 60000)}m` : '—'}</td>
                      </tr>
                    ))}
                  </Table>
                )}
              </Card>
            </>
          ) : (
            <Card title="Day report">
              <Empty text="Select a date on the calendar to see that day's trades, net P&L, margin used and every trade's outcome." />
              {report && report.totals.trades > 0 && (
                <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
                  <Stat label={`All-time closed P&L (${cur})`} value={<span className={pnlTone(report.totals.pnl)}>{money(report.totals.pnl)}</span>} />
                  <Stat label="Closed trades" value={String(report.totals.trades)} />
                  <Stat label="Wins / Losses" value={`${report.totals.wins} / ${report.totals.losses}`} />
                  <Stat label={`Fees + swap (${cur})`} value={money(report.totals.fees + report.totals.swap)} />
                </div>
              )}
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
