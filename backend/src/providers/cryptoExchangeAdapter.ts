/**
 * CryptoExchangeAdapter (spec §9). The rest of the application talks to OUR
 * normalized interface — never to CCXT directly. The CCXT implementation
 * provides market metadata, quotes, OHLCV and order books from the public
 * Binance API. Balance/position/order methods are present for interface
 * completeness but REFUSE to do anything without keys: live execution is
 * disabled by default and the DisabledExecutionProvider is the only execution
 * path in this build.
 *
 * The real-time tick path stays on BinanceCryptoMarketDataProvider (WebSocket);
 * this adapter is the metadata/REST-research/execution-interface layer.
 */
import ccxt from 'ccxt';
import { Candle, Timeframe } from '@fx/shared';
import { logger } from '../core/logger';

// ---------------------------------------------------------------------------
// Normalized types (our own contract)
// ---------------------------------------------------------------------------

export interface CryptoMarketInfo {
  symbol: string; // internal "BTC/USDT"
  exchange: string;
  baseAsset: string;
  quoteAsset: string;
  tickSize: number | null;
  quantityStep: number | null;
  minQuantity: number | null;
  maxQuantity: number | null;
  makerFee: number;
  takerFee: number;
  active: boolean;
  spot: boolean;
  swap: boolean;
  margin: boolean;
}

export interface CryptoQuote {
  symbol: string;
  timestamp: number;
  bid: number;
  ask: number;
  mid: number;
  spread: number;
}

export interface CryptoOhlcv {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface CryptoOrderBook {
  symbol: string;
  timestamp: number;
  bids: Array<[number, number]>;
  asks: Array<[number, number]>;
}

export interface CryptoExchangeAdapter {
  readonly name: string;
  readonly description: string;
  connect(): Promise<void>;
  getMarkets(): Promise<CryptoMarketInfo[]>;
  getMarket(symbol: string): Promise<CryptoMarketInfo | null>;
  getQuote(symbol: string): Promise<CryptoQuote | null>;
  getOHLCV(symbol: string, timeframe: Timeframe, from: number, to: number, limit?: number): Promise<CryptoOhlcv[]>;
  getOrderBook(symbol: string, limit?: number): Promise<CryptoOrderBook | null>;
  /** Empty without API keys (honest: no credentials configured). */
  getBalance(): Promise<Record<string, number>>;
  /** Empty without API keys. */
  getPositions(): Promise<unknown[]>;
  createOrder(): Promise<never>;
  cancelOrder(): Promise<never>;
  getOrder(): Promise<never>;
  getOpenOrders(): Promise<never>;
  health(): Promise<{ ok: boolean; detail: string }>;
}

// ---------------------------------------------------------------------------
// CCXT implementation (Binance public API)
// ---------------------------------------------------------------------------

/** Minimal shape of a CCXT market entry (avoids depending on ccxt's loose types). */
interface CcxtMarketLike {
  symbol?: string;
  base?: string;
  quote?: string;
  precision?: { price?: number; amount?: number };
  limits?: { amount?: { min?: number; max?: number } };
  maker?: number;
  taker?: number;
  active?: boolean;
  spot?: boolean;
  swap?: boolean;
  margin?: boolean;
}

const CCXT_TIMEFRAMES: Record<Timeframe, string> = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '30m': '30m',
  '1h': '1h',
  '4h': '4h',
  '1D': '1d',
};

function ccxtTimeframe(tf: Timeframe): string {
  return CCXT_TIMEFRAMES[tf] ?? '1h';
}

export class CcxtCryptoExchangeAdapter implements CryptoExchangeAdapter {
  readonly name = 'CCXT-BINANCE';
  readonly description =
    'CCXT-backed Binance adapter (public market data, no key). Normalized getMarkets/getQuote/getOHLCV/getOrderBook; ' +
    'execution methods refuse without keys — live trading disabled by default.';
  private markets: CryptoMarketInfo[] | null = null;
  private marketsAt = 0;

  constructor(private exchange: InstanceType<typeof ccxt.binance> = new ccxt.binance({ enableRateLimit: true })) {}

  async connect(): Promise<void> {
    // Public endpoints need no connection; markets load lazily on first use.
    logger.info('crypto exchange adapter ready', { exchange: this.exchange.id });
  }

  private async loadMarkets(force = false): Promise<CryptoMarketInfo[]> {
    // Cache for 5 minutes — fetchMarkets is the heaviest public call.
    if (!force && this.markets && Date.now() - this.marketsAt < 5 * 60_000) return this.markets;
    try {
      const raw = (await this.exchange.loadMarkets()) as unknown as Record<string, CcxtMarketLike>;
      const out: CryptoMarketInfo[] = [];
      for (const m of Object.values(raw)) {
        if (!m || !m.symbol) continue;
        out.push({
          symbol: m.symbol,
          exchange: this.exchange.id,
          baseAsset: m.base ?? '',
          quoteAsset: m.quote ?? '',
          tickSize: m.precision?.price ?? null,
          quantityStep: m.precision?.amount ?? null,
          minQuantity: m.limits?.amount?.min ?? null,
          maxQuantity: m.limits?.amount?.max ?? null,
          makerFee: m.maker ?? 0,
          takerFee: m.taker ?? 0,
          active: m.active !== false,
          spot: m.spot === true,
          swap: m.swap === true,
          margin: m.margin === true,
        });
      }
      this.markets = out;
      this.marketsAt = Date.now();
      return out;
    } catch (err) {
      logger.warn('ccxt loadMarkets failed', { err: String(err) });
      return this.markets ?? [];
    }
  }

  async getMarkets(): Promise<CryptoMarketInfo[]> {
    return this.loadMarkets();
  }

  async getMarket(symbol: string): Promise<CryptoMarketInfo | null> {
    const markets = await this.loadMarkets();
    return markets.find((m) => m.symbol === symbol && m.active) ?? null;
  }

  async getQuote(symbol: string): Promise<CryptoQuote | null> {
    try {
      const t = await this.exchange.fetchTicker(symbol);
      if (t.bid === undefined || t.ask === undefined || t.bid === null || t.ask === null) return null;
      const bid = t.bid;
      const ask = t.ask;
      return {
        symbol,
        timestamp: t.timestamp ?? Date.now(),
        bid,
        ask,
        mid: (bid + ask) / 2,
        spread: ask - bid,
      };
    } catch (err) {
      logger.warn('ccxt fetchTicker failed', { symbol, err: String(err) });
      return null;
    }
  }

  async getOHLCV(symbol: string, timeframe: Timeframe, from: number, to: number, limit = 1000): Promise<CryptoOhlcv[]> {
    try {
      const raw = await this.exchange.fetchOHLCV(symbol, ccxtTimeframe(timeframe), from, limit);
      return raw.map((row): CryptoOhlcv => {
        const [timestamp, open, high, low, close, volume] = row as [number, number, number, number, number, number];
        return {
          timestamp: Number(timestamp),
          open: Number(open),
          high: Number(high),
          low: Number(low),
          close: Number(close),
          volume: Number(volume),
        };
      }).filter((c: CryptoOhlcv) => c.timestamp >= from && c.timestamp <= to);
    } catch (err) {
      logger.warn('ccxt fetchOHLCV failed', { symbol, timeframe, err: String(err) });
      return [];
    }
  }

  async getOrderBook(symbol: string, limit = 20): Promise<CryptoOrderBook | null> {
    try {
      const ob = await this.exchange.fetchOrderBook(symbol, limit);
      return {
        symbol,
        timestamp: ob.timestamp ?? Date.now(),
        bids: ob.bids.slice(0, limit).map((row) => [Number(row[0]), Number(row[1])]),
        asks: ob.asks.slice(0, limit).map((row) => [Number(row[0]), Number(row[1])]),
      };
    } catch (err) {
      logger.warn('ccxt fetchOrderBook failed', { symbol, err: String(err) });
      return null;
    }
  }

  async getBalance(): Promise<Record<string, number>> {
    // No keys configured — return empty rather than guessing.
    return {};
  }

  async getPositions(): Promise<unknown[]> {
    return [];
  }

  private refuse(method: string): never {
    throw new Error(
      `${method} refused: live execution is disabled by default. ` +
      'Configure API keys AND ENABLE_LIVE_TRADING=true through the ExecutionProvider safety gates first.',
    );
  }

  async createOrder(): Promise<never> {
    return this.refuse('createOrder');
  }

  async cancelOrder(): Promise<never> {
    return this.refuse('cancelOrder');
  }

  async getOrder(): Promise<never> {
    return this.refuse('getOrder');
  }

  async getOpenOrders(): Promise<never> {
    return this.refuse('getOpenOrders');
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    return {
      ok: true,
      detail: 'ccxt binance adapter ready (read-only public data; live execution disabled)',
    };
  }
}

/** Map CCXT OHLCV rows into internal candles (helper for consumers). */
export function ohlcvToCandles(symbol: string, timeframe: Timeframe, rows: CryptoOhlcv[]): Candle[] {
  const tfMs: Record<string, number> = {
    '1m': 60_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000, '1h': 3_600_000, '4h': 14_400_000, '1D': 86_400_000,
  };
  return rows.map((r) => ({
    symbol,
    timeframe,
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    volume: r.volume,
    openTime: r.timestamp,
    closeTime: r.timestamp + tfMs[timeframe],
    state: 'COMPLETED' as const,
    completed: true,
    updatedAt: r.timestamp + tfMs[timeframe],
  }));
}
