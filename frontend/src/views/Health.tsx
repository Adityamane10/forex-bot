import { useEffect, useState } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../store';
import { Card, Table, StatusBadge, Badge, Stat } from '../components/ui';
import { timeAgo } from '../format';
import { api } from '../api';
import { ComponentStatus } from '@fx/shared';
import { toast } from '../components/live';

interface ReconciliationView {
  at: number;
  brokerPositions: number;
  paperPositions: number;
  matched: number;
  closedAsBrokerClosed: Array<{ positionId: string; symbol: string; exitPrice: number }>;
  divergences: Array<{ positionId: string; symbol: string; kind: string; paperLots?: number; brokerLots?: number }>;
  brokerOnly: Array<{ ticket: number; symbol: string; lots: number }>;
}

type EmergencyState = { triggered: boolean; reason: string; triggeredAt: number | null };

/**
 * Broker↔dashboard truth loop. Polled every 15s; the backend recomputes the
 * diff on every worker heartbeat, so what is shown here is the last verified
 * state — never an invention.
 */
function ReconciliationPanel() {
  const [rec, setRec] = useState<ReconciliationView | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    const load = () => {
      void api<ReconciliationView>('/mt5/reconciliation')
        .then((r) => { setRec(r); setUnavailable(false); })
        .catch(() => setUnavailable(true));
    };
    load();
    const id = window.setInterval(load, 15_000);
    return () => window.clearInterval(id);
  }, []);
  if (unavailable) {
    return <div className="text-xs text-slate-500">No reconciliation report yet — the MT5 worker has not delivered a heartbeat with positions (or the mirror is offline).</div>;
  }
  if (!rec) return <div className="text-xs text-slate-500">Loading…</div>;
  const healthy = rec.divergences.length === 0 && rec.brokerOnly.length === 0;
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Broker positions" value={rec.brokerPositions} />
        <Stat label="Dashboard positions" value={rec.paperPositions} />
        <Stat label="Matched" value={rec.matched} />
        <Stat label="Divergences" value={rec.divergences.length + rec.brokerOnly.length} />
      </div>
      {healthy ? (
        <div className="flex items-center gap-2 text-xs text-emerald-300"><span className="live-dot text-emerald-400" />In sync — last verified {timeAgo(rec.at)}</div>
      ) : (
        <div className="space-y-1">
          {rec.divergences.map((d) => (
            <div key={d.positionId + d.kind} className="rounded border border-amber-500/30 bg-amber-500/[0.06] px-2.5 py-1.5 text-xs text-amber-200">
              {d.kind === 'VOLUME_DRIFT'
                ? `${d.symbol}: dashboard ${d.paperLots} lots vs broker ${d.brokerLots} lots`
                : `${d.symbol}: direction mismatch`}
            </div>
          ))}
          {rec.brokerOnly.map((b) => (
            <div key={b.ticket} className="rounded border border-slate-100/15 bg-panel2 px-2.5 py-1.5 text-xs text-slate-300">
              Broker-only position #{b.ticket}: {b.symbol} {b.lots} lots (placed in the terminal directly — not platform-managed)
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Health() {
  const status = useSelector((s: RootState) => s.system.status);
  const wsConnected = useSelector((s: RootState) => s.system.wsConnected);
  const alerts = useSelector((s: RootState) => s.system.alerts);
  const [emergency, setEmergency] = useState<EmergencyState | null>(null);
  const [busy, setBusy] = useState(false);

  const loadEmergency = async () => {
    try {
      const d = (await api<{ emergencyStop?: EmergencyState }>('/system/status')) as { emergencyStop?: EmergencyState };
      setEmergency(d.emergencyStop ?? null);
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    void api('/system/status').then(() => undefined).catch(() => undefined);
    void loadEmergency();
  }, []);

  const setEmergencyStop = async (action: 'trigger' | 'release') => {
    setBusy(true);
    try {
      await api('/system/emergency-stop', {
        method: 'POST',
        body: JSON.stringify({ action, reason: action === 'trigger' ? 'manual emergency stop from System view' : 'manual release from System view' }),
      });
      await loadEmergency();
    } catch {
      /* ignore */
    } finally {
      setBusy(false);
    }
  };

  const rows = status?.components ?? [];

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-slate-100">System Health</h1>

      <Card title="Emergency Stop (spec §90)">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <Badge tone={emergency?.triggered ? 'red' : 'up'}>
            {emergency?.triggered ? 'TRIGGERED' : 'ARMED / NORMAL'}
          </Badge>
          {emergency?.triggered && (
            <span className="text-xs text-red-300">
              stopped at {emergency.triggeredAt ? new Date(emergency.triggeredAt).toLocaleString('en-GB', { hour12: false }) : '—'} — {emergency.reason}
            </span>
          )}
          {!emergency?.triggered && <span className="text-xs text-slate-500">When triggered: no new signals, no new orders. Open positions keep tracking.</span>}
          {emergency?.triggered ? (
            <button
              onClick={() => void setEmergencyStop('release')}
              disabled={busy}
              className="rounded bg-emerald-600 px-4 py-1.5 text-xs font-semibold text-slate-950 transition-colors hover:bg-emerald-500 disabled:opacity-50"
            >
              Release Emergency Stop
            </button>
          ) : (
            <button
              onClick={() => void setEmergencyStop('trigger')}
              disabled={busy}
              className="rounded bg-red-700 px-4 py-1.5 text-xs font-medium text-white hover:bg-red-600 disabled:opacity-50"
            >
              Trigger Emergency Stop
            </button>
          )}
        </div>
      </Card>

      <Card
        title="Broker Reconciliation (MT5 ↔ Dashboard)"
        right={
          <button
            onClick={async () => {
              if (!window.confirm('FLATTEN ALL: close every open position (dashboard + MT5 sweep)?')) return;
              try {
                const r = await api<{ closed: number }>('/mt5/flatten-all', { method: 'POST', body: JSON.stringify({ reason: 'kill switch from System view' }) });
                toast(`Flatten complete — ${r.closed} closed`, 'up');
              } catch { toast('Flatten failed', 'down'); }
            }}
            className="kill-switch press rounded-md px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-red-200"
          >
            ⏻ Flatten all
          </button>
        }
      >
        <ReconciliationPanel />
      </Card>

      <Card title="Components">
        <Table head={['Component', 'Status', 'Detail', 'Latency', 'Checked']}>
          {rows.map((c: ComponentStatus) => (
            <tr key={c.name}>
              <td className="font-medium text-slate-200">{c.name}</td>
              <td><StatusBadge status={c.status} /></td>
              <td className="max-w-[420px] truncate text-xs text-slate-500">{c.detail}</td>
              <td className="font-mono text-xs">{c.latencyMs !== undefined ? `${c.latencyMs}ms` : '—'}</td>
              <td className="text-xs text-slate-500">{timeAgo(c.lastChecked)}</td>
            </tr>
          ))}
        </Table>
        <div className="mt-3 flex items-center gap-2 text-sm">
          <span className="text-slate-400">WebSocket:</span>
          <Badge tone={wsConnected ? 'up' : 'red'}>{wsConnected ? 'CONNECTED' : 'DISCONNECTED'}</Badge>
          <span className="ml-4 text-slate-400">Signal generation:</span>
          <Badge tone={status?.signalGenerationAllowed ? 'up' : 'red'}>{status?.signalGenerationAllowed ? 'ALLOWED' : 'STOPPED'}</Badge>
        </div>
      </Card>

      <Card title="Alerts">
        {alerts.length === 0 ? (
          <div className="py-4 text-center text-sm text-slate-400">No alerts.</div>
        ) : (
          <div className="scroll-thin max-h-72 space-y-1 overflow-y-auto">
            {alerts.slice(0, 100).map((a) => (
              <div key={a.id} className="flex items-center gap-3 rounded border border-border/60 bg-panel2 px-2 py-1.5 text-xs">
                <Badge tone={a.severity === 'CRITICAL' ? 'red' : a.severity === 'WARNING' ? 'warn' : 'info'}>{a.severity}</Badge>
                <Badge tone="muted">{a.type}</Badge>
                <span className="text-slate-300">{a.symbol && <span className="mr-1 font-mono">{a.symbol}</span>}{a.message}</span>
                <span className="ml-auto text-slate-500">{timeAgo(a.timestamp)}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
