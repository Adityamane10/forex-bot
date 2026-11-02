import { io, Socket } from 'socket.io-client';
import { store, actions } from './store';
import { clearToken, getToken } from './api';
import { toast, playSound } from './components/live';
import {
  Alert, OpportunityRanking, PaperAccount, PaperPosition, PaperTrade, Signal,
  SignalUpdate, SystemStatusReport, Tick, NewsItem, Candle, UserSettings, GoalAnalysis,
  IndiaTick, IndiaCandle, IndiaSignal, IndiaPosition, IndiaPaperAccount,
  IndiaExecutionAuthorityState, IndiaDataHealth, IndiaGoal,
  IndiaInstrument,
  IndiaOptionAnalytics, IndiaOptionFlowSnapshot, IndiaSignalRejection,
} from '@fx/shared';

let socket: Socket | null = null;

/**
 * When the session token was last discarded after a rejected handshake.
 *
 * A cooldown rather than a one-shot flag on purpose: a one-shot guard would let
 * a *second* rejection fall through and leave a dead socket auto-reconnecting
 * forever with a token the backend will never accept — invisible, and with no
 * sign-in screen to escape through.
 */
let lastSessionReissue = 0;
const REISSUE_COOLDOWN_MS = 30_000;
/** Pending automatic session retry, so recovery never depends on a click. */
let reissueTimer: number | undefined;

/** Tears down a socket that exists but isn't usable, so a replacement can be
 *  opened without the dead one reconnecting in the background. */
function disposeSocket(): void {
  if (!socket) return;
  socket.removeAllListeners();
  socket.disconnect();
  socket = null;
}

/**
 * Forces a brand-new session: drops the stored token and stops the socket, so
 * App mints a fresh token and reconnects. This is what the offline notice's
 * "Try again" does — the only manual recovery path now that there is no login.
 */
export function resetSession(): void {
  lastSessionReissue = Date.now();
  if (reissueTimer !== undefined) {
    window.clearTimeout(reissueTimer);
    reissueTimer = undefined;
  }
  disposeSocket();
  clearToken();
  store.dispatch(actions.auth.clearAuth());
}

/**
 * Timeframe the user is currently viewing. Candle data is cached per
 * (symbol, timeframe) pair, and background refreshes target this timeframe.
 */
let currentTf: string = '1h';

export function setActiveTimeframe(tf: string): void {
  currentTf = tf;
}

export function getActiveTimeframe(): string {
  return currentTf;
}

export function connectSocket(): Socket {
  if (socket?.connected) return socket;
  // A socket can exist while being permanently unusable — typically stuck
  // retrying with a token the backend no longer accepts. Dispose it first, or
  // the dead one keeps reconnecting alongside its replacement.
  disposeSocket();
  // Same-origin by default: works on any hostname (remote access, containers,
  // TLS domains) because the API is served through the same origin/proxy.
  // VITE_API_URL overrides for split deployments. The hardcoded
  // http://127.0.0.1:4000 broke everything except localhost browsers.
  const backendUrl = import.meta.env.VITE_API_URL as string | undefined ?? window.location.origin;
  socket = io(backendUrl, {
    auth: { token: getToken() },
    transports: ['websocket', 'polling'],
    path: '/socket.io',
  });

  socket.on('connect', () => {
    lastSessionReissue = 0;
    store.dispatch(actions.system.ws(true));
    socket?.emit('subscribe', 'market');
    socket?.emit('subscribe', 'signals');
    socket?.emit('subscribe', 'news');
    socket?.emit('subscribe', 'risk');
    socket?.emit('subscribe', 'paper');
    socket?.emit('subscribe', 'system');
    socket?.emit('subscribe', 'scanner');
    socket?.emit('subscribe', 'india');
  });
  socket.on('disconnect', () => store.dispatch(actions.system.ws(false)));
  socket.on('connect_error', (err: Error) => {
    store.dispatch(actions.system.ws(false));
    if (!/auth|token/i.test(String(err?.message ?? ''))) return;
    // The handshake was rejected. Always stop this socket: left alone it retries
    // the same refused token indefinitely.
    disposeSocket();
    // Then discard the token so App mints a fresh one — usually the backend
    // restarted and reissued its signing key. Rate-limited, so a backend that
    // refuses everything can't spin; the UI shows the offline notice instead.
    const since = Date.now() - lastSessionReissue;
    if (since < REISSUE_COOLDOWN_MS) {
      // Still cooling down. Schedule the next attempt for when it lapses, so the
      // app heals itself even if nobody is watching it.
      if (reissueTimer === undefined) {
        reissueTimer = window.setTimeout(() => {
          reissueTimer = undefined;
          resetSession();
        }, REISSUE_COOLDOWN_MS - since + 250);
      }
      return;
    }
    // Reissue now. Going through resetSession() rather than clearing the token
    // inline matters: it also cancels any timer armed by an earlier failure,
    // which would otherwise fire moments later and discard the brand-new token.
    resetSession();
  });

  socket.on('market.price', (tick: Tick) => store.dispatch(actions.market.tick(tick)));
  socket.on('market.candle', (candle: Candle | undefined) => {
    // Apply the completed candle in place; the REST fallback only exists for
    // older/partial payloads. This kills the 300-bar refetch per candle close.
    if (!candle || typeof candle.openTime !== 'number' || !candle.symbol || !candle.timeframe) {
      void refreshCandles(store.getState().view.symbol);
      return;
    }
    const key = `${candle.symbol}|${candle.timeframe}`;
    const list = (store.getState().market.candles[key] as Candle[] | undefined) ?? [];
    const merged = list.filter((c) => c.openTime !== candle.openTime);
    merged.push(candle);
    merged.sort((a, b) => a.openTime - b.openTime);
    store.dispatch(actions.market.candles({ symbol: key, candles: merged.slice(-300) }));
  });
  socket.on('signal.created', (s: Signal) => {
    store.dispatch(actions.signals.upsert(s));
    toast(`Signal: ${s.direction ?? ''} ${s.symbol} @ ${typeof s.price === 'number' ? s.price.toPrecision(6) : ''}`.trim(), s.direction === 'BUY' ? 'up' : s.direction === 'SELL' ? 'down' : 'info');
    playSound('signal');
    void refreshSignals();
  });
  socket.on('signal.updated', (s: Signal | SignalUpdate) => {
    // The backend now emits the full, refreshed Signal so we can apply it
    // instantly; fall back to a refetch for older/partial payloads.
    if ('id' in s && 'entry' in s) store.dispatch(actions.signals.upsert(s as Signal));
    else void refreshSignals();
    void refreshPaper();
  });
  socket.on('signal.state', () => {
    // State transitions (ENTRY_REACHED → POSITION_ACTIVE → …) sync active
    // signals + history + paper immediately.
    void refreshSignals();
    void refreshPaper();
  });
  socket.on('signal.invalidated', () => {
    void refreshSignals();
  });
  socket.on('signal.missed', () => {
    void refreshSignals();
  });
  // Position P&L is tick-driven (paper.onTick marks every position on its own
  // symbol's ticks and pushes the full position at ~1 Hz). Applying the pushed
  // position directly keeps `unrealizedPnl` live; the old handler refetched the
  // whole book over REST per push, which read as a 1–3 s P&L delay in the UI.
  socket.on('paper.position', (p: PaperPosition) => {
    if (!p || typeof p.id !== 'string') {
      void refreshPaper();
      return;
    }
    const cur = store.getState().paper.positions;
    if (p.status === 'CLOSED') {
      store.dispatch(actions.paper.positions(cur.filter((x) => x.id !== p.id)));
      return;
    }
    const idx = cur.findIndex((x) => x.id === p.id);
    if (idx >= 0) {
      const next = [...cur];
      next[idx] = p;
      store.dispatch(actions.paper.positions(next));
    } else {
      store.dispatch(actions.paper.positions([p, ...cur]));
    }
  });
  socket.on('paper.trade', (t?: { symbol?: string; pnl?: number; exitReason?: string }) => {
    if (t && typeof t.pnl === 'number') {
      toast(`${t.exitReason ?? 'CLOSED'} ${t.symbol ?? ''} — P&L ${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)}`, t.pnl >= 0 ? 'up' : 'down');
    }
    playSound('close');
    void refreshPaper();
    void refreshSignals();
  });
  socket.on('risk.update', (a: PaperAccount) => store.dispatch(actions.paper.account(a)));
  socket.on('news.update', (n: NewsItem[]) => {
    store.dispatch(actions.news.news(n));
    void refreshNews();
  });
  socket.on('scanner.update', (r: OpportunityRanking[]) => store.dispatch(actions.scanner.set(r)));
  socket.on('goal.update', (a: GoalAnalysis[]) => store.dispatch(actions.scanner.setGoal(a)));
  socket.on('system.status', (s: SystemStatusReport) => store.dispatch(actions.system.status(s)));
  socket.on('alert', (a: Alert) => {
    store.dispatch(actions.system.alerts([a, ...store.getState().system.alerts].slice(0, 100)));
    // Critical alerts also surface as a toast + alarm sound so they are seen
    // even when the user is on another view.
    if (a.severity === 'CRITICAL') {
      toast(a.message, 'down');
      playSound('alarm');
    } else if (a.severity === 'WARNING') {
      toast(a.message, 'warn');
    }
  });

  // ---- india realtime -------------------------------------------------------
  socket.on('india.price', (t: IndiaTick) => store.dispatch(actions.india.tick(t)));
  socket.on('india.candle', (c: IndiaCandle | undefined) => {
    if (!c || typeof c.openTime !== 'number' || !c.instrumentToken || !c.timeframe) return;
    const key = `${c.instrumentToken}|${c.timeframe}`;
    const list = (store.getState().india.candles[key] ?? []);
    const merged = list.filter((x) => x.openTime !== c.openTime);
    merged.push(c);
    merged.sort((a, b) => a.openTime - b.openTime);
    store.dispatch(actions.india.candles({ token: c.instrumentToken, timeframe: c.timeframe, candles: merged.slice(-500) }));
  });
  socket.on('india.marketStatus', () => void refreshIndiaStatus());
  // The backend emits the bare snapshot here, not the wrapped IndiaHealthDto
  // that GET /api/india/health returns (see data-health.ts emit()). The reducer
  // normalises both shapes; annotating it correctly is what makes that visible.
  socket.on('india.dataHealth', (h: IndiaDataHealth) => store.dispatch(actions.india.setHealth(h)));
  socket.on('india.signal', (s: IndiaSignal) => {
    store.dispatch(actions.india.upsertSignal(s));
    void refreshIndiaSignals();
  });
  socket.on('india.signalInvalidated', () => void refreshIndiaSignals());
  // Setups the engine declined. Pushed, never fetched — there is no endpoint and
  // there shouldn't be: a rejection is only interesting while it is fresh.
  socket.on('india.signalRejected', (r: IndiaSignalRejection) => store.dispatch(actions.india.rejection(r)));
  socket.on('india.optionAnalytics', (a: IndiaOptionAnalytics) => store.dispatch(actions.india.optionAnalytics(a)));
  socket.on('india.optionFlow', (f: IndiaOptionFlowSnapshot) => store.dispatch(actions.india.optionFlow(f)));
  // Position P&L is tick-driven (paper.monitor on every `india:tick`). The
  // previous handler re-fetched the whole position book over REST on every
  // tick — an extra round-trip that made `currentPrice`/`uPnL` lag the `ticks`
  // map by the REST latency plus the 10s `refreshAll` fallback. Apply the
  // pushed position directly and keep the REST fetch only as a catch-up.
  socket.on('india.position', (p: IndiaPosition) => {
    if (!p || typeof (p as IndiaPosition).positionId !== 'string') {
      void refreshIndiaPositions();
      return;
    }
    const cur = store.getState().india.positions;
    const idx = cur.findIndex((x) => x.positionId === (p as IndiaPosition).positionId);
    let next: IndiaPosition[];
    if ((p as IndiaPosition).status === 'CLOSED') {
      next = cur.filter((x) => x.positionId !== (p as IndiaPosition).positionId);
    } else if (idx >= 0) {
      next = [...cur];
      next[idx] = p as IndiaPosition;
    } else {
      next = [p as IndiaPosition, ...cur];
    }
    store.dispatch(actions.india.positions(next));
  });
  socket.on('india.pnl', (a: IndiaPaperAccount) => store.dispatch(actions.india.account(a)));
  socket.on('india.goal', () => void refreshIndiaGoals());
  socket.on('india.goalProgress', () => void refreshIndiaGoals());
  socket.on('india.executionAuthority', (a: IndiaExecutionAuthorityState) => store.dispatch(actions.india.authority(a)));
  return socket;
}

function authHeader(): Record<string, string> {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

export async function refreshCandles(symbol: string, tf: string = currentTf): Promise<void> {
  try {
    // Symbols contain a slash (EUR/USD); encode it or Express 404s the request.
    // A 10s timeout guarantees a slow provider/lazy seed can never hang the UI.
    const res = await fetch(`/api/candles/${encodeURIComponent(symbol)}?timeframe=${tf}&limit=300`, { headers: authHeader(), signal: AbortSignal.timeout(10_000) });
    const json = (await res.json()) as { candles: unknown[] };
    store.dispatch(actions.market.candles({ symbol: `${symbol}|${tf}`, candles: json.candles ?? [] }));
  } catch {
    /* ignore */
  }
}

async function refreshSignals(): Promise<void> {
  try {
    const h = authHeader();
    const [active, history] = await Promise.all([
      fetch('/api/signals', { headers: h }).then((r) => r.json()),
      fetch('/api/signals/history', { headers: h }).then((r) => r.json()),
    ]);
    // Guard against undefined payloads (e.g. an API error) so the Signals view
    // never renders with a non-array and crashes. History is deduped by id
    // (keep the newest state) — one signal may span several stored rows from
    // earlier versions of the persistence layer.
    const hist = (history as { signals?: Signal[] }).signals ?? [];
    const seen = new Set<string>();
    const deduped = hist.filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)));
    store.dispatch(actions.signals.setActive((active as { signals?: Signal[] }).signals ?? []));
    store.dispatch(actions.signals.setHistory(deduped));
  } catch {
    /* ignore */
  }
}

async function refreshPaper(): Promise<void> {
  try {
    const h = authHeader();
    const [pos, trades] = await Promise.all([
      fetch('/api/paper/positions', { headers: h }).then((r) => r.json()),
      fetch('/api/paper/trades', { headers: h }).then((r) => r.json()),
    ]);
    store.dispatch(actions.paper.positions((pos as { positions: PaperPosition[] }).positions));
    store.dispatch(actions.paper.trades((trades as { trades: PaperTrade[] }).trades));
  } catch {
    /* ignore */
  }
}

export { refreshPaper, refreshSignals };

async function refreshNews(): Promise<void> {
  try {
    const h = authHeader();
    const res = await fetch('/api/news', { headers: h });
    store.dispatch(actions.news.news((await res.json() as { news: NewsItem[] }).news));
  } catch {
    /* ignore */
  }
}

async function refreshIndiaStatus(): Promise<void> {
  try {
    const h = authHeader();
    const res = await fetch('/api/india/status', { headers: h });
    store.dispatch(actions.india.setStatus(await res.json() as never));
  } catch {
    /* ignore */
  }
}

async function refreshIndiaSignals(): Promise<void> {
  try {
    const h = authHeader();
    const res = await fetch('/api/india/signals', { headers: h });
    store.dispatch(actions.india.signals((await res.json() as IndiaSignal[])));
  } catch {
    /* ignore */
  }
}

async function refreshIndiaPositions(): Promise<void> {
  try {
    const h = authHeader();
    const [positions, account] = await Promise.all([
      fetch('/api/india/positions', { headers: h }).then((r) => r.json()),
      fetch('/api/india/account', { headers: h }).then((r) => r.json()),
    ]);
    store.dispatch(actions.india.positions(positions as IndiaPosition[]));
    store.dispatch(actions.india.account(account as IndiaPaperAccount));
  } catch {
    /* ignore */
  }
}

async function refreshIndiaGoals(): Promise<void> {
  try {
    const h = authHeader();
    const [goals, authority] = await Promise.all([
      fetch('/api/india/goals', { headers: h }).then((r) => r.json()),
      fetch('/api/india/authority', { headers: h }).then((r) => r.json()),
    ]);
    store.dispatch(actions.india.goals(goals as IndiaGoal[]));
    store.dispatch(actions.india.authority(authority as IndiaExecutionAuthorityState));
  } catch {
    /* ignore */
  }
}

export { refreshIndiaStatus, refreshIndiaSignals, refreshIndiaPositions, refreshIndiaGoals };

export async function bootstrap(): Promise<void> {
  const h = authHeader();
  const [scanner, risk, alerts, ticks, status, settings, goal] = await Promise.all([
    fetch('/api/scanner', { headers: h }).then((r) => r.json()).catch(() => ({ rankings: [] })),
    fetch('/api/risk', { headers: h }).then((r) => r.json()).catch(() => ({ account: null })),
    fetch('/api/system/alerts', { headers: h }).then((r) => r.json()).catch(() => ({ alerts: [] })),
    fetch('/api/ticks', { headers: h }).then((r) => r.json()).catch(() => ({ ticks: [] })),
    fetch('/api/system/status', { headers: h }).then((r) => r.json()).catch(() => ({ mt5ServerOffsetMs: 0 })),
    fetch('/api/settings', { headers: h }).then((r) => r.json()).catch(() => null),
    fetch('/api/goal-signals', { headers: h }).then((r) => r.json()).catch(() => ({ analyses: [] })),
  ]);
  store.dispatch(actions.scanner.set((scanner as { rankings: OpportunityRanking[] }).rankings));
  store.dispatch(actions.scanner.setGoal((goal as { analyses: GoalAnalysis[] }).analyses));
  store.dispatch(actions.paper.account((risk as { account: PaperAccount | null }).account ?? ({} as PaperAccount)));
  store.dispatch(actions.system.alerts((alerts as { alerts: Alert[] }).alerts));
  if (settings) store.dispatch(actions.settings.set(settings as UserSettings));
  // MT5 server time offset — chart timestamps match the MT5 terminal exactly.
  const offset = Number((status as { mt5ServerOffsetMs?: number }).mt5ServerOffsetMs ?? 0);
  if (Number.isFinite(offset) && offset !== 0) store.dispatch(actions.system.mt5Offset(offset));
  // Populate latest prices instantly so the UI is never empty on page load
  // while waiting for the next poll cycle.
  for (const t of (ticks as { ticks: Tick[] }).ticks ?? []) store.dispatch(actions.market.tick(t));
  await refreshSignals();
  await refreshPaper();
  await refreshNews();
  await refreshIndiaStatus();
  await refreshIndiaSignals();
  await refreshIndiaPositions();
  await refreshIndiaGoals();
  void refreshIndiaInstruments();
}

async function refreshIndiaInstruments(): Promise<void> {
  try {
    const res = await fetch('/api/india/instruments', { headers: authHeader() });
    store.dispatch(actions.india.instruments((await res.json() as IndiaInstrument[])));
  } catch {
    /* ignore */
  }
}
