import { useDispatch, useSelector } from 'react-redux';
import { useState } from 'react';
import { actions, RootState } from '../store';
import { Card, Stat, Table, DecisionBadge, RiskBadge, ModeBadge, StatusBadge, Empty } from '../components/ui';
import { fmt, fmtCur, fmtPct, fmtPrice, timeAgo } from '../format';
import { PriceFlash } from '../components/live';
import { api } from '../api';
import { refreshPaper } from '../socket';

/** Wallet top-up (paper): credits the account instantly via the backend. */
function AddBalance({ currency }: { currency?: string }) {
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const add = async () => {
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setMsg({ ok: false, text: 'Enter a positive amount.' });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      await api('/paper/add-funds', { method: 'POST', body: JSON.stringify({ amount: amt }) });
      setMsg({ ok: true, text: `Added ${fmtCur(amt, currency)} — wallet updated.` });
      setAmount('');
      void refreshPaper();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'top-up failed' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Add Balance (Paper)">
      <form onSubmit={(e) => { e.preventDefault(); void add(); }} className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-slate-400">
          Amount ({currency ?? 'USD'})
          <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal"
            placeholder="1000"
            className="w-32 rounded border border-border bg-panel2 px-2.5 py-1.5 font-mono text-sm text-slate-200 shadow-panel transition-all focus:border-blue-300 focus:outline-none focus:ring-2 focus:ring-blue-300/15" />
        </label>
        <button type="submit" disabled={busy}
          className="press rounded-md border border-emerald-500/40 bg-emerald-600/20 px-4 py-1.5 text-sm font-medium text-emerald-200 transition-colors hover:bg-emerald-600/30 disabled:opacity-50">
          {busy ? 'Adding…' : '+ Add funds'}
        </button>
        {msg && <span className={`text-xs ${msg.ok ? 'text-emerald-400' : 'text-red-400'}`}>{msg.text}</span>}
      </form>
      <p className="mt-2 text-[11px] text-slate-500">Paper money only — credited to the virtual wallet instantly; positions and trade history are untouched.</p>
    </Card>
  );
}

export function Dashboard() {
  const dispatch = useDispatch();
  const rankings = useSelector((s: RootState) => s.scanner.rankings);
  const account = useSelector((s: RootState) => s.paper.account);
  const ticks = useSelector((s: RootState) => s.market.ticks);
  const mode = useSelector((s: RootState) => s.market.mode);
  const status = useSelector((s: RootState) => s.system.status);

  const md = status?.components?.find((c) => c.name === 'Market Data');
  const mdLatency = md?.latencyMs != null ? `${fmt(md.latencyMs, 0)}ms` : '—';

  const refresh = async () => {
    const res = await api<{ rankings: typeof rankings }>('/scanner/refresh', { method: 'POST' });
    dispatch(actions.scanner.set(res.rankings));
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-slate-100">Dashboard</h1>
        <div className="flex items-center gap-2">
          <ModeBadge mode={mode} />
          <button onClick={() => void refresh()} className="rounded border border-border bg-panel2 px-3 py-1 text-xs hover:bg-border">Refresh Scanner</button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-6">
        <Stat label="Balance" value={account ? fmtCur(account.balance, account.currency) : '—'} sub={account?.currency} />
        <Stat label="Equity" value={account ? fmtCur(account.equity, account.currency) : '—'} />
        <Stat label="Free Margin" value={account ? fmtCur(account.freeMargin, account.currency) : '—'} />
        <Stat label="Unrealized P&L" value={account ? fmtCur(account.unrealizedPnl, account.currency) : '—'} />
        <Stat label="Open Positions" value={account?.openPositionCount ?? 0} />
        <Stat label="Drawdown" value={account ? fmtPct(account.maxDrawdownPct) : '—'} />
        <Stat label="Data Latency" value={mdLatency} sub="median feed→engine" />
      </div>

      <AddBalance currency={account?.currency} />

      <Card
        title="Market Scanner"
        right={
          <div className="flex items-center gap-2 text-[11px] text-slate-500">
            <StatusBadge status={status?.overall ?? 'UNKNOWN'} />
            signals allowed: {status?.signalGenerationAllowed ? 'yes' : 'no'}
          </div>
        }
      >
        {rankings.length === 0 ? (
          <Empty text="Scanner has not produced rankings yet — press Refresh or wait for the next scan cycle." />
        ) : (
          <Table head={['Asset', 'Price', 'Decision', 'Prob', 'Conf', 'Risk', 'Regime', 'EV', 'Reason', 'Updated']}>
            {rankings.map((r) => {
              const t = ticks[r.symbol];
              return (
                <tr key={r.symbol} className="cursor-pointer hover:bg-panel2" onClick={() => dispatch(actions.view.go({ view: 'market', symbol: r.symbol }))}>
                  <td className="font-medium text-slate-200">{r.symbol}</td>
                  <td className="font-mono">
                    {t ? <PriceFlash value={t.mid}>{fmtPrice(t.mid, r.symbol)}</PriceFlash> : '—'}
                  </td>
                  <td><DecisionBadge d={r.decision} /></td>
                  <td className="font-mono">{fmt(r.probability * 100, 1)}%</td>
                  <td className="font-mono">{fmt(r.confidence * 100, 0)}%</td>
                  <td><RiskBadge level={r.riskLevel} /></td>
                  <td className="text-xs">{r.regime}</td>
                  <td className={`font-mono ${r.expectedValue >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{fmt(r.expectedValue, 2)}</td>
                  <td className="max-w-[260px] truncate text-xs text-slate-500">{r.reason}</td>
                  <td className="text-xs text-slate-500">{timeAgo(r.updatedAt)}</td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>
    </div>
  );
}
