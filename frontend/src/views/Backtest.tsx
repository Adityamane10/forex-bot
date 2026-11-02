import { useEffect, useState } from 'react';
import { Card, Table, Stat, Badge, Empty, Spinner } from '../components/ui';
import { fmt, fmtPct } from '../format';
import { api } from '../api';
import { BacktestResult } from '@fx/shared';
import { LineChart, Line, ResponsiveContainer, XAxis, YAxis, Tooltip, CartesianGrid, ReferenceLine } from 'recharts';

export function Backtest() {
  const [backtests, setBacktests] = useState<BacktestResult[]>([]);
  const [running, setRunning] = useState(false);
  const [form, setForm] = useState({
    startDays: 90, endDays: 0, startingCapital: 10000, riskPercent: 1, minRr: 1.5, maxOpenPositions: 3,
  });

  const refresh = async () => {
    const r = await api<{ backtests: BacktestResult[] }>('/backtests');
    setBacktests(r.backtests);
  };
  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 5000);
    return () => clearInterval(id);
  }, []);

  const run = async () => {
    setRunning(true);
    const end = Date.now();
    const start = end - form.startDays * 86400_000;
    try {
      await api('/backtests', {
        method: 'POST',
        body: JSON.stringify({
          symbols: ['EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'USD/CAD', 'NZD/USD', 'EUR/GBP', 'EUR/JPY', 'GBP/JPY', 'USD/CHF'],
          timeframes: ['1h'],
          start, end,
          startingCapital: form.startingCapital,
          riskPercent: form.riskPercent,
          minRr: form.minRr,
          minConfidence: 0.55,
          maxOpenPositions: form.maxOpenPositions,
          commissionPerLot: 7,
          slippagePips: 0.2,
          spreadMultiplier: 1,
          useMl: false,
          includeNews: false,
          includeEvents: false,
        }),
      });
      setTimeout(() => void refresh(), 2000);
    } finally {
      setTimeout(() => setRunning(false), 2000);
    }
  };

  const latest = backtests.find((b) => b.status === 'COMPLETED') ?? backtests[0];

  // Equity curve framing: the opening balance is the line that matters, so it is
  // drawn as a datum and the curve is coloured by which side of it it ends on.
  const curve = latest?.equityCurve ?? [];
  const equityAt = (i: number) => Number((curve[i] as { equity?: number } | undefined)?.equity);
  const openingEquity = curve.length > 0 ? equityAt(0) : NaN;
  const closingEquity = curve.length > 0 ? equityAt(curve.length - 1) : NaN;
  const curveColor =
    Number.isFinite(openingEquity) && Number.isFinite(closingEquity) && closingEquity < openingEquity
      ? '#FF6B5E'
      : '#34D6A0';

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-slate-100">Backtesting</h1>
      <p className="text-xs text-slate-500">
        Replays the full signal pipeline over real historical candles with spread, slippage, commission and swap.
        In DEMO mode history is simulated — results are flagged accordingly. Past performance is not a claim about the future.
      </p>

      <Card title="Run Backtest">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
          {([
            ['startDays', 'History (days)'],
            ['startingCapital', 'Capital ($)'],
            ['riskPercent', 'Risk %'],
            ['minRr', 'Min R:R'],
            ['maxOpenPositions', 'Max positions'],
          ] as const).map(([key, label]) => (
            <label key={key} className="block">
              <span className="eyebrow">{label}</span>
              <input
                type="number"
                value={form[key]}
                onChange={(e) => setForm({ ...form, [key]: Number(e.target.value) })}
                className="mt-1 w-full rounded border border-border bg-panel2 px-2 py-1.5 font-mono text-sm text-slate-100 transition-colors hover:border-hairline focus:border-blue-400 focus:outline-none"
              />
            </label>
          ))}
          <div className="flex items-end">
            <button onClick={() => void run()} disabled={running} className="rounded bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50">
              {running ? 'Running…' : 'Run'}
            </button>
          </div>
        </div>
      </Card>

      {backtests.length === 0 && <Card><Empty text="No backtests yet." /></Card>}
      {latest?.status === 'RUNNING' && <Card><Spinner /></Card>}

      {latest?.dataNote && (
        <div className="rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          ⚠ {latest.dataNote}
        </div>
      )}

      {latest?.metrics && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-8">
            <Stat label="Total return" value={fmtPct(latest.metrics.totalReturnPct)} />
            <Stat label="Win rate" value={fmtPct(latest.metrics.winRate * 100, 1)} />
            <Stat label="Profit factor" value={fmt(latest.metrics.profitFactor, 2)} />
            <Stat label="Expectancy" value={fmt(latest.metrics.expectancy, 2)} sub="per trade" />
            <Stat label="Sharpe" value={fmt(latest.metrics.sharpe, 2)} />
            <Stat label="Sortino" value={fmt(latest.metrics.sortino, 2)} />
            <Stat label="Max DD" value={fmtPct(latest.metrics.maxDrawdownPct)} />
            <Stat label="Trades" value={latest.metrics.tradeCount} />
          </div>

          <Card title="Equity Curve">
            {latest.equityCurve && latest.equityCurve.length > 1 ? (
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={latest.equityCurve} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid vertical={false} stroke="#1F1E1A" />
                  <XAxis
                    dataKey="time"
                    tickFormatter={(t: number) => new Date(t).toLocaleDateString('en-GB', { month: 'short', day: 'numeric' })}
                    axisLine={{ stroke: '#262521' }}
                    tickLine={false}
                    tick={{ fill: '#74716A', fontSize: 10 }}
                    minTickGap={28}
                  />
                  <YAxis
                    domain={['auto', 'auto']}
                    axisLine={false}
                    tickLine={false}
                    tick={{ fill: '#74716A', fontSize: 10 }}
                    width={64}
                  />
                  {Number.isFinite(openingEquity) && (
                    <ReferenceLine y={openingEquity} stroke="#3A3934" strokeDasharray="3 3" />
                  )}
                  <Tooltip
                    contentStyle={{
                      background: '#171716',
                      border: '1px solid #33322C',
                      borderRadius: 6,
                      fontSize: 11,
                      boxShadow: 'none',
                    }}
                    labelStyle={{ color: '#96938A', fontSize: 10 }}
                    itemStyle={{ color: '#F1EFE9' }}
                    cursor={{ stroke: 'rgba(213,209,196,0.28)', strokeDasharray: '2 3' }}
                    labelFormatter={(t) => new Date(Number(t)).toLocaleString('en-GB')}
                    formatter={(v: number) => [fmt(v, 2), 'equity']}
                  />
                  <Line
                    type="monotone"
                    dataKey="equity"
                    stroke={curveColor}
                    dot={false}
                    strokeWidth={1.75}
                    activeDot={{ r: 3, fill: curveColor, stroke: '#0A0A09', strokeWidth: 2 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <Empty text="No equity curve." />
            )}
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="By Pair">
              <Table head={['Pair', 'Trades', 'Win rate', 'P&L']}>
                {Object.entries(latest.metrics.byPair).map(([k, v]) => (
                  <tr key={k}>
                    <td className="text-slate-200">{k}</td>
                    <td>{v.trades}</td>
                    <td className="font-mono">{fmt(v.winRate * 100, 0)}%</td>
                    <td className={`font-mono ${v.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{fmt(v.pnl, 2)}</td>
                  </tr>
                ))}
              </Table>
            </Card>
            <Card title="By Session / Regime">
              <Table head={['Key', 'Trades', 'Win rate', 'P&L']}>
                {[...Object.entries(latest.metrics.bySession), ...Object.entries(latest.metrics.byRegime)].map(([k, v]) => (
                  <tr key={k}>
                    <td className="text-slate-200">{k}</td>
                    <td>{v.trades}</td>
                    <td className="font-mono">{fmt(v.winRate * 100, 0)}%</td>
                    <td className={`font-mono ${v.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{fmt(v.pnl, 2)}</td>
                  </tr>
                ))}
              </Table>
            </Card>
          </div>
        </>
      )}

      <Card title="Recent Backtests">
        <Table head={['ID', 'Status', 'Symbols', 'Trades', 'Return', 'Created']}>
          {backtests.slice(0, 10).map((b) => (
            <tr key={b.backtestId}>
              <td className="font-mono text-xs">{b.backtestId.slice(0, 8)}</td>
              <td><Badge tone={b.status === 'COMPLETED' ? 'up' : b.status === 'FAILED' ? 'red' : 'warn'}>{b.status}</Badge></td>
              <td className="text-xs">{b.config.symbols.length} pairs</td>
              <td>{b.metrics?.tradeCount ?? '—'}</td>
              <td className={`font-mono ${(b.metrics?.totalReturnPct ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{b.metrics ? fmtPct(b.metrics.totalReturnPct) : '—'}</td>
              <td className="text-xs text-slate-500">{new Date(b.createdAt).toLocaleString('en-GB', { hour12: false })}</td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}
