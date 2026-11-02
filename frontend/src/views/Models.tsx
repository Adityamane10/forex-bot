import { useEffect, useState } from 'react';
import { Card, Table, Badge, Stat, Empty, Spinner } from '../components/ui';
import { fmt, fmtDateTime } from '../format';
import { api } from '../api';
import { ModelVersion } from '@fx/shared';

export function Models() {
  const [local, setLocal] = useState<ModelVersion[]>([]);
  const [calibration, setCalibration] = useState<{ brier: number | null; calibrationError: number | null; samples: number } | null>(null);
  const [drift, setDrift] = useState<{ status: string; reason?: string } | null>(null);
  const [training, setTraining] = useState(false);
  const [promoteMsg, setPromoteMsg] = useState<string | null>(null);

  const refresh = async () => {
    const [models, cal, d] = await Promise.all([
      api<{ local: ModelVersion[] }>('/models').catch(() => ({ local: [] })),
      api<{ brier: number | null; calibrationError: number | null; samples: number }>('/models/calibration').catch(() => ({ brier: null, calibrationError: null, samples: 0 })),
      api<{ status: string; reason?: string }>('/drift').catch(() => ({ status: 'UNKNOWN' })),
    ]);
    setLocal(models.local);
    setCalibration(cal);
    setDrift(d);
  };
  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(id);
  }, []);

  const train = async () => {
    setTraining(true);
    setPromoteMsg(null);
    try {
      const end = Date.now();
      const start = end - 120 * 86400_000;
      const symbols = ['EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'USD/CAD', 'NZD/USD', 'EUR/GBP', 'EUR/JPY', 'GBP/JPY', 'USD/CHF'];
      const data: Record<string, unknown[]> = {};
      for (const sym of symbols) {
        const r = await api<{ candles: unknown[] }>(`/candles/${sym}?timeframe=1h&limit=3000`).catch(() => ({ candles: [] }));
        if (r.candles.length > 250) data[sym] = r.candles;
      }
      const res = await api<{ status: string; averageTestMetrics: Record<string, number>; challenger: { modelVersion: string } }>('/models/train', {
        method: 'POST',
        body: JSON.stringify({ symbols: Object.keys(data), timeframe: '1h', start, end, folds: 3, data }),
      });
      setPromoteMsg(`Training complete — challenger ${res.challenger.modelVersion} registered. Avg test: brier ${fmt(res.averageTestMetrics.brier ?? 0, 4)}, profitFactor ${fmt(res.averageTestMetrics.profitFactor ?? 0, 2)}.`);
      await refresh();
    } catch (err) {
      setPromoteMsg(`Training failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setTraining(false);
    }
  };

  const promote = async () => {
    const r = await api<{ promoted: boolean; reason: string }>('/models/promote', { method: 'POST' });
    setPromoteMsg(`Promotion: ${r.promoted ? 'PROMOTED — ' : 'not promoted — '}${r.reason}`);
    await refresh();
  };

  const champion = local.find((m) => m.status === 'CHAMPION');
  const challenger = local.find((m) => m.status === 'CHALLENGER');

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-slate-100">Models & MLOps</h1>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Champion">
          {champion ? (
            <div className="space-y-1 text-sm">
              <div className="font-mono text-slate-100">{champion.modelVersion}</div>
              <div className="text-xs text-slate-500">{champion.algorithm} · dataset {champion.datasetVersion} · features {champion.featureVersion}</div>
              <div className="text-xs text-slate-500">trained {fmtDateTime(champion.createdAt)}</div>
              <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                <Stat label="Brier" value={champion.metrics.brier !== undefined ? fmt(champion.metrics.brier, 4) : '—'} />
                <Stat label="Profit factor" value={champion.metrics.profitFactor !== undefined ? fmt(champion.metrics.profitFactor, 2) : '—'} />
                <Stat label="Win rate" value={champion.metrics.winRate !== undefined ? fmt(champion.metrics.winRate * 100, 0) + '%' : '—'} />
                <Stat label="Max DD" value={champion.metrics.maxDrawdown !== undefined ? fmt(champion.metrics.maxDrawdown, 2) : '—'} />
              </div>
            </div>
          ) : (
            <Empty text="No champion model. Run training to create one." />
          )}
        </Card>

        <Card title="Challenger (shadow mode)">
          {challenger ? (
            <div className="space-y-1 text-sm">
              <div className="font-mono text-slate-100">{challenger.modelVersion}</div>
              <div className="text-xs text-slate-500">{challenger.algorithm} · dataset {challenger.datasetVersion} · shadow: {challenger.shadow ? 'yes' : 'no'}</div>
              <div className="text-xs text-slate-500">trained {fmtDateTime(challenger.createdAt)}</div>
              <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                <Stat label="Brier" value={challenger.metrics.brier !== undefined ? fmt(challenger.metrics.brier, 4) : '—'} />
                <Stat label="Profit factor" value={challenger.metrics.profitFactor !== undefined ? fmt(challenger.metrics.profitFactor, 2) : '—'} />
                <Stat label="Win rate" value={challenger.metrics.winRate !== undefined ? fmt(challenger.metrics.winRate * 100, 0) + '%' : '—'} />
                <Stat label="Max DD" value={challenger.metrics.maxDrawdown !== undefined ? fmt(challenger.metrics.maxDrawdown, 2) : '—'} />
              </div>
            </div>
          ) : (
            <Empty text="No challenger yet." />
          )}
        </Card>
      </div>

      <Card title="Training">
        <div className="flex items-center gap-3">
          <button onClick={() => void train()} disabled={training} className="rounded bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50">
            {training ? 'Training (walk-forward)…' : 'Train challenger (120 days, 1h, 3 folds)'}
          </button>
          <button onClick={() => void promote()} className="rounded border border-border px-4 py-1.5 text-sm hover:bg-panel2">Evaluate & promote challenger</button>
          {training && <Spinner />}
        </div>
        {promoteMsg && <div className="mt-2 text-xs text-slate-400">{promoteMsg}</div>}
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Calibration">
          <div className="space-y-2 text-sm">
            <Stat label="Brier score" value={calibration?.brier !== null && calibration?.brier !== undefined ? fmt(calibration.brier, 4) : '—'} />
            <Stat label="Calibration error" value={calibration?.calibrationError !== null && calibration?.calibrationError !== undefined ? fmt(calibration.calibrationError, 4) : '—'} />
            <Stat label="Samples" value={calibration?.samples ?? 0} />
            <p className="text-[11px] text-slate-500">Lower Brier is better. Models report calibrated probabilities, never guaranteed outcomes.</p>
          </div>
        </Card>
        <Card title="Model Drift">
          <div className="flex items-center gap-2">
            <Badge tone={drift?.status === 'HEALTHY' ? 'up' : drift?.status === 'WARNING' ? 'warn' : drift?.status === 'PAUSED' ? 'red' : 'muted'}>{drift?.status ?? 'UNKNOWN'}</Badge>
            <span className="text-xs text-slate-500">{drift?.reason ?? 'no drift assessment yet'}</span>
          </div>
        </Card>
        <Card title="All Versions">
          <div className="scroll-thin max-h-56 overflow-y-auto">
            {local.length === 0 ? <Empty text="No model versions." /> : (
              <Table head={['Version', 'Algorithm', 'Status', 'Dataset']}>
                {local.slice(0, 20).map((m) => (
                  <tr key={m.modelVersion}>
                    <td className="font-mono text-xs">{m.modelVersion.slice(0, 14)}</td>
                    <td className="text-xs">{m.algorithm}</td>
                    <td><Badge tone={m.status === 'CHAMPION' ? 'up' : m.status === 'CHALLENGER' ? 'warn' : 'muted'}>{m.status}</Badge></td>
                    <td className="font-mono text-xs">{m.datasetVersion.slice(0, 14)}</td>
                  </tr>
                ))}
              </Table>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
