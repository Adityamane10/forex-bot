/**
 * Zerodha Kite Connect adapter — implements IndiaBrokerAdapter on the official
 * Kite Connect REST + WebSocket APIs.
 */
import type { IndiaCandle, IndiaInstrument, IndiaTick, IndiaTimeframe } from '@fx/shared';
import { IndiaBrokerAdapter, BrokerAccount, BrokerCredentials, BrokerOrder, BrokerOrderRequest, BrokerPosition } from '../types';
import { kiteSession, kiteProfile, kiteLogout, kiteLoginUrl } from './zerodha-auth';
import {
  fetchKiteInstruments,
  fetchKiteHistoricalCandles,
  fetchKiteQuote,
  fetchKiteQuotes,
  KiteWebSocket,
} from './zerodha-market-data';
import {
  kitePlaceOrder,
  kiteModifyOrder,
  kiteCancelOrder,
  kiteGetOrders,
  kiteGetPositions,
  kiteGetAccount,
} from './zerodha-orders';
import { logger } from '../../../core/logger';

export class ZerodhaAdapter implements IndiaBrokerAdapter {
  readonly name = 'ZERODHA' as const;
  readonly feedMode = 'ltp' as const;
  private apiKey = '';
  private accessToken = '';
  private ws: KiteWebSocket | null = null;
  private instrumentsByToken = new Map<string, IndiaInstrument>();
  private tickHandler: ((tick: IndiaTick) => void) | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectCount = 0;

  get connected(): boolean {
    return Boolean(this.apiKey && this.accessToken) && (this.ws?.connected ?? false);
  }

  get readOnly(): boolean {
    return false;
  }

  async connect(): Promise<void> {
    // Connect happens implicitly via authenticate(). Idempotent guard.
    if (this.connected) return;
  }

  async disconnect(): Promise<void> {
    this.ws?.close();
    this.ws = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.apiKey && this.accessToken) await kiteLogout(this.apiKey, this.accessToken).catch(() => undefined);
    this.apiKey = '';
    this.accessToken = '';
  }

  async authenticate(credentials: BrokerCredentials): Promise<import('../types').BrokerAuthResult> {
    const session = await kiteSession(credentials);
    this.apiKey = session.apiKey;
    this.accessToken = session.accessToken;
    logger.info('zerodha: authenticated', { userId: session.userId });
    return session;
  }

  async subscribe(instrumentTokens: string[]): Promise<void> {
    const tokens = instrumentTokens.map((t) => Number(t)).filter((t) => Number.isFinite(t));
    if (!tokens.length) return;
    if (!this.ws) this.openWs();
    // Delay the subscription slightly so the ws has time to establish.
    const deliver = () => this.ws?.subscribe(tokens);
    if (this.ws?.connected) deliver();
    else setTimeout(deliver, 1500);
  }

  async unsubscribe(instrumentTokens: string[]): Promise<void> {
    const tokens = instrumentTokens.map((t) => Number(t)).filter((t) => Number.isFinite(t));
    this.ws?.unsubscribe(tokens);
  }

  async streamTicks(onTick: (tick: IndiaTick) => void): Promise<void> {
    this.tickHandler = onTick;
    if (!this.ws) this.openWs();
  }

  private openWs(): void {
    if (!this.apiKey || !this.accessToken) return;
    this.ws = new KiteWebSocket(this.apiKey, this.accessToken);
    this.ws.connect({
      onTick: (tick) => {
        const instr = this.instrumentsByToken.get(tick.instrumentToken);
        if (instr) {
          tick.tradingSymbol = instr.tradingSymbol;
          tick.underlying = instr.underlying;
          tick.segment = instr.segment;
          tick.exchange = instr.exchange;
        }
        this.tickHandler?.(tick);
      },
      onConnect: () => {
        logger.info('zerodha: websocket connected');
      },
      onDisconnect: () => {
        logger.warn('zerodha: websocket disconnected');
        this.scheduleReconnect();
      },
      onError: (err) => logger.error('zerodha: websocket error', { err: String(err) }),
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectCount += 1;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.reconnectCount, 5));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.apiKey && this.accessToken) this.openWs();
    }, delay);
  }

  async getQuote(instrumentToken: string): Promise<IndiaTick | null> {
    if (!this.apiKey || !this.accessToken) return null;
    const instr = this.instrumentsByToken.get(instrumentToken);
    const symbol = instr?.tradingSymbol ?? instrumentToken;
    const exchange = instr?.exchange ?? 'NSE';
    return fetchKiteQuote(this.apiKey, this.accessToken, exchange, symbol);
  }

  async getLtpBatch(instrumentTokens: string[]): Promise<IndiaTick[]> {
    if (!this.apiKey || !this.accessToken) return [];
    // Kite's quote endpoint accepts up to 100 instruments in ONE request —
    // the per-token loop burned the ~1 req/s quota in seconds.
    const keys = instrumentTokens
      .map((t) => {
        const instr = this.instrumentsByToken.get(t);
        return `${instr?.exchange ?? 'NSE'}:${instr?.tradingSymbol ?? t}`;
      });
    const out: IndiaTick[] = [];
    for (let i = 0; i < keys.length; i += 100) {
      try {
        const batch = await fetchKiteQuotes(this.apiKey, this.accessToken, keys.slice(i, i + 100));
        for (const key of keys.slice(i, i + 100)) {
          const tick = batch.get(key);
          if (tick) {
            const instr = this.instrumentsByToken.get(tick.instrumentToken);
            if (instr) {
              tick.tradingSymbol = instr.tradingSymbol;
              tick.underlying = instr.underlying;
              tick.segment = instr.segment;
            }
            out.push(tick);
          }
        }
      } catch (err) {
        logger.warn('zerodha: batch quote failed', { err: String(err) });
        break;
      }
    }
    return out;
  }

  async getOhlcBatch(): Promise<never[]> {
    return []; // Zerodha: not yet implemented — returns empty, falls back to LTP
  }

  async getInstruments(): Promise<IndiaInstrument[]> {
    const list = await fetchKiteInstruments();
    this.instrumentsByToken = new Map(list.map((i) => [i.instrumentToken, i]));
    return list;
  }

  async getHistoricalCandles(instrumentToken: string, timeframe: IndiaTimeframe, from: number, to: number): Promise<IndiaCandle[]> {
    if (!this.apiKey || !this.accessToken) return [];
    const instr = this.instrumentsByToken.get(instrumentToken);
    // Stamp the resolved instrument's real identity — hardcoded NSE/NSE_FUT
    // mislabeled every BSE/index/option history row.
    return fetchKiteHistoricalCandles(this.apiKey, this.accessToken, instrumentToken, timeframe, from, to, instr
      ? { exchange: instr.exchange, segment: instr.segment, tradingSymbol: instr.tradingSymbol, underlying: instr.underlying }
      : undefined);
  }

  async getIntradayCandles(): Promise<never[]> {
    return []; // Zerodha uses historical API for today's data too
  }

  async getOrders(): Promise<BrokerOrder[]> {
    if (!this.apiKey || !this.accessToken) return [];
    return kiteGetOrders(this.apiKey, this.accessToken);
  }

  async getPositions(): Promise<BrokerPosition[]> {
    if (!this.apiKey || !this.accessToken) return [];
    return kiteGetPositions(this.apiKey, this.accessToken);
  }

  async getAccount(): Promise<BrokerAccount | null> {
    if (!this.apiKey || !this.accessToken) return null;
    const acc = await kiteGetAccount(this.apiKey, this.accessToken);
    if (!acc) return null;
    return { userId: 'kite-user', availableCash: acc.availableCash, availableMargin: acc.availableMargin, currency: 'INR' };
  }

  async placeOrder(req: BrokerOrderRequest): Promise<BrokerOrder> {
    if (!this.apiKey || !this.accessToken) throw new Error('zerodha not authenticated');
    return kitePlaceOrder(this.apiKey, this.accessToken, req);
  }

  async modifyOrder(orderId: string, req: Partial<BrokerOrderRequest>): Promise<BrokerOrder> {
    if (!this.apiKey || !this.accessToken) throw new Error('zerodha not authenticated');
    return kiteModifyOrder(this.apiKey, this.accessToken, orderId, req);
  }

  async cancelOrder(orderId: string): Promise<BrokerOrder> {
    if (!this.apiKey || !this.accessToken) throw new Error('zerodha not authenticated');
    return kiteCancelOrder(this.apiKey, this.accessToken, orderId);
  }

  async getOptionChain(): Promise<import('../types').OptionChainData | null> {
    logger.warn('zerodha: getOptionChain not implemented yet');
    return null;
  }
}

export { kiteLoginUrl as zerodhaLoginUrl, kiteProfile as zerodhaProfile };