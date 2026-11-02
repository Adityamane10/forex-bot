/**
 * Upstox adapter — implements IndiaBrokerAdapter on the official Upstox APIs.
 */
import type { IndiaCandle, IndiaInstrument, IndiaTick, IndiaTimeframe } from '@fx/shared';
import { IndiaBrokerAdapter, BrokerAccount, BrokerCredentials, BrokerOrder, BrokerOrderRequest, BrokerPosition } from '../types';
import { upstoxToken, upstoxLoginUrl } from './upstox-auth';
import { fetchUpstoxInstruments, fetchUpstoxHistoricalCandles, fetchUpstoxIntradayCandles, UpstoxWebSocket, UpstoxFeedMode } from './upstox-market-data';
import { upstoxPlaceOrder, upstoxModifyOrder, upstoxCancelOrder, upstoxGetOrders, upstoxGetPositions, upstoxGetAccount } from './upstox-orders';
import { logger } from '../../../core/logger';

export class UpstoxAdapter implements IndiaBrokerAdapter {
  readonly name = 'UPSTOX' as const;
  readonly feedMode: UpstoxFeedMode;
  private apiKey = '';
  private accessToken = '';
  private ws: UpstoxWebSocket | null = null;
  private instrumentsByToken = new Map<string, IndiaInstrument>();
  /** Secondary map keyed by instrumentKey (full 'NSE_INDEX|26000') for tick reverse-lookup. */
  private instrumentsByKey = new Map<string, IndiaInstrument>();
  private tickHandler: ((tick: IndiaTick) => void) | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectCount = 0;
  private readOnlySession = false;

  constructor(opts?: { feedMode?: UpstoxFeedMode }) {
    this.feedMode = opts?.feedMode ?? 'ltp';
  }

  get connected(): boolean {
    return Boolean(this.apiKey || this.accessToken) && (this.ws?.connected ?? false);
  }

  get readOnly(): boolean {
    return this.readOnlySession;
  }

  async connect(): Promise<void> {
    // Authenticate first; connect() is idempotent.
  }

  async disconnect(): Promise<void> {
    this.ws?.close();
    this.ws = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.apiKey = '';
    this.accessToken = '';
  }

  async authenticate(credentials: BrokerCredentials): Promise<import('../types').BrokerAuthResult> {
    const session = await upstoxToken(credentials);
    this.apiKey = session.apiKey;
    this.accessToken = session.accessToken;
    this.readOnlySession = Boolean(session.readOnly);
    logger.info('upstox: authenticated', { readOnly: this.readOnlySession });
    return session;
  }

  /** Returns the broker instrument key for subscription.
   *  Prefer the stored instrumentKey field; fall back to constructing it from segment. */
  private instrumentKeyFor(token: string): string {
    const instr = this.instrumentsByToken.get(token);
    if (instr?.instrumentKey) return instr.instrumentKey;
    // Fallback: construct from segment + token (handles cached instruments without the key)
    const segment = instr?.segment === 'NSE_INDEX' ? 'NSE_INDEX'
      : instr?.segment === 'BSE_INDEX' ? 'BSE_INDEX'
      : instr?.segment === 'BSE_FUT' ? 'BSE_FUT'
      : instr?.segment === 'BSE_OPT' ? 'BSE_OPT'
      : instr?.segment === 'NSE_OPT' ? 'NSE_OPT'
      : 'NSE_FO';
    return `${segment}|${token}`;
  }

  async subscribe(instrumentTokens: string[]): Promise<void> {
    const keys = instrumentTokens.map((t) => this.instrumentKeyFor(t));
    if (!keys.length) return;
    if (!this.ws) await this.openWs();
    const deliver = () => this.ws?.subscribe(keys);
    if (this.ws?.connected) deliver();
    else setTimeout(deliver, 1500);
  }

  async unsubscribe(instrumentTokens: string[]): Promise<void> {
    this.ws?.unsubscribe(instrumentTokens.map((t) => this.instrumentKeyFor(t)));
  }

  async streamTicks(onTick: (tick: IndiaTick) => void): Promise<void> {
    this.tickHandler = onTick;
    if (!this.ws) await this.openWs();
  }

  private async openWs(): Promise<void> {
    if (!this.accessToken) return;
    this.ws = new UpstoxWebSocket(this.accessToken, { feedMode: this.feedMode });
    await this.ws.connect({
      onTick: (tick) => {
        // ticks arrive with instrumentToken set to the raw broker key (e.g. 'NSE_INDEX|26000')
        // Look up via instrumentsByKey first; fall back to instrumentsByToken for numeric tokens.
        const instrByKey = this.instrumentsByKey.get(tick.instrumentToken);
        const instr = instrByKey ?? this.instrumentsByToken.get(tick.instrumentToken);
        if (instr) {
          // Rewrite instrumentToken to the canonical numeric id (exchange_token)
          // so all downstream consumers (candle engine, paper exec, frontend) see
          // the same token that is stored in instruments.byToken.
          tick.instrumentToken = instr.instrumentToken;
          tick.tradingSymbol = instr.tradingSymbol;
          tick.underlying = instr.underlying;
          tick.segment = instr.segment;
          tick.exchange = instr.exchange;
        }
        this.tickHandler?.(tick);
      },
      onConnect: () => logger.info('upstox: websocket connected'),
      onDisconnect: () => {
        logger.warn('upstox: websocket disconnected');
        this.scheduleReconnect();
      },
      onError: (err) => logger.error('upstox: websocket error', { err: String(err) }),
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectCount += 1;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.reconnectCount, 5));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.accessToken) void this.openWs().catch((err) => logger.warn('upstox: ws reconnect failed', { err: String(err) }));
    }, delay);
  }

  async getQuote(instrumentToken: string): Promise<IndiaTick | null> {
    if (!this.accessToken) return null;
    const key = this.instrumentKeyFor(instrumentToken);
    const res = await fetch(`https://api.upstox.com/v2/market-quote/ltp?instrument_key=${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${this.accessToken}`, Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: Record<string, { last_price: number; instrument_token?: string }> };
    // Response key uses colon: "NSE_INDEX:Nifty 50"
    const responseKey = key.replace('|', ':');
    const d = json.data?.[responseKey] ?? Object.values(json.data ?? {})[0];
    if (!d) return null;
    const ts = Date.now();
    const instr = this.instrumentsByToken.get(instrumentToken);
    return {
      exchange: instr?.exchange ?? 'NSE',
      segment: instr?.segment ?? 'NSE_INDEX',
      instrumentToken,
      tradingSymbol: instr?.tradingSymbol ?? key,
      underlying: instr?.underlying ?? '',
      marketTimestamp: ts,
      receivedAt: ts,
      timestamp: ts,
      ltp: d.last_price,
      bid: null, ask: null, bidQuantity: null, askQuantity: null,
      volume: null, openInterest: null,
      dayOpen: null, dayHigh: null, dayLow: null,
      previousClose: null, lastTradeQuantity: null,
      source: 'UPSTOX',
      tradable: true,
    };
  }

  /** Fetch LTP for multiple instruments in a single request.
   *  Used to populate live prices on boot when the WS stream is unavailable. */
  async getLtpBatch(instrumentTokens: string[]): Promise<IndiaTick[]> {
    if (!this.accessToken || instrumentTokens.length === 0) return [];
    const keys = instrumentTokens.map(t => this.instrumentKeyFor(t));
    const param = keys.map(k => encodeURIComponent(k)).join(',');
    const res = await fetch(`https://api.upstox.com/v2/market-quote/ltp?instrument_key=${param}`, {
      headers: { Authorization: `Bearer ${this.accessToken}`, Accept: 'application/json' },
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { data?: Record<string, { last_price: number }> };
    if (!json.data) return [];
    const ticks: IndiaTick[] = [];
    const ts = Date.now();
    for (let i = 0; i < instrumentTokens.length; i++) {
      const token = instrumentTokens[i];
      const key = keys[i];
      // Upstox responds with colon-separated key
      const responseKey = key.replace('|', ':');
      const d = json.data[responseKey];
      if (!d) continue;
      const instr = this.instrumentsByToken.get(token);
      ticks.push({
        exchange: instr?.exchange ?? 'NSE',
        segment: instr?.segment ?? 'NSE_INDEX',
        instrumentToken: token,
        tradingSymbol: instr?.tradingSymbol ?? key,
        underlying: instr?.underlying ?? '',
        marketTimestamp: ts,
        receivedAt: ts,
        timestamp: ts,
        ltp: d.last_price,
        bid: null, ask: null, bidQuantity: null, askQuantity: null,
        volume: null, openInterest: null,
        dayOpen: null, dayHigh: null, dayLow: null,
        previousClose: null, lastTradeQuantity: null,
        source: 'UPSTOX',
        tradable: true,
      });
    }
    return ticks;
  }

  /** Fetch current day OHLC + LTP for multiple instruments in one request.
   *  Returns today's open/high/low/close even during live session.
   *  Used to build today's candle data when the historical API has no live-session bars. */
  async getOhlcBatch(instrumentTokens: string[]): Promise<Array<{
    instrumentToken: string;
    ltp: number;
    open: number; high: number; low: number; close: number;
    volume: number | null;
    oi: number | null;
    previousClose: number | null;
  }>> {
    if (!this.accessToken || instrumentTokens.length === 0) return [];
    const keys = instrumentTokens.map(t => this.instrumentKeyFor(t));
    const param = keys.map(k => encodeURIComponent(k)).join(',');
    const res = await fetch(
      `https://api.upstox.com/v2/market-quote/ohlc?instrument_key=${param}`,
      { headers: { Authorization: `Bearer ${this.accessToken}`, Accept: 'application/json' } },
    );
    if (!res.ok) return [];
    const json = (await res.json()) as {
      data?: Record<string, {
        last_price: number;
        ohlc: { open: number; high: number; low: number; close: number };
        volume?: number;
        oi?: number;
        net_change?: number;
      }>;
    };
    if (!json.data) return [];
    const results: Array<{
      instrumentToken: string; ltp: number;
      open: number; high: number; low: number; close: number;
      volume: number | null; oi: number | null; previousClose: number | null;
    }> = [];
    for (let i = 0; i < instrumentTokens.length; i++) {
      const token = instrumentTokens[i];
      const responseKey = keys[i].replace('|', ':');
      const d = json.data[responseKey];
      if (!d?.ohlc) continue;
      results.push({
        instrumentToken: token,
        ltp: d.last_price,
        open: d.ohlc.open,
        high: d.ohlc.high,
        low: d.ohlc.low,
        close: d.ohlc.close,   // this IS the LTP/current price for live session
        volume: d.volume ?? null,
        oi: d.oi ?? null,
        previousClose: d.ohlc.close !== d.last_price ? d.ohlc.close : null,
      });
    }
    return results;
  }

  async getInstruments(): Promise<IndiaInstrument[]> {
    const list = await fetchUpstoxInstruments();
    this.instrumentsByToken = new Map(list.map((i) => [i.instrumentToken, i]));
    this.instrumentsByKey = new Map(
      list.filter((i) => i.instrumentKey).map((i) => [i.instrumentKey!, i])
    );
    return list;
  }

  adoptInstruments(list: IndiaInstrument[]): void {
    if (this.instrumentsByToken.size > 0) return;
    this.instrumentsByToken = new Map(list.map((i) => [i.instrumentToken, i]));
    this.instrumentsByKey = new Map(
      list.filter((i) => i.instrumentKey).map((i) => [i.instrumentKey!, i])
    );
  }

  async getHistoricalCandles(instrumentToken: string, timeframe: IndiaTimeframe, from: number, to: number): Promise<IndiaCandle[]> {
    if (!this.accessToken) return [];
    const instr = this.instrumentsByToken.get(instrumentToken);
    return fetchUpstoxHistoricalCandles(
      this.accessToken,
      this.instrumentKeyFor(instrumentToken),
      timeframe, from, to,
      2,
      instrumentToken,
      instr?.segment,
      instr?.tradingSymbol,
    );
  }

  async getIntradayCandles(instrumentToken: string, timeframe: IndiaTimeframe): Promise<IndiaCandle[]> {
    if (!this.accessToken) return [];
    const instr = this.instrumentsByToken.get(instrumentToken);
    return fetchUpstoxIntradayCandles(
      this.accessToken,
      this.instrumentKeyFor(instrumentToken),
      timeframe,
      instrumentToken,
      instr?.segment,
      instr?.tradingSymbol,
    );
  }

  async getOrders(): Promise<BrokerOrder[]> {
    if (!this.accessToken) return [];
    return upstoxGetOrders(this.accessToken);
  }

  async getPositions(): Promise<BrokerPosition[]> {
    if (!this.accessToken) return [];
    return upstoxGetPositions(this.accessToken);
  }

  async getAccount(): Promise<BrokerAccount | null> {
    if (!this.accessToken) return null;
    const acc = await upstoxGetAccount(this.accessToken);
    if (!acc) return null;
    return { userId: 'upstox-user', availableCash: acc.availableCash, availableMargin: acc.availableMargin, currency: 'INR' };
  }

  async placeOrder(req: BrokerOrderRequest): Promise<BrokerOrder> {
    if (this.readOnlySession) throw new Error('Upstox Analytics Token is read-only — cannot place orders. Use a full OAuth access token for live trading.');
    if (!this.accessToken) throw new Error('upstox not authenticated');
    return upstoxPlaceOrder(this.accessToken, req);
  }

  async modifyOrder(orderId: string, req: Partial<BrokerOrderRequest>): Promise<BrokerOrder> {
    if (this.readOnlySession) throw new Error('Upstox Analytics Token is read-only — cannot modify orders.');
    if (!this.accessToken) throw new Error('upstox not authenticated');
    return upstoxModifyOrder(this.accessToken, orderId, req);
  }

  async cancelOrder(orderId: string): Promise<BrokerOrder> {
    if (this.readOnlySession) throw new Error('Upstox Analytics Token is read-only — cannot cancel orders.');
    if (!this.accessToken) throw new Error('upstox not authenticated');
    return upstoxCancelOrder(this.accessToken, orderId);
  }

  async getOptionChain(underlying: string): Promise<import('../types').OptionChainData | null> {
    if (!this.accessToken) {
      logger.warn('upstox: getOptionChain: no access token');
      return null;
    }
    // Upstox requires the MASTER's index key ('NSE_INDEX|Nifty 50'), not the
    // canonical short name — 'NSE_INDEX|NIFTY' 400s and the chain never loads.
    const canonical = underlying.toUpperCase();
    let indexKey = `NSE_INDEX|${underlying}`;
    for (const instr of this.instrumentsByKey.keys()) {
      const meta = this.instrumentsByKey.get(instr);
      if (meta && meta.segment === 'NSE_INDEX' && (meta.underlying.toUpperCase() === canonical || meta.tradingSymbol.toUpperCase() === canonical)) {
        indexKey = instr;
        break;
      }
    }
    const { getOptionChain } = await import('./upstox-market-data');
    return getOptionChain(this.accessToken, underlying, indexKey);
  }
}

export { upstoxLoginUrl };