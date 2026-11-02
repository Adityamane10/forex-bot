/**
 * Angel One adapter — implements IndiaBrokerAdapter on SmartAPI.
 *
 * Transport is REST-poll (quote endpoint, ≤50 tokens/call): the feed service
 * treats it exactly like the Upstox analytics credential — boot subscribe is
 * best-effort and the LTP fallback poll becomes the tick source. No static-IP
 * pinning anywhere in this flow; that constraint is why this adapter exists.
 *
 * Orders are refused at the adapter boundary: the platform is paper-only for
 * Angel One regardless of credentials (live execution has its own separate gate).
 */
import type { IndiaCandle, IndiaInstrument, IndiaTick, IndiaTimeframe } from '@fx/shared';
import { IndiaBrokerAdapter, BrokerAccount, BrokerCredentials, BrokerAuthResult, BrokerOrder, BrokerOrderRequest, BrokerPosition } from '../types';
import { angelLogin, angelHeaders, AngelSession, AngelCredentials } from './angelone-auth';
import {
  fetchAngelInstruments,
  fetchAngelLtpBatch,
  fetchAngelHistoricalCandles,
  AngelHttpError,
} from './angelone-market-data';
import { logger } from '../../../core/logger';

export class AngelOneAdapter implements IndiaBrokerAdapter {
  readonly name = 'ANGELONE' as const;
  readonly feedMode = 'ltp' as const;

  private session: AngelSession | null = null;
  private creds: AngelCredentials | null = null;
  private instrumentsByToken = new Map<string, IndiaInstrument>();

  get connected(): boolean {
    return Boolean(this.session?.accessToken);
  }

  get readOnly(): boolean {
    return true;
  }

  async connect(): Promise<void> { /* auth happens in authenticate() */ }

  async disconnect(): Promise<void> {
    this.session = null;
    this.creds = null;
  }

  async authenticate(credentials: BrokerCredentials): Promise<BrokerAuthResult> {
    if (!credentials.angelApiKey || !credentials.angelClientCode || !credentials.angelPin || !credentials.angelTotpSecret) {
      const err = 'angelone: INDIA_ANGEL_API_KEY / INDIA_ANGEL_CLIENT_CODE / INDIA_ANGEL_PIN / INDIA_ANGEL_TOTP_SECRET missing';
      logger.warn(err);
      return {
        broker: 'ANGELONE',
        apiKey: credentials.angelApiKey ?? '',
        accessToken: '',
        authenticated: false,
        readOnly: true,
        userId: '',
        error: err,
      };
    }
    this.creds = {
      apiKey: credentials.angelApiKey,
      clientCode: credentials.angelClientCode,
      pin: credentials.angelPin,
      totpSecret: credentials.angelTotpSecret,
    };
    try {
      this.session = await angelLogin(this.creds);
      return {
        broker: 'ANGELONE',
        apiKey: this.creds.apiKey,
        accessToken: this.session.accessToken,
        authenticated: true,
        readOnly: true,
        userId: this.session.userId,
      };
    } catch (err) {
      this.session = null;
      const message = String(err);
      logger.error('angelone: login failed', { err: message });
      return {
        broker: 'ANGELONE',
        apiKey: this.creds.apiKey,
        accessToken: '',
        authenticated: false,
        readOnly: true,
        userId: '',
        error: message,
      };
    }
  }

  /** One silent re-login when a REST call reports an expired session. */
  private async ensureSession(): Promise<AngelSession | null> {
    if (this.session) return this.session;
    if (!this.creds) return null;
    try {
      this.session = await angelLogin(this.creds);
      logger.info('angelone: session re-established');
      return this.session;
    } catch (err) {
      logger.warn('angelone: re-login failed', { err: String(err) });
      return null;
    }
  }

  /** Angel's websocket is intentionally unused at this stage: streamTicks stays
   *  unimplemented and the feed service falls back to its batched REST poll,
   *  which carries no IP restrictions and fits the rate budget. */
  async subscribe(): Promise<void> {
    throw new Error('angelone: websocket streaming not enabled — REST poll mode');
  }
  async unsubscribe(): Promise<void> { /* nothing subscribed */ }
  async streamTicks(): Promise<void> {
    throw new Error('angelone: websocket streaming not enabled — REST poll mode');
  }

  private withInstruments(list: IndiaInstrument[]): void {
    this.instrumentsByToken = new Map(list.map((i) => [i.instrumentToken, i]));
  }

  adoptInstruments(list: IndiaInstrument[]): void {
    if (this.instrumentsByToken.size > 0) return;
    this.withInstruments(list);
  }

  async getInstruments(): Promise<IndiaInstrument[]> {
    const list = await fetchAngelInstruments();
    this.withInstruments(list);
    return list;
  }

  private async withRetry<T>(fn: (session: AngelSession) => Promise<T>): Promise<T | null> {
    let session = await this.ensureSession();
    if (!session) return null;
    try {
      return await fn(session);
    } catch (err) {
      // Session tokens die daily (~5 AM IST); one transparent re-login then retry.
      const isAuthError = (err instanceof AngelHttpError && (err.status === 401 || err.status === 403))
        || /401|403|expired|Authentication|Time pass/i.test(String(err));
      if (isAuthError) {
        this.session = null;
        session = await this.ensureSession();
        if (!session) return null;
        return await fn(session);
      }
      throw err;
    }
  }

  async getLtpBatch(instrumentTokens: string[]): Promise<IndiaTick[]> {
    const list = instrumentTokens
      .map((t) => this.instrumentsByToken.get(t))
      .filter((i): i is IndiaInstrument => Boolean(i));
    if (!list.length) return [];
    return (await this.withRetry((s) => fetchAngelLtpBatch(s, list))) ?? [];
  }

  async getHistoricalCandles(instrumentToken: string, timeframe: IndiaTimeframe, from: number, to: number): Promise<IndiaCandle[]> {
    const instr = this.instrumentsByToken.get(instrumentToken);
    if (!instr) return [];
    return (await this.withRetry((s) => fetchAngelHistoricalCandles(s, instr, timeframe, from, to))) ?? [];
  }

  /** Same candle source serves intraday: today's window on the shared grid. */
  async getIntradayCandles(instrumentToken: string, timeframe: IndiaTimeframe): Promise<IndiaCandle[]> {
    const since = Date.now() - 12 * 3600_000;
    return this.getHistoricalCandles(instrumentToken, timeframe, since, Date.now());
  }

  async getQuote(instrumentToken: string): Promise<IndiaTick | null> {
    const ticks = await this.getLtpBatch([instrumentToken]);
    return ticks[0] ?? null;
  }

  /** OHLC batch mirrors the Upstox shape so enrichment code is shared. The v2
   *  quote endpoint in FULL mode carries open/high/low/volume per key. */
  async getOhlcBatch(instrumentTokens: string[]) {
    const list = instrumentTokens
      .map((t) => ({ token: t, instr: this.instrumentsByToken.get(t) }))
      .filter((x): x is { token: string; instr: IndiaInstrument } => Boolean(x.instr));
    if (!list.length) return [];

    const byExchange = new Map<string, { token: string; instr: IndiaInstrument }[]>();
    for (const x of list) {
      const exch = x.instr.segment === 'NSE_INDEX' ? 'NSE' : 'NFO';
      if (!byExchange.has(exch)) byExchange.set(exch, []);
      byExchange.get(exch)!.push(x);
    }

    const out: Array<{
      instrumentToken: string; ltp: number;
      open: number; high: number; low: number; close: number;
      volume: number | null; oi: number | null; previousClose: number | null;
    }> = [];

    const run = async (session: AngelSession) => {
      out.length = 0;
      for (const [exchange, group] of byExchange) {
        for (let i = 0; i < group.length; i += 50) {
          const slice = group.slice(i, i + 50);
          const res = await fetch('https://apiconnect.angelone.in/rest/secure/angelbroking/market/v1/quote/', {
            method: 'POST',
            headers: angelHeaders(session),
            body: JSON.stringify({ mode: 'OHLC', exchangeTokens: { [exchange]: slice.map((x) => x.token) } }),
          });
          if (!res.ok) continue;
          const json = (await res.json().catch(() => null)) as {
            status?: boolean;
            data?: Record<string, { open?: number; high?: number; low?: number; close?: number; ltp?: number }> & { fetched?: Array<{ symbolToken?: string; open?: number; high?: number; low?: number; close?: number; ltp?: number }> };
          } | null;
          const data = json?.data;
          if (!data) continue;
          const feeds = ('fetched' in data ? {} : data) as Record<string, { open?: number; high?: number; low?: number; close?: number; ltp?: number }>;
          const fetchedList = Array.isArray(data.fetched) ? data.fetched : [];
          for (const x of slice) {
            const d = fetchedList.find((f) => f.symbolToken === x.token)
              ?? feeds[`${exchange}:${x.token}`];
            if (!d || d.ltp == null || d.open == null) continue;
            out.push({
              instrumentToken: x.token,
              ltp: Number(d.ltp),
              open: Number(d.open), high: Number(d.high ?? d.ltp), low: Number(d.low ?? d.ltp), close: Number(d.close ?? d.ltp),
              volume: null, oi: null, previousClose: null,
            });
          }
        }
      }
      return out.length > 0;
    };

    const ok = await this.withRetry(run).catch(() => false);
    return ok ? out : [];
  }

  async getOrders(): Promise<BrokerOrder[]> { return []; }
  async getPositions(): Promise<BrokerPosition[]> { return []; }
  async getAccount(): Promise<BrokerAccount | null> { return null; }
  async placeOrder(): Promise<BrokerOrder> {
    throw new Error('Angel One adapter is data-only at the paper-trading stage.');
  }
  async modifyOrder(): Promise<BrokerOrder> {
    throw new Error('Angel One adapter is data-only at the paper-trading stage.');
  }
  async cancelOrder(): Promise<BrokerOrder> {
    throw new Error('Angel One adapter is data-only at the paper-trading stage.');
  }
  async getOptionChain(): Promise<null> {
    // Chain endpoint not wired yet: option analytics falls back to its OI-only
    // path, which is exactly how the Upstox analytics credential already runs.
    return null;
  }
}
