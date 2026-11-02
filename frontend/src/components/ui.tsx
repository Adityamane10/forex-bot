import React from 'react';
import type { Decision, RiskLevel, SystemStatus } from '@fx/shared';

/**
 * Shared UI primitives — "Instrument".
 *
 * Chrome is achromatic; colour is data. `info` and `muted` tones are
 * deliberately hue-free so that a green or red badge on screen always carries
 * meaning about money or direction rather than decoration.
 *
 * Every export name and prop signature here is unchanged — this file is a
 * restyle, not a redesign of the component API.
 */

export function Card({
  title,
  right,
  children,
  className = '',
}: {
  title?: React.ReactNode;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`sheen group/card relative overflow-hidden rounded-lg border border-border bg-panel shadow-panel transition-shadow duration-200 hover:shadow-lift ${className}`}
    >
      {(title || right) && (
        <>
          <div className="flex items-center justify-between gap-3 px-3.5 pb-2 pt-2.5">
            <div className="eyebrow flex items-center gap-1.5 text-slate-400">
              {/* A machined index mark before every card title: the collection
                  reads as one instrument family rather than loose panels. */}
              <span aria-hidden="true" className="h-[3px] w-[3px] rounded-full bg-accent/50 transition-colors group-hover/card:bg-accent" />
              {title}
            </div>
            {right}
          </div>
          <div className="seam" />
        </>
      )}
      <div className="p-3.5">{children}</div>
    </div>
  );
}

export function Badge({
  tone,
  children,
}: {
  tone: 'up' | 'down' | 'warn' | 'info' | 'muted' | 'red';
  children: React.ReactNode;
}) {
  const tones: Record<string, string> = {
    up: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/25',
    down: 'bg-red-500/10 text-red-300 border-red-500/25',
    warn: 'bg-amber-500/10 text-amber-300 border-amber-500/25',
    // Achromatic on purpose: "info" is chrome, not data.
    info: 'bg-slate-100/[0.06] text-slate-300 border-slate-100/15',
    red: 'bg-red-500/15 text-red-200 border-red-500/40',
    muted: 'bg-slate-100/[0.04] text-slate-400 border-slate-100/10',
  };
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full border px-2 py-[2.5px] font-mono text-[10px] font-medium uppercase leading-none backdrop-blur-sm ${tones[tone]}`}
      style={{ letterSpacing: '0.06em' }}
    >
      {children}
    </span>
  );
}

export function DecisionBadge({ d }: { d: Decision }) {
  const map: Record<Decision, { tone: 'up' | 'down' | 'warn' | 'muted' | 'red'; label: string }> = {
    BUY: { tone: 'up', label: 'BUY' },
    SELL: { tone: 'down', label: 'SELL' },
    WAIT: { tone: 'warn', label: 'WAIT' },
    NO_TRADE: { tone: 'red', label: 'NO TRADE' },
    INSUFFICIENT_CONFIDENCE: { tone: 'muted', label: 'INSUFFICIENT CONFIDENCE' },
  };
  const m = map[d];
  return <Badge tone={m.tone}>{m.label}</Badge>;
}

export function RiskBadge({ level }: { level: RiskLevel }) {
  const map: Record<RiskLevel, 'up' | 'warn' | 'red'> = { GREEN: 'up', YELLOW: 'warn', RED: 'red' };
  return <Badge tone={map[level]}>{level}</Badge>;
}

export function StatusBadge({ status }: { status: SystemStatus | string }) {
  const map: Record<string, 'up' | 'warn' | 'red' | 'muted'> = {
    HEALTHY: 'up',
    CONNECTED: 'up',
    OK: 'up',
    WARNING: 'warn',
    UNKNOWN: 'warn',
    DOWN: 'red',
    DISCONNECTED: 'red',
  };
  return <Badge tone={map[status] ?? 'muted'}>{status}</Badge>;
}

/**
 * Data provenance is a safety control, not a decoration: simulated data must
 * never be mistakable for a real feed, so DEMO gets the caution treatment and
 * LIVE gets a quiet confirmation rather than the louder styling.
 */
export function ModeBadge({ mode }: { mode: string }) {
  if (mode === 'DEMO' || mode === 'SIMULATED') return <Badge tone="warn">DEMO DATA</Badge>;
  if (!mode) return <Badge tone="muted">CONNECTING…</Badge>;
  return <Badge tone="up">LIVE DATA</Badge>;
}

export function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="relative overflow-hidden rounded-md border border-border bg-panel2 px-3 py-2.5 shadow-panel transition-colors duration-200 hover:border-hairline">
      {/* A single accent hairline across the top of each stat: the row reads as
          one instrument bank with individually lit cells. */}
      <span aria-hidden="true" className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-slate-100/20 to-transparent" />
      <div className="eyebrow">{label}</div>
      <div className="num-display mt-1 text-[19px] font-medium leading-tight text-slate-100">{value}</div>
      {sub && <div className="mt-0.5 truncate text-[11px] text-slate-500">{sub}</div>}
    </div>
  );
}

/** Three breathing bars — an instrument settling rather than a spinning wheel. */
export function Spinner() {
  return (
    <div className="flex items-center gap-2" role="status" aria-label="Loading">
      <span className="flex items-end gap-[3px]">
        <span className="h-2.5 w-[3px] animate-breathe rounded-full bg-slate-500" style={{ animationDelay: '0ms' }} />
        <span className="h-4 w-[3px] animate-breathe rounded-full bg-slate-400" style={{ animationDelay: '160ms' }} />
        <span className="h-2.5 w-[3px] animate-breathe rounded-full bg-slate-500" style={{ animationDelay: '320ms' }} />
      </span>
      <span className="eyebrow">Loading</span>
    </div>
  );
}

export function Table({ head, children }: { head: React.ReactNode[]; children: React.ReactNode }) {
  return (
    <div className="scroll-thin -mx-1 overflow-x-auto px-1">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-hairline text-left">
            {head.map((h, i) => (
              <th key={i} className="eyebrow whitespace-nowrap pb-2 align-bottom">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border/70">{children}</tbody>
      </table>
    </div>
  );
}

/** An empty state is an instruction, not an apology. */
export function Empty({ text }: { text: string }) {
  return (
    <div className="rounded-md border border-dashed border-border px-4 py-7 text-center text-[13px] leading-relaxed text-slate-500">
      {text}
    </div>
  );
}

export function Input({ className = '', ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`rounded border border-border bg-panel2 px-2.5 py-1.5 text-sm text-slate-200 shadow-panel transition-all placeholder:text-slate-600 hover:border-hairline focus:border-blue-300 focus:outline-none focus:ring-2 focus:ring-blue-300/15 ${className}`}
      {...props}
    />
  );
}
