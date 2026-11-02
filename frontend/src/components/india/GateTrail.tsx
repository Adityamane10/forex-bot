/**
 * Why a signal exists — and why one didn't.
 *
 * The engine runs six pre-trade checks (session window, days to expiry, option
 * book posture, IV regime, liquidity, target reachability) and each one either
 * passes, warns and shaves confidence, blocks the trade outright, or reports
 * that it had no data to judge with. Until now none of that reached the screen:
 * a signal showed a confidence number with no account of how it got there, and a
 * *rejected* setup left no trace at all — so "why has nothing traded for two
 * hours" was a question the UI could not answer.
 *
 * Two views on the same data. `GateTrail` explains one decision. `WhyNoTradeFeed`
 * shows the decisions that went against trading, newest first, with a tally of
 * which check is doing the refusing.
 */
import { useMemo, useState } from 'react';
import { useSelector } from 'react-redux';
import type { IndiaGateResult, IndiaGateVerdict, IndiaSignalGateTrail, IndiaSignalRejection } from '@fx/shared';
import { RootState } from '../../store';
import { fmtTime } from '../../format';

const cls = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(' ');

/**
 * PASS reads as gain, BLOCK as loss, WARN as caution — the same three colours
 * this app uses for money, so the meaning transfers without a legend. SKIPPED is
 * deliberately colourless: it means "not checked", which is not a judgement.
 */
const VERDICT_BAR: Record<IndiaGateVerdict, string> = {
  PASS: 'bg-up',
  WARN: 'bg-warn',
  BLOCK: 'bg-down',
  SKIPPED: 'bg-slate-700',
};

const VERDICT_TEXT: Record<IndiaGateVerdict, string> = {
  PASS: 'text-slate-300',
  WARN: 'text-warn',
  BLOCK: 'text-down',
  SKIPPED: 'text-slate-600',
};

/** Confidence deltas are stored on a 0..1 scale but shown as points, because
 *  that is how confidence itself is shown everywhere else in this view. */
function deltaLabel(delta: number | undefined): string | null {
  if (delta === undefined || delta === 0) return null;
  const points = Math.round(delta * 100);
  if (points === 0) return null;
  return points > 0 ? `+${points}` : `−${Math.abs(points)}`;
}

function GateRow({ gate }: { gate: IndiaGateResult }) {
  const raw = gate.confidenceDelta ?? 0;
  const delta = deltaLabel(gate.confidenceDelta);
  return (
    <div className="flex items-start gap-2 py-1">
      <span className={cls('mt-1 h-3 w-[3px] shrink-0 rounded-full', VERDICT_BAR[gate.verdict])} aria-hidden />
      <span className="sr-only">{gate.verdict}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className={cls('text-[11px] font-medium', VERDICT_TEXT[gate.verdict])}>{gate.label}</span>
          {delta && <span className={cls('font-mono text-[10px]', raw > 0 ? 'text-up' : 'text-down')}>{delta}</span>}
        </div>
        <div className="text-[10px] leading-snug text-slate-500">{gate.detail}</div>
      </div>
    </div>
  );
}

export function GateTrail({ trail, defaultOpen = false }: { trail: IndiaSignalGateTrail; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const gates = trail.gates ?? [];
  const blocking = gates.find((g) => g.gate === trail.blockedBy) ?? null;
  const warns = gates.filter((g) => g.verdict === 'WARN').length;
  const skipped = gates.filter((g) => g.verdict === 'SKIPPED').length;
  const passed = gates.filter((g) => g.verdict === 'PASS').length;

  const summary = blocking
    ? `Blocked — ${blocking.label.toLowerCase()}`
    : [`${passed} of ${gates.length} checks clear`,
       warns > 0 && `${warns} warning${warns > 1 ? 's' : ''}`,
       skipped > 0 && `${skipped} not checked`].filter(Boolean).join(' · ');

  const base = Math.round(trail.baseConfidence * 100);
  const final = Math.round(trail.finalConfidence * 100);

  return (
    <div className="rounded border border-border/60 bg-panel2/60">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left hover:bg-panel2 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="flex shrink-0 gap-[2px]" aria-hidden>
            {gates.map((g) => (
              <span key={g.gate} className={cls('h-3 w-[3px] rounded-full', VERDICT_BAR[g.verdict])} />
            ))}
          </span>
          <span className={cls('truncate text-[10px] uppercase tracking-eyebrow', blocking ? 'text-down' : 'text-slate-500')}>
            {summary}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5 font-mono text-[10px]">
          <span className="text-slate-600">{base}</span>
          <span className="text-slate-700">→</span>
          <span className={final > base ? 'text-up' : final < base ? 'text-down' : 'text-slate-400'}>{final}</span>
          <span className="text-slate-600">{open ? '▾' : '▸'}</span>
        </span>
      </button>
      {open && (
        <div className="divide-y divide-border/40 border-t border-border/40 px-2 pb-1.5">
          {gates.map((g) => <GateRow key={g.gate} gate={g} />)}
        </div>
      )}
    </div>
  );
}

/** How each drop point reads in the feed. NO_SETUP and COOLDOWN are in the
 *  payload's union but the engine deliberately never emits them — they would fire
 *  once per instrument per scan tick and bury the informative rejections. */
const STAGE_LABEL: Record<IndiaSignalRejection['stage'], string> = {
  NO_SETUP: 'No setup',
  COOLDOWN: 'Cooling down',
  GATE: 'Pre-trade check',
  SIZING: 'Position sizing',
};

/** Label for the check that refused a setup, taken from the rejection's own
 *  trail so the wording can never drift from what the engine reported. */
function blockLabel(r: IndiaSignalRejection): string {
  if (r.stage !== 'GATE') return STAGE_LABEL[r.stage];
  const trail = r.gateTrail;
  const hit = trail?.gates?.find((g) => g.gate === trail.blockedBy);
  return hit?.label ?? STAGE_LABEL.GATE;
}

function RejectionRow({ rejection }: { rejection: IndiaSignalRejection }) {
  const [open, setOpen] = useState(false);
  const hasTrail = !!rejection.gateTrail?.gates?.length;
  return (
    <div className="rounded border border-border/50 bg-panel2/50 px-2 py-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex min-w-0 items-baseline gap-1.5">
          {rejection.side && (
            <span className={cls('font-mono text-[10px] font-semibold', rejection.side === 'BUY' ? 'text-up' : 'text-down')}>
              {rejection.side}
            </span>
          )}
          <span className="truncate font-mono text-[11px] text-slate-300">{rejection.tradingSymbol}</span>
          {rejection.goalId && (
            <span className="shrink-0 rounded bg-violet-500/15 px-1 text-[9px] uppercase tracking-eyebrow text-violet-300">goal</span>
          )}
        </div>
        <span className="shrink-0 font-mono text-[10px] text-slate-600">{fmtTime(rejection.at)}</span>
      </div>
      <div className="mt-0.5 flex items-baseline justify-between gap-2">
        <span className="truncate text-[10px] text-slate-500">
          <span className="text-warn">{blockLabel(rejection)}</span> · {rejection.reason}
        </span>
        {hasTrail && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="shrink-0 text-[10px] text-slate-600 hover:text-slate-400 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
          >
            {open ? 'hide checks' : 'all checks'}
          </button>
        )}
      </div>
      {open && rejection.gateTrail && (
        <div className="mt-1.5">
          <GateTrail trail={rejection.gateTrail} defaultOpen />
        </div>
      )}
    </div>
  );
}

export function WhyNoTradeFeed({ limit = 25 }: { limit?: number }) {
  const rejections = useSelector((s: RootState) => s.india.rejections);

  // Which check is doing the refusing. This is the number that actually answers
  // the question — one line of "Option book × 23" says more than scrolling
  // twenty-three individually reasonable-looking rejections.
  const tally = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of rejections) {
      const label = blockLabel(r);
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  }, [rejections]);

  return (
    <div className="sheen relative overflow-hidden rounded-lg border border-border bg-panel shadow-panel transition-shadow duration-200 hover:shadow-lift">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-eyebrow text-slate-400">
          <span aria-hidden="true" className="h-[3px] w-[3px] rounded-full bg-accent/50" />
          Why no trade
        </span>
        <span className="inline-flex items-center gap-1.5 text-[10px] text-slate-600">
          {rejections.length ? `${rejections.length} declined this session` : <><span aria-hidden="true" className="live-dot text-slate-500" />live</>}
        </span>
      </div>

      {rejections.length === 0 ? (
        <div className="px-3 py-4 text-[11px] leading-relaxed text-slate-500">
          Nothing declined yet. When the engine finds a setup and refuses it, it appears here with the check that
          stopped it — so a quiet session is explained rather than silent.
        </div>
      ) : (
        <div className="space-y-2 p-3">
          <div className="flex flex-wrap gap-1.5">
            {tally.map(([label, count]) => (
              <span key={label} className="rounded bg-panel2 px-1.5 py-0.5 text-[10px] text-slate-400">
                {label} <span className="font-mono text-slate-300">×{count}</span>
              </span>
            ))}
          </div>
          <div className="max-h-[420px] space-y-1.5 overflow-y-auto pr-0.5">
            {rejections.slice(0, limit).map((r) => (
              <RejectionRow key={`${r.at}-${r.instrumentToken}-${r.side ?? 'x'}`} rejection={r} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
