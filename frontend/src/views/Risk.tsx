import { useEffect, useState } from 'react';
import { Card, Table, Badge, Stat, Empty } from '../components/ui';
import { fmt, fmtCur, fmtPct } from '../format';
import { api } from '../api';

export function Risk() {
  const [risk, setRisk] = useState<{
    account: { balance: number; equity: number; margin: number; freeMargin: number; maxDrawdownPct: number; currency?: string } | null;
    openPositions: number;
    exposure: { currencyExposure: Record<string, { long: number; short: number; net: number }>; maxCurrencyExposure: { currency: string; net: number }; blocked: string[] };
    settings: { maxRiskPercent: number; minRr: number; maxDailyLossPercent: number; maxDrawdownPercent: number; maxOpenPositions: number; maxCorrelatedPositions: number; maxLeverage: number; maxCurrencyExposurePercent: number } | null;
    portfolio: {
      status: string;
      engine: string;
      samples: number;
      symbols: string[];
      weights: { current: number[]; hrp: number[]; minVariance: number[] };
      volatility: number[];
      riskContributionPct: number[];
      portfolio: { currentVolatility: number; minVarianceVolatility: number; hrpVolatility: number; hrpCvar95: number; effectiveN: number };
      recommendation: string;
      detail?: string;
    } | null;
  } | null>(null);

  useEffect(() => {
    const refresh = async () => {
      try {
        const r = await api<typeof risk>('/risk');
        setRisk(r);
      } catch {
        /* ignore */
      }
    };
    void refresh();
    const id = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(id);
  }, []);

  const settings = risk?.settings;
  const account = risk?.account;

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-slate-100">Risk</h1>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Account Risk State">
          {!account ? <Empty text="No risk data yet." /> : (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label="Equity" value={fmtCur(account.equity, account.currency)} />
              <Stat label="Drawdown" value={fmtPct(account.maxDrawdownPct)} />
              <Stat label="Open positions" value={risk?.openPositions ?? 0} />
              <Stat label="Margin" value={fmtCur(account.margin, account.currency)} />
            </div>
          )}
        </Card>

        <Card title="Limits">
          {!settings ? <Empty text="No settings." /> : (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label="Max risk / trade" value={fmt(settings.maxRiskPercent, 1) + '%'} />
              <Stat label="Min R:R" value={fmt(settings.minRr, 2)} />
              <Stat label="Max daily loss" value={fmt(settings.maxDailyLossPercent, 1) + '%'} />
              <Stat label="Max drawdown" value={fmt(settings.maxDrawdownPercent, 1) + '%'} />
              <Stat label="Max positions" value={settings.maxOpenPositions} />
              <Stat label="Max correlated" value={settings.maxCorrelatedPositions} />
              <Stat label="Max leverage" value={settings.maxLeverage + 'x'} />
              <Stat label="Max exposure" value={fmt(settings.maxCurrencyExposurePercent, 0) + '%'} />
            </div>
          )}
        </Card>
      </div>

      <Card title="Portfolio Analytics (skfolio)">
        {!risk?.portfolio || risk.portfolio.status !== 'OK' ? (
          <Empty text={risk?.portfolio?.detail ?? 'Portfolio analytics unavailable — open a position.'} />
        ) : (
          <>
            <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label="Engine" value={risk.portfolio.engine} />
              <Stat label="HRP CVaR 95" value={fmtPct(risk.portfolio.portfolio.hrpCvar95)} />
              <Stat label="Effective N" value={fmt(risk.portfolio.portfolio.effectiveN, 2)} />
              <Stat label="Volatility (HRP)" value={fmtPct(risk.portfolio.portfolio.hrpVolatility)} />
            </div>
            <Table head={['Symbol', 'Current', 'HRP target', 'Min-vol target', 'Vol (ann.)', 'Risk contrib.']}>
              {(risk.portfolio.symbols ?? []).map((sym, i) => (
                <tr key={sym}>
                  <td className="font-medium text-slate-200">{sym}</td>
                  <td className="font-mono text-slate-300">{fmtPct(risk.portfolio!.weights.current[i] ?? 0)}</td>
                  <td className="font-mono text-slate-300">{fmtPct(risk.portfolio!.weights.hrp[i] ?? 0)}</td>
                  <td className="font-mono text-slate-300">{fmtPct(risk.portfolio!.weights.minVariance[i] ?? 0)}</td>
                  <td className="font-mono text-slate-300">{fmtPct(risk.portfolio!.volatility[i] ?? 0)}</td>
                  <td className="font-mono text-slate-300">{fmtPct(risk.portfolio!.riskContributionPct[i] ?? 0)}</td>
                </tr>
              ))}
            </Table>
            <div className="mt-2 text-xs text-slate-500">
              Recommendation: {risk.portfolio.recommendation}. Advisory only — computed from 1h bars of your open positions; it never blocks or alters trades.
            </div>
          </>
        )}
      </Card>

      <Card title="Currency Exposure">
        {!risk?.exposure || Object.keys(risk.exposure.currencyExposure).length === 0 ? (
          <Empty text="No currency exposure — no open positions." />
        ) : (
          <>
            <Table head={['Currency', 'Long', 'Short', 'Net']}>
              {Object.entries(risk.exposure.currencyExposure).map(([cur, e]) => (
                <tr key={cur}>
                  <td className="font-medium text-slate-200">{cur}</td>
                  <td className="font-mono text-emerald-400">{fmt(e.long, 0)}</td>
                  <td className="font-mono text-red-400">{fmt(e.short, 0)}</td>
                  <td className={`font-mono ${e.net >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{fmt(e.net, 0)}</td>
                </tr>
              ))}
            </Table>
            {risk.exposure.blocked.length > 0 && (
              <div className="mt-2 space-y-1">
                {risk.exposure.blocked.map((b, i) => <div key={i} className="text-xs text-red-400">• {b}</div>)}
              </div>
            )}
          </>
        )}
      </Card>

      <div className="text-xs text-slate-500">
        Circuit breakers (max daily/weekly loss, drawdown, consecutive losses, positions, correlation, leverage, exposure) are evaluated by the signal engine on every decision. When a breaker trips, new signals stop — the LLM can never override risk controls.
      </div>
    </div>
  );
}
