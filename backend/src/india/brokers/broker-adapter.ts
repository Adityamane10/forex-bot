/**
 * Broker adapter factory. Selects the configured broker adapter (spec §3-§4).
 * When no broker is configured the module uses a NullBrokerAdapter: it never
 * fabricates prices — the engine simply reports DATA_DISCONNECTED and refuses
 * to trade until a real broker is configured.
 */
import { indiaConfig } from '../config';
import { ZerodhaAdapter } from './zerodha/zerodha-adapter';
import { UpstoxAdapter } from './upstox/upstox-adapter';
import { AngelOneAdapter } from './angelone/angelone-adapter';
import { IndiaBrokerAdapter } from './types';
import { logger } from '../../core/logger';

export class NullBrokerAdapter implements IndiaBrokerAdapter {
  readonly name = 'ZERODHA' as const;
  readonly connected = false;
  readonly readOnly = true;
  readonly feedMode = 'ltp' as const;
  async connect(): Promise<void> {
    throw new Error('INDIA_BROKER is NONE or missing INDIA_API_KEY — no Indian market data feed configured');
  }
  async disconnect(): Promise<void> {
    /* nothing to disconnect */
  }
  async authenticate(): Promise<never> {
    throw new Error('broker not configured');
  }
  async subscribe(): Promise<void> {
    /* no-op */
  }
  async unsubscribe(): Promise<void> {
    /* no-op */
  }
  async streamTicks(): Promise<void> {
    /* no-op */
  }
  async getQuote(): Promise<null> {
    return null;
  }
  async getLtpBatch(): Promise<never[]> {
    return [];
  }
  async getOhlcBatch(): Promise<never[]> {
    return [];
  }
  async getInstruments(): Promise<never[]> {
    return [];
  }
  async getHistoricalCandles(): Promise<never[]> {
    return [];
  }
  async getIntradayCandles(): Promise<never[]> {
    return [];
  }
  async getOrders(): Promise<never[]> {
    return [];
  }
  async getPositions(): Promise<never[]> {
    return [];
  }
  async getAccount(): Promise<null> {
    return null;
  }
  async placeOrder(): Promise<never> {
    throw new Error('no broker configured — cannot place orders');
  }
  async modifyOrder(): Promise<never> {
    throw new Error('no broker configured');
  }
  async cancelOrder(): Promise<never> {
    throw new Error('no broker configured');
  }
  async getOptionChain(): Promise<null> {
    return null;
  }
}

export function createIndiaBrokerAdapter(): IndiaBrokerAdapter {
  const broker = indiaConfig.broker;
  if (broker === 'ZERODHA') {
    logger.info('india: broker adapter = ZERODHA (Kite Connect)');
    return new ZerodhaAdapter();
  }
  if (broker === 'UPSTOX') {
    logger.info('india: broker adapter = UPSTOX', { feedMode: indiaConfig.upstoxFeedMode });
    return new UpstoxAdapter({ feedMode: indiaConfig.upstoxFeedMode });
  }
  if (broker === 'ANGELONE') {
    const configured = Boolean(
      indiaConfig.angelApiKey && indiaConfig.angelClientCode && indiaConfig.angelPin && indiaConfig.angelTotpSecret,
    );
    if (!configured) {
      logger.warn('india: ANGELONE selected but credentials incomplete — falling back to NullBrokerAdapter');
      return new NullBrokerAdapter();
    }
    logger.info('india: broker adapter = ANGELONE (SmartAPI, REST-poll mode)');
    return new AngelOneAdapter();
  }
  logger.warn('india: no broker configured (INDIA_BROKER=NONE) — using NullBrokerAdapter, trading disabled');
  return new NullBrokerAdapter();
}