/**
 * Session arc and option context — the two things a discretionary trader checks
 * before looking at anything else, and neither was on screen.
 *
 * The arc is not decoration. Its bands are the engine's own entry windows, read
 * from `INDIA_ENTRY_WINDOW` in `@fx/shared` — the same constants the pre-trade
 * session gate enforces. So "why is nothing firing at 09:20" is answered by
 * looking at where the marker sits, and the answer cannot drift from the rule,
 * because there is only one copy of the rule.
 *
 * The chips beside it carry what makes an option position behave differently
 * from a cash one: how long until expiry, whether volatility is expensive
 * relative to its own history, and which way the book is leaning. Each is shown
 * only when the data behind it exists; where it doesn't, the chip says so
 * instead of printing a confident zero.
 */
import { useEffect, useState } from 'react';
import { useSelector } from 'react-redux';
import type { IndiaMarketStatusDto, IndiaOptionAnalytics } from '@fx/shared';
import { INDIA_ENTRY_WINDOW, INDIA_SESSION_CLOSE_MIN, INDIA_SESSION_OPEN_MIN } from '@fx/shared';
import { RootState } from '../../store';
import { expiryCountdown, ivPct, level } from './optionFormat';

const cls = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(' ');

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const SESSION_MINUTES = INDIA_SESSION_CLOSE_MIN - INDIA_SESSION_OPEN_MIN;

/**
 * Minute of the IST day. Derived from the epoch and a fixed offset rather than
 * the browser's timezone, so the arc reads the same from Mumbai, London or a CI
 * container — the market's clock is the only one that matters here.
 */
function istMinuteOfDay(now: number): number {
  const ist = new Date(now + IST_OFFSET_MS);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

function hhmm(minuteOfDay: number): string {
  const m = ((minuteOfDay % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** "3h 12m" / "47m" — a duration, never a bare minute count once it passes an hour. */
function dur(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

type EntryPhase = { verdict: 'PASS' | 'WARN' | 'BLOCK' | 'CLOSED'; text: string };

/**
 * Reads the clock the way `gateSessionWindow` does, in the same order, so the
 * strip and the gate can never disagree about what the engine will do next.
 */
function entryPhase(minute: number, isHoliday: boolean): EntryPhase {
  const w = INDIA_ENTRY_WINDOW;
  if (isHoliday) return { verdict: 'CLOSED', text: 'Exchange holiday — no session today' };

  const sinceOpen = minute - INDIA_SESSION_OPEN_MIN;
  const toClose = INDIA_SESSION_CLOSE_MIN - minute;

  if (sinceOpen < 0) return { verdict: 'CLOSED', text: `Pre-open · session starts in ${dur(-sinceOpen)}` };
  if (toClose <= 0) return { verdict: 'CLOSED', text: 'Session closed' };
  if (sinceOpen < w.openBlockMinutes) {
    return { verdict: 'BLOCK', text: `Entries held · opening auction, ${dur(w.openBlockMinutes - sinceOpen)} to go` };
  }
  if (toClose < w.closeBlockMinutes) {
    return { verdict: 'BLOCK', text: `Entries closed · ${dur(toClose)} to the bell, squaring off only` };
  }
  if (sinceOpen < w.openWarnMinutes) {
    return { verdict: 'WARN', text: `Entries flagged · ${dur(w.openWarnMinutes - sinceOpen)} until the open settles` };
  }
  if (toClose < w.closeWarnMinutes) {
    return { verdict: 'WARN', text: `Entries flagged · squaring off in ${dur(toClose - w.closeBlockMinutes)}` };
  }
  return { verdict: 'PASS', text: `Entries open · ${dur(toClose - w.closeBlockMinutes)} of entry window left` };
}

const PHASE_TEXT: Record<EntryPhase['verdict'], string> = {
  PASS: 'text-up',
  WARN: 'text-warn',
  BLOCK: 'text-down',
  CLOSED: 'text-slate-500',
};

/** Fractions of the session axis, so the bands are geometry from the constants
 *  rather than percentages someone typed in and then forgot to update. */
const pct = (minutesFromOpen: number) => (minutesFromOpen / SESSION_MINUTES) * 100;

function SessionArc({ minute, isHoliday }: { minute: number; isHoliday: boolean }) {
  const w = INDIA_ENTRY_WINDOW;
  const phase = entryPhase(minute, isHoliday);
  const elapsed = Math.min(Math.max(minute - INDIA_SESSION_OPEN_MIN, 0), SESSION_MINUTES);
  const inSession = minute >= INDIA_SESSION_OPEN_MIN && minute < INDIA_SESSION_CLOSE_MIN && !isHoliday;

  // Bands, left to right: held / flagged / open / flagged / held.
  const bands = [
    { from: 0, to: w.openBlockMinutes, fill: 'bg-down/20', title: 'No new entries — opening auction' },
    { from: w.openBlockMinutes, to: w.openWarnMinutes, fill: 'bg-warn/20', title: 'Entries allowed but flagged — the open is still settling' },
    { from: w.openWarnMinutes, to: SESSION_MINUTES - w.closeWarnMinutes, fill: 'bg-up/12', title: 'Mid-session — entries accepted' },
    { from: SESSION_MINUTES - w.closeWarnMinutes, to: SESSION_MINUTES - w.closeBlockMinutes, fill: 'bg-warn/20', title: 'Entries allowed but flagged — squaring off soon' },
    { from: SESSION_MINUTES - w.closeBlockMinutes, to: SESSION_MINUTES, fill: 'bg-down/20', title: 'No new entries — too close to the bell' },
  ];

  return (
    <div className="min-w-[240px] flex-1">
      <div className="flex items-baseline justify-between gap-3">
        <span className={cls('text-[11px] font-medium', PHASE_TEXT[phase.verdict])}>{phase.text}</span>
        <span className="shrink-0 font-mono text-[10px] text-slate-600">{hhmm(minute)} IST</span>
      </div>
      <div className={cls('relative mt-1.5 h-2 overflow-hidden rounded-sm bg-panel2', !inSession && 'opacity-40')}>
        {bands.map((b) => (
          <span
            key={b.from}
            title={b.title}
            className={cls('absolute inset-y-0', b.fill)}
            style={{ left: `${pct(b.from)}%`, width: `${pct(b.to - b.from)}%` }}
          />
        ))}
        {inSession && (
          <span
            className="absolute inset-y-0 w-px bg-slate-100 transition-[left] duration-700 motion-reduce:transition-none"
            style={{ left: `${pct(elapsed)}%` }}
            aria-hidden
          />
        )}
      </div>
      <div className="mt-1 flex justify-between font-mono text-[9px] text-slate-700">
        <span>{hhmm(INDIA_SESSION_OPEN_MIN)}</span>
        <span>{hhmm(INDIA_SESSION_CLOSE_MIN)}</span>
      </div>
    </div>
  );
}

function Chip({
  label, value, title, color,
}: {
  label: string;
  value: string;
  title?: string;
  color?: string;
}) {
  return (
    <span title={title} className="inline-flex items-baseline gap-1 rounded border border-border bg-panel2 px-2 py-1">
      <span className="text-[9px] uppercase tracking-eyebrow text-slate-600">{label}</span>
      <span className={cls('font-mono text-[11px] font-medium', color ?? 'text-slate-300')}>{value}</span>
    </span>
  );
}

/** The chips that only make sense for a dated option book. */
function OptionChips({ analytics }: { analytics: IndiaOptionAnalytics }) {
  const { ivAnalysis, pcr, dataQuality, daysToExpiry } = analytics;
  const oiOnly = dataQuality.source === 'OI_ONLY';
  const nearExpiry = daysToExpiry != null && daysToExpiry < 1;

  return (
    <>
      <Chip
        label="expiry"
        value={expiryCountdown(analytics.minutesToExpiry, daysToExpiry)}
        title={
          nearExpiry
            ? 'Expiry day. Theta decay dominates, and a long option can lose on a correct call.'
            : 'Time to expiry of the nearest tradable chain.'
        }
        color={nearExpiry ? 'text-warn' : undefined}
      />
      {daysToExpiry != null && (
        <Chip label="dte" value={daysToExpiry.toFixed(daysToExpiry < 10 ? 1 : 0)} title="Days to expiry, including the fraction of today that is left." />
      )}
      <Chip
        label="iv rank"
        value={ivAnalysis.ivRank != null ? ivAnalysis.ivRank.toFixed(0) : '—'}
        title={
          ivAnalysis.ivRank != null
            ? `ATM implied volatility sits at the ${ivAnalysis.ivRank.toFixed(0)}th percentile of the last ${ivAnalysis.ivWindowDays} days. High means options are expensive: better to sell premium than buy it.`
            : `Not enough history yet — ${ivAnalysis.ivWindowDays} days observed. Shown as unknown rather than as a percentile computed from too little data.`
        }
        color={
          ivAnalysis.ivRank == null ? 'text-slate-600'
            : ivAnalysis.ivRank >= 80 ? 'text-warn'
            : ivAnalysis.ivRank <= 20 ? 'text-slate-400'
            : undefined
        }
      />
      {!oiOnly && (
        <Chip label="atm iv" value={ivPct(ivAnalysis.atmIV)} title="Implied volatility at the money — the market's own forecast for the rest of the contract's life." />
      )}
      <Chip
        label="pcr"
        value={pcr.byOI.toFixed(2)}
        title="Put/call ratio by open interest. Above 1 means put writers dominate, which puts support beneath the market — bullish. Below 1, the reverse."
        color={pcr.byOI > 1.2 ? 'text-up' : pcr.byOI < 0.8 ? 'text-down' : undefined}
      />
      <Chip
        label="max pain"
        value={level(analytics.maxPain.strike)}
        title={`The strike where option writers lose least, so the level the book would rather expiry happened at. ${(analytics.maxPain.confidence * 100).toFixed(0)}% confidence.`}
      />
      {oiOnly && (
        <Chip
          label="feed"
          value="OI only"
          title="Open interest is real, but this feed carries no premiums or quotes, so implied volatility, greeks and spreads are unavailable by construction rather than by failure."
          color="text-warn"
        />
      )}
    </>
  );
}

export function ContextStrip({
  session, underlying,
}: {
  session: IndiaMarketStatusDto | undefined;
  /** Underlying of the selected instrument, when it has an option chain. */
  underlying: string | null;
}) {
  const analytics: IndiaOptionAnalytics | undefined = useSelector((s: RootState) =>
    underlying ? s.india.optionAnalytics[underlying] : undefined,
  );

  // The arc has to move on its own — the trader is watching for a boundary they
  // are about to cross, and a marker that only advances when a tick arrives
  // would freeze exactly during the quiet stretch they care about.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 20_000);
    return () => window.clearInterval(id);
  }, []);

  const minute = istMinuteOfDay(now);

  return (
    <div className="flex flex-wrap items-start gap-x-5 gap-y-3 rounded-lg border border-border bg-panel px-3 py-2.5">
      <SessionArc minute={minute} isHoliday={session?.isHoliday ?? false} />
      <div className="flex flex-wrap items-center gap-1.5">
        {analytics ? (
          <OptionChips analytics={analytics} />
        ) : (
          <span className="text-[11px] text-slate-600">
            {underlying ? `No option chain for ${underlying} yet` : 'Select an index for option context'}
          </span>
        )}
      </div>
    </div>
  );
}
