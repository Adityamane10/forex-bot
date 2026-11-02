import { Candle, DataMode, EconomicEvent, NewsItem, Tick } from '@fx/shared';
import { Timeframe } from '@fx/shared';

// ---------------------------------------------------------------------------
// Market data provider
// ---------------------------------------------------------------------------

export interface MarketDataProvider {
  readonly name: string;
  readonly mode: DataMode;
  /** Human description of the provider (free tier, limits...). */
  readonly description: string;
  /** True when the provider pushes ticks itself (streaming). When false, the
   *  market data engine polls getLatestPrice() using the poll capabilities below. */
  readonly streaming: boolean;
  /** Free-tier request budget per minute when streaming is false. */
  readonly pollBudgetPerMinute?: number;
  /** Fastest poll intervals: { active (hot symbols), idle } in ms. */
  readonly minPollIntervalMs?: { active: number; idle: number };
  /** Timeframes to preload from history at startup (default: all). */
  readonly preloadTimeframes?: Timeframe[];
  /** Provider's own quote freshness ceiling (ms) — staleness grace accounts for it. */
  readonly feedLatencyMs?: number;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getSymbols(): Promise<string[]>;
  /** Optional: inject the symbol list before connect (used by the container). */
  setSymbols?(symbols: string[]): void;
  getHistoricalCandles(symbol: string, timeframe: Timeframe, from: number, to: number): Promise<Candle[]>;
  getLatestPrice(symbol: string): Promise<Tick | null>;
  getBidAsk(symbol: string): Promise<{ bid: number; ask: number } | null>;
  getSpread(symbol: string): Promise<number | null>;
  /** Register a callback for real-time ticks. Returns an unsubscribe fn. */
  subscribe(symbol: string, onTick: (tick: Tick) => void): Promise<() => void>;
  unsubscribe(symbol: string): Promise<void>;
  /** Provider health probe. */
  health(): Promise<{ ok: boolean; detail: string }>;
}

// ---------------------------------------------------------------------------
// News provider
// ---------------------------------------------------------------------------

export interface NewsProvider {
  readonly name: string;
  readonly description: string;
  connect(): Promise<void>;
  getLatestNews(limit?: number, currencies?: string[]): Promise<NewsItem[]>;
  searchNews(query: string, limit?: number): Promise<NewsItem[]>;
  getCurrencyNews(currency: string, limit?: number): Promise<NewsItem[]>;
  health(): Promise<{ ok: boolean; detail: string }>;
}

// ---------------------------------------------------------------------------
// Economic calendar provider
// ---------------------------------------------------------------------------

export interface EconomicCalendarProvider {
  readonly name: string;
  readonly description: string;
  connect(): Promise<void>;
  getEvents(from: number, to: number): Promise<EconomicEvent[]>;
  getUpcomingEvents(limit?: number): Promise<EconomicEvent[]>;
  health(): Promise<{ ok: boolean; detail: string }>;
}

// ---------------------------------------------------------------------------
// LLM provider (optional; never required for core logic)
// ---------------------------------------------------------------------------

export interface LlmProvider {
  readonly name: string;
  readonly available: boolean;
  summarize(news: NewsItem[]): Promise<string | null>;
  classify(news: NewsItem): Promise<{ currencies: string[]; category: string; importance: string } | null>;
  explain(context: Record<string, unknown>): Promise<string | null>;
  health(): Promise<{ ok: boolean; detail: string }>;
}

// ---------------------------------------------------------------------------
// Execution provider (spec §43). Live execution is DISABLED by default and
// every execution request is gated by the platform risk engine. The v1
// implementation is a safety stub: it can never place a real order.
// ---------------------------------------------------------------------------

export type ExecutionMode = 'PAPER' | 'SHADOW' | 'LIVE';

export interface ExecutionOrder {
  symbol: string;
  direction: 'BUY' | 'SELL';
  quantity: number; // lots (forex) or base quantity (crypto)
  orderType: 'MARKET' | 'LIMIT' | 'STOP';
  price?: number;
  stopLoss?: number;
  takeProfit?: number;
}

export interface ExecutionResult {
  ok: boolean;
  orderId?: string;
  fillPrice?: number;
  reason?: string;
}

export interface ExecutionProvider {
  readonly name: string;
  readonly mode: ExecutionMode;
  /** True only when this provider can place real orders (never in v1). */
  readonly liveCapable: boolean;
  readonly description: string;
  /** Attempt to place an order. Must refuse (ok:false) unless live trading is
   *  explicitly enabled AND the caller passed every safety gate. */
  placeOrder(order: ExecutionOrder, gates: { riskApproved: boolean; liveEnabled: boolean }): Promise<ExecutionResult>;
  /** Cancel an open order. */
  cancelOrder(orderId: string): Promise<ExecutionResult>;
  health(): Promise<{ ok: boolean; detail: string }>;
}

/**
 * Safety stub: the platform's execution interface with live trading OFF.
 * It always refuses real orders. Paper/shadow execution remains the engine's
 * own simulated path (PaperTradingEngine) — this provider only exists so the
 * execution contract is explicit and the health panel can report its state.
 */
export class DisabledExecutionProvider implements ExecutionProvider {
  readonly name = 'DISABLED';
  readonly mode: ExecutionMode = 'PAPER';
  readonly liveCapable = false;
  readonly description =
    'Execution interface present but LIVE TRADING IS DISABLED by default (ENABLE_LIVE_TRADING=false). ' +
    'Paper execution runs inside the platform PaperTradingEngine; no real order can be placed.';

  constructor(private liveEnabled: boolean) {}

  async placeOrder(order: ExecutionOrder, gates: { riskApproved: boolean; liveEnabled: boolean }): Promise<ExecutionResult> {
    const reason =
      !gates.liveEnabled || !this.liveEnabled
        ? 'live trading disabled — set ENABLE_LIVE_TRADING=true and pass every safety gate'
        : !gates.riskApproved
          ? 'risk engine did not approve this order'
          : 'execution provider is a safety stub — no real orders in this build';
    return { ok: false, reason };
  }

  async cancelOrder(_orderId: string): Promise<ExecutionResult> {
    return { ok: false, reason: 'live trading disabled' };
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    return {
      ok: true,
      detail: this.liveEnabled
        ? 'execution enabled (risk gates still enforced)'
        : 'live execution disabled by default (ENABLE_LIVE_TRADING=false)',
    };
  }
}

export interface ProviderRegistry {
  marketData: MarketDataProvider;
  news: NewsProvider;
  calendar: EconomicCalendarProvider;
  llm: LlmProvider;
  /** Execution interface — live trading is OFF in this build (safety stub). */
  execution: ExecutionProvider;
  /** Normalized crypto exchange connectivity (CCXT-backed; spec §9). */
  cryptoExchange: import('./cryptoExchangeAdapter').CryptoExchangeAdapter;
  /** Crypto on-chain data (spec §17-18) — optional; reports UNAVAILABLE when absent. */
  onChain: import('./onChainProvider').OnChainProvider;
}
