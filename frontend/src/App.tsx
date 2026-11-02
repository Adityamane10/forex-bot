import { Component, ReactNode, useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { actions, RootState } from './store';
import { connectSocket, bootstrap, refreshCandles, resetSession } from './socket';
import { DEMO_EMAIL, ensureDemoAuth } from './api';
import { Dashboard } from './views/Dashboard';
import { Market } from './views/Market';
import { Signals } from './views/Signals';
import { News } from './views/News';
import { Paper } from './views/Paper';
import { Backtest } from './views/Backtest';
import { Models } from './views/Models';
import { Risk } from './views/Risk';
import { Reports } from './views/Reports';
import { Health } from './views/Health';
import { Settings } from './views/Settings';
import { Broker } from './views/Broker';
import { India } from './views/India';
import { ModeBadge } from './components/ui';
import { ToastHost, armAudio } from './components/live';
import { StatusBar } from './components/StatusBar';

const NAV = [
  ['dashboard', 'Dashboard'],
  ['market', 'Market'],
  ['signals', 'Signals'],
  ['news', 'News'],
  ['paper', 'Paper Trading'],
  ['broker', 'Broker & Account'],
  ['backtest', 'Backtesting'],
  ['models', 'Models'],
  ['risk', 'Risk'],
  ['reports', 'Reports'],
  ['india', 'India Markets'],
  ['health', 'System'],
  ['settings', 'Settings'],
] as const;

type NavItem = (typeof NAV)[number];

/**
 * Visual grouping only — derived from NAV so the entries, their order and their
 * dispatch types stay exactly as they were. Grouping gives the sidebar a
 * readable hierarchy instead of eleven equal-weight rows.
 */
const GROUPS: Array<{ label: string; items: NavItem[] }> = [
  { label: 'Markets', items: NAV.filter(([k]) => ['dashboard', 'market', 'signals', 'news'].includes(k)) },
  { label: 'Trading', items: NAV.filter(([k]) => ['paper', 'broker', 'backtest', 'models', 'risk', 'reports'].includes(k)) },
  { label: 'Regional', items: NAV.filter(([k]) => ['india'].includes(k)) },
  { label: 'System', items: NAV.filter(([k]) => ['health', 'settings'].includes(k)) },
];

/** One 15px stroke glyph per destination. Decorative only — the label carries
 *  the meaning; these give the eye a fixed point to return to while scanning. */
const ICONS: Record<NavItem[0], ReactNode> = {
  dashboard: <><rect x="2" y="2" width="5.2" height="7.4" rx="1" /><rect x="9.8" y="2" width="3.2" height="4.6" rx="1" /><rect x="2" y="12.2" width="3.2" height="2.8" rx="1" /><rect x="9.8" y="9.4" width="3.2" height="5.6" rx="1" /><path d="M15 4h1M16 11h-1" /></>,
  market: <><path d="M1.5 11.5 5 8l3 2.5L14.5 4" /><path d="M10.5 4h4v4" /></>,
  signals: <><path d="M2 13V8.5M6 13V4M10 13V6.5M14 13V2.5" /></>,
  news: <><rect x="1.75" y="3" width="11.5" height="10" rx="1.4" /><path d="M4.25 6.2h6.5M4.25 8.6h6.5M4.25 11h4" /><path d="M13.25 5h.9a.85.85 0 0 1 .85.85V12a1 1 0 0 1-1 1h-.75" /></>,
  paper: <><circle cx="8" cy="5.4" r="2.65" /><path d="M2.6 14c.7-3 2.9-4.4 5.4-4.4s4.7 1.4 5.4 4.4" /></>,
  // A bank/binding glyph: what the platform is trading on.
  broker: <><path d="M2.4 6.4 8 2.6l5.6 3.8" /><path d="M3.6 6.9v4.6M6.4 6.9v4.6M9.6 6.9v4.6M12.4 6.9v4.6" /><path d="M2.2 11.9h11.6M2.2 13.9h11.6" /></>,
  backtest: <><circle cx="7" cy="7" r="4.6" /><path d="M10.4 10.4 14 14" /><path d="M5 7h4M7 5v4" /></>,
  models: <><path d="M8 1.8 13.8 5v6L8 14.2 2.2 11V5L8 1.8Z" /><path d="M8 8v6.2M8 8 2.2 5M8 8l5.8-3" /></>,
  risk: <><path d="M8 1.8 13.6 4v4.2c0 3.2-2.3 5.4-5.6 6.6C4.7 13.6 2.4 11.4 2.4 8.2V4L8 1.8Z" /><path d="M8 5.4v3M8 10.4v.2" /></>,
  // A calendar glyph for the trading-history reports.
  reports: <><rect x="2" y="3" width="12" height="11" rx="1.4" /><path d="M2 6.4h12M5.4 1.6v2.8M10.6 1.6v2.8M5.4 9.4h2.4" /></>,
  india: <><circle cx="8" cy="8" r="6.2" /><path d="M1.8 8h12.4M8 1.8c-4.7 4-4.7 8.4 0 12.4 4.7-4 4.7-8.4 0-12.4Z" /></>,
  health: <><path d="M1.5 8h3l1.6-4 2.6 8 1.8-4h3" /></>,
  settings: <><circle cx="8" cy="8" r="2.2" /><path d="M8 1.6v2.2M8 12.2v2.2M1.6 8h2.2M12.2 8h2.2M3.5 3.5l1.6 1.6M10.9 10.9l1.6 1.6M12.5 3.5l-1.6 1.6M5.1 10.9l-1.6 1.6" /></>,
};

function NavIcon({ item }: { item: NavItem[0] }) {
  return (
    <svg
      width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"
      stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round"
      className="shrink-0 opacity-70 transition-opacity group-hover:opacity-100"
    >
      {ICONS[item]}
    </svg>
  );
}

/** Aperture mark: a lens iris, for an instrument that watches a market.
 *  The core breathes on a slow loop — the only continuously animated element
 *  in the chrome, so "the instrument is on" is legible at a glance. */
function Mark() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true" className="shrink-0 animate-iris">
      <circle cx="10" cy="10" r="8.25" stroke="#D5D1C4" strokeWidth="1.2" opacity="0.85" />
      <circle cx="10" cy="10" r="2.6" fill="#34D6A0" className="animate-breathe" style={{ animationDuration: '3.2s' }} />
      <path d="M10 1.75V6M10 14v4.25M1.75 10H6M14 10h4.25" stroke="#D5D1C4" strokeWidth="1.2" opacity="0.5" />
    </svg>
  );
}

/** Live transport indicator: a breathing core with a slow ping ring when
 *  connected; hollow and still when not. */
function Wire({ ok }: { ok: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {ok ? (
        <span className="live-dot text-emerald-400" aria-hidden="true" />
      ) : (
        <span className="h-1.5 w-1.5 rounded-full border border-red-400 bg-transparent" aria-hidden="true" />
      )}
      <span className={`font-mono text-[10px] uppercase ${ok ? 'text-slate-400' : 'text-red-300'}`} style={{ letterSpacing: '0.08em' }}>
        {ok ? 'Live' : 'Offline'}
      </span>
    </span>
  );
}

/**
 * Shown when the app can't reach the backend, or holds a session but can't open
 * the realtime link. It is a notice, not a gate: the dashboard stays interactive
 * behind it and repopulates on its own once the connection returns.
 */
function SessionNotice({ reason, onRetry }: { reason: 'backend' | 'link'; onRetry: () => void }) {
  const copy =
    reason === 'backend'
      ? {
          title: 'No backend connection',
          body: 'Prices, signals and account data stay empty until the backend on port 4000 responds. Retrying every 8 seconds.',
        }
      : {
          title: 'Live feed disconnected',
          body: 'Pages still load, but prices and signals will not stream until the realtime link reconnects. Recovering automatically.',
        };
  return (
    <div
      role="status"
      className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-amber-500/30 bg-amber-500/[0.06] px-3.5 py-2.5"
    >
      <div className="min-w-0 flex-1">
        <div className="eyebrow text-amber-300">{copy.title}</div>
        <div className="mt-0.5 text-[12px] leading-relaxed text-slate-300">{copy.body}</div>
      </div>
      <button
        onClick={onRetry}
        className="shrink-0 rounded border border-amber-500/40 px-2.5 py-1 text-[11px] font-medium text-amber-200 transition-colors hover:bg-amber-500/15"
      >
        Try again
      </button>
    </div>
  );
}

/** Catches render errors so a crash in one view never blanks the whole app. */
class Boundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(err: unknown) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-[60vh] items-center justify-center p-6">
          <div className="w-full max-w-md rounded-lg border border-red-500/30 bg-panel p-5 shadow-panel">
            <div className="eyebrow text-red-300">View error</div>
            <div className="mt-2 text-sm text-slate-200">This section stopped rendering.</div>
            <div className="mt-2 break-words font-mono text-[11px] leading-relaxed text-slate-500">{this.state.error}</div>
            <button
              onClick={() => this.setState({ error: null })}
              className="mt-4 rounded border border-border bg-panel2 px-3 py-1.5 text-xs font-medium text-slate-200 transition-colors hover:border-hairline hover:bg-border"
            >
              Reload this view
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  const dispatch = useDispatch();
  const view = useSelector((s: RootState) => s.view.view);
  const symbol = useSelector((s: RootState) => s.view.symbol);
  const token = useSelector((s: RootState) => s.auth.token);
  const ws = useSelector((s: RootState) => s.system.wsConnected);
  const dataMode = useSelector((s: RootState) => s.market.mode);
  /** Set when a session attempt fails. Drives the offline notice only — it
   *  never gates the UI, because the dashboard always renders. */
  const [sessionDown, setSessionDown] = useState(false);
  /** Bumped by "Try again" to restart the retry loop immediately. */
  const [retryNonce, setRetryNonce] = useState(0);

  // The realtime socket needs a session token, so one is acquired silently on
  // load and retried in the background. That is plumbing, not something to ask
  // the user about — there is deliberately no sign-in step.
  useEffect(() => {
    if (token) {
      setSessionDown(false);
      return;
    }
    let cancelled = false;
    let timer: number | undefined;
    const attempt = async () => {
      const t = await ensureDemoAuth();
      if (cancelled) return;
      if (t) {
        setSessionDown(false);
        dispatch(actions.auth.setAuth({ token: t, email: DEMO_EMAIL }));
      } else {
        // Backend unreachable. Keep trying: the dashboard stays on screen and
        // fills in by itself the moment the connection comes back.
        setSessionDown(true);
        timer = window.setTimeout(() => void attempt(), 8_000);
      }
    };
    void attempt();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [token, retryNonce]); // eslint-disable-line react-hooks/exhaustive-deps

  // We hold a session but the realtime link is down. Delayed by six seconds,
  // because ws is briefly false during every normal page load and a banner that
  // flashes on startup would train the user to ignore it.
  const [linkDown, setLinkDown] = useState(false);
  useEffect(() => {
    if (ws) {
      setLinkDown(false);
      return;
    }
    // Latched: once raised, the notice stays up until the socket actually
    // connects. Recovery cycles the token, and clearing on `!token` would make
    // the banner blink every 30 seconds — exactly the flicker the delay above
    // exists to avoid.
    if (!token || linkDown) return;
    const id = window.setTimeout(() => setLinkDown(true), 6_000);
    return () => window.clearTimeout(id);
  }, [token, ws, linkDown]);

  const retryNow = () => {
    // Holding a token but not connected means the token itself is suspect, so
    // drop it and mint a fresh one. With no token, just restart the loop early
    // instead of waiting out the backoff.
    if (token) resetSession();
    else setRetryNonce((n) => n + 1);
  };

  // Session-scoped: connect and load reference data once per session.
  useEffect(() => {
    if (!token) return;
    connectSocket();
    void bootstrap();
    armAudio();
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  // Symbol-scoped: keep the selected instrument's candles warm. Split out from
  // the effect above so switching symbols no longer replays the whole bootstrap.
  useEffect(() => {
    if (!token) return;
    void refreshCandles(symbol);
    const id = window.setInterval(() => void refreshCandles(symbol), 20_000);
    return () => window.clearInterval(id);
  }, [token, symbol]); // eslint-disable-line react-hooks/exhaustive-deps

  const navButton = (key: NavItem[0], label: string) => {
    const on = view === key;
    return (
      <button
        key={key}
        onClick={() => dispatch(actions.view.go({ view: key }))}
        aria-current={on ? 'page' : undefined}
        className={`group relative flex w-full items-center gap-2.5 rounded-md py-1.5 pl-3 pr-3 text-left text-[13px] transition-all duration-150 ${
          on ? 'bg-slate-100/[0.07] font-medium text-slate-100' : 'text-slate-400 hover:bg-slate-100/[0.035] hover:text-slate-200'
        }`}
      >
        {/* Lit edge: the active row reads as an illuminated instrument channel,
            growing from a spark on hover to full height when selected. */}
        <span
          className={`absolute left-0 top-1/2 -translate-y-1/2 rounded-full bg-accent transition-all duration-200 ${
            on ? 'h-[18px] w-[2px] opacity-100' : 'h-2 w-[2px] opacity-0 group-hover:opacity-40'
          }`}
          style={on ? { boxShadow: '0 0 8px 0 rgba(213,209,196,0.45)' } : undefined}
          aria-hidden="true"
        />
        <NavIcon item={key} />
        <span className="truncate">{label}</span>
      </button>
    );
  };

  return (
    <div className="flex min-h-screen flex-col">
      {/* Mobile top bar — hidden on md+ where the sidebar takes over. */}
      <header className="sticky top-0 z-20 border-b border-border bg-panel/95 backdrop-blur md:hidden">
        <div className="flex items-center justify-between px-4 py-2.5">
          <div className="flex items-center gap-2">
            <Mark />
            <span className="font-mono text-[11px] uppercase text-slate-100" style={{ letterSpacing: '0.16em' }}>
              FX Intel
            </span>
          </div>
          <div className="flex items-center gap-2">
            <ModeBadge mode={dataMode} />
            <Wire ok={ws} />
          </div>
        </div>
        <nav className="scroll-thin flex gap-1 overflow-x-auto px-3 pb-2">
          {NAV.map(([key, label]) => (
            <button
              key={key}
              onClick={() => dispatch(actions.view.go({ view: key }))}
              className={`shrink-0 rounded-md px-3 py-1.5 text-xs transition-colors ${
                view === key ? 'bg-slate-100/[0.08] font-medium text-slate-100' : 'text-slate-400 hover:bg-slate-100/[0.04]'
              }`}
            >
              {label}
            </button>
          ))}
        </nav>
      </header>

      <div className="flex flex-1">
        <aside className="hidden w-60 shrink-0 flex-col border-r border-border bg-panel md:flex">
          <div className="px-4 pb-3.5 pt-4">
            <div className="flex items-center gap-2.5">
              <Mark />
              <span className="font-mono text-[12px] font-medium uppercase text-slate-100" style={{ letterSpacing: '0.17em' }}>
                FX Intel
              </span>
            </div>
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <ModeBadge mode={dataMode} />
              <Wire ok={ws} />
            </div>
          </div>

          <div className="seam" />

          <nav className="flex-1 space-y-5 overflow-y-auto px-2.5 py-4">
            {GROUPS.map((group) => (
              <div key={group.label}>
                <div className="eyebrow mb-1.5 px-1">{group.label}</div>
                <div className="space-y-0.5">{group.items.map(([key, label]) => navButton(key, label))}</div>
              </div>
            ))}
          </nav>

          <div className="seam" />

          <div className="px-4 py-3.5">
            {/* No account identity is shown: the session token is acquired
                silently and there is no sign-in, so an email address here would
                imply an account the user never created. Styled as an engraved
                caution plate on a machined instrument. */}
            <div className="rounded-md border border-border bg-panel2 px-2.5 py-2">
              <div className="text-[10px] leading-relaxed text-slate-600">
                Paper trading only. No real money is traded and no outcome is guaranteed.
              </div>
            </div>
          </div>
        </aside>

        <main className="scroll-thin min-w-0 flex-1 overflow-y-auto p-4 lg:p-6">
          <div className="animate-slide-up">
            {(sessionDown || linkDown) && (
              <SessionNotice reason={sessionDown ? 'backend' : 'link'} onRetry={retryNow} />
            )}
            {/* Keyed on the view so navigating away clears a crashed view's
                error state instead of leaving every section stuck on it. */}
            <Boundary key={view}>
              {view === 'dashboard' && <Dashboard />}
              {view === 'market' && <Market symbol={symbol} />}
              {view === 'signals' && <Signals />}
              {view === 'news' && <News />}
              {view === 'paper' && <Paper />}
              {view === 'broker' && <Broker />}
              {view === 'backtest' && <Backtest />}
              {view === 'models' && <Models />}
              {view === 'risk' && <Risk />}
              {view === 'reports' && <Reports />}
              {view === 'india' && <India />}
              {view === 'health' && <Health />}
              {view === 'settings' && <Settings />}
            </Boundary>
          </div>
        </main>      </div>

      {/* Always-visible transport strip + transient notification stack. */}
      <StatusBar />
      <ToastHost />
    </div>
  );
}
