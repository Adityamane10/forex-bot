import { configureStore, createSlice, PayloadAction } from '@reduxjs/toolkit';
import {
  Alert, OpportunityRanking, PaperAccount, PaperPosition, PaperTrade, Signal,
  SystemStatusReport, UserSettings, Tick, NewsItem, EconomicEvent, GoalAnalysis,
  IndiaTick, IndiaCandle, IndiaInstrument, IndiaSignal, IndiaPosition,
  IndiaPaperAccount, IndiaExecutionAuthorityState, IndiaGoal, IndiaBacktestRun,
  IndiaHealthDto, IndiaMarketStatusDto, IndiaDataHealth, IndiaTimeframe,
  IndiaOptionAnalytics, IndiaOptionFlowSnapshot, IndiaSignalRejection,
} from '@fx/shared';

// ---- auth ---------------------------------------------------------------
const authSlice = createSlice({
  name: 'auth',
  initialState: { token: localStorage.getItem('fx_token') ?? null, email: localStorage.getItem('fx_email') ?? null },
  reducers: {
    setAuth: (s, a: PayloadAction<{ token: string; email: string }>) => {
      s.token = a.payload.token;
      s.email = a.payload.email;
      localStorage.setItem('fx_token', a.payload.token);
      localStorage.setItem('fx_email', a.payload.email);
    },
    clearAuth: (s) => {
      s.token = null;
      s.email = null;
      localStorage.removeItem('fx_token');
      localStorage.removeItem('fx_email');
    },
  },
});

// ---- market ---------------------------------------------------------------
const marketSlice = createSlice({
  name: 'market',
  initialState: { ticks: {} as Record<string, Tick>, candles: {} as Record<string, unknown[]>, mode: '' as string },
  reducers: {
    tick: (s, a: PayloadAction<Tick>) => {
      s.ticks[a.payload.symbol] = a.payload;
      s.mode = a.payload.mode;
    },
    candles: (s, a: PayloadAction<{ symbol: string; candles: unknown[] }>) => {
      s.candles[a.payload.symbol] = a.payload.candles;
    },
  },
});

// ---- scanner ----------------------------------------------------------------
const scannerSlice = createSlice({
  name: 'scanner',
  initialState: { rankings: [] as OpportunityRanking[], goalAnalyses: [] as GoalAnalysis[] },
  reducers: {
    set: (s, a: PayloadAction<OpportunityRanking[]>) => {
      // `?? []` because an API error can deliver a 200 with an unexpected shape,
      // and storing undefined here crashes anything that reads `.length`.
      s.rankings = a.payload ?? [];
    },
    setGoal: (s, a: PayloadAction<GoalAnalysis[]>) => {
      s.goalAnalyses = a.payload ?? [];
    },
  },
});

// ---- signals -----------------------------------------------------------------
const signalsSlice = createSlice({
  name: 'signals',
  initialState: { active: [] as Signal[], history: [] as Signal[] },
  reducers: {
    setActive: (s, a: PayloadAction<Signal[]>) => {
      s.active = a.payload ?? [];
    },
    setHistory: (s, a: PayloadAction<Signal[]>) => {
      s.history = a.payload ?? [];
    },
    upsert: (s, a: PayloadAction<Signal>) => {
      const i = s.active.findIndex((x) => x.id === a.payload.id);
      if (i >= 0) s.active[i] = a.payload;
      else s.active.push(a.payload);
    },
    remove: (s, a: PayloadAction<string>) => {
      s.active = s.active.filter((x) => x.id !== a.payload);
    },
  },
});

// ---- paper ---------------------------------------------------------------------
const paperSlice = createSlice({
  name: 'paper',
  initialState: {
    account: null as PaperAccount | null,
    positions: [] as PaperPosition[],
    trades: [] as PaperTrade[],
  },
  reducers: {
    account: (s, a: PayloadAction<PaperAccount>) => {
      s.account = a.payload;
    },
    positions: (s, a: PayloadAction<PaperPosition[]>) => {
      s.positions = a.payload;
    },
    trades: (s, a: PayloadAction<PaperTrade[]>) => {
      s.trades = a.payload;
    },
  },
});

// ---- news / calendar -------------------------------------------------------------
const newsSlice = createSlice({
  name: 'news',
  initialState: { news: [] as NewsItem[], events: [] as EconomicEvent[] },
  reducers: {
    news: (s, a: PayloadAction<NewsItem[]>) => {
      s.news = a.payload;
    },
    events: (s, a: PayloadAction<EconomicEvent[]>) => {
      s.events = a.payload;
    },
  },
});

// ---- system ------------------------------------------------------------------------
const systemSlice = createSlice({
  name: 'system',
  initialState: {
    status: null as SystemStatusReport | null,
    alerts: [] as Alert[],
    wsConnected: false,
    /** MT5 broker server time offset (ms) — added to chart times so they match
     *  what the MT5 terminal shows. 0 = display plain UTC/local. */
    mt5OffsetMs: 0,
  },
  reducers: {
    status: (s, a: PayloadAction<SystemStatusReport>) => {
      s.status = a.payload;
    },
    alerts: (s, a: PayloadAction<Alert[]>) => {
      s.alerts = a.payload ?? [];
    },
    ws: (s, a: PayloadAction<boolean>) => {
      s.wsConnected = a.payload;
    },
    mt5Offset: (s, a: PayloadAction<number>) => {
      s.mt5OffsetMs = a.payload;
    },
  },
});

// ---- settings -----------------------------------------------------------------------
const settingsSlice = createSlice({
  name: 'settings',
  initialState: { settings: null as UserSettings | null },
  reducers: {
    set: (s, a: PayloadAction<UserSettings>) => {
      s.settings = a.payload;
    },
  },
});

// ---- ui view --------------------------------------------------------------------------
const viewSlice = createSlice({
  name: 'view',
  // tf persists across navigation so switching assets keeps your timeframe.
  initialState: { view: 'dashboard', symbol: 'EUR/USD', signalId: null as string | null, tf: '1h' as string },
  reducers: {
    go: (s, a: PayloadAction<{ view: string; symbol?: string; signalId?: string | null; tf?: string }>) => {
      s.view = a.payload.view;
      if (a.payload.symbol) s.symbol = a.payload.symbol;
      if (a.payload.signalId !== undefined) s.signalId = a.payload.signalId;
      if (a.payload.tf) s.tf = a.payload.tf;
    },
    setTf: (s, a: PayloadAction<string>) => {
      s.tf = a.payload;
    },
  },
});

// ---- india ------------------------------------------------------------------
type IndiaStatusDto = {
  broker: string;
  configured: boolean;
  liveExecution: boolean;
  readOnly: boolean;
  feedMode: 'ltp' | 'full';
  feedSource: string;
  primaryTimeframe: string;
  session: IndiaMarketStatusDto;
  health: IndiaDataHealth;
  executionAuthority: IndiaExecutionAuthorityState;
  feed: { connected: boolean; ticks: number; messages: number };
  instruments: number;
};

/**
 * What the store actually holds for India data health.
 *
 * Two writers feed this one slot and they carry different amounts of
 * information: `GET /api/india/health` returns the whole IndiaHealthDto, while
 * the `india.dataHealth` socket event carries only the bare IndiaDataHealth
 * snapshot. Modelling the surrounding context as optional keeps that honest —
 * and lets a socket update refresh the snapshot without discarding it.
 */
type IndiaHealthState = {
  dataHealth: IndiaDataHealth;
  session?: IndiaMarketStatusDto;
  executionAuthority?: IndiaExecutionAuthorityState;
  stale: boolean;
};

const indiaSlice = createSlice({
  name: 'india',
  initialState: {
    status: null as IndiaStatusDto | null,
    health: null as IndiaHealthState | null,
    instruments: [] as IndiaInstrument[],
    ticks: {} as Record<string, IndiaTick>,
    candles: {} as Record<string, IndiaCandle[]>,
    signals: [] as IndiaSignal[],
    positions: [] as IndiaPosition[],
    account: null as IndiaPaperAccount | null,
    authority: null as IndiaExecutionAuthorityState | null,
    goals: [] as IndiaGoal[],
    backtests: [] as IndiaBacktestRun[],
    /** Chain analytics keyed by underlying — pushed live, no longer polled. */
    optionAnalytics: {} as Record<string, IndiaOptionAnalytics>,
    optionFlow: {} as Record<string, IndiaOptionFlowSnapshot>,
    /**
     * Setups the engine found and declined. Capped and never persisted: these are
     * only interesting while fresh, and they are what answers "why has nothing
     * traded for two hours" — a question the UI previously could not address at
     * all, because only accepted signals were ever recorded.
     */
    rejections: [] as IndiaSignalRejection[],
    selectedToken: null as string | null,
    tf: '5m' as IndiaTimeframe,
  },
  reducers: {
    setStatus: (s, a: PayloadAction<IndiaStatusDto>) => {
      s.status = a.payload;
    },
    setTf: (s, a: PayloadAction<IndiaTimeframe>) => {
      s.tf = a.payload;
    },
    /**
     * Accepts either shape written to this slot. The socket carries the bare
     * snapshot, so it is merged in rather than replacing the whole object —
     * assigning it wholesale left `dataHealth` undefined, which the India view
     * renders as a red DISCONNECTED badge even when the feed is fine. An
     * unrecognised payload is ignored so the last good reading survives.
     */
    setHealth: (s, a: PayloadAction<IndiaHealthDto | IndiaDataHealth | null | undefined>) => {
      const p = a.payload;
      if (!p) return;
      if ('dataHealth' in p) {
        s.health = p;
        return;
      }
      if (!('state' in p)) return;
      if (s.health) {
        s.health.dataHealth = p;
        s.health.stale = p.stale;
      } else {
        s.health = { dataHealth: p, stale: p.stale };
      }
    },
    instruments: (s, a: PayloadAction<IndiaInstrument[]>) => {
      s.instruments = a.payload ?? [];
      if (!s.selectedToken && s.instruments.length) s.selectedToken = s.instruments[0].instrumentToken;
    },
    tick: (s, a: PayloadAction<IndiaTick>) => {
      s.ticks[a.payload.instrumentToken] = a.payload;
    },
    candles: (s, a: PayloadAction<{ token: string; timeframe: string; candles: IndiaCandle[] }>) => {
      s.candles[`${a.payload.token}|${a.payload.timeframe}`] = a.payload.candles ?? [];
    },
    upsertSignal: (s, a: PayloadAction<IndiaSignal>) => {
      const i = s.signals.findIndex((x) => x.signalId === a.payload.signalId);
      if (i >= 0) s.signals[i] = a.payload;
      else s.signals.unshift(a.payload);
      s.signals = s.signals.slice(0, 200);
    },
    signals: (s, a: PayloadAction<IndiaSignal[]>) => {
      s.signals = a.payload ?? [];
    },
    optionAnalytics: (s, a: PayloadAction<IndiaOptionAnalytics | null | undefined>) => {
      const p = a.payload;
      // Guard the underlying: a malformed payload must not create an empty-string
      // key that then shadows a real underlying in every lookup.
      if (!p || typeof p.underlying !== 'string' || p.underlying === '') return;
      // Drop an out-of-order write. Two writers feed this slot — a socket push
      // and the panel's initial REST fill — and the fill can land after the first
      // push, which would make the panel visibly step backwards in time.
      const prev = s.optionAnalytics[p.underlying];
      if (prev && typeof p.timestamp === 'number' && p.timestamp < prev.timestamp) return;
      s.optionAnalytics[p.underlying] = p;
    },
    optionFlow: (s, a: PayloadAction<IndiaOptionFlowSnapshot | null | undefined>) => {
      const p = a.payload;
      if (!p || typeof p.underlying !== 'string' || p.underlying === '') return;
      const prev = s.optionFlow[p.underlying];
      if (prev && typeof p.timestamp === 'number' && p.timestamp < prev.timestamp) return;
      s.optionFlow[p.underlying] = p;
    },
    rejection: (s, a: PayloadAction<IndiaSignalRejection | null | undefined>) => {
      const p = a.payload;
      if (!p || typeof p.at !== 'number') return;
      s.rejections = [p, ...s.rejections].slice(0, 100);
    },
    positions: (s, a: PayloadAction<IndiaPosition[]>) => {
      s.positions = a.payload ?? [];
    },
    account: (s, a: PayloadAction<IndiaPaperAccount>) => {
      s.account = a.payload;
    },
    authority: (s, a: PayloadAction<IndiaExecutionAuthorityState>) => {
      s.authority = a.payload;
    },
    goals: (s, a: PayloadAction<IndiaGoal[]>) => {
      s.goals = a.payload ?? [];
    },
    backtests: (s, a: PayloadAction<IndiaBacktestRun[]>) => {
      s.backtests = a.payload ?? [];
    },
    select: (s, a: PayloadAction<string>) => {
      s.selectedToken = a.payload;
    },
  },
});

export const store = configureStore({
  reducer: {
    auth: authSlice.reducer,
    market: marketSlice.reducer,
    scanner: scannerSlice.reducer,
    signals: signalsSlice.reducer,
    paper: paperSlice.reducer,
    news: newsSlice.reducer,
    system: systemSlice.reducer,
    settings: settingsSlice.reducer,
    view: viewSlice.reducer,
    india: indiaSlice.reducer,
  },
});

export const actions = {
  auth: authSlice.actions,
  market: marketSlice.actions,
  scanner: scannerSlice.actions,
  signals: signalsSlice.actions,
  paper: paperSlice.actions,
  news: newsSlice.actions,
  system: systemSlice.actions,
  settings: settingsSlice.actions,
  view: viewSlice.actions,
  india: indiaSlice.actions,
};

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
