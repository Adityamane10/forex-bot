/**
 * Live status bar — the always-visible transport strip.
 *
 * One glance answers: is the realtime link up, what mode is the feed in, is
 * the ML engine healthy, may orders dispatch, and how many positions are
 * open. Data comes from the Redux store (system.status, paper account) which
 * the socket layer keeps fresh.
 */
import { useSelector } from 'react-redux';
import type { RootState } from '../store';
import { isSoundMuted, setSoundMuted } from './live';
import { useState } from 'react';

function Dot({ ok, warn }: { ok: boolean; warn?: boolean }) {
  if (ok) return <span className="live-dot text-emerald-400" aria-hidden="true" />;
  return <span className={`h-1.5 w-1.5 rounded-full ${warn ? 'bg-amber-400' : 'bg-red-400'}`} aria-hidden="true" />;
}

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap">
      <span className="hidden font-mono text-[9px] uppercase tracking-[0.08em] text-slate-600 sm:inline">{label}</span>
      {children}
    </span>
  );
}

export function StatusBar() {
  const status = useSelector((s: RootState) => s.system.status);
  const wsConnected = useSelector((s: RootState) => s.system.wsConnected);
  const account = useSelector((s: RootState) => s.paper.account);
  const mode = useSelector((s: RootState) => s.market.mode);
  const [muted, setMuted] = useState(isSoundMuted());

  const ai = status?.components?.find((c) => c.name === 'Python AI');
  const md = status?.components?.find((c) => c.name === 'Market Data');
  const gateOpen = status?.signalGenerationAllowed ?? false;

  return (
    <div className="flex items-center gap-x-4 gap-y-1 overflow-x-auto border-t border-border bg-panel/80 px-3 py-1 backdrop-blur" style={{ scrollbarWidth: 'none' }}>
      <Cell label="link">
        <Dot ok={wsConnected} />
        <span className={`font-mono text-[10px] uppercase tracking-[0.08em] ${wsConnected ? 'text-slate-400' : 'text-red-300'}`}>{wsConnected ? 'Live' : 'Offline'}</span>
      </Cell>
      <Cell label="feed">
        <span className={`font-mono text-[10px] uppercase tracking-[0.08em] ${mode === 'LIVE' ? 'text-emerald-300/90' : 'text-amber-300/90'}`}>{mode || '…'}</span>
      </Cell>
      <Cell label="latency">
        {md?.latencyMs != null
          ? <span className="font-mono text-[10px] text-slate-400">{md.latencyMs < 1000 ? `${md.latencyMs}ms` : `${(md.latencyMs / 1000).toFixed(1)}s`}</span>
          : <span className="font-mono text-[10px] text-slate-600">—</span>}
      </Cell>
      <Cell label="ml">
        <Dot ok={ai?.status === 'HEALTHY'} warn={ai?.status === 'WARNING'} />
        <span className={`font-mono text-[10px] uppercase tracking-[0.08em] ${ai?.status === 'HEALTHY' ? 'text-slate-400' : 'text-amber-300'}`}>{ai?.status ?? '…'}</span>
      </Cell>
      <Cell label="signals">
        <Dot ok={gateOpen} warn={!gateOpen} />
        <span className={`font-mono text-[10px] uppercase tracking-[0.08em] ${gateOpen ? 'text-slate-400' : 'text-amber-300'}`}>{gateOpen ? 'allowed' : 'stopped'}</span>
      </Cell>
      <Cell label="pos">
        <span className="font-mono text-[10px] text-slate-400">{account?.openPositionCount ?? 0}</span>
      </Cell>
      <Cell label="equity">
        <span className="font-mono text-[10px] text-slate-300">
          {account ? `${account.equity.toFixed(2)} ${account.currency}` : '—'}
        </span>
      </Cell>
      <button
        onClick={() => { const next = !muted; setMuted(next); setSoundMuted(next); }}
        className="ml-auto whitespace-nowrap rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.08em] text-slate-500 transition-colors hover:bg-panel2 hover:text-slate-300"
        title={muted ? 'Sound alerts are muted' : 'Sound alerts are on'}
      >
        {muted ? '🔇 muted' : '🔊 sound'}
      </button>
    </div>
  );
}
