import { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { actions, RootState } from '../store';
import { Card, Table, Badge, DecisionBadge, RiskBadge, Empty } from '../components/ui';
import { fmt, fmtCur, fmtPrice, fmtDateTime, timeAgo, curSymbol } from '../format';
import { api } from '../api';
import { refreshSignals } from '../socket';
import { friendlyExecutionError, RiskLockoutBanner } from '../components/risk';
import { ALL_SYMBOLS, GoalAnalysis, OpportunityRanking, Signal, SignalSnapshot, UserSettings } from '@fx/shared';

export function Signals() {
  const dispatch = useDispatch();
  const active = useSelector((s: RootState) => s.signals.active);
  const history = useSelector((s: RootState) => s.signals.history);
  const settings = useSelector((s: RootState) => s.settings.settings);
  const selectedId = useSelector((s: RootState) => s.view.signalId);
  // Live market state: prices move on every tick, positions on every paper update.
  const ticks = useSelector((s: RootState) => s.market.ticks);
  const positions = useSelector((s: RootState) => s.paper.positions);
  const account = useSelector((s: RootState) => s.paper.account);
  // Scanner rankings carry the honest per-symbol reason the engine is WAITing
  // (score below threshold, ML conflict, asset not selected, …).
  const rankings = useSelector((s: RootState) => s.scanner.rankings);
  // Goal mode: the live per-symbol market search — which asset can cover the
  // set profit goal right now, and the exact plan (entry/SL/TP/lots) to do it.
  const goalAnalyses = useSelector((s: RootState) => s.scanner.goalAnalyses);
  const [detail, setDetail] = useState<{ signal: Signal; snapshot: SignalSnapshot | null } | null>(null);
  // One goal surface: the goal card below is the ONLY place goal settings are
  // edited (the Settings page no longer duplicates them).
  const mode = 'goal' as const;
  const [goal, setGoal] = useState<{ availableCapital: number; minimumProfit: number; maxMarginUsedPct: number; maxRiskPercent: number; goalMaxTrades: number | null; minimumInvestment: number; maximumPositionSize: number; lotMode: 'auto' | 'manual'; manualLot: number } | null>(null);
  const [goalSaved, setGoalSaved] = useState(false);
  const [executing, setExecuting] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!settings) return;
    setGoal({
      availableCapital: settings.availableCapital,
      minimumProfit: settings.minimumProfit,
      maxMarginUsedPct: settings.maxMarginUsedPct,
      maxRiskPercent: settings.maxRiskPercent,
      goalMaxTrades: settings.goalMaxTrades ?? null,
      minimumInvestment: settings.minimumInvestment ?? 0,
      maximumPositionSize: settings.maximumPositionSize ?? 0,
      lotMode: settings.lotMode ?? 'auto',
      manualLot: settings.manualLot ?? 0.1,
    });
  }, [settings]);

  useEffect(() => {
    if (!selectedId) return;
    void api<{ signal: Signal; snapshot: SignalSnapshot | null }>(`/signals/${selectedId}`).then((d) => setDetail(d)).catch(() => undefined);
  }, [selectedId, active]);

  const setAutoTrade = async (on: boolean) => {
    try {
      await api('/settings', { method: 'PUT', body: JSON.stringify({ autoTradeEnabled: on }) });
      if (settings) dispatch(actions.settings.set({ ...settings, autoTradeEnabled: on }));
      setNotice(on ? 'Automatic trading ON — matched signals open positions automatically.' : 'Automatic trading OFF — trade signals manually with the Trade button.');
    } catch {
      setNotice('Failed to update automatic trading.');
    }
  };

  /** Symbol lock (XM/MT5 pattern): pick one symbol → signals are scanned for
   *  it ONLY and every trade (auto/manual, paper/MT5 demo/real) stays within
   *  it. '' clears the lock. Applied realtime on the backend. */
  const setSymbolLock = async (sym: string) => {
    const value = sym || null;
    try {
      await api('/settings', { method: 'PUT', body: JSON.stringify({ symbolLock: value }) });
      if (settings) dispatch(actions.settings.set({ ...settings, symbolLock: value }));
      setNotice(value
        ? `Locked to ${value.toUpperCase()} — signals and trading now happen for this symbol only (dashboard, MT5 demo and real account).`
        : 'Symbol lock cleared — all watchlist symbols trade again.');
    } catch {
      setNotice('Failed to update the symbol lock.');
    }
  };

  // signalMode stays 'goal' for the scanner's goal hunt — the single goal
  // surface below is authoritative; no universal-settings mode exists anymore.

  const saveGoal = async () => {
    if (!goal) return;
    const safe = {
      ...goal,
      maxMarginUsedPct: Math.min(100, Math.max(0, goal.maxMarginUsedPct)),
      maxRiskPercent: Math.min(100, Math.max(0.01, goal.maxRiskPercent)),
      minimumInvestment: Math.max(0, goal.minimumInvestment ?? 0),
      maximumPositionSize: Math.max(0, goal.maximumPositionSize ?? 0),
      lotMode: (goal.lotMode === 'manual' ? 'manual' : 'auto') as 'auto' | 'manual',
      manualLot: Math.max(0, goal.manualLot ?? 0.1),
    };
    setGoal(safe);
    try {
      await api('/settings', { method: 'PUT', body: JSON.stringify(safe) });
      if (settings) dispatch(actions.settings.set({ ...settings, ...safe }));
      setGoalSaved(true);
      setNotice('Goal saved — every asset is re-evaluated against the new goal right now.');
      setTimeout(() => setGoalSaved(false), 2500);
    } catch {
      setNotice('Failed to save goal settings.');
    }
  };

  const executeSignal = async (id: string) => {
    if (executing) return;
    setExecuting(id);
    setNotice(null);
    try {
      const res = await api<{ ok: boolean }>(`/signals/${id}/execute`, { method: 'POST' });
      setNotice(res.ok ? 'Position opened — the engine monitors it and auto-closes at the profit target.' : 'Execution failed.');
      void refreshSignals();
    } catch (err: any) {
      const raw = String(err?.error || err?.message || 'Execution blocked by the risk engine.');
      const f = friendlyExecutionError(raw);
      // A dead signal must not linger as a clickable card: drop it from the
      // list the moment the backend says it is gone.
      if (f.staleSignal) void refreshSignals();
      setNotice(`No trade — ${f.title}${f.hint ? `: ${f.hint}` : '.'}`);
    } finally {
      setExecuting(null);
    }
  };

  if (selectedId && detail) {
    return <SignalDetail
      signal={detail.signal}
      snapshot={detail.snapshot}
      executing={executing}
      notice={notice}
      onBack={() => dispatch(actions.view.go({ view: 'signals', signalId: null }))}
      onTrade={() => void executeSignal(detail.signal.id)}
    />;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold text-slate-100">Signals</h1>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 rounded border border-border bg-panel2 px-2 py-1">
            <span className="text-[10px] uppercase tracking-wide text-slate-500">🔒 Trade only</span>
            <select
              value={settings?.symbolLock ?? ''}
              onChange={(e) => void setSymbolLock(e.target.value)}
              className="bg-transparent text-xs font-medium text-slate-200 outline-none"
              title="Lock signals AND auto-trading to this symbol only — on the dashboard, the MT5 demo account and a real XM account"
            >
              <option value="">All symbols</option>
              {ALL_SYMBOLS.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <button
            onClick={() => void setAutoTrade(!(settings?.autoTradeEnabled ?? false))}
            className={`rounded px-3 py-1.5 text-xs font-medium border ${settings?.autoTradeEnabled ? 'border-emerald-500/60 bg-emerald-500/10 text-emerald-300' : 'border-border bg-panel2 text-slate-400'}`}
          >
            {settings?.autoTradeEnabled ? '⚡ Auto-trade ON' : 'Auto-trade OFF'}
          </button>
        </div>
      </div>

      {/* The fill-gate's state, visible before any Trade click (§34). */}
      <RiskLockoutBanner />

      <Card title="Goal Trading — define your own target (saved until you change it)">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <label className="block">
              <span className="text-[11px] uppercase text-slate-500">Amount to use ({curSymbol(account?.currency)})</span>
              <input type="number" value={goal?.availableCapital ?? 0} min={100}
                onChange={(e) => setGoal((g) => ({ ...(g as NonNullable<typeof goal>), availableCapital: Number(e.target.value) }))}
                className="mt-1 w-full rounded border border-border bg-panel2 px-2 py-1 font-mono text-sm" />
            </label>
            <label className="block">
              <span className="text-[11px] uppercase text-slate-500">Minimum profit ({curSymbol(account?.currency)})</span>
              <input type="number" value={goal?.minimumProfit ?? 0} min={0}
                onChange={(e) => setGoal((g) => ({ ...(g as NonNullable<typeof goal>), minimumProfit: Number(e.target.value) }))}
                className="mt-1 w-full rounded border border-border bg-panel2 px-2 py-1 font-mono text-sm" />
            </label>
            <label className="block">
              <span className="text-[11px] uppercase text-slate-500">Max margin used / trade (%)</span>
              <input type="number" value={goal?.maxMarginUsedPct ?? 0} min={0} max={100}
                onChange={(e) => setGoal((g) => ({ ...(g as NonNullable<typeof goal>), maxMarginUsedPct: Number(e.target.value) }))}
                className="mt-1 w-full rounded border border-border bg-panel2 px-2 py-1 font-mono text-sm" />
            </label>
            <label className="block">
              <span className="text-[11px] uppercase text-slate-500">Risk per trade (%)</span>
              <input type="number" value={goal?.maxRiskPercent ?? 0} min={0.01} max={100} step={0.1}
                onChange={(e) => setGoal((g) => ({ ...(g as NonNullable<typeof goal>), maxRiskPercent: Number(e.target.value) }))}
                className="mt-1 w-full rounded border border-border bg-panel2 px-2 py-1 font-mono text-sm" />
            </label>
            <label className="block">
              <span className="text-[11px] uppercase text-slate-500">Max trades (goal session)</span>
              <input type="number" value={goal?.goalMaxTrades ?? ''} min={1} placeholder="∞"
                onChange={(e) => setGoal((g) => ({ ...(g as NonNullable<typeof goal>), goalMaxTrades: e.target.value === '' ? null : Number(e.target.value) }))}
                className="mt-1 w-full rounded border border-border bg-panel2 px-2 py-1 font-mono text-sm" />
            </label>
            <label className="block">
              <span className="text-[11px] uppercase text-slate-500">Min investment ({curSymbol(account?.currency)})</span>
              <input type="number" value={goal?.minimumInvestment ?? 0} min={0}
                onChange={(e) => setGoal((g) => ({ ...(g as NonNullable<typeof goal>), minimumInvestment: Number(e.target.value) }))}
                className="mt-1 w-full rounded border border-border bg-panel2 px-2 py-1 font-mono text-sm" />
            </label>
            <label className="block">
              <span className="text-[11px] uppercase text-slate-500">Max position size ({curSymbol(account?.currency)})</span>
              <input type="number" value={goal?.maximumPositionSize ?? 0} min={0}
                onChange={(e) => setGoal((g) => ({ ...(g as NonNullable<typeof goal>), maximumPositionSize: Number(e.target.value) }))}
                className="mt-1 w-full rounded border border-border bg-panel2 px-2 py-1 font-mono text-sm" />
            </label>
            <label className="block">
              <span className="text-[11px] uppercase text-slate-500">Lot mode</span>
              <select value={goal?.lotMode ?? 'auto'}
                onChange={(e) => setGoal((g) => ({ ...(g as NonNullable<typeof goal>), lotMode: e.target.value as 'auto' | 'manual' }))}
                className="mt-1 w-full rounded border border-border bg-panel2 px-2 py-1 text-sm">
                <option value="auto">Auto (engine sizes safely)</option>
                <option value="manual">Manual (my exact lot)</option>
              </select>
            </label>
            <label className="block">
              <span className="text-[11px] uppercase text-slate-500">Lot size (manual mode)</span>
              <input type="number" value={goal?.manualLot ?? 0.1} min={0.01} step={0.01} disabled={(goal?.lotMode ?? 'auto') === 'auto'}
                onChange={(e) => setGoal((g) => ({ ...(g as NonNullable<typeof goal>), manualLot: Number(e.target.value) }))}
                className="mt-1 w-full rounded border border-border bg-panel2 px-2 py-1 font-mono text-sm disabled:opacity-40" />
            </label>
            <div className="flex items-end">
              <button onClick={() => void saveGoal()} disabled={!goal}
                className="rounded bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50">
                {goalSaved ? 'Saved ✓' : 'Save goal'}
              </button>
            </div>
          </div>

          {/* Instrument choice lives ONLY in the 'Trade only' dropdown in the
              header (symbolLock): one symbol = signals + trades happen for it
              only; 'All symbols' scans everything. */}
          {notice && <p className="mt-2 text-xs text-slate-400">{notice}</p>}
          <p className="mt-2 text-[11px] text-slate-500">
            Signals are evaluated against THIS goal in real time: the engine sizes every setup so the position can
            actually make your minimum profit within the risk and margin limits — and only shows a signal when it can.
            The goal stays active until you change it. Use the Auto-trade switch to execute matched signals
            automatically, or the Trade button on each signal for manual trading.
            Investment filters: a sized position whose value is below Min investment (or above Max position size, when set) is rejected with NO SUITABLE OPPORTUNITY — 0 disables a filter.
          </p>
        </Card>

      {mode === 'goal' && (
        <Card title={`Goal market search — hunting ${curSymbol(account?.currency)}${goal?.minimumProfit ?? 0} profit on any symbol (${goalAnalyses.length})`}>
          {goalAnalyses.length === 0 ? (
            <Empty text="Searching every market for a setup that can cover your goal… live prices are being analyzed right now." />
          ) : (
            <Table head={['Symbol', 'Price', 'Dir', 'Entry', 'SL', 'TP', 'R:R', 'Lots', `Est. profit (${curSymbol(account?.currency)})`, `Risk (${curSymbol(account?.currency)})`, 'Margin', 'Lev', 'Status', '']}>
              {goalAnalyses.map((g) => {
                const live = ticks[g.symbol];
                const hasPos = g.signalId ? positions.some((p) => p.signalId === g.signalId && p.status === 'OPEN') : false;
                const dirOk = !!g.direction;
                return (
                  <tr key={g.symbol} className={g.achievable ? '' : 'opacity-70'}>
                    <td className="font-medium text-slate-200">{g.symbol}</td>
                    <td className="font-mono">{live ? fmtPrice(live.mid, g.symbol) : fmtPrice(g.entry, g.symbol)}</td>
                    <td>{dirOk ? <Badge tone={g.direction === 'BUY' ? 'up' : 'down'}>{g.direction}</Badge> : <Badge tone="muted">—</Badge>}</td>
                    <td className="font-mono">{fmtPrice(g.entry, g.symbol)}</td>
                    <td className="font-mono text-red-400">{fmtPrice(g.stopLoss, g.symbol)}</td>
                    <td className="font-mono text-emerald-400">{fmtPrice(g.takeProfit, g.symbol)}</td>
                    <td className="font-mono">{fmt(g.rr, 2)}</td>
                    <td className="font-mono">{g.lots > 0 ? fmt(g.lots, 2) : '—'}</td>
                    <td className="font-mono text-emerald-400">{g.expectedProfit > 0 ? fmtCur(g.expectedProfit, account?.currency) : '—'}</td>
                    <td className="font-mono">{g.riskAmount > 0 ? `${fmt(g.riskPctRequired, 1)}%` : '—'}</td>
                    <td className="font-mono">{g.marginPct > 0 ? `${fmt(g.marginPct, 0)}%` : '—'}</td>
                    <td className="font-mono">{g.leverageUsed > 0 ? fmt(g.leverageUsed, 0) : '—'}</td>
                    <td className="max-w-[20rem] text-xs">
                      {g.achievable ? <span className="text-emerald-400">GOAL REACHABLE</span>
                        : <span className="text-slate-500">{g.reason}</span>}
                      {g.aiGate === 'BLOCKED' && (
                        <div className="mt-1 text-[11px] font-medium text-red-400" title={g.aiReason ?? ''}>AI: {g.aiReason ?? 'blocked — NO TRADE'}</div>
                      )}
                      {g.aiGate === 'PASS' && g.aiConfidence != null && (
                        <div className="mt-1 text-[11px] text-slate-500">AI {Math.round((g.aiConfidence ?? 0) * 100)}% · {g.aiModelVersion}</div>
                      )}
                    </td>
                    <td>
                      <button
                        disabled={!g.achievable || !g.signalId || hasPos || executing === g.signalId}
                        onClick={() => g.signalId && void executeSignal(g.signalId)}
                        className="rounded border border-emerald-500/50 px-2 py-1 text-xs font-medium text-emerald-300 hover:bg-emerald-500/10 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {executing === g.signalId ? 'Opening…' : hasPos ? 'Traded' : 'Trade'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </Table>
          )}
          <p className="mt-2 text-[11px] text-slate-500">
            Real live prices, every scan. The engine checks every symbol: direction from the live technical consensus,
            SL/TP from current structure, and sizes the trade so the TP move alone covers your goal — then honestly reports
            the risk %, margin % and leverage it would use. When a symbol is marked GOAL REACHABLE the trade is sized to
            cover the goal and stays within all your caps; everything else shows exactly why not.
          </p>
        </Card>
      )}

      <Card title={`Active Signals (${active.length})`}>
        {active.length === 0 ? (
          <Empty text="No active signals. The scanner evaluates every asset continuously; a signal appears only when the full pipeline passes." />
        ) : (
          <Table head={['Symbol', 'Price', 'Dir', 'State', 'Entry', 'SL', 'TP1', 'R:R', 'Prob', 'P&L', 'Risk', 'Regime', 'Updated', '']}>
            {active.map((s) => {
              const live = ticks[s.symbol];
              const pos = positions.find((p) => p.signalId === s.id && p.status === 'OPEN');
              const executable = !pos && ['CANDIDATE', 'ANALYZING', 'QUALIFIED', 'SIGNAL_CREATED', 'WAITING_FOR_ENTRY', 'ENTRY_REACHED'].includes(s.state);
              return (
                <tr key={s.id} className="cursor-pointer hover:bg-panel2" onClick={() => dispatch(actions.view.go({ view: 'signals', signalId: s.id }))}>
                  <td className="font-medium text-slate-200">{s.symbol}</td>
                  <td className="font-mono">{live ? fmtPrice(live.mid, s.symbol) : '—'}</td>
                  <td><Badge tone={s.direction === 'BUY' ? 'up' : 'down'}>{s.direction}</Badge></td>
                  <td><Badge tone={pos ? 'up' : s.state === 'ENTRY_REACHED' || s.state === 'POSITION_ACTIVE' ? 'up' : 'info'}>{pos ? 'ACTIVE' : s.state}</Badge>
                    {pos && <span className="ml-1 text-[10px] text-slate-500">position {pos.direction} {pos.lots}L</span>}
                  </td>
                  <td className="font-mono">{fmtPrice(s.entry.preferredEntry, s.symbol)}</td>
                  <td className="font-mono text-red-400">{fmtPrice(s.stopLoss.price, s.symbol)}</td>
                  <td className="font-mono text-emerald-400">{fmtPrice(s.takeProfit.tp1, s.symbol)}</td>
                  <td className="font-mono">{fmt(s.rr, 2)}</td>
                  <td className="font-mono">{fmt(s.probability * 100, 1)}%</td>
                  <td className={`font-mono ${pos ? (pos.unrealizedPnl >= 0 ? 'text-emerald-400' : 'text-red-400') : 'text-slate-500'}`}>{pos ? fmtCur(pos.unrealizedPnl, account?.currency) : '—'}</td>
                  <td><RiskBadge level={s.risk.level} /></td>
                  <td className="text-xs">{s.regime.regime}</td>
                  <td className="text-xs text-slate-500">{timeAgo(s.updatedAt)}</td>
                  <td>
                    <button
                      disabled={!executable || executing === s.id}
                      onClick={(e) => { e.stopPropagation(); void executeSignal(s.id); }}
                      className="rounded border border-emerald-500/50 px-2 py-1 text-xs font-medium text-emerald-300 hover:bg-emerald-500/10 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {executing === s.id ? 'Opening…' : pos ? 'Traded' : 'Trade'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>

      <Card title="Signal History">
        {history.length === 0 ? (
          <Empty text="No recorded signal history yet." />
        ) : (
          <Table head={['Symbol', 'Dir', 'State', 'Entry', 'Prob', 'Model', 'Mode', 'Updated']}>
            {history.slice(0, 50).map((s) => (
              <tr key={s.id}>
                <td className="text-slate-200">{s.symbol}</td>
                <td><DecisionBadge d={s.decision} /></td>
                <td><Badge tone="muted">{s.state}</Badge></td>
                <td className="font-mono">{fmtPrice(s.entry?.preferredEntry, s.symbol)}</td>
                <td className="font-mono">{fmt(s.probability * 100, 1)}%</td>
                <td className="text-xs font-mono">{s.modelVersion}</td>
                <td className="text-xs">{s.mode}</td>
                <td className="text-xs text-slate-500">{fmtDateTime(s.updatedAt)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card title={`Market Scan — why no signal fires (${rankings.length})`}>
        {rankings.length === 0 ? (
          <Empty text="No scanner data yet — the engine evaluates every asset continuously." />
        ) : (
          <Table head={['Symbol', 'Decision', 'ML prob', 'Score', 'Risk', 'Regime', 'Reason', 'Updated']}>
            {rankings.map((r: OpportunityRanking) => (
              <tr key={r.symbol}>
                <td className="font-medium text-slate-200">{r.symbol}</td>
                <td><DecisionBadge d={r.decision} /></td>
                <td className="font-mono">{fmt(r.probability * 100, 1)}%</td>
                <td className="font-mono">{fmt(r.score, 0)}</td>
                <td><RiskBadge level={r.riskLevel} /></td>
                <td className="text-xs">{r.regime}</td>
                <td className="max-w-[26rem] text-xs text-slate-400">{r.reason}</td>
                <td className="text-xs text-slate-500">{timeAgo(r.updatedAt)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

function SignalDetail({ signal, snapshot, executing, notice, onBack, onTrade }: {
  signal: Signal;
  snapshot: SignalSnapshot | null;
  executing: string | null;
  notice?: string | null;
  onBack: () => void;
  onTrade: () => void;
}) {
  return (
    <div className="space-y-4">
      {/* Fill-gate state + the last refusal, right where the Trade button is. */}
      <RiskLockoutBanner />
      {notice && (
        <p role="status" className="animate-slide-up rounded-md border border-border bg-panel px-3.5 py-2.5 text-[12px] leading-relaxed text-slate-300">
          {notice}
        </p>
      )}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="rounded border border-border px-2 py-1 text-xs hover:bg-panel2">← Back</button>
          <h1 className="text-lg font-semibold text-slate-100">{signal.symbol} <Badge tone={signal.direction === 'BUY' ? 'up' : 'down'}>{signal.direction}</Badge></h1>
          <Badge tone="muted">{signal.state}</Badge>
          <RiskBadge level={signal.risk.level} />
        </div>
        <div className="flex items-center gap-2">
          <div className="text-xs text-slate-500">model {signal.modelVersion} · {signal.mode}</div>
          {['CANDIDATE', 'ANALYZING', 'QUALIFIED', 'SIGNAL_CREATED', 'WAITING_FOR_ENTRY', 'ENTRY_REACHED'].includes(signal.state) && (
            <button
              onClick={() => { void api(`/signals/${signal.id}/cancel`, { method: 'POST' }).then(onBack).catch(() => undefined); }}
              className="rounded border border-red-500/40 px-2 py-1 text-xs text-red-300 hover:bg-red-500/10"
            >
              Cancel signal
            </button>
          )}
          {['CANDIDATE', 'ANALYZING', 'QUALIFIED', 'SIGNAL_CREATED', 'WAITING_FOR_ENTRY', 'ENTRY_REACHED'].includes(signal.state) && (
            <button
              onClick={onTrade}
              disabled={executing !== null}
              className="rounded bg-emerald-600 px-3 py-1 text-xs font-semibold text-slate-950 transition-colors hover:bg-emerald-500 disabled:opacity-50"
            >
              {executing === signal.id ? 'Opening…' : 'Trade this signal'}
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-6">
        {[
          ['Entry', fmtPrice(signal.entry.preferredEntry, signal.symbol)],
          ['SL', fmtPrice(signal.stopLoss.price, signal.symbol)],
          ['TP1', fmtPrice(signal.takeProfit.tp1, signal.symbol)],
          ['TP2', signal.takeProfit.tp2 ? fmtPrice(signal.takeProfit.tp2, signal.symbol) : '—'],
          ['R:R', fmt(signal.rr, 2)],
          ['Probability', fmt(signal.probability * 100, 1) + '%'],
          ['Confidence', fmt(signal.confidence * 100, 0) + '%'],
          ['EV / trade', fmt(signal.expectedValue.evPerTrade, 2)],
          ['Regime', signal.regime.regime],
          ['Data quality', snapshot ? fmt(snapshot.dataQualityScore * 100, 0) + '%' : '—'],
          ['Risk score', fmt(signal.risk.score, 0)],
          ['Created', fmtDateTime(signal.timestamp)],
        ].map(([k, v]) => <div key={k} className="rounded border border-border bg-panel2 px-3 py-2"><div className="text-[10px] uppercase text-slate-500">{k}</div><div className="font-mono text-sm">{v}</div></div>)}
      </div>

      {snapshot?.componentScores ? (
        <Card title="Component Scores (spec §12)">
          <div className="grid grid-cols-3 gap-2 md:grid-cols-6">
            {Object.entries(snapshot.componentScores).map(([k, v]) => (
              <div key={k} className="rounded border border-border bg-panel2 px-2 py-1 text-center">
                <div className="text-[10px] uppercase text-slate-500">{k}</div>
                <div className={`font-mono text-sm ${v >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{fmt(v, 1)}</div>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        {([
          ['Technical evidence', signal.evidence.technical],
          ['Multi-timeframe', signal.evidence.multiTimeframe],
          ['Price action', signal.evidence.priceAction],
          ['Historical evidence', signal.evidence.historical],
          ['ML evidence', signal.evidence.ml],
          ['News evidence', signal.evidence.news],
          ['Risk evidence', signal.evidence.risk],
          ['Opposing evidence', signal.evidence.opposing],
        ] as Array<[string, string[]]>).map(([title, items]) => (
          <Card key={title} title={title}>
            {items.length === 0 ? <div className="text-xs text-slate-500">none</div> : (
              <ul className="space-y-1 text-xs text-slate-400">
                {items.map((it, i) => <li key={i}>• {it}</li>)}
              </ul>
            )}
          </Card>
        ))}
      </div>

      <Card title="Signal Lifecycle">
        <div className="space-y-1">
          {signal.events.map((e, i) => (
            <div key={i} className="flex items-center gap-3 text-xs">
              <span className="font-mono text-slate-500">{fmtDateTime(e.timestamp)}</span>
              <Badge tone="info">{e.state}</Badge>
              <span className="text-slate-500">{e.note}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
