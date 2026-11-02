/**
 * Shared risk-state UI (spec §34 spirit): a fill-gate refusal must never be
 * the first place the user learns about a lockout. One hook + banner used by
 * both Paper and Signals views, so the blocker — and its legitimate reset —
 * live wherever a Trade button lives.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { Badge } from './ui';

export interface RiskSnapshot {
  account: { consecutiveLosses?: number; dailyPnl?: number; currency?: string };
  settings: { maxConsecutiveLosses?: number; maxDailyLossPercent?: number };
}

export function useRiskState() {
  const [risk, setRisk] = useState<RiskSnapshot | null>(null);

  const load = useCallback(async () => {
    try {
      setRisk(await api<RiskSnapshot>('/risk'));
    } catch { /* advisory only */ }
  }, []);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(id);
  }, [load]);

  return { risk, reloadRisk: load };
}

export function useRiskLockout(risk: RiskSnapshot | null) {
  if (!risk?.account || !risk.settings) return null;
  const losses = risk.account.consecutiveLosses ?? 0;
  const max = risk.settings.maxConsecutiveLosses ?? 0;
  return max > 0 && losses >= max ? { losses, max } : null;
}

export function RiskLockoutBanner({ onChanged }: { onChanged?: () => void }) {
  const { risk, reloadRisk } = useRiskState();
  const lockout = useRiskLockout(risk);
  const [busy, setBusy] = useState(false);

  const reset = async () => {
    setBusy(true);
    try {
      await api('/paper/reset-risk', { method: 'POST' });
      await reloadRisk();
      onChanged?.();
    } finally {
      setBusy(false);
    }
  };

  if (!lockout) return null;
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.07] px-3.5 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="eyebrow text-amber-300">Risk lockout — new entries blocked</div>
        <div className="mt-0.5 text-[12px] leading-relaxed text-slate-300">
          {lockout.losses} consecutive losses (limit {lockout.max}). Review closed trades, then re-arm.
        </div>
      </div>
      <button onClick={() => void reset()} disabled={busy}
        className="press shrink-0 rounded-md border border-amber-400/40 bg-amber-500/10 px-3 py-1.5 text-[11px] font-medium text-amber-200 transition-colors hover:bg-amber-500/20 disabled:opacity-50">
        {busy ? 'Resetting…' : 'Reset risk counters'}
      </button>
    </div>
  );
}

/** Human wording for fill-gate refusals. `staleSignal` tells the caller to
 *  drop the dead card from the list instead of blaming the user. */
export function friendlyExecutionError(raw: string): { title: string; hint?: string; staleSignal?: boolean } {
  const m = raw.toLowerCase();
  if (m.includes('no longer active') || m.includes('not found')) {
    return {
      title: 'This signal has expired',
      hint: 'The setup is no longer live — the list below shows what the engine is watching right now.',
      staleSignal: true,
    };
  }
  if (raw.includes('MAX_CONSECUTIVE_LOSSES')) {
    return {
      title: 'Risk lockout: too many losses in a row',
      hint: 'Use "Reset risk counters" above to re-arm after reviewing your closed trades.',
    };
  }
  if (raw.includes('MAX_DAILY_LOSS')) return { title: 'Daily loss limit reached', hint: 'Entries unlock next trading day (UTC), or reset counters.' };
  if (raw.includes('MAX_WEEKLY_LOSS')) return { title: 'Weekly loss limit reached', hint: 'Entries unlock next week (UTC), or reset counters.' };
  if (raw.includes('MAX_DRAWDOWN')) return { title: 'Drawdown limit reached', hint: 'Equity fell further than the configured maximum from its peak.' };
  if (m.includes('margin')) return { title: raw, hint: 'Close an open position or raise the margin cap in Settings.' };
  if (m.includes('leverage')) return { title: raw, hint: 'Reduce the lot size or raise max leverage in Settings.' };
  if (m.includes('stale')) return { title: raw, hint: 'The conversion feed paused — execution resumes automatically when it recovers.' };
  return { title: raw };
}
