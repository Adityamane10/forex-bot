import type { BrokerStatusView, BrokerPolicySnapshot, IndiaOptionAnalytics, IndiaOptionChainView } from '@fx/shared';

const TOKEN_KEY = 'fx_token';

/** Local demo identity used for anonymous realtime access. Never shown in the UI. */
export const DEMO_EMAIL = 'demo@fx.local';
const DEMO_PASSWORD = 'demo-fx-realtime';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

/** In-flight bootstrap, so React StrictMode's double mount (or two callers
 *  racing) results in one register/login round-trip rather than two. */
let pendingAuth: Promise<string | null> | null = null;

/**
 * Guarantees a usable session token for realtime market data without any user
 * interaction: registers the demo identity on first load, falls back to login
 * when it already exists (e.g. a second tab or a persisted store).
 *
 * Returns null only when the backend is unreachable. There is no sign-in screen
 * to fall back to — the caller keeps retrying in the background and the app
 * shows a non-blocking offline notice meanwhile.
 */
export async function ensureDemoAuth(): Promise<string | null> {
  const existing = getToken();
  if (existing) return existing;
  if (pendingAuth) return pendingAuth;
  pendingAuth = acquire().finally(() => {
    pendingAuth = null;
  });
  return pendingAuth;

  async function acquire(): Promise<string | null> {
    const token = await tryRegister();
    if (token) return token;
    const fallback = await tryLogin();
    if (fallback) return fallback;
    return null;
  }

  async function tryRegister(): Promise<string | null> {
    try {
      const res = await AuthApi.register(DEMO_EMAIL, DEMO_PASSWORD);
      setToken(res.token);
      return res.token;
    } catch {
      return null;
    }
  }
  async function tryLogin(): Promise<string | null> {
    try {
      const res = await AuthApi.login(DEMO_EMAIL, DEMO_PASSWORD);
      setToken(res.token);
      return res.token;
    } catch {
      return null;
    }
  }
}

export async function api<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(options.headers as Record<string, string>) };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`/api${path}`, { ...options, headers });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) detail = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

export const AuthApi = {
  login: (email: string, password: string) =>
    api<{ token: string; user: { id: string; email: string; role: string } }>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  register: (email: string, password: string) =>
    api<{ token: string; user: { id: string; email: string; role: string } }>('/auth/register', { method: 'POST', body: JSON.stringify({ email, password }) }),
};

/** MT5 demo-account mirror control (dashboard ↔ MetaTrader sync). */
export const Mt5Api = {
  status: () => api<{ online: boolean; enabled: boolean; workerId: string | null; lastSeenAt: number | null; pendingCommands: number; accountInfo?: { login: number; server: string; balance: number; currency: string } | null }>('/mt5/status'),
  enable: (enabled: boolean) => api<unknown>('/mt5/enable', { method: 'POST', body: JSON.stringify({ enabled }) }),
  mirrors: () => api<Array<{ commandId: string; positionId: string; symbol: string; direction: string; lots: number; action: string; status: string; mt5Ticket?: number; price?: number; error?: string; createdAt: number }>>('/mt5/mirrors'),
};

/**
 * Broker account binding (XM account type, its real conditions, and whether
 * orders may be dispatched to the bound MT5 account).
 */
export const BrokerApi = {
  profile: () => api<BrokerStatusView>('/broker/profile'),
  catalog: () => api<{
    brokers: string[];
    defaults: { profileId: string; broker: string; accountType: string };
    profiles: Array<{ id: string; broker: string; accountType: string; label: string; marketUrl: string; note: string }>;
    conditionFields: Array<{ key: string; label: string; unit?: string; kind: string }>;
  }>('/broker/catalog'),
  select: (broker: string, accountType: string) =>
    api<BrokerStatusView>('/broker/profile', { method: 'PUT', body: JSON.stringify({ broker, accountType }) }),
  confirmConditions: (values: Record<string, unknown>, note?: string) =>
    api<BrokerStatusView>('/broker/conditions/confirm', { method: 'POST', body: JSON.stringify({ values, note }) }),
  clearConditions: () => api<BrokerStatusView>('/broker/conditions/clear', { method: 'POST' }),
  /** "I have read the terms the broker publishes for this account type." */
  acknowledgeTerms: () => api<BrokerStatusView>('/broker/terms/acknowledge', { method: 'POST' }),
  /** Per-symbol costs on the bound account (spread/commission/swap + sources). */
  costs: (symbols?: string[]) =>
    api<{ accountCurrency: string; costs: unknown[]; complete: boolean }>(
      `/broker/costs${symbols?.length ? `?symbols=${encodeURIComponent(symbols.join(','))}` : ''}`,
    ),
  /** Consolidated live-money readiness checklist, optionally for one symbol. */
  readiness: (symbol?: string) =>
    api<{ ready: boolean; checkedAt: number; symbol: string | null; items: Array<{ key: string; label: string; ok: boolean; severity: string; detail: string }>; blocking: string[] }>(
      `/broker/readiness${symbol ? `?symbol=${encodeURIComponent(symbol)}` : ''}`,
    ),
  /** Terms provenance: the record written onto positions and trades. */
  terms: (symbol?: string) =>
    api<unknown>(`/broker/terms${symbol ? `?symbol=${encodeURIComponent(symbol)}` : ''}`),
  policy: () => api<BrokerPolicySnapshot>('/broker/policy'),
  recheckPolicy: () => api<BrokerPolicySnapshot>('/broker/policy/refresh', { method: 'POST' }),
};

/** Indian subsystem REST client (backend mounted at /api/india). */
export const IndiaApi = {
  status: () => api<unknown>('/india/status'),
  health: () => api<unknown>('/india/health'),
  instruments: (underlying?: string) => api<unknown>(`/india/instruments${underlying ? `?underlying=${encodeURIComponent(underlying)}` : ''}`),
  candles: (token: string, timeframe = '5m', limit = 500) =>
    api<{ token: string; timeframe: string; candles: unknown[] }>(`/india/candles/${token}?timeframe=${timeframe}&limit=${limit}`),
  indicators: (token: string, timeframe = '5m') => api<unknown>(`/india/indicators/${token}?timeframe=${timeframe}`),
  analysis: (token?: string) => api<unknown>(token ? `/india/analysis/${token}` : '/india/analysis'),
  signals: () => api<unknown>('/india/signals'),
  executeSignal: (signalId: string) =>
    api<{ position: unknown; signalId: string }>(`/india/signals/${encodeURIComponent(signalId)}/execute`, { method: 'POST' }),
  positions: () => api<unknown>('/india/positions'),
  account: () => api<unknown>('/india/account'),
  closePosition: (positionId: string) =>
    api<{ position: unknown; trade: unknown } | { error: string }>(`/india/positions/${positionId}/close`, { method: 'POST' }),
  startGoal: (body: {
    goalId?: string; amountInr: number; minimumProfitInr: number; maxRiskInr: number;
    maxMarginPercent: number; numberOfTrades: number; executionMode?: 'OFF' | 'MANUAL' | 'AUTO'; sessionPolicy?: 'TODAY_ONLY' | 'CONTINUE_NEXT_SESSION';
    tradeUnderlyings?: string[];
    // Handover variant: takes execution authority from UNIVERSAL before the
    // engine starts (the plain /goals/start fails while another owner holds it).
  }) => api<unknown>('/india/goals/handover-start', { method: 'POST', body: JSON.stringify(body) }),
  stopGoal: (goalId?: string) => api<unknown>(`/india/goals${goalId ? `/${goalId}` : ''}/stop`, { method: 'POST' }),
  userSettings: () => api<Record<string, number>>('/india/settings'),
  saveUserSettings: (body: Partial<Record<string, number>>) =>
    api<Record<string, number>>('/india/settings', { method: 'PUT', body: JSON.stringify(body) }),
  goals: () => api<unknown>('/india/goals'),
  currentGoal: () => api<unknown>('/india/goals/current'),
  authority: () => api<unknown>('/india/authority'),
  setAuthority: (body: { owner?: 'GOAL' | 'UNIVERSAL'; goalMode?: 'OFF' | 'MANUAL' | 'AUTO'; universalMode?: 'OFF' | 'MANUAL' | 'AUTO'; reason?: string }) =>
    api<unknown>('/india/authority', { method: 'POST', body: JSON.stringify(body) }),
  trades: () => api<unknown>('/india/trades'),
  backtests: () => api<unknown>('/india/backtests'),
  runBacktest: (body: {
    instruments: string[]; timeframe: string; start: number; end: number; startingCapitalInr: number;
    maxRiskInr: number; maxMarginPercent: number; minRr: number; lotSizing: 'FIXED_LOT' | 'RISK_BASED';
    numberOfTrades: number | null; goalTargetInr: number | null; slippageTicks: number; commissionPerLot: number;
  }) => api<unknown>('/india/backtests/run', { method: 'POST', body: JSON.stringify(body) }),
  backtest: (runId: string) => api<unknown>(`/india/backtests/${runId}`),
  // Option chain analytics. Typed from `@fx/shared` rather than `unknown`: the
  // callers used to cast the response to a locally-declared shape, which is how
  // the panel ended up rendering fields the backend had stopped sending.
  //
  // The route answers HTTP 200 with `{ error }` when it cannot build a chain, so
  // "no analytics" is normalised to null here instead of at every call site.
  getOptionAnalytics: async (underlying: string): Promise<IndiaOptionAnalytics | null> => {
    const res = await api<IndiaOptionAnalytics | { error: string }>(
      `/india/option-analytics?underlying=${encodeURIComponent(underlying)}`,
    );
    if ('error' in res) return null;
    return res;
  },
  getAllOptionAnalytics: () => api<Record<string, IndiaOptionAnalytics | null>>('/india/option-analytics'),
  /** Summary and per-strike ladder from one chain fetch — see IndiaOptionChainView. */
  getOptionChain: (underlying: string) =>
    api<IndiaOptionChainView>(`/india/option-chain?underlying=${encodeURIComponent(underlying)}`),
  // New: Multi-Timeframe Analysis
  getMultiTimeframe: (instrumentToken: string) => api<unknown>(`/india/multi-timeframe/${encodeURIComponent(instrumentToken)}`),
  // New: Performance Analytics
  getPerformanceAnalytics: (startDate: number, endDate: number) => 
    api<unknown>(`/india/performance?startDate=${startDate}&endDate=${endDate}`),
};
