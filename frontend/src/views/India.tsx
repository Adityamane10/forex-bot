import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { actions, RootState } from '../store';
import { CandleChart } from '../components/CandleChart';
import { OptionAnalyticsPanel } from '../components/india/OptionAnalytics';
import { OptionChainPanel } from '../components/india/OptionChain';
import { ContextStrip } from '../components/india/ContextStrip';
import { GateTrail, WhyNoTradeFeed } from '../components/india/GateTrail';
import { MultiTimeframePanel } from '../components/india/MultiTimeframe';
import { PerformanceAnalyticsDashboard } from '../components/india/PerformanceAnalytics';
import { fmt, fmtCur, fmtTime } from '../format';
import { IndiaApi } from '../api';
import type {
  IndiaAnalysisSnapshot, IndiaCandle, IndiaExecutionAuthorityState,
  IndiaExecutionMode, IndiaGoal, IndiaInstrument, IndiaPosition,
  IndiaPaperAccount, IndiaSignal, IndiaTimeframe, IndiaTrade, IndiaUnderlying,
} from '@fx/shared';
import { INDIA_TIMEFRAMES } from '@fx/shared';

// ─── domain constants ─────────────────────────────────────────────────────────
const TRADING_UNDERLYINGS: IndiaUnderlying[] = ['NIFTY', 'BANKNIFTY', 'FINNIFTY'];
/**
 * Membership test for the option panels. `IndiaInstrument.underlying` is a plain
 * string, so `TRADING_UNDERLYINGS.includes(...)` would not accept it — which is
 * why the option-analytics call site had drifted into using its own hardcoded
 * literal list. One source of truth, and adding an underlying above now reaches
 * every gate that mentions it.
 */
const HAS_OPTION_CHAIN: ReadonlySet<string> = new Set<string>(TRADING_UNDERLYINGS);
const LABEL: Record<IndiaUnderlying, string> = {
  NIFTY: 'NIFTY 50', BANKNIFTY: 'BANK NIFTY', FINNIFTY: 'FIN NIFTY', MIDCPNIFTY: 'MIDCAP',
};
const DEAD_STATUSES = new Set(['EXPIRED', 'INVALIDATED', 'MISSED', 'BLOCKED']);
const LIVE_STATUSES = new Set(['READY', 'SIGNAL_FOUND', 'WAITING_FOR_ENTRY', 'EXECUTING', 'POSITION_OPEN', 'MONITORING', 'EXITING']);

// ─── tiny ui primitives ───────────────────────────────────────────────────────
const cls = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(' ');

function Pill({ children, color }: { children: React.ReactNode; color: string }) {
  return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium backdrop-blur-sm ${color}`}>{children}</span>;
}
function SidePill({ side }: { side: 'BUY' | 'SELL' }) {
  return (
    <Pill color={side === 'BUY'
      ? 'bg-emerald-500/15 text-emerald-300 shadow-glow-up'
      : 'bg-red-500/15 text-red-300 shadow-glow-down'}>
      {side === 'BUY' ? '▲' : '▼'} {side}
    </Pill>
  );
}
function StatBox({ label, value, sub, color }: { label: string; value: React.ReactNode; sub?: string; color?: string }) {
  return (
    <div className="relative overflow-hidden rounded bg-panel2 px-2.5 py-2 transition-colors duration-200 hover:bg-border/40">
      {/* Lit top edge: each cell reads as an individually backlit readout in a
          bank of instruments. */}
      <span aria-hidden="true" className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-slate-100/15 to-transparent" />
      <div className="text-[10px] text-slate-500 uppercase tracking-wide">{label}</div>
      <div className={cls('num-display mt-0.5 text-sm font-semibold', color ?? 'text-slate-200')}>{value}</div>
      {sub && <div className="text-[10px] text-slate-600 mt-0.5">{sub}</div>}
    </div>
  );
}
function SectionHeader({ title, right }: { title: string; right?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-border pb-1.5 mb-2">
      <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-slate-400">
        <span aria-hidden="true" className="h-[3px] w-[3px] rounded-full bg-accent/50" />
        {title}
      </span>
      {right}
    </div>
  );
}
function Divider() { return <div className="seam my-4" />; }

// ─── engine config form (shared by Goal + Universal) ─────────────────────────
interface EngineConfig {
  amountInr: number; minimumProfitInr: number; maxRiskInr: number;
  maxMarginPercent: number; numberOfTrades: number;
  executionMode: IndiaExecutionMode; sessionPolicy: 'TODAY_ONLY' | 'CONTINUE_NEXT_SESSION';
  tradeUnderlyings: IndiaUnderlying[];
  /** How the ₹ target completes the run (§6) — explicit, never implied. */
  profitSemantics: 'CUMULATIVE' | 'PER_TRADE';
  /** Strategy holding barrier in minutes (§11): stagnation exit threshold. */
  maxHoldMinutes: number;
}
function defaultConfig(): EngineConfig {
  return { amountInr: 100000, minimumProfitInr: 2500, maxRiskInr: 500, maxMarginPercent: 20,
    numberOfTrades: 3, executionMode: 'AUTO', sessionPolicy: 'TODAY_ONLY', tradeUnderlyings: [...TRADING_UNDERLYINGS],
    profitSemantics: 'CUMULATIVE', maxHoldMinutes: 45 };
}

function EngineConfigForm({
  id, value, onChange,
}: { id: string; value: EngineConfig; onChange: (v: EngineConfig) => void }) {
  const set = <K extends keyof EngineConfig>(k: K, v: EngineConfig[K]) => onChange({ ...value, [k]: v });
  const toggleUl = (u: IndiaUnderlying) => {
    const next = value.tradeUnderlyings.includes(u)
      ? value.tradeUnderlyings.filter(x => x !== u)
      : [...value.tradeUnderlyings, u];
    set('tradeUnderlyings', next.length ? next : [u]);
  };
  const inp = 'w-full rounded border border-border bg-panel2 px-2 py-1 text-[11px] text-slate-200 shadow-panel transition-all focus:border-blue-300/60 focus:outline-none focus:ring-2 focus:ring-blue-300/15';
  const lbl = 'block text-[10px] text-slate-500 uppercase mb-0.5 tracking-wide';
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <label><span className={lbl}>Capital (₹)</span>
          <input id={`${id}-amount`} className={inp} type="number" min={10000} step={5000} value={value.amountInr}
            onChange={e => set('amountInr', Number(e.target.value))} /></label>
        <label><span className={lbl}>Profit Target (₹)</span>
          <input className={inp} type="number" min={100} value={value.minimumProfitInr}
            onChange={e => set('minimumProfitInr', Number(e.target.value))} /></label>
        <label><span className={lbl}>Max Risk / Trade (₹)</span>
          <input className={inp} type="number" min={100} value={value.maxRiskInr}
            onChange={e => set('maxRiskInr', Number(e.target.value))} /></label>
        <label><span className={lbl}>Max Margin %</span>
          <input className={inp} type="number" min={1} max={100} value={value.maxMarginPercent}
            onChange={e => set('maxMarginPercent', Number(e.target.value))} /></label>
        <label><span className={lbl}>No. of Trades</span>
          <input className={inp} type="number" min={1} max={50} value={value.numberOfTrades}
            onChange={e => set('numberOfTrades', Number(e.target.value))} /></label>
        <label><span className={lbl}>Mode</span>
          <select className={inp} value={value.executionMode}
            onChange={e => set('executionMode', e.target.value as IndiaExecutionMode)}>
            <option value="AUTO">AUTO — trade automatically</option>
            <option value="MANUAL">MANUAL — signals only, you trade</option>
            <option value="OFF">OFF</option>
          </select></label>
      </div>
      <label><span className={lbl}>Session Policy</span>
        <select className={inp} value={value.sessionPolicy}
          onChange={e => set('sessionPolicy', e.target.value as EngineConfig['sessionPolicy'])}>
          <option value="TODAY_ONLY">TODAY ONLY — stop at market close</option>
          <option value="CONTINUE_NEXT_SESSION">CONTINUE — resume next session</option>
        </select></label>
      <div className="grid grid-cols-2 gap-2">
        <label><span className={lbl}>Goal Completion</span>
          <select className={inp} value={value.profitSemantics}
            onChange={e => set('profitSemantics', e.target.value as EngineConfig['profitSemantics'])}>
            <option value="CUMULATIVE">CUMULATIVE — all trades combined</option>
            <option value="PER_TRADE">PER TRADE — target each trade</option>
          </select></label>
        <label><span className={lbl}>Max Hold (min)</span>
          <input id={`${id}-maxhold`} className={inp} type="number" min={5} max={240} value={value.maxHoldMinutes}
            onChange={e => set('maxHoldMinutes', Number(e.target.value))} /></label>
      </div>
      <div>
        <div className={lbl}>Trade on</div>
        <div className="flex gap-1.5 mt-0.5">
          {TRADING_UNDERLYINGS.map(u => (
            <button key={u} type="button" onClick={() => toggleUl(u)}
              className={cls('press rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-all',
                value.tradeUnderlyings.includes(u)
                  ? 'bg-blue-300/15 text-blue-100 border-blue-300/35 shadow-glow-live'
                  : 'bg-panel2 text-slate-500 border-border hover:text-slate-300')}>
              {LABEL[u]}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── signal card ──────────────────────────────────────────────────────────────
function SignalCard({ signal, onTrade, trading }: {
  signal: IndiaSignal; onTrade: (s: IndiaSignal) => void; trading: boolean;
}) {
  const now = Date.now();
  const expired = (signal.expiresAt ?? 0) < now || DEAD_STATUSES.has(signal.status);
  const canTrade = !expired && (signal.status === 'READY' || signal.status === 'SIGNAL_FOUND' || signal.status === 'WAITING_FOR_ENTRY');
  const live = LIVE_STATUSES.has(signal.status) && !expired;
  const a = signal.analysis;
  const ttlSec = signal.expiresAt ? Math.max(0, Math.floor((signal.expiresAt - now) / 1000)) : null;
  // TTL burn-down as a fraction of the original five-minute window — the card
  // visibly ages, so a stale signal is felt before it is read.
  const TTL_WINDOW = 300;
  const ttlFrac = ttlSec !== null ? Math.max(0, Math.min(1, ttlSec / TTL_WINDOW)) : null;

  return (
    <div className={cls('sheen relative overflow-hidden rounded-lg border p-3 space-y-2 transition-all duration-200',
      expired ? 'opacity-40 border-border'
        : live ? 'border-blue-300/30 bg-blue-300/[0.05] shadow-glow-live'
        : 'border-border bg-panel2 hover:border-hairline')}>

      {/* Live pulse edge: a live signal breathes at its top edge; a dead one
          is left perfectly still. */}
      {live && (
        <span aria-hidden="true"
          className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-blue-300/70 to-transparent animate-breathe" />
      )}

      {/* Header row */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <SidePill side={signal.side} />
          <span className="font-mono text-xs font-semibold text-slate-100">{signal.tradingSymbol}</span>
          <Pill color="bg-slate-500/20 text-slate-400">{signal.contractType}</Pill>
          {signal.strategy && <Pill color="bg-violet-500/20 text-violet-300">{signal.strategy}</Pill>}
        </div>
        <div className="flex items-center gap-2">
          {ttlSec !== null && !expired && (
            <span className={cls('text-[10px] font-mono', ttlSec < 60 ? 'text-amber-400' : 'text-slate-500')}>
              {ttlSec < 60 ? `${ttlSec}s` : `${Math.floor(ttlSec / 60)}m`} left
            </span>
          )}
          <Pill color={expired ? 'bg-slate-500/20 text-slate-500' :
            signal.status === 'POSITION_OPEN' ? 'bg-emerald-500/20 text-emerald-300 shadow-glow-up' :
            live ? 'bg-blue-500/20 text-blue-300' : 'bg-slate-500/20 text-slate-400'}>
            {signal.status}
          </Pill>
        </div>
      </div>

      {/* Price levels */}
      <div className="grid grid-cols-3 gap-2">
        <StatBox label="Entry" value={fmt(signal.entry, 2)} />
        <StatBox label="Stop Loss" value={fmt(signal.stopLoss, 2)} color="text-red-400" />
        <StatBox label="Target" value={fmt(signal.target, 2)} color="text-emerald-400" />
      </div>

      {/* Risk / RR / confidence */}
      <div className="flex gap-3 text-[11px] text-slate-500 flex-wrap">
        <span>Risk <span className="text-slate-300 font-mono">₹{fmt(signal.riskInr, 0)}</span></span>
        <span>RR <span className="text-slate-300 font-mono">{fmt(signal.rr, 2)}</span></span>
        <span>Conf <span className="text-slate-300 font-mono">{fmt(signal.confidence * 100, 0)}%</span></span>
        <span>Qty <span className="text-slate-300 font-mono">{signal.quantity} (lot {signal.lotSize})</span></span>
        <span>Profit est <span className="text-emerald-400 font-mono">₹{fmt(signal.expectedProfitInr, 0)}</span></span>
      </div>

      {/* Freshness track: burns right-to-left as the signal ages out. */}
      {ttlFrac !== null && !expired && (
        <div className="h-[2px] w-full overflow-hidden rounded-full bg-border" aria-hidden="true">
          <div className={cls('h-full rounded-full transition-all duration-1000',
            ttlSec !== null && ttlSec < 60 ? 'bg-amber-400/80' : 'bg-blue-300/60')}
            style={{ width: `${ttlFrac * 100}%` }} />
        </div>
      )}

      {/* Analysis indicators */}
      {a && (
        <div className="flex gap-3 text-[10px] text-slate-600 flex-wrap border-t border-border/40 pt-1.5">
          <span>Regime <span className="text-slate-500">{a.regime}</span></span>
          <span>Trend <span className={a.trend === 'BULLISH' ? 'text-emerald-400' : a.trend === 'BEARISH' ? 'text-red-400' : 'text-amber-400'}>{a.trend}</span></span>
          {a.riskContext && <>
            <span>RSI <span className="text-slate-400 font-mono">{fmt(Number(a.riskContext.rsi), 0)}</span></span>
            <span>ADX <span className="text-slate-400 font-mono">{fmt(Number(a.riskContext.adx), 0)}</span></span>
            <span>ATR <span className="text-slate-400 font-mono">{fmt(Number(a.riskContext.atr), 2)}</span></span>
          </>}
          {a.prediction?.available && (
            <span>AI <span className="text-blue-400 font-mono">{fmt((a.prediction.probability ?? 0) * 100, 0)}%</span></span>
          )}
          {a.support && <span>S <span className="text-emerald-500 font-mono">{fmt(a.support, 2)}</span></span>}
          {a.resistance && <span>R <span className="text-red-500 font-mono">{fmt(a.resistance, 2)}</span></span>}
        </div>
      )}

      {/* How the engine arrived at this — the six pre-trade checks and what each
          one did to the confidence number shown above. Collapsed by default so
          the card stays scannable; every signal that reaches the screen has one. */}
      {signal.gateTrail && <GateTrail trail={signal.gateTrail} />}

      {/* Trade button */}
      {canTrade && (
        <button disabled={trading} onClick={() => onTrade(signal)}
          className="press w-full rounded-md border border-blue-300/35 bg-blue-300/[0.12] py-1.5 text-xs font-semibold text-blue-100 shadow-glow-live transition-all hover:bg-blue-300/20 disabled:opacity-50 mt-1">
          {trading ? 'Placing order…' : `▶ Trade — ${signal.side} ${signal.tradingSymbol}`}
        </button>
      )}
      {signal.status === 'POSITION_OPEN' && (
        <div className="text-[11px] text-emerald-400 text-center py-1">✓ Position open</div>
      )}
      {expired && signal.status !== 'POSITION_OPEN' && (
        <div className="text-[11px] text-slate-500 text-center py-1">
          {signal.invalidatedReason ?? signal.status}
        </div>
      )}
      <div className="text-[10px] text-slate-500 text-right">{fmtTime(signal.createdAt)} · {signal.owner}</div>
    </div>
  );
}

// ─── goal / universal engine panel ───────────────────────────────────────────
function EnginePanel({
  owner, activeGoal, authority, config, setConfig,
  onStart, onStop, busy, msg,
}: {
  owner: 'GOAL' | 'UNIVERSAL';
  activeGoal: IndiaGoal | null;
  authority: IndiaExecutionAuthorityState | null;
  config: EngineConfig; setConfig: (v: EngineConfig) => void;
  onStart: () => void; onStop: () => void;
  busy: boolean; msg: string | null;
}) {
  const isOwner = authority?.owner === owner;
  const mode = owner === 'GOAL' ? authority?.goal.executionMode : authority?.universal.executionMode;
  const isActive = owner === 'GOAL'
    ? (!!activeGoal && activeGoal.status === 'ACTIVE')
    : (isOwner && (mode === 'AUTO' || mode === 'MANUAL'));

  return (
    <div className="sheen relative overflow-hidden rounded-lg border border-border bg-panel shadow-panel transition-shadow duration-200 hover:shadow-lift">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-slate-400">
            <span aria-hidden="true" className="h-[3px] w-[3px] rounded-full bg-accent/50" />
            {owner === 'GOAL' ? 'Goal Trading' : 'Universal Signals'}
          </span>
          {isActive && (
            <Pill color="bg-emerald-500/15 text-emerald-300">
              <span aria-hidden="true" className="live-dot text-emerald-400" />
              RUNNING
            </Pill>
          )}
        </div>
        <div className="text-[10px] text-slate-600 max-w-[140px] text-right leading-tight">
          {owner === 'GOAL'
            ? 'Sequential trades to a profit target'
            : 'Continuous signals · AUTO trades · MANUAL signals only'}
        </div>
      </div>
      <div className="p-3 space-y-3">

        {/* Config form — always visible so user can edit settings */}
        <EngineConfigForm id={owner.toLowerCase()} value={config} onChange={setConfig} />

        {/* Active goal progress shown BELOW the form */}
        {owner === 'GOAL' && activeGoal && activeGoal.status === 'ACTIVE' && (() => {
          const p = activeGoal.progress;
          const realized = p.realizedProfitInr ?? p.totalPnlInr;
          const remaining = p.remainingProfitInr ?? Math.max(0, activeGoal.config.minimumProfitInr - realized);
          const achieved = realized >= activeGoal.config.minimumProfitInr;
          const inTrade = !!p.currentPosition;
          const statusChip = achieved ? 'GOAL ACHIEVED'
            : inTrade ? 'IN TRADE'
            : activeGoal.state === 'MONITORING' || activeGoal.state === 'POSITION_OPEN' ? 'IN TRADE'
            : p.waitReason ? 'WAITING' : 'SCANNING';
          const opp = p.currentOpportunity;
          return (
            <div className="relative overflow-hidden rounded-lg border border-blue-300/20 bg-blue-300/[0.04] p-2.5 space-y-2 shadow-panel">
              {/* Halo: the active engine reads as lit from within. */}
              <span aria-hidden="true" className="pointer-events-none absolute inset-0"
                style={{ background: 'radial-gradient(320px 110px at 50% -40%, rgba(213,209,196,0.07), transparent 70%)' }} />
              <div className="relative flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-1.5">
                  <Pill color={achieved ? 'bg-emerald-500/15 text-emerald-300 shadow-glow-up'
                    : inTrade ? 'bg-amber-500/15 text-amber-300'
                    : 'bg-blue-500/15 text-blue-200'}>
                    {/* The engine's heartbeat: breathing while it works, still
                        when it holds, glowing when it wins. */}
                    {statusChip === 'SCANNING' && (
                      <span aria-hidden="true" className="live-dot text-current" />
                    )}
                    {statusChip}
                  </Pill>
                  {p.mlStatus && (
                    <Pill color={p.mlStatus === 'ONLINE' ? 'bg-emerald-500/15 text-emerald-400'
                      : p.mlStatus === 'SHADOW' ? 'bg-sky-500/15 text-sky-400'
                      : 'bg-red-500/15 text-red-400'}>
                      ML {p.mlStatus}
                    </Pill>
                  )}
                </div>
                <span className="font-mono text-[10px] text-slate-600 truncate">{activeGoal.goalId}</span>
              </div>
              <div className="relative grid grid-cols-4 gap-1.5">
                <StatBox label="Goal" value={fmtCur(activeGoal.config.minimumProfitInr, 'INR', 0)} />
                <StatBox label="Realized" value={fmtCur(realized, 'INR', 0)}
                  color={realized >= 0 ? 'text-emerald-400' : 'text-red-400'} />
                <StatBox label="Remaining" value={fmtCur(remaining, 'INR', 0)} />
                <StatBox label="Trades" value={`${p.completedTrades}/${p.requestedTrades}`} />
              </div>
              <div className="relative" role="progressbar"
                aria-valuenow={Math.round(Math.min(100, Math.max(0,
                  activeGoal.config.minimumProfitInr > 0 ? (realized / activeGoal.config.minimumProfitInr) * 100 : 0)))}
                aria-valuemin={0} aria-valuemax={100}>
                {/* Quarter ticks: progress against a machined scale, not a
                    floating bar. */}
                <div className="pointer-events-none absolute inset-y-[-2px] left-1/4 border-l border-slate-100/10" />
                <div className="pointer-events-none absolute inset-y-[-2px] left-2/4 border-l border-slate-100/10" />
                <div className="pointer-events-none absolute inset-y-[-2px] left-3/4 border-l border-slate-100/10" />
                <div className="h-1.5 rounded-full bg-panel overflow-hidden border border-border/60">
                  <div className={cls('h-full rounded-full transition-all duration-700',
                    achieved
                      ? 'bg-gradient-to-r from-emerald-600 to-emerald-400 shadow-glow-up'
                      : realized >= 0
                        ? 'bg-gradient-to-r from-blue-300/50 to-blue-300'
                        : 'bg-gradient-to-r from-red-600 to-red-400')}
                    style={{ width: `${Math.min(100, Math.max(0,
                      activeGoal.config.minimumProfitInr > 0
                        ? (realized / activeGoal.config.minimumProfitInr) * 100
                        : 0))}%` }} />
                </div>
              </div>

              {/* Best current opportunity — an ESTIMATE, never a promise (§27) */}
              {opp && !inTrade && (
                <div className="rounded border border-border bg-panel2 p-2 space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-medium text-slate-200 truncate">{opp.tradingSymbol}</span>
                    <SidePill side={opp.side} />
                  </div>
                  <div className="grid grid-cols-4 gap-1.5">
                    <StatBox label="Exp. Profit" value={fmtCur(opp.expectedProfitInr, 'INR', 0)} color="text-emerald-400" />
                    <StatBox label="TP Prob." value={`${Math.round(opp.tpProbability * 100)}%`} color="text-blue-300" />
                    <StatBox label={`Time ~${opp.expectedMinutes}m`} value="estimate"
                      sub={undefined} color="text-slate-400" />
                    <StatBox label="Risk" value={fmtCur(opp.riskInr, 'INR', 0)} color="text-red-400" />
                  </div>
                  <div className="flex items-center gap-2 text-[10px] text-slate-600 flex-wrap">
                    {/* Composite score on a machined scale — the number the
                        engine actually ranked this candidate by. */}
                    <span className="inline-flex items-center gap-1.5">
                      score
                      <span className="relative h-1 w-12 overflow-hidden rounded-full bg-border" aria-hidden="true">
                        <span className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-slate-500/60 to-blue-300"
                          style={{ width: `${Math.min(100, Math.max(0, (opp.score + 0.5) * 100))}%` }} />
                      </span>
                      <span className="font-mono text-slate-400">{opp.score.toFixed(3)}</span>
                    </span>
                    <span>liquidity <span className={
                      opp.liquidity === 'GOOD' ? 'text-emerald-500' : opp.liquidity === 'FAIR' ? 'text-amber-500' : 'text-slate-400'
                    }>{opp.liquidity}</span></span>
                    <span>{opp.mlStatus === 'SHADOW' ? 'ML shadow' : `ML ${opp.mlStatus.toLowerCase()}`}</span>
                  </div>
                </div>
              )}

              {/* Why the engine is waiting — silence must have a reason (§27) */}
              {!inTrade && p.waitReason && !achieved && (
                <p className="text-[10px] text-amber-400/90 leading-snug">⏸ {p.waitReason}</p>
              )}

              {/* Per-stage scan diagnostics (§34): where candidates die */}
              {!inTrade && p.diagnostics && !achieved && (() => {
                const d = p.diagnostics;
                const rej = d.rejected;
                const parts = [
                  { label: 'data', value: `${d.instrumentsWithData}/${d.instrumentsScanned}`, warn: d.instrumentsWithData === 0 },
                  { label: 'criteria', value: `${d.criteriaPassed}`, warn: false },
                  { label: 'ml✗', value: `${rej.ml}`, warn: rej.ml > 0 && d.validCandidates === 0 },
                  { label: 'gates✗', value: `${rej.gates}`, warn: rej.gates > 0 && d.validCandidates === 0 },
                  { label: 'sizing✗', value: `${rej.sizing}`, warn: rej.sizing > 0 && d.validCandidates === 0 },
                  { label: 'valid', value: `${d.validCandidates}`, warn: false },
                ];
                return (
                  <div className="flex items-center gap-x-2.5 gap-y-0.5 text-[10px] text-slate-600 flex-wrap border-t border-border/50 pt-1.5">
                    <span className="inline-flex items-center gap-1.5">
                      {(d.lastScanAt > 0) && <span aria-hidden="true" className="live-dot text-slate-500" style={{ transform: 'scale(0.8)' }} />}
                      last scan {d.lastScanAt > 0 ? new Date(d.lastScanAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—'} · {(d.lastScanDurationMs / 1000).toFixed(1)}s
                    </span>
                    {parts.map((x) => (
                      <span key={x.label} className={x.warn ? 'text-amber-500' : undefined}>
                        {x.label} <span className="font-mono text-slate-400">{x.value}</span>
                      </span>
                    ))}
                  </div>
                );
              })()}

              {p.currentSignal && (
                <div className="text-[10px] text-slate-500 flex items-center gap-1">
                  Current signal: <span className="text-slate-300">{p.currentSignal.tradingSymbol}</span>
                  <SidePill side={p.currentSignal.side} />
                </div>
              )}
            </div>
          );
        })()}

        {/* Action buttons */}
        <div className="flex gap-2">
          {!isActive ? (
            <button onClick={onStart} disabled={busy}
              className="press flex-1 rounded-md border border-blue-300/30 bg-blue-300/[0.12] py-1.5 text-xs font-semibold text-blue-100 shadow-glow-live transition-all hover:bg-blue-300/20 disabled:opacity-50">
              {busy ? 'Starting…' : owner === 'GOAL' ? '▶ Start Goal Trading' : '▶ Activate Universal Signals'}
            </button>
          ) : (
            <button onClick={onStop} disabled={busy}
              className="press flex-1 rounded-md border border-red-500/30 bg-red-500/10 py-1.5 text-xs font-semibold text-red-300 transition-all hover:bg-red-500/20 disabled:opacity-50">
              ■ Stop
            </button>
          )}
        </div>

        {msg && (
          <p className={cls('animate-slide-up rounded-md border px-2 py-1 text-[11px]',
            msg.toLowerCase().includes('fail') || msg.toLowerCase().includes('error')
              ? 'border-red-500/30 bg-red-500/10 text-red-300'
              : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300')}>
            {msg}
          </p>
        )}
      </div>
    </div>
  );
}


// ─── signals feed panel ───────────────────────────────────────────────────────
function SignalsFeed({ title, signals, onTrade, tradingId }: {
  title: string; signals: IndiaSignal[];
  onTrade: (s: IndiaSignal) => void; tradingId: string | null;
}) {
  const live = signals.filter(s => LIVE_STATUSES.has(s.status));
  const dead = signals.filter(s => DEAD_STATUSES.has(s.status)).slice(0, 5);

  return (
    <div className="sheen relative overflow-hidden rounded-lg border border-border bg-panel shadow-panel transition-shadow duration-200 hover:shadow-lift">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-slate-400">
          <span aria-hidden="true" className="h-[3px] w-[3px] rounded-full bg-accent/50" />
          {title}
        </span>
        <span className="text-[11px] text-slate-500">
          {live.length > 0 && <span className="mr-2 inline-flex items-center gap-1 text-blue-300"><span aria-hidden="true" className="live-dot" />{live.length} live</span>}
          {signals.length} total
        </span>
      </div>
      <div className="p-3 space-y-2">
        {live.length === 0 && dead.length === 0 && (
          <p className="text-xs text-slate-500 py-4 text-center">
            No signals yet — engine scans live instruments during market hours (09:15–15:30 IST)
          </p>
        )}
        {live.map(s => (
          <SignalCard key={s.signalId} signal={s}
            onTrade={onTrade} trading={tradingId === s.signalId} />
        ))}
        {dead.length > 0 && (
          <details className="mt-1">
            <summary className="text-[10px] text-slate-600 cursor-pointer select-none">
              {dead.length} expired / invalid
            </summary>
            <div className="mt-2 space-y-2">
              {dead.map(s => (
                <SignalCard key={s.signalId} signal={s}
                  onTrade={onTrade} trading={false} />
              ))}
            </div>
          </details>
        )}
      </div>
    </div>
  );
}

// ─── trade history (closed) ─────────────────────────────────────────────────
function TradeHistoryTable({ trades }: { trades: IndiaTrade[] }) {
  if (trades.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-panel overflow-hidden shadow-panel">
        <div className="border-b border-border px-3 py-2">
          <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-slate-400">
            <span aria-hidden="true" className="h-[3px] w-[3px] rounded-full bg-accent/50" />
            Trade History
          </span>
        </div>
        <p className="text-xs text-slate-500 p-4 text-center">No closed trades yet — history appears after the first position closes (TP/SL/profit-target).</p>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-border bg-panel overflow-hidden shadow-panel">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-slate-400">
          <span aria-hidden="true" className="h-[3px] w-[3px] rounded-full bg-accent/50" />
          Trade History
        </span>
        <span className="text-[11px] text-slate-500">{trades.length} closed</span>
      </div>
      <div className="overflow-x-auto max-h-[380px] overflow-y-auto scroll-thin">
        <table className="w-full text-[11px]">
          <thead className="sticky top-0 bg-panel"><tr className="border-b border-border text-slate-500">
            {['Symbol','Side','Qty','Entry','Exit','P&L','Fees','Reason','Time','Held'].map(h => (
              <th key={h} className="py-1.5 px-2 text-left font-medium whitespace-nowrap">{h}</th>
            ))}
          </tr></thead>
          <tbody>
            {trades.map(t => {
              const held = t.closedAt && t.openedAt ? Math.round((t.closedAt - t.openedAt)/60000) : 0;
              const isWin = t.netPnl >= 0;
              return (
                <tr key={t.tradeId} className="border-b border-border/40 hover:bg-panel2/50">
                  <td className="py-1.5 px-2 font-mono text-slate-200 whitespace-nowrap">{t.tradingSymbol} <span className="text-slate-600">{t.optionType ?? ''} {t.strike ?? ''}</span></td>
                  <td className="py-1.5 px-2"><SidePill side={t.side} /></td>
                  <td className="py-1.5 px-2 font-mono">{t.quantity}</td>
                  <td className="py-1.5 px-2 font-mono">{fmt(t.entryPrice,2)}</td>
                  <td className="py-1.5 px-2 font-mono">{fmt(t.exitPrice,2)}</td>
                  <td className={cls('py-1.5 px-2 font-mono font-medium', isWin ? 'text-emerald-400' : 'text-red-400')}>{isWin?'+':''}{fmtCur(t.netPnl,'INR',0)} <span className="text-slate-600 text-[10px]">({fmtCur(t.grossPnl,'INR',0)})</span></td>
                  <td className="py-1.5 px-2 font-mono text-amber-400">{fmtCur(t.charges,'INR',0)}</td>
                  <td className="py-1.5 px-2 text-slate-400 whitespace-nowrap">{t.exitReason}</td>
                  <td className="py-1.5 px-2 font-mono text-slate-400 whitespace-nowrap">{fmtTime(t.closedAt)}</td>
                  <td className="py-1.5 px-2 font-mono text-slate-500">{held}m</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="border-t border-border px-3 py-2 flex gap-3 text-[11px] text-slate-500">
        <span>Wins <span className="font-mono text-emerald-400">{trades.filter(x=>x.netPnl>0).length}</span></span>
        <span>Losses <span className="font-mono text-red-400">{trades.filter(x=>x.netPnl<0).length}</span></span>
        <span>Net <span className={cls('font-mono', trades.reduce((a,b)=>a+b.netPnl,0)>=0?'text-emerald-400':'text-red-400')}>{fmtCur(trades.reduce((a,b)=>a+b.netPnl,0),'INR',0)}</span></span>
      </div>
    </div>
  );
}

// ─── positions table ──────────────────────────────────────────────────────────
function PositionsTable({ positions, ticks, account, onClose }: {
  positions: IndiaPosition[]; ticks: Record<string, { ltp: number }>;
  account: IndiaPaperAccount | null; onClose: (p: IndiaPosition) => void;
}) {
  return (
    <div className="rounded-lg border border-border bg-panel overflow-hidden shadow-panel transition-shadow duration-200 hover:shadow-lift">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-slate-400">
          <span aria-hidden="true" className="h-[3px] w-[3px] rounded-full bg-accent/50" />
          Open Positions
        </span>
        <span className={cls('text-[11px]', positions.length > 0 ? 'text-slate-400' : 'text-slate-500')}>{positions.length} open</span>
      </div>
      {positions.length === 0 ? (
        <p className="text-xs text-slate-500 p-4 text-center">No open positions</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead><tr className="border-b border-border text-slate-500">
              {['Symbol','Side','Qty','Entry','LTP','SL','Target','uPnL','Time',''].map(h => (
                <th key={h} className="py-1.5 px-2 text-left font-medium whitespace-nowrap">{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {positions.map(p => {
                const ltp = ticks[p.instrumentToken]?.ltp ?? p.currentPrice ?? p.entry;
                const upnl = (ltp - p.entry) * p.quantity * (p.side === 'BUY' ? 1 : -1);
                return (
                  <tr key={p.positionId} className="border-b border-border/40 transition-colors hover:bg-panel2">
                    <td className="py-1.5 px-2 font-mono text-slate-200 whitespace-nowrap">{p.tradingSymbol}</td>
                    <td className="py-1.5 px-2"><SidePill side={p.side} /></td>
                    <td className="py-1.5 px-2 font-mono">{p.quantity}</td>
                    <td className="py-1.5 px-2 font-mono">{fmt(p.entry, 2)}</td>
                    <td className="py-1.5 px-2 font-mono text-blue-300">{fmt(ltp, 2)}</td>
                    <td className="py-1.5 px-2 font-mono text-red-400">{fmt(p.stopLoss, 2)}</td>
                    <td className="py-1.5 px-2 font-mono text-emerald-400">{fmt(p.target, 2)}</td>
                    <td className={cls('py-1.5 px-2 font-mono font-medium', upnl >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                      {upnl >= 0 ? '+' : ''}{fmtCur(upnl, 'INR', 0)}
                    </td>
                    <td className="py-1.5 px-2 font-mono text-slate-400 whitespace-nowrap">{fmtTime(p.openedAt)}</td>
                    <td className="py-1.5 px-2">
                      <button onClick={() => onClose(p)}
                        className="press rounded border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-[10px] text-red-300 transition-colors hover:bg-red-500/20">
                        Close
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {account && (
        <div className="border-t border-border px-3 py-2 flex gap-4 flex-wrap text-[11px] text-slate-500">
          <span>Balance <span className="font-mono text-slate-200">{fmtCur(account.balance, 'INR', 0)}</span></span>
          <span>Realized <span className={cls('font-mono', account.realizedPnl >= 0 ? 'text-emerald-400' : 'text-red-400')}>{fmtCur(account.realizedPnl, 'INR', 0)}</span></span>
          <span>Unrealized <span className={cls('font-mono', account.unrealizedPnl >= 0 ? 'text-emerald-400' : 'text-red-400')}>{fmtCur(account.unrealizedPnl, 'INR', 0)}</span></span>
          <span>Fees <span className="font-mono text-amber-400">{fmtCur(account.fees, 'INR', 0)}</span></span>
        </div>
      )}
    </div>
  );
}

// ─── main page ────────────────────────────────────────────────────────────────

/**
 * How often the selected instrument's candles and analysis are re-polled.
 *
 * A named constant because the chart's error state tells the user how often it is
 * retrying, and a promise like that should not be a number typed twice in two
 * places that can drift apart.
 */
const CHART_POLL_MS = 15_000;

export function India() {
  const dispatch = useDispatch();

  // redux state
  const status      = useSelector((s: RootState) => s.india.status);
  const health      = useSelector((s: RootState) => s.india.health);
  const instruments = useSelector((s: RootState) => s.india.instruments);
  const selectedToken = useSelector((s: RootState) => s.india.selectedToken);
  const tf          = useSelector((s: RootState) => s.india.tf);
  const ticks       = useSelector((s: RootState) => s.india.ticks);
  const candles     = useSelector((s: RootState) => s.india.candles);
  const selectedCandles = selectedToken ? candles[`${selectedToken}|${tf}`] : undefined;
  const signals     = useSelector((s: RootState) => s.india.signals);
  const positions   = useSelector((s: RootState) => s.india.positions);
  const account     = useSelector((s: RootState) => s.india.account);
  const authority   = useSelector((s: RootState) => s.india.authority);
  const goals       = useSelector((s: RootState) => s.india.goals);

  // local state
  const [analysis, setAnalysis] = useState<IndiaAnalysisSnapshot | null>(null);
  /** Indicator overlays for the current token+timeframe, refreshed with the
   * chart poll. Null until the first successful indicator fetch. */
  const [chartOverlays, setChartOverlays] = useState<Array<{ name: string; color: string; points: Array<{ time: number; value: number }> }> | null>(null);
  const [goalCfg,  setGoalCfg]  = useState<EngineConfig>(defaultConfig);
  const [univCfg,  setUnivCfg]  = useState<EngineConfig>({ ...defaultConfig(), executionMode: 'MANUAL' });
  const [goalMsg,  setGoalMsg]  = useState<string | null>(null);
  const [univMsg,  setUnivMsg]  = useState<string | null>(null);
  const [goalBusy, setGoalBusy] = useState(false);
  const [univBusy, setUnivBusy] = useState(false);
  const [tradingId, setTradingId] = useState<string | null>(null);
  const [posMsg,   setPosMsg]   = useState<string | null>(null);
  const [indiaTrades, setIndiaTrades] = useState<IndiaTrade[]>([]);
  const [search,   setSearch]   = useState('');
  const [showDropdown, setShowDropdown] = useState(false);
  const [tfLoading, setTfLoading] = useState(false);
  /**
   * Why the chart has nothing to draw, once we know. Null means either "still
   * waiting on the first response" or "there is data" — the candle array itself
   * distinguishes those. What this adds is the difference between a request that
   * came back empty and one that never came back at all, which the chart used to
   * render identically: a spinner that never stopped.
   */
  const [chartIssue, setChartIssue] = useState<'empty' | 'error' | null>(null);
  const searchRef = useRef<HTMLDivElement>(null);
  /**
   * Marker for the most recent timeframe request, compared on resolution so a slower
   * earlier one cannot describe the chart the user is now looking at.
   *
   * The polling effect solves the same problem with a `cancelled` flag in its cleanup,
   * but this is an event handler and has no cleanup to hang one on, so the marker has
   * to outlive the call. Bumping it is also how `selectToken` disowns a request that
   * was made about the previous contract.
   */
  const tfRequestRef = useRef(0);

  // Immediate timeframe change with loading state
  const handleTimeframeChange = async (t: IndiaTimeframe) => {
    dispatch(actions.india.setTf(t));
    if (!selectedToken) return;

    const requestId = ++tfRequestRef.current;
    // Pinned, because the user can pick a different contract while this is in flight
    // and `selectedToken` would then read as the new one on the way back.
    const token = selectedToken;
    setTfLoading(true);
    setChartIssue(null);
    try {
      const r = await IndiaApi.candles(token, t, 5000);
      const bars = (r.candles ?? []) as IndiaCandle[];
      // Dispatched even when superseded: the slot is keyed by token and timeframe, so
      // these bars are correct for their own key and worth keeping either way.
      dispatch(actions.india.candles({
        token,
        timeframe: t,
        candles: bars,
      }));
      if (requestId === tfRequestRef.current) setChartIssue(bars.length > 0 ? null : 'empty');
    } catch (err) {
      console.error('Timeframe change candle fetch failed:', err);
      if (requestId === tfRequestRef.current) setChartIssue('error');
    } finally {
      // Only the newest request may lower the flag. Unconditionally, an earlier request
      // finishing second reports "loaded" while the current one is still fetching, and
      // the timeframe buttons come back live over a chart that has not arrived.
      if (requestId === tfRequestRef.current) setTfLoading(false);
    }
  };

  // index token map — keyed by canonical underlying name
  // Match by exact tradingSymbol first (most reliable), then fall back to underlying
  const SYMBOL_MAP: Record<IndiaUnderlying, string[]> = {
    NIFTY:      ['NIFTY'],
    BANKNIFTY:  ['BANKNIFTY'],
    FINNIFTY:   ['FINNIFTY'],
    MIDCPNIFTY: ['MIDCPNIFTY'],
  };
  const indexTokens = useMemo(() => {
    const map: Partial<Record<IndiaUnderlying, string>> = {};
    const all: IndiaUnderlying[] = ['NIFTY', 'BANKNIFTY', 'FINNIFTY'];
    for (const u of all) {
      // Pass 1: NSE_INDEX with exact tradingSymbol match
      const bySymbol = instruments.find(i =>
        i.contractType === 'INDEX' && i.segment === 'NSE_INDEX' &&
        SYMBOL_MAP[u].some(s => i.tradingSymbol.toUpperCase() === s)
      );
      if (bySymbol) { map[u] = bySymbol.instrumentToken; continue; }
      // Pass 2: NSE_INDEX with underlying match
      const byUnderlying = instruments.find(i =>
        i.contractType === 'INDEX' && i.segment === 'NSE_INDEX' && i.underlying === u
      );
      if (byUnderlying) { map[u] = byUnderlying.instrumentToken; continue; }
      // Pass 3: BSE_INDEX fallback
      const bse = instruments.find(i =>
        i.contractType === 'INDEX' && i.segment === 'BSE_INDEX' && i.underlying === u
      );
      if (bse) map[u] = bse.instrumentToken;
    }
    return map;
  }, [instruments]);

  const selectedInstr = useMemo(
    () => instruments.find(i => i.instrumentToken === selectedToken) ?? null,
    [instruments, selectedToken]);
  const selectedTick = selectedToken ? ticks[selectedToken] : undefined;

  // active signal for the selected instrument (for chart overlay)
  const chartSignal = useMemo(() => {
    const live: IndiaSignal['status'][] = ['READY', 'SIGNAL_FOUND', 'WAITING_FOR_ENTRY', 'EXECUTING', 'POSITION_OPEN', 'MONITORING'];
    const s = signals.find(x => x.instrumentToken === selectedToken && live.includes(x.status));
    if (!s) return null;
    return { direction: s.side, state: s.status, timestamp: s.createdAt,
      entry: { preferredEntry: s.entry }, stopLoss: { price: s.stopLoss },
      takeProfit: { tp1: s.target, tp2: null } } as never;
  }, [signals, selectedToken]);

  // search results
  const searchResults = useMemo(() => {
    if (!search.trim()) return [];
    const q = search.toLowerCase();
    const seen = new Set<string>();
    return instruments.filter(i => {
      if (seen.has(i.instrumentToken)) return false;
      seen.add(i.instrumentToken);
      const label = LABEL[i.underlying as IndiaUnderlying] ?? '';
      return i.tradingSymbol.toLowerCase().includes(q) ||
        i.underlying.toLowerCase().includes(q) ||
        label.toLowerCase().includes(q) ||
        (i.name ?? '').toLowerCase().includes(q) ||
        (i.strike !== null && String(i.strike).includes(q)) ||
        (i.optionType ?? '').toLowerCase() === q;
    }).slice(0, 60);
  }, [instruments, search]);

  // goal/universal signals
  const goalSignals = useMemo(() => signals.filter(s => s.owner === 'GOAL').slice(0, 30), [signals]);
  const univSignals = useMemo(() => signals.filter(s => s.owner === 'UNIVERSAL').slice(0, 30), [signals]);
  const activeGoal  = goals.find(g => g.status === 'ACTIVE') ?? null;

  // close dropdown when clicking outside
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) setShowDropdown(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  // refresh helpers
  const refreshAll = useCallback(async () => {
    try { dispatch(actions.india.setStatus(await IndiaApi.status() as never)); } catch {}
    try { dispatch(actions.india.setHealth(await IndiaApi.health() as never)); } catch {}
    try { dispatch(actions.india.signals(await IndiaApi.signals() as IndiaSignal[])); } catch {}
    try {
      const [pos, acc, g, auth] = await Promise.all([
        IndiaApi.positions(), IndiaApi.account(), IndiaApi.goals(), IndiaApi.authority()]);
      dispatch(actions.india.positions(pos as IndiaPosition[]));
      dispatch(actions.india.account(acc as IndiaPaperAccount));
      dispatch(actions.india.goals(g as IndiaGoal[]));
      dispatch(actions.india.authority(auth as IndiaExecutionAuthorityState));
    } catch {}
  }, [dispatch]);

  useEffect(() => {
    void refreshAll();
    const id = setInterval(refreshAll, 10_000);
    return () => clearInterval(id);
  }, [refreshAll]);

  // Trade history — closed trades are the only place P&L becomes real. The
  // previous view had no table at all, so `GET /india/trades` was never called
  // and the user saw "no history" while the `test` DB held 70+ rows.
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = (await IndiaApi.trades()) as unknown;
        const list: IndiaTrade[] = Array.isArray(res)
          ? (res as IndiaTrade[])
          : ((res as { trades?: IndiaTrade[] })?.trades ?? (res as IndiaTrade[]) ?? []);
        if (alive) setIndiaTrades(Array.isArray(list) ? list : []);
      } catch {
        /* keep last */
      }
    };
    void load();
    const id = setInterval(load, 10_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  // Load the user's saved trading settings once and seed both engine forms, so
  // what the dashboard shows is what the engines actually use (and vice versa).
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  useEffect(() => {
    if (settingsLoaded) return;
    (async () => {
      try {
        const s = await IndiaApi.userSettings();
        setGoalCfg((c) => ({
          ...c,
          amountInr: Number(s.amountInr) || c.amountInr,
          minimumProfitInr: Number(s.minimumProfitInr) || c.minimumProfitInr,
          maxRiskInr: Number(s.maxRiskInr) || c.maxRiskInr,
          maxMarginPercent: Number(s.maxMarginPercent) || c.maxMarginPercent,
        }));
        setUnivCfg((c) => ({
          ...c,
          amountInr: Number(s.amountInr) || c.amountInr,
          minimumProfitInr: Number(s.minimumProfitInr) || c.minimumProfitInr,
          maxRiskInr: Number(s.maxRiskInr) || c.maxRiskInr,
          maxMarginPercent: Number(s.maxMarginPercent) || c.maxMarginPercent,
        }));
      } catch { /* defaults remain until first successful save */ }
      setSettingsLoaded(true);
    })();
  }, [settingsLoaded]);

  // instrument master
  useEffect(() => {
    const fetch = async () => {
      try { dispatch(actions.india.instruments(await IndiaApi.instruments() as IndiaInstrument[])); } catch {}
    };
    void fetch();
    const id = setInterval(fetch, 30_000);
    return () => clearInterval(id);
  }, [dispatch]);

  // auto-select NIFTY on first load
  useEffect(() => {
    if (selectedToken) return;
    const tok = indexTokens['NIFTY'];
    if (tok) dispatch(actions.india.select(tok));
  }, [indexTokens, selectedToken, dispatch]);

  // PRE-FETCH: Load primary index data on mount for dashboard tiles
  useEffect(() => {
    const primaryTokens = [indexTokens['NIFTY'], indexTokens['BANKNIFTY'], indexTokens['FINNIFTY']].filter(Boolean) as string[];
    if (primaryTokens.length === 0) return;

    const loadPrimary = async () => {
      for (const token of primaryTokens) {
        try {
          // Fetch 5m candles for dashboard display (use same TF for consistency)
          const r = await IndiaApi.candles(token, '5m', 5000);
          dispatch(actions.india.candles({ token, timeframe: '5m', candles: (r.candles ?? []) as IndiaCandle[] }));
        } catch {}
      }
    };
    void loadPrimary();
    // Refresh every 30s to keep dashboard tiles updated
    const id = setInterval(loadPrimary, 30_000);
    return () => clearInterval(id);
  }, [indexTokens, dispatch]);

  // candles + analysis for selected token - AUTO-LOAD on mount
  useEffect(() => {
    if (!selectedToken) return;
    const token = selectedToken;
    const effectiveTf: IndiaTimeframe = tf || '5m';
    // A new instrument or timeframe is an open question again, not a continuation
    // of the last answer.
    setChartIssue(null);
    // Overlays from the previous chart must not survive the switch: for one poll
    // cycle they would draw the old contract's averages over the new one's bars.
    setChartOverlays(null);
    // Nothing here can cancel an HTTP request, but a response that arrives after
    // the user has moved on must not be allowed to describe the chart they are now
    // looking at. Switching timeframe mid-poll otherwise let the old timeframe's
    // verdict land last: 5m had bars, so this went back to null while 15m was
    // genuinely empty, and the fallback dropped to the spinner for another 15
    // seconds — the "chart never loads" symptom, manufactured by the very state
    // that was added to explain it.
    let cancelled = false;
    const load = async () => {
      try {
        const r = await IndiaApi.candles(token, effectiveTf, 5000);
        const bars = (r.candles ?? []) as IndiaCandle[];
        // Dispatched even when cancelled: the slot is keyed by token and timeframe,
        // so these bars are correct for their own key and worth keeping. It is only
        // the verdict below, which speaks for whatever is on screen now, that has to
        // stand down.
        dispatch(actions.india.candles({ token, timeframe: effectiveTf, candles: bars }));
        // An empty response is a real answer — the contract has no bars in the
        // window the broker was asked for — and the chart is allowed to say so.
        if (!cancelled) setChartIssue(bars.length > 0 ? null : 'empty');
      } catch { if (!cancelled) setChartIssue('error'); }
      try {
        const snap = await IndiaApi.analysis(token) as IndiaAnalysisSnapshot;
        if (!cancelled) setAnalysis(snap);
      } catch {}
      try {
        const ind = await IndiaApi.indicators(token, effectiveTf) as { series?: Record<string, Array<{ time: number; value: number }>> };
        const s = ind.series ?? {};
        const next = [
          { name: 'EMA 9', color: '#38BDF8', points: s.ema9 ?? [] },
          { name: 'EMA 20', color: '#A78BFA', points: s.ema20 ?? [] },
          { name: 'SMA 20', color: '#F472B6', points: s.sma20 ?? [] },
        ].filter((o) => o.points.length > 0);
        if (!cancelled) setChartOverlays(next);
      } catch { /* overlays are decorative; candles still render without them */ }
    };
    void load();
    const id = setInterval(load, CHART_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [selectedToken, tf, dispatch]);

  const selectToken = (tok: string) => {
    // `chartIssue` is reset here as well as in the effect above, because effects run
    // after paint: without this, picking a new contract commits one frame still
    // holding the previous one's verdict, and the empty-state heading interpolates
    // the *new* symbol into it — "No 5m candles for NIFTY24900CE" about a contract
    // nobody has asked the broker about yet.
    //
    // Bumping `tfRequestRef` disowns any timeframe request still in flight for the
    // contract being left behind. `tfLoading` has to be lowered by hand in the same
    // breath: a disowned request no longer passes its own `finally` guard, so nothing
    // else would ever lower it and the timeframe buttons would stay dead.
    tfRequestRef.current += 1;
    setTfLoading(false);
    dispatch(actions.india.select(tok)); setAnalysis(null); setChartIssue(null); setSearch(''); setShowDropdown(false);
  };

  // trade handler
  const handleTrade = async (signal: IndiaSignal) => {
    setTradingId(signal.signalId);
    try {
      await IndiaApi.executeSignal(signal.signalId);
      await refreshAll();
    } catch (e) {
      setPosMsg(e instanceof Error ? e.message : 'trade failed');
    } finally {
      setTradingId(null);
    }
  };

  // goal actions
  const startGoal = async () => {
    setGoalBusy(true); setGoalMsg(null);
    try {
      // Persist the form's values FIRST: sizing, profit-taking and portfolio
      // caps all read these live — starting an engine must never leave the
      // engines trading on stale numbers.
      await IndiaApi.saveUserSettings({
        amountInr: goalCfg.amountInr,
        minimumProfitInr: goalCfg.minimumProfitInr,
        maxRiskInr: goalCfg.maxRiskInr,
        maxMarginPercent: goalCfg.maxMarginPercent,
      });
      await IndiaApi.startGoal({ ...goalCfg, tradeUnderlyings: goalCfg.tradeUnderlyings });
      setGoalMsg('Goal started — scanning for signals');
      await refreshAll();
    } catch (e) { setGoalMsg(e instanceof Error ? e.message : 'start failed'); }
    finally { setGoalBusy(false); }
  };
  const stopGoal = async () => {
    setGoalBusy(true);
    try {
      await IndiaApi.stopGoal(activeGoal?.goalId);
      // Clear immediately so UI shows form instead of "RUNNING" while refreshAll runs
      dispatch(actions.india.goals([]));
      setGoalMsg('Goal stopped');
      await refreshAll();
    } catch (e) { setGoalMsg(e instanceof Error ? e.message : 'stop failed'); }
    finally { setGoalBusy(false); }
  };

  // universal actions
  const startUniversal = async () => {
    setUnivBusy(true); setUnivMsg(null);
    try {
      // Persist the form's values FIRST — universal sizing, the min-profit
      // exit and the portfolio caps all read these live.
      await IndiaApi.saveUserSettings({
        amountInr: univCfg.amountInr,
        minimumProfitInr: univCfg.minimumProfitInr,
        maxRiskInr: univCfg.maxRiskInr,
        maxMarginPercent: univCfg.maxMarginPercent,
      });
      await IndiaApi.setAuthority({ owner: 'UNIVERSAL', universalMode: univCfg.executionMode });
      setUnivMsg(`Universal signals active — mode ${univCfg.executionMode}`);
      await refreshAll();
    } catch (e) { setUnivMsg(e instanceof Error ? e.message : 'failed'); }
    finally { setUnivBusy(false); }
  };
  const stopUniversal = async () => {
    setUnivBusy(true);
    try {
      await IndiaApi.setAuthority({ universalMode: 'OFF' });
      setUnivMsg('Universal stopped');
      await refreshAll();
    } catch (e) { setUnivMsg(e instanceof Error ? e.message : 'failed'); }
    finally { setUnivBusy(false); }
  };

  const closePosition = async (p: IndiaPosition) => {
    try {
      await IndiaApi.closePosition(p.positionId);
      setPosMsg(`Closed ${p.tradingSymbol}`);
      await refreshAll();
    } catch (e) { setPosMsg(e instanceof Error ? e.message : 'close failed'); }
  };

  // derived values
  const healthState = health?.dataHealth?.state ?? 'DISCONNECTED';
  const marketOpen  = status?.session?.marketOpen ?? false;
  const healthColor = healthState === 'HEALTHY' ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10'
    : healthState === 'MARKET_CLOSED' ? 'text-amber-400 border-amber-500/30 bg-amber-500/10'
    : 'text-red-400 border-red-500/30 bg-red-500/10';
  /** Underlying whose option chain applies to the selection — null when there is
   *  none, so the context strip can say so rather than guess at NIFTY. */
  const optionUnderlying = selectedInstr?.underlying && HAS_OPTION_CHAIN.has(selectedInstr.underlying)
    ? selectedInstr.underlying
    : null;

  return (
    <div className="space-y-4 text-sm">

      {/* ── Status bar ──────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-base font-bold text-slate-100 tracking-tight">NSE Markets</h1>
          <p className="text-[11px] text-slate-500 mt-0.5">
            {status?.feedSource ?? status?.broker ?? 'No broker configured'} ·{' '}
            {status?.liveExecution ? 'LIVE' : 'Paper Mode'} · IST {status?.session?.ist ?? '--:--'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className={cls('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium backdrop-blur-sm', healthColor)}>
            {(healthState === 'HEALTHY' || marketOpen) && (
              <span aria-hidden="true" className={cls('live-dot', healthState === 'HEALTHY' ? 'text-emerald-400' : 'text-current')} />
            )}
            {healthState}
          </span>
          <span className={cls('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium backdrop-blur-sm',
            marketOpen ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10'
              : 'text-slate-400 border-slate-500/30 bg-slate-500/10')}>
            {marketOpen && <span aria-hidden="true" className="live-dot text-emerald-400" />}
            {status?.session?.status ?? 'CLOSED'}
          </span>
          {authority?.owner !== 'NONE' && authority?.owner && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-blue-300/25 bg-blue-300/[0.07] px-2.5 py-0.5 text-[11px] font-medium text-blue-200 shadow-glow-live">
              {authority.owner} owns execution
            </span>
          )}
        </div>
      </div>

      {/* ── Session arc + option context ─────────────────────────────────────── */}
      {/* Where we are in the trading day relative to the windows the engine will
          actually enter in, plus the option-book facts that change how a position
          behaves. Above the index tiles because it frames everything below it. */}
      <ContextStrip session={status?.session} underlying={optionUnderlying} />

      {/* ── Index tiles ─────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-3 gap-2">
        {TRADING_UNDERLYINGS.map(u => {
          const tok = indexTokens[u];
          const instr = tok ? instruments.find(i => i.instrumentToken === tok) : null;
          const tick = tok ? ticks[tok] : undefined;

          // Fallback: use last candle close when no live tick (market closed / analytics token)
          const candleKey = tok ? candles[`${tok}|${tf}`] : undefined;
          const lastCandle = candleKey && candleKey.length > 0 ? candleKey[candleKey.length - 1] : undefined;
          const prevCandle = candleKey && candleKey.length > 1 ? candleKey[candleKey.length - 2] : undefined;

          const ltp = tick?.ltp ?? lastCandle?.close ?? null;
          const prevClose = tick?.previousClose ?? prevCandle?.close ?? null;
          const dayHigh = tick?.dayHigh ?? null;
          const dayLow = tick?.dayLow ?? null;

          const chg = ltp && prevClose ? ((ltp - prevClose) / prevClose) * 100 : null;
          // Where the last price sits inside today's range — a one-glance read
          // of whether the day has room above or below. Pure presentation over
          // fields already on screen.
          const rangePos = ltp != null && dayHigh != null && dayLow != null && dayHigh > dayLow
            ? Math.min(100, Math.max(0, ((ltp - dayLow) / (dayHigh - dayLow)) * 100))
            : null;

          return (
            <button key={u} disabled={!tok} onClick={() => tok && selectToken(tok)}
              className={cls('sheen group relative overflow-hidden rounded-lg border p-3 text-left transition-all duration-200 press',
                selectedToken === tok
                  ? 'border-blue-300/40 bg-blue-300/[0.08] shadow-lift'
                  : 'border-border bg-panel2 hover:border-slate-600 hover:shadow-lift',
                !tok && 'opacity-40 cursor-not-allowed')}>
              {/* Selected halo: light pooling under the active instrument. */}
              {selectedToken === tok && (
                <span aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-lg"
                  style={{ background: 'radial-gradient(420px 120px at 50% -30%, rgba(213,209,196,0.09), transparent 70%)' }} />
              )}
              <div className="relative flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-300">{LABEL[u]}</span>
                {chg !== null && (
                  <span className={cls('rounded-full px-1.5 py-px text-[10px] font-medium font-mono',
                    chg >= 0 ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400')}>
                    {chg >= 0 ? '+' : ''}{chg.toFixed(2)}%
                  </span>
                )}
              </div>
              <div className={cls('num-display relative mt-1.5 text-[22px] font-semibold leading-none',
                ltp === null ? 'text-slate-500' : chg === null ? 'text-slate-300' : chg >= 0 ? 'text-emerald-300' : 'text-red-300')}>
                {ltp !== null ? ltp.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : instr ? '—' : 'N/A'}
              </div>
              {/* Day range track: low ·——· high with a marker at the last price. */}
              {rangePos !== null && (
                <div className="relative mt-2 h-[3px] w-full rounded-full bg-border" aria-hidden="true">
                  <div className="absolute inset-y-0 left-0 rounded-full transition-all duration-500"
                    style={{ width: `${rangePos}%`, background: (chg ?? 0) >= 0
                      ? 'linear-gradient(to right, rgba(52,214,160,0.15), rgba(52,214,160,0.6))'
                      : 'linear-gradient(to right, rgba(255,107,94,0.15), rgba(255,107,94,0.6))' }} />
                  <span className="absolute top-1/2 h-[7px] w-[7px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-panel bg-slate-100 transition-all duration-500"
                    style={{ left: `${rangePos}%` }} />
                </div>
              )}
              <div className="relative mt-1.5 flex gap-3 text-[10px] text-slate-600">
                {dayHigh != null && <span className="text-emerald-600">H {dayHigh.toLocaleString('en-IN')}</span>}
                {dayLow  != null && <span className="text-red-600">L {dayLow.toLocaleString('en-IN')}</span>}
                {lastCandle && !tick && (
                  <span className="text-slate-500">prev close</span>
                )}
                {tick?.volume != null && <span>{(tick.volume / 1000).toFixed(0)}K</span>}
              </div>
            </button>
          );
        })}
      </div>

      {/* ── Chart + right column ─────────────────────────────────────────────── */}
      <div className="grid gap-3 lg:grid-cols-[1fr_320px]">

        {/* LEFT: search + timeframes + chart */}
        <div className="space-y-2">

          {/* Search + timeframes */}
          <div className="flex flex-wrap items-center gap-2">
            <div ref={searchRef} className="relative flex-1 min-w-[200px]">
              {/* Decorative magnifier: the affordance of search without a word. */}
              <svg aria-hidden="true" width="13" height="13" viewBox="0 0 16 16" fill="none"
                stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-600">
                <circle cx="7" cy="7" r="4.4" /><path d="M10.4 10.4 14 14" />
              </svg>
              <input value={search} onChange={e => { setSearch(e.target.value); setShowDropdown(true); }}
                onFocus={() => setShowDropdown(true)}
                placeholder="Search NIFTY 50, CE, PE, strike…"
                className="w-full rounded-md border border-border bg-panel2 py-1.5 pl-8 pr-7 text-xs text-slate-200 placeholder-slate-600 shadow-panel transition-all focus:border-blue-300/60 focus:outline-none focus:ring-2 focus:ring-blue-300/15" />
              {search && <button onClick={() => { setSearch(''); setShowDropdown(false); }}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 transition-colors hover:text-slate-200">✕</button>}
              {showDropdown && searchResults.length > 0 && (
                <div className="animate-slide-up absolute top-full mt-1 z-50 max-h-60 w-full overflow-y-auto scroll-thin rounded-lg border border-border bg-panel shadow-lift backdrop-blur">
                  {searchResults.map(i => (
                    <button key={i.instrumentToken} onClick={() => selectToken(i.instrumentToken)}
                      className="block w-full px-3 py-1.5 text-left text-xs transition-colors hover:bg-panel2">
                      <span className="font-mono text-slate-200">{i.tradingSymbol}</span>
                      {i.contractType === 'OPT' && (
                        <span className={cls('ml-2 text-[10px]', i.optionType === 'CE' ? 'text-emerald-400' : 'text-red-400')}>
                          {i.optionType} ₹{i.strike}
                        </span>
                      )}
                      <span className="ml-2 text-[10px] text-slate-600">lot {i.lotSize}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="flex rounded-md border border-border bg-panel2 p-0.5 shadow-panel">
              {INDIA_TIMEFRAMES.map(t => (
                <button key={t} onClick={() => handleTimeframeChange(t)}
                  disabled={tfLoading}
                  className={cls('press rounded px-2 py-1 text-[11px] font-medium transition-all',
                    tf === t
                      ? 'bg-blue-300/15 text-blue-100 shadow-glow-live'
                      : 'text-slate-500 hover:text-slate-200',
                    tfLoading && 'opacity-50 cursor-wait')}>
                  {t}
                </button>
              ))}
            </div>
            {selectedInstr && selectedTick && (
              <span className="ml-auto font-mono text-xs text-slate-300 whitespace-nowrap">
                <span className="text-slate-500 mr-1">{selectedInstr.tradingSymbol}</span>
                {selectedTick.ltp.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                {selectedTick.previousClose != null && (
                  <span className={cls('ml-1', selectedTick.ltp >= selectedTick.previousClose ? 'text-emerald-400' : 'text-red-400')}>
                    {selectedTick.ltp >= selectedTick.previousClose ? '▲' : '▼'}
                    {Math.abs(((selectedTick.ltp - selectedTick.previousClose) / selectedTick.previousClose) * 100).toFixed(2)}%
                  </span>
                )}
              </span>
            )}
          </div>

          {/* Chart */}
          <div className="rounded-lg border border-border bg-panel overflow-hidden shadow-panel transition-shadow duration-200 hover:shadow-lift">
            {chartOverlays && chartOverlays.length > 0 && (
              <div className="flex items-center gap-3 px-3 pt-2 text-[10px] text-slate-500">
                {chartOverlays.map(o => (
                  <span key={o.name} className="flex items-center gap-1">
                    <span className="inline-block h-0.5 w-3 rounded" style={{ background: o.color }} />
                    {o.name}
                  </span>
                ))}
              </div>
            )}
            {selectedCandles && (selectedCandles as IndiaCandle[]).length > 0 ? (
              <CandleChart candles={selectedCandles as never} symbol={selectedInstr?.tradingSymbol ?? ''}
                signal={chartSignal} tick={selectedTick ? { mid: selectedTick.ltp } : null}
                overlays={chartOverlays ?? undefined}
                timeOffsetMs={19800000} />
            ) : (
              <div className="flex h-[380px] flex-col items-center justify-center gap-2 px-6">
                {instruments.length === 0 ? (
                  <p className="text-xs text-slate-500 max-w-xs text-center">
                    No instruments loaded. Configure Upstox/Zerodha in <code className="bg-panel2 px-1 rounded">.env</code> and restart.
                  </p>
                ) : chartIssue === 'error' ? (
                  <>
                    <p className="text-xs text-down">Could not reach the candle feed.</p>
                    <p className="max-w-sm text-center text-[11px] leading-relaxed text-slate-600">
                      Retrying every {Math.round(CHART_POLL_MS / 1000)} seconds. Check that the backend is running and
                      the broker session is still valid.
                    </p>
                  </>
                ) : chartIssue === 'empty' ? (
                  <>
                    <p className="text-xs text-slate-400">
                      No {tf} candles for {selectedInstr?.tradingSymbol ?? 'this contract'}.
                    </p>
                    {/* The explanation is conditioned on what we actually know. Blaming
                        thin trading reads as authoritative, and is simply wrong for an
                        index — where an empty response means the history itself is
                        missing, not that nobody traded. */}
                    <p className="max-w-sm text-center text-[11px] leading-relaxed text-slate-600">
                      {selectedInstr?.optionType != null
                        ? 'The broker returned no history for this strike, usually because it has not printed a trade. A nearer strike, or a longer timeframe, will normally have bars.'
                        : 'The broker returned no history for this instrument over the period requested.'}
                    </p>
                  </>
                ) : <><span className="flex items-end gap-[3px]" aria-hidden="true">
                     <span className="h-2.5 w-[3px] animate-breathe rounded-full bg-slate-500" style={{ animationDelay: '0ms' }} />
                     <span className="h-4 w-[3px] animate-breathe rounded-full bg-slate-400" style={{ animationDelay: '160ms' }} />
                     <span className="h-2.5 w-[3px] animate-breathe rounded-full bg-slate-500" style={{ animationDelay: '320ms' }} />
                   </span>
                      <span className="text-xs text-slate-500">Loading chart…</span></>}
              </div>
            )}
            {/* Analysis strip — the instrument's read-out line under the glass. */}
            {analysis && (
              <div className="border-t border-border px-3 py-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] bg-edge">
                <span className="text-slate-500">Regime <span className="text-slate-300">{analysis.regime}</span></span>
                <span className="text-slate-500">Trend <span className={
                  analysis.trend === 'BULLISH' ? 'text-emerald-400' : analysis.trend === 'BEARISH' ? 'text-red-400' : 'text-amber-400'
                }>{analysis.trend}</span></span>
                {analysis.riskContext && <>
                  <span className="text-slate-500">RSI <span className="text-slate-300 font-mono">{fmt(Number(analysis.riskContext.rsi), 0)}</span></span>
                  <span className="text-slate-500">ADX <span className="text-slate-300 font-mono">{fmt(Number(analysis.riskContext.adx), 0)}</span></span>
                </>}
                <span className="text-slate-500">S <span className="text-emerald-500 font-mono">{fmt(analysis.support, 2)}</span></span>
                <span className="text-slate-500">R <span className="text-red-500 font-mono">{fmt(analysis.resistance, 2)}</span></span>
                <span className="text-slate-500">Conf <span className="text-slate-300">{fmt(analysis.confidence * 100, 0)}%</span></span>
                {analysis.prediction?.available && (
                  <span className="text-slate-500">AI <span className="text-blue-400">{fmt((analysis.prediction.probability ?? 0) * 100, 0)}%</span></span>
                )}
              </div>
            )}
          </div>

          {/* Option chain ladder — under the chart, where the book that will move
              the price belongs. Collapsed until asked for: it is the heaviest
              request in the view. */}
          {optionUnderlying && <OptionChainPanel underlying={optionUnderlying} />}

           {/* Positions */}
           <PositionsTable positions={positions} ticks={ticks as never}
             account={account} onClose={closePosition} />
           {posMsg && <p className="text-[11px] text-amber-400 px-1">{posMsg}</p>}

           {/* Trade History — closed, settled P&L (was never fetched) */}
           <TradeHistoryTable trades={indiaTrades} />

           <Divider />

          {/* Goal Signals */}
          <SignalsFeed title="Goal Signals" signals={goalSignals}
            onTrade={handleTrade} tradingId={tradingId} />

          {/* Universal Signals */}
          <SignalsFeed title="Universal Signals" signals={univSignals}
            onTrade={handleTrade} tradingId={tradingId} />

          {/* Setups the engine declined — the other half of the signal feed, and
              the only place a quiet session gets explained. */}
          <WhyNoTradeFeed />
        </div>

        {/* RIGHT: account + engines */}
        <div className="space-y-3">

          {/* Paper account */}
          <div className="sheen relative overflow-hidden rounded-lg border border-border bg-panel shadow-panel transition-shadow duration-200 hover:shadow-lift">
            <div className="border-b border-border px-3 py-2 flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-slate-400">
                <span aria-hidden="true" className="h-[3px] w-[3px] rounded-full bg-accent/50" />
                Paper Account
              </span>
              {account && <span className={cls('num-display text-[11px] font-medium',
                account.equity >= account.startingBalance ? 'text-emerald-400' : 'text-red-400')}>
                {fmtCur(account.equity, 'INR', 0)}
              </span>}
            </div>
            <div className="p-3">
              {account ? (
                <div className="grid grid-cols-2 gap-2">
                  <StatBox label="Balance" value={fmtCur(account.balance, 'INR', 0)} />
                  <StatBox label="Free Margin" value={fmtCur(account.freeMargin, 'INR', 0)} />
                  <StatBox label="Realized P&L" value={fmtCur(account.realizedPnl, 'INR', 0)}
                    color={account.realizedPnl >= 0 ? 'text-emerald-400' : 'text-red-400'} />
                  <StatBox label={`Open (${account.openPositionCount})`} value={fmtCur(account.unrealizedPnl, 'INR', 0)}
                    color={account.unrealizedPnl >= 0 ? 'text-emerald-400' : 'text-red-400'} />
                </div>
              ) : <p className="text-xs text-slate-500">No account — initialises on first paper trade</p>}
            </div>
          </div>

          {/* Goal Trading */}
          <EnginePanel owner="GOAL" activeGoal={activeGoal} authority={authority}
            config={goalCfg} setConfig={setGoalCfg}
            onStart={startGoal} onStop={stopGoal}
            busy={goalBusy} msg={goalMsg} />

          {/* Universal Signals */}
          <EnginePanel owner="UNIVERSAL" activeGoal={null} authority={authority}
            config={univCfg} setConfig={setUnivCfg}
            onStart={startUniversal} onStop={stopUniversal}
            busy={univBusy} msg={univMsg} />

        </div>

        {/* RIGHT BOTTOM: Analytics Panels */}
        <div className="space-y-3">
          
          {/* Performance Analytics */}
          <PerformanceAnalyticsDashboard days={30} />
          
          {/* Multi-Timeframe Context */}
          {selectedToken && (
            <MultiTimeframePanel instrumentToken={selectedToken} />
          )}
          
          {/* Option Analytics */}
          {optionUnderlying && <OptionAnalyticsPanel underlying={optionUnderlying} />}

        </div>
      </div>
    </div>
  );
}
