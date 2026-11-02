/**
 * Broker adapter abstraction (spec §3, §4). All Indian market logic depends on
 * this interface — NEVER on a concrete Zerodha/Upstox class. This lets us swap
 * brokers without rewriting the analysis/execution engine.
 */
import type {
  IndiaCandle,
  IndiaInstrument,
  IndiaPosition,
  IndiaTick,
  IndiaTimeframe,
} from '@fx/shared';

export type IndiaBrokerName = 'ZERODHA' | 'UPSTOX' | 'ANGELONE';

export interface BrokerCredentials {
  broker: IndiaBrokerName;
  apiKey: string;
  apiSecret: string;
  /** Pre-issued access token (optional if requestToken flow is used). */
  accessToken?: string;
  /** Upstox API Analytics Token — free, read-only, long-lived (~1 year). */
  analyticsToken?: string;
  /** OAuth request token / code obtained from the broker login redirect. */
  requestToken?: string;
  redirectUri?: string;
  /** Angel One SmartAPI (free market data, no static-IP requirement). */
  angelApiKey?: string;
  angelClientCode?: string;
  angelPin?: string;
  angelTotpSecret?: string;
}

export interface BrokerAuthResult {
  userId: string;
  accessToken: string;
  apiKey: string;
  broker: IndiaBrokerName;
  authenticated: boolean;
  /** True when the session is read-only (e.g. an Upstox Analytics Token). */
  readOnly?: boolean;
  error?: string;
}

export type BrokerOrderType = 'MARKET' | 'LIMIT' | 'SL' | 'SL-M';
export type BrokerProduct = 'CNC' | 'MIS' | 'NRML';

export interface BrokerOrderRequest {
  clientOrderId: string;
  instrumentToken: string;
  exchange: string;
  tradingSymbol: string;
  segment: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  orderType: BrokerOrderType;
  price?: number | null;
  triggerPrice?: number | null;
  product: BrokerProduct;
  validity: 'DAY' | 'IOC';
  tag?: string;
}

export interface BrokerOrder {
  orderId: string;
  clientOrderId: string;
  status: string;
  averagePrice: number | null;
  filledQuantity: number;
  remainingQuantity: number;
  rejectionReason?: string;
}

export interface BrokerAccount {
  userId: string;
  availableCash: number | null;
  availableMargin: number | null;
  currency: 'INR';
}

/** Normalized position as reported by the broker (for reconciliation, spec §50). */
export interface BrokerPosition {
  tradingSymbol: string;
  instrumentToken: string;
  exchange: string;
  segment: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  averagePrice: number;
  unrealizedPnl: number | null;
  realizedPnl: number | null;
}

export interface IndiaBrokerAdapter {
  readonly name: IndiaBrokerName;
  readonly connected: boolean;
  /** True when the current session cannot place/modify/cancel orders (read-only
   *  market-data token or no broker). Paper execution still works in-engine. */
  readonly readOnly: boolean;
  /** WebSocket market-data mode: 'ltp' = tick-by-tick (TBT); 'full' = depth. */
  readonly feedMode: 'ltp' | 'full';
  /** Establish the transport (REST + WebSocket) connection. */
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** Exchange a request/access token for a live access token. */
  authenticate(credentials: BrokerCredentials): Promise<BrokerAuthResult>;
  /** Subscribe to live ticks for the given instrument tokens. */
  subscribe(instrumentTokens: string[]): Promise<void>;
  unsubscribe(instrumentTokens: string[]): Promise<void>;
  /** Start streaming normalized ticks to the handler. */
  streamTicks(onTick: (tick: IndiaTick) => void): Promise<void>;
  /** Fetch a one-shot quote for an instrument. */
  getQuote(instrumentToken: string): Promise<IndiaTick | null>;
  /** Fetch current LTP for multiple instruments in one request (best-effort). */
  getLtpBatch(instrumentTokens: string[]): Promise<IndiaTick[]>;
  /** Fetch today's OHLC + LTP for multiple instruments (current session data). */
  getOhlcBatch(instrumentTokens: string[]): Promise<Array<{
    instrumentToken: string; ltp: number;
    open: number; high: number; low: number; close: number;
    volume: number | null; oi: number | null; previousClose: number | null;
  }>>;
  /** Fetch the full instrument master (spec §11). */
  getInstruments(): Promise<IndiaInstrument[]>;
  /**
   * Adopt an already-fetched instrument list without hitting the broker.
   *
   * Adapters that keep their own token→key map (Upstox) construct fallback keys
   * like `NSE_INDEX|26000` while that map is cold — keys the broker rejects, so
   * every history/LTP call fails even though the platform holds correct cached
   * metadata. Feeding the cache through here keeps those lookups exact on boots
   * where the master could not be re-downloaded.
   */
  adoptInstruments?(list: IndiaInstrument[]): void;
  /** Fetch historical candles from the broker/exchange. */
  getHistoricalCandles(
    instrumentToken: string,
    timeframe: IndiaTimeframe,
    from: number,
    to: number,
  ): Promise<IndiaCandle[]>;
  /** Fetch today's intraday candles (aggregated from 1-min data). */
  getIntradayCandles(instrumentToken: string, timeframe: IndiaTimeframe): Promise<IndiaCandle[]>;
  getOrders(): Promise<BrokerOrder[]>;
  getPositions(): Promise<BrokerPosition[]>;
  getAccount(): Promise<BrokerAccount | null>;
  placeOrder(req: BrokerOrderRequest): Promise<BrokerOrder>;
  modifyOrder(orderId: string, req: Partial<BrokerOrderRequest>): Promise<BrokerOrder>;
  cancelOrder(orderId: string): Promise<BrokerOrder>;
  /** Fetch option chain data for an underlying (NIFTY/BANKNIFTY/FINNIFTY). */
  getOptionChain(underlying: string): Promise<OptionChainData | null>;
}

/** Option chain strike data. */
export interface OptionStrikeData {
  strikePrice: number;
  expiryDate: number;
  call: {
    instrumentToken: string;
    tradingSymbol: string;
    ltp: number | null;
    oi: number | null;
    oiChange: number | null;
    volume: number | null;
    iv: number | null;
    bid: number | null;
    ask: number | null;
  };
  put: {
    instrumentToken: string;
    tradingSymbol: string;
    ltp: number | null;
    oi: number | null;
    oiChange: number | null;
    volume: number | null;
    iv: number | null;
    bid: number | null;
    ask: number | null;
  };
}

export interface OptionChainData {
  underlying: string;
  spotPrice: number | null;
  timestamp: number;
  strikes: OptionStrikeData[];
}