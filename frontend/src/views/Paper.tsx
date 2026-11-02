import { FormEvent, useCallback, useEffect, useState } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../store';
import { Card, Table, Stat, Badge, Empty } from '../components/ui';
import { fmt, fmtCur, curSymbol, fmtPrice, fmtDateTime, timeAgo } from '../format';
import { toast, PriceFlash } from '../components/live';

const cls = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(' ');
import { api, Mt5Api } from '../api';
import { refreshPaper } from '../socket';
import { ALL_SYMBOLS, PaperAccount, PaperPosition } from '@fx/shared';

interface RiskSnapshot {
  account: PaperAccount & { consecutiveLosses?: number; dailyPnl?: number };
  settings: { maxConsecutiveLosses?: number; maxDailyLossPercent?: number };
}



/** Human wording for the fill-gate refusals. The raw reasons are internal
 *  identifiers; a person clicking Trade should never have to decode them. */
function friendlyOpenError(raw: string): { title: string; hint?: string } {
  if (raw.includes('MAX_CONSECUTIVE_LOSSES')) {
    return {
      title: 'Risk lockout: too many losses in a row',
      hint: 'The engine blocks new entries after repeated losing trades. Review your closed trades below, then use “Reset risk counters” to re-arm.',
    };
  }
  if (raw.includes('MAX_DAILY_LOSS')) {
    return { title: 'Daily loss limit reached', hint: 'New entries unlock at the next trading day (UTC), or reset the counters below.' };
  }
  if (raw.includes('MAX_WEEKLY_LOSS')) {
    return { title: 'Weekly loss limit reached', hint: 'New entries unlock next week (UTC), or reset the counters below.' };
  }
  if (raw.includes('MAX_DRAWDOWN')) {
    return { title: 'Drawdown limit reached', hint: 'Equity has fallen further than the configured maximum from its peak.' };
  }
  if (raw.includes('MAX_OPEN_POSITIONS')) {
    return { title: 'Position limit reached', hint: 'Close an open position before opening another.' };
  }
  if (raw.includes('leverage')) {
    return { title: raw, hint: 'Reduce the lot size or raise max leverage in Settings.' };
  }
  return { title: raw };
}

export function Paper() {
  const account = useSelector((s: RootState) => s.paper.account);
  /** Currency symbol for money labels — from the LIVE wallet, never hardcoded.
   *  A bound XM/USD account shows $ everywhere; an INR wallet shows ₹. */
  const cur = curSymbol(account?.currency);
  const positions = useSelector((s: RootState) => s.paper.positions);
  const trades = useSelector((s: RootState) => s.paper.trades);
  // Live FX conversion feed (USD/<wallet-currency>) — shown for any non-USD wallet.
  const walletCcy = account?.currency ?? 'USD';
  const rateSymbol = walletCcy !== 'USD' ? `USD/${walletCcy}` : null;
  // Hook is unconditional (rules of hooks); the selector yields null for a USD wallet.
  const convTick = useSelector((s: RootState) => (rateSymbol ? (s.market.ticks[rateSymbol] ?? null) : null));
  const [symbol, setSymbol] = useState('EUR/USD');
  const [direction, setDirection] = useState<'BUY' | 'SELL'>('BUY');
  const [lots, setLots] = useState('');
  const [sl, setSl] = useState('');
  const [tp, setTp] = useState('');
  const [pending, setPending] = useState(false);
  /** Per-row close state — the row's button reads "Closing…" for exactly the
   *  one position being closed, and nothing on the page navigates away. */
  const [closingId, setClosingId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [errHint, setErrHint] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  /** Live risk state — drives the lockout banner so the blocker is visible
   *  BEFORE the user wonders why Trade refuses. */
  const [risk, setRisk] = useState<RiskSnapshot | null>(null);
  /** Dynamic-lot preview against the live wallet (§13/§14). */
  const [lotPreview, setLotPreview] = useState<Record<string, unknown> | null>(null);

  // ---- MT5 demo execution state (ALWAYS ON) ---------------------------------
  interface Mt5Status {
    online: boolean; enabled: boolean; workerId: string | null; lastSeenAt: number | null; pendingCommands: number;
    accountInfo?: { login: number; server: string; balance: number; currency: string; equity?: number; profit?: number; margin?: number } | null;
    paper?: { balance: number; currency: string; equity: number } | null;
  }
  const [mt5, setMt5] = useState<Mt5Status | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const s = await Mt5Api.status();
        if (!cancelled) setMt5(s as Mt5Status);
      } catch { if (!cancelled) setMt5(null); }
    };
    void load();
    const id = window.setInterval(load, 10_000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const loadPreview = async () => {
      try {
        const r = await api<Record<string, unknown>>(`/paper/lot-preview?symbol=${encodeURIComponent(symbol)}&direction=${direction}`);
        if (!cancelled) setLotPreview(r);
      } catch { if (!cancelled) setLotPreview(null); }
    };
    void loadPreview();
    const id = window.setInterval(loadPreview, 10_000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [symbol, direction]);

  const loadRisk = useCallback(async () => {
    try {
      setRisk(await api<RiskSnapshot>('/risk'));
    } catch { /* advisory only */ }
  }, []);

  useEffect(() => {
    void loadRisk();
    const id = window.setInterval(() => void loadRisk(), 15_000);
    return () => window.clearInterval(id);
  }, [loadRisk]);

  const lockout = (() => {
    if (!risk?.account || !risk.settings) return null;
    const losses = risk.account.consecutiveLosses ?? 0;
    const max = risk.settings.maxConsecutiveLosses ?? 0;
    return max > 0 && losses >= max ? { losses, max } : null;
  })();

  const resetRisk = async () => {
    try {
      await api('/paper/reset-risk', { method: 'POST' });
      setErr(null); setErrHint(null);
      setOk('Risk counters reset — you can trade again.');
      await Promise.all([refreshPaper(), loadRisk()]);
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex));
    }
  };

  const close = async (id: string) => {
    setClosingId(id);
    try {
      await api(`/paper/close/${id}`, { method: 'POST' });
      toast('Position closed at market', 'info');
      // In-place refresh over socket/REST — no full page reload, the position
      // row disappears the moment the store updates.
      await refreshPaper();
      void loadRisk();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex));
    } finally {
      setClosingId(null);
    }
  };

  /** Move SL to entry — zero-risk the position with one click. */
  const [busyId, setBusyId] = useState<string | null>(null);
  const breakEven = async (id: string) => {
    setBusyId(id);
    try {
      await api(`/paper/breakeven/${id}`, { method: 'POST' });
      toast('Stop moved to entry — position is now risk-free', 'up');
      await refreshPaper();
    } catch (ex) {
      toast(ex instanceof Error ? ex.message : 'break-even failed', 'down');
    } finally {
      setBusyId(null);
    }
  };

  /** Close half the position (button label makes the size explicit). */
  const partialClose = async (id: string, lots: number) => {
    setBusyId(id);
    try {
      await api(`/paper/close-partial/${id}`, { method: 'POST', body: JSON.stringify({ lots }) });
      toast(`Closed ${lots} lots — remainder still managed`, 'up');
      await refreshPaper();
      void loadRisk();
    } catch (ex) {
      toast(ex instanceof Error ? ex.message : 'partial close failed', 'down');
    } finally {
      setBusyId(null);
    }
  };

  /** Kill switch: close EVERYTHING after an explicit confirmation. */
  const [flattenBusy, setFlattenBusy] = useState(false);
  const flattenAll = async () => {
    if (!window.confirm('FLATTEN ALL: close every open position now (dashboard + MT5 terminal sweep)?')) return;
    setFlattenBusy(true);
    try {
      const r = await api<{ closed: number; failed: Array<{ positionId: string }> }>('/mt5/flatten-all', {
        method: 'POST',
        body: JSON.stringify({ reason: 'kill switch from Paper view' }),
      });
      toast(`Flatten complete — ${r.closed} position(s) closed${r.failed?.length ? `, ${r.failed.length} failed` : ''}`, r.failed?.length ? 'warn' : 'up');
      await Promise.all([refreshPaper(), loadRisk()]);
    } catch (ex) {
      toast(ex instanceof Error ? ex.message : 'flatten failed', 'down');
    } finally {
      setFlattenBusy(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setPending(true);
    setErr(null);
    setErrHint(null);
    setOk(null);
    try {
      const r = await api<{ position: PaperPosition }>('/paper/manual', {
        method: 'POST',
        body: JSON.stringify({
          symbol,
          direction,
          lots: lots ? Number(lots) : undefined,
          sl: sl ? Number(sl) : undefined,
          tp: tp ? Number(tp) : undefined,
        }),
      });
      setOk(`position opened: ${r.position.direction} ${r.position.symbol} ${fmt(r.position.lots, 2)} lots @ ${fmtPrice(r.position.entryPrice, symbol)}`);
      setLots(''); setSl(''); setTp('');
      await Promise.all([refreshPaper(), loadRisk()]);
    } catch (ex) {
      const msg = (ex instanceof Error ? ex.message : String(ex)).replace(/^Error:\s*/, '');
      const f = friendlyOpenError(msg);
      setErr(f.title);
      setErrHint(f.hint ?? null);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-slate-100">Paper Trading</h1>
      <p className="text-xs text-slate-500">Virtual account on real market prices. Never executes real money.</p>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-6">
        <Stat label={`Balance (${account?.currency ?? 'USD'})`} value={account ? fmtCur(account.balance, account.currency) : '—'} />
        <Stat label="Equity" value={account ? fmtCur(account.equity, account.currency) : '—'} />
        <Stat label="Margin" value={account ? fmtCur(account.margin, account.currency) : '—'} />
        <Stat label="Free Margin" value={account ? fmtCur(account.freeMargin, account.currency) : '—'} />
        <Stat label="Realized P&L" value={account ? fmtCur(account.realizedPnl, account.currency) : '—'} />
        <Stat label="Fees" value={account ? fmtCur(account.fees, account.currency) : '—'} />
      </div>

      {rateSymbol && (
        <div className="text-[11px] text-slate-500">
          USD/{walletCcy} live rate: <span className="font-mono text-slate-300">{convTick ? fmtPrice(convTick.mid, rateSymbol) : '…'}</span>
          {convTick && <span className="text-slate-600"> · {timeAgo(convTick.receivedAt ?? convTick.timestamp)} · P&L/sizing convert live</span>}
        </div>
      )}



      {/* Risk lockout — the reason Trade refuses, shown before it is asked. */}
      {lockout && (
        <div role="status" className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.07] px-3.5 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="eyebrow text-amber-300">Risk lockout — new entries blocked</div>
            <div className="mt-0.5 text-[12px] leading-relaxed text-slate-300">
              {lockout.losses} consecutive losses (limit {lockout.max}). Review the closed trades below before re-arming.
            </div>
          </div>
          <button onClick={() => void resetRisk()}
            className="press shrink-0 rounded-md border border-amber-400/40 bg-amber-500/10 px-3 py-1.5 text-[11px] font-medium text-amber-200 transition-colors hover:bg-amber-500/20">
            Reset risk counters
          </button>
        </div>
      )}

      <Card title="Manual Paper Trade">

        <form onSubmit={(e) => void submit(e)} className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-slate-400">
            Symbol
            <select value={symbol} onChange={(e) => setSymbol(e.target.value)} className="rounded border border-border bg-panel2 px-2 py-1.5 font-mono text-sm text-slate-200">
              {ALL_SYMBOLS.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-slate-400">
            Direction
            <select value={direction} onChange={(e) => setDirection(e.target.value as 'BUY' | 'SELL')} className="rounded border border-border bg-panel2 px-2 py-1.5 font-mono text-sm text-slate-200">
              <option value="BUY">BUY</option>
              <option value="SELL">SELL</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-slate-400">
            Lots <span className="text-slate-600">(auto = risk %)</span>
            <input value={lots} onChange={(e) => setLots(e.target.value)} placeholder="auto" inputMode="decimal" className="w-24 rounded border border-border bg-panel2 px-2 py-1.5 font-mono text-sm text-slate-200" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-slate-400">
            SL <span className="text-slate-600">(auto = 50 pips / 2%)</span>
            <input value={sl} onChange={(e) => setSl(e.target.value)} placeholder="auto" inputMode="decimal" className="w-28 rounded border border-border bg-panel2 px-2 py-1.5 font-mono text-sm text-slate-200" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-slate-400">
            TP <span className="text-slate-600">(auto = 2R)</span>
            <input value={tp} onChange={(e) => setTp(e.target.value)} placeholder="auto" inputMode="decimal" className="w-28 rounded border border-border bg-panel2 px-2 py-1.5 font-mono text-sm text-slate-200" />
          </label>
          <button type="submit" disabled={pending} className="press rounded-md border border-emerald-500/40 bg-emerald-600/20 px-4 py-1.5 text-sm font-medium text-emerald-200 transition-colors hover:bg-emerald-600/30 disabled:opacity-50">
            {pending ? 'Opening…' : `Open ${direction}`}
          </button>
          {err && (
            <span className="text-xs text-red-400">
              {err}
              {errHint && <span className="block max-w-sm font-normal leading-relaxed text-slate-500">{errHint}</span>}
            </span>
          )}
          {ok && <span className="animate-slide-up text-xs text-emerald-400">{ok}</span>}
        </form>
        <p className="mt-2 text-[11px] text-slate-500">Manual trades go through the same risk gates, slippage, fees and SL/TP management as signal entries.</p>

        {/* Dynamic sizing preview (§14): why the engine will pick the size it
            picks — every limit shown, final = MIN of them. */}
        {lotPreview && (
          <div className="mt-3 rounded-md border border-border bg-panel2 px-3 py-2">
            {(lotPreview as { valid?: boolean; reason?: string }).valid ? (
              <>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
                  <span>Recommended <span className="font-mono font-semibold text-slate-100">{fmt((lotPreview as { finalLots: number }).finalLots, 2)}</span> lot</span>
                  <span>margin max <span className="font-mono text-slate-300">{fmt((lotPreview as { limits: { marginBasedLots: number } }).limits.marginBasedLots, 2)}</span></span>
                  <span>risk max <span className="font-mono text-slate-300">{fmt((lotPreview as { limits: { riskBasedLots: number } }).limits.riskBasedLots, 2)}</span></span>
                  <span>capital max <span className="font-mono text-slate-300">{fmt((lotPreview as { limits: { capitalBasedLots: number } }).limits.capitalBasedLots, 2)}</span></span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-slate-500">
                  <span>margin/lot {cur}{fmt((lotPreview as { marginPerLotAccount: number }).marginPerLotAccount, 0)}</span>
                  <span>risk/lot at SL {cur}{fmt((lotPreview as { riskPerLotAccount: number }).riskPerLotAccount, 0)}</span>
                  <span>required margin {cur}{fmt((lotPreview as { marginPerLotAccount: number; finalLots: number }).marginPerLotAccount * (lotPreview as { finalLots: number }).finalLots, 0)}</span>
                  <span className="text-red-400/80">SL loss {cur}{fmt(Math.abs((lotPreview as { riskPerLotAccount: number; finalLots: number }).riskPerLotAccount * (lotPreview as { finalLots: number }).finalLots), 0)}</span>
                  {(lotPreview as { expectedProfitAtTp2x: number | null }).expectedProfitAtTp2x != null && (
                    <span className="text-emerald-400/80">TP(2R) profit {cur}{fmt((lotPreview as { expectedProfitAtTp2x: number }).expectedProfitAtTp2x, 0)}</span>
                  )}
                  <span>{(lotPreview as { leverage: number }).leverage}x</span>
                  <span>free {cur}{fmt((lotPreview as { freeMarginAccount: number }).freeMarginAccount, 0)}</span>
                </div>
              </>
            ) : (
              <div className="text-[11px] text-amber-400">{String((lotPreview as { reason?: string }).reason ?? 'not sizeable right now')}</div>
            )}
          </div>
        )}
      </Card>

      {/* MT5 demo-account execution — ALWAYS ON, uses MT5 demo money */}
      <Card title="MT5 Demo Execution — Always On">
        <div className="flex flex-wrap items-center gap-3">
          <Badge tone={mt5?.online ? 'up' : 'down'}>
            {mt5?.online ? `MT5 demo connected (${mt5.workerId ?? ''})` : 'MT5 trader offline — trades queue for MT5'}
          </Badge>
          <span className="text-xs font-semibold text-emerald-400">EXECUTING ON MT5 DEMO BALANCE</span>
          {mt5?.accountInfo && (
            <span className="text-[11px] text-slate-300">
              MT5 #{mt5.accountInfo.login} · {mt5.accountInfo.server} · <b>{fmt(mt5.accountInfo.balance, 2)} {mt5.accountInfo.currency}</b>
              {mt5.accountInfo.equity != null && mt5.accountInfo.equity !== mt5.accountInfo.balance && (
                <span className="ml-2 text-slate-400">eq {fmt(mt5.accountInfo.equity, 2)}</span>
              )}
            </span>
          )}
          {(mt5?.pendingCommands ?? 0) > 0 && (
            <span className="text-[11px] text-amber-400">{mt5?.pendingCommands} MT5 commands pending</span>
          )}
          {!mt5?.online && (
            <span className="text-[11px] text-amber-400">Install & run trader.py — it will pick up queued trades automatically.</span>
          )}
        </div>
        <p className="mt-2 text-[11px] leading-snug text-slate-500">
          Every auto-trade and manual trade from this dashboard <b>uses MT5 demo account money</b> and appears in <b>both places</b> — dashboard + MT5 terminal — with identical open/close (SL/TP/trailing/profit-target).
          All money is shown in the account's settlement currency (USD on an XM MT5 account) — balance, targets, P&amp;L and risk alike. P&amp;L is deducted from both the dashboard and MT5 demo balances.
          Each platform's money stays separate (paper vs MT5), but trades are always mirrored — no toggle to miss a trade.
        </p>
        {mt5?.paper && mt5?.accountInfo && (
          <div className="mt-2 text-[11px] text-slate-500">
            Dashboard paper: <span className="font-mono text-slate-300">{fmtCur(mt5.paper.balance, mt5.paper.currency)} {mt5.paper.currency}</span>
            <span className="mx-2 text-slate-700">→ MT5 demo drives sizing (free margin synced live)</span>
          </div>
        )}
      </Card>

      <Card
        title={`Open Positions (${positions.length})`}
        right={positions.length > 0 ? (
          <button
            onClick={() => void flattenAll()}
            disabled={flattenBusy}
            className="kill-switch press rounded-md px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-red-200 transition-colors disabled:opacity-50"
            title="Close every open position (dashboard + MT5)"
          >
            {flattenBusy ? 'Flattening…' : '⏻ Flatten all'}
          </button>
        ) : undefined}
      >
        {positions.length === 0 ? (
          <Empty text="No open positions. Use the manual trade form above, or wait — when an active signal's entry zone is reached, a paper position is opened automatically." />
        ) : (
          <Table head={['Symbol', 'Dir', 'Lots', 'Units', 'Entry', 'SL', 'TP1', 'Bid/Ask', 'Pips', 'Net P&L', 'Duration', '']}>
            {positions.map((p: PaperPosition) => {
              // §21: every money figure here is backend-computed. Net P&L is
              // the engine's executable-side mark net of swap + commission.
              const pips = p.pipMovement;
              return (
                <tr key={p.id}>
                  <td className="font-medium text-slate-200">
                    {p.symbol}
                    <span className="block text-[10px] text-slate-600">{p.baseCurrency}/{p.quoteCurrency}{p.convStale ? ' · CONV STALE' : ''}</span>
                  </td>
                  <td><Badge tone={p.direction === 'BUY' ? 'up' : 'down'}>{p.direction}</Badge></td>
                  <td className="font-mono">{fmt(p.lots, 2)}</td>
                  <td className="font-mono text-slate-400">{p.units ? fmt(p.units, 0) : '—'}</td>
                  <td className="font-mono">{fmtPrice(p.entryPrice, p.symbol)}</td>
                  <td className="font-mono text-red-400">{fmtPrice(p.stopLoss, p.symbol)}</td>
                  <td className="font-mono text-emerald-400">{p.takeProfit1 != null ? fmtPrice(p.takeProfit1, p.symbol) : '—'}</td>
                  <td className="font-mono text-[10px] leading-tight text-slate-400">
                    {p.currentBid != null ? fmtPrice(p.currentBid, p.symbol) : '—'}
                    <span className="text-slate-700"> / </span>
                    {p.currentAsk != null ? fmtPrice(p.currentAsk, p.symbol) : '—'}
                  </td>
                  <td className={`font-mono ${pips == null ? 'text-slate-500' : pips >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {pips == null ? '—' : `${pips > 0 ? '+' : ''}${fmt(pips, 1)}`}
                  </td>
                  <td className={`font-mono font-semibold ${(p.unrealizedPnl ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    <PriceFlash value={p.unrealizedPnl}>{fmtCur(p.unrealizedPnl, account?.currency)}</PriceFlash>
                    {p.quotePnl != null && (
                      <span className="block text-[10px] font-normal text-slate-600">{fmt(p.quotePnl, 4)} {p.quoteCurrency}</span>
                    )}
                  </td>
                  <td className="font-mono text-xs">{(p.durationMs / 3600_000).toFixed(1)}h</td>
                  <td>
                    <div className="flex items-center gap-1">
                      <button onClick={() => void breakEven(p.id)} disabled={busyId === p.id}
                        title="Move SL to entry — remove all risk from this position"
                        className="press rounded border border-border px-1.5 py-0.5 text-[10px] transition-colors hover:bg-panel2 disabled:opacity-50">
                        BE
                      </button>
                      {p.lots / 2 >= (p.minimumLot ?? 0.01) && (
                        <button onClick={() => void partialClose(p.id, Number((p.lots / 2).toFixed(2)))} disabled={busyId === p.id}
                          title={`Close ${Number((p.lots / 2).toFixed(2))} lots (half)`}
                          className="press rounded border border-border px-1.5 py-0.5 text-[10px] transition-colors hover:bg-panel2 disabled:opacity-50">
                          ½
                        </button>
                      )}
                      <button onClick={() => void close(p.id)} disabled={closingId !== null}
                        className="press rounded border border-border px-2 py-0.5 text-xs transition-colors hover:bg-panel2 disabled:opacity-50">
                        {closingId === p.id ? 'Closing…' : 'Close'}
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>

      <Card title={`Closed Trades (${trades.length})`}>
        {trades.length === 0 ? (
          <Empty text="No closed trades yet." />
        ) : (
          <Table head={['Symbol', 'Dir', 'Lots', 'Entry', 'Exit', 'Reason', 'P&L', 'Fees', 'Swap', 'R', 'Closed']}>
            {trades.slice(0, 50).map((t) => (
              <tr key={t.id}>
                <td className="text-slate-200">{t.symbol}</td>
                <td><Badge tone={t.direction === 'BUY' ? 'up' : 'down'}>{t.direction}</Badge></td>
                <td className="font-mono">{fmt(t.lots, 2)}</td>
                <td className="font-mono">{fmtPrice(t.entryPrice, t.symbol)}</td>
                <td className="font-mono">{fmtPrice(t.exitPrice, t.symbol)}</td>
                <td><Badge tone={t.exitReason === 'SL' ? 'red' : 'up'}>{t.exitReason}</Badge></td>
                <td className={`font-mono font-semibold ${t.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {fmtCur(t.pnl, account?.currency)}
                  {t.fxRate != null && (
                    <span className="block text-[10px] font-normal text-slate-600" title={`quote→account rate at exit${t.fxStale ? ' (STALE)' : ''}`}>
                      @{fmt(t.fxRate, 2)}{t.fxStale ? ' ⚠' : ''}
                    </span>
                  )}
                </td>
                <td className="font-mono text-xs">{fmtCur(t.fees, account?.currency)}</td>
                <td className="font-mono text-xs">{fmtCur(t.swap, account?.currency)}</td>
                <td className="font-mono">{fmt(t.rr, 2)}</td>
                <td className="text-xs text-slate-500">{fmtDateTime(t.closeTime)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}