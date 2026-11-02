/**
 * Finnhub market data provider (free tier).
 *
 * Free tier facts (verified at time of writing):
 *  - 60 API calls/minute free, real-time forex quotes and candles
 *  - Real-time forex from 10 brokers (symbols like OANDA:EUR_USD)
 *  - No bid/ask for forex on the free tier — mid price only
 *  - Max 5000 candles per request (deep history = multiple calls)
 *
 * Bid/ask honesty: Finnhub quotes a mid price only. This provider models
 * bid/ask from typical per-pair spreads and marks every tick with
 * `spreadModeled: true`. Downstream consumers (EV, risk, data quality) can see
 * the flag and the UI can label it. Mid price is real; the spread is an
 * estimate, never presented as a live quote.
 *
 * The provider never exceeds its per-minute budget (token bucket). If the API
 * key is missing or the call fails, it reports DOWN and the container falls
 * back to the clearly-labeled DEMO feed.
 */
import { Candle, Tick, DataMode } from '@fx/shared';
import { Timeframe, TIMEFRAME_MS, getAsset } from '@fx/shared';
import { MarketDataProvider } from './types';
import { config } from '../config';
import { TokenBucket } from './rateLimiter';

const TF_MAP: Record<Timeframe, string> = {
  '1m': '1',
  '5m': '5',
  '15m': '15',
  '30m': '30',
  '1h': '60',
  '4h': '240',
  '1D': 'D',
};

/** Typical spread in pips per pair — used ONLY to model bid/ask around the real mid. */
const TYPICAL_SPREAD_PIPS: Record<string, number> = {
  'EUR/USD': 0.8,
  'GBP/USD': 1.2,
  'USD/JPY': 0.9,
  'USD/CHF': 1.2,
  'AUD/USD': 1.0,
  'USD/CAD': 1.4,
  'NZD/USD': 1.6,
  'EUR/GBP': 1.4,
  'EUR/JPY': 1.5,
  'GBP/JPY': 2.2,
  // Retail spot gold is ~$0.20-0.40 wide; 25 pips overstated costs ~10×.
  'XAU/USD': 3,
};

function toFinnhubSymbol(symbol: string): string {
  return `OANDA:${symbol.replace('/', '_')}`;
}

export class FinnhubMarketDataProvider implements MarketDataProvider {
  readonly name = 'FINNHUB';
  readonly mode: DataMode = 'LIVE';
  readonly description =
    'Finnhub free tier (60 calls/min). Real-time forex mid price + candles. No free bid/ask — spread is modeled and labeled. Requires FINNHUB_API_KEY.';
  /** True when the provider pushes ticks itself; Finnhub is polled by the engine. */
  readonly streaming = false;
  /** Stay under the 60/min free limit with headroom. */
  readonly pollBudgetPerMinute = 55;
  readonly minPollIntervalMs = { active: 5_000, idle: 30_000 };
  /** Finnhub forex quotes update on a sub-minute cadence. */
  readonly feedLatencyMs = 30_000;
  /** Preload these timeframes at startup (1h/4h/1D drive MTF, S/R, patterns; intraday builds live). */
  readonly preloadTimeframes: Timeframe[] = ['15m', '1h', '4h', '1D'];

  private symbols: string[] = [];
  private connected = false;
  private bucket = new TokenBucket(55, 55 / 60_000);
  private base = 'https://finnhub.io/api/v1';

  private get key(): string {
    return config.finnhubApiKey;
  }

  async connect(): Promise<void> {
    if (!this.key) throw new Error('FINNHUB requires FINNHUB_API_KEY');
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async getSymbols(): Promise<string[]> {
    return this.symbols;
  }

  setSymbols(symbols: string[]): void {
    this.symbols = symbols;
  }

  private async request(path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
    await this.bucket.acquire();
    const qs = new URLSearchParams({ ...params, token: this.key });
    const res = await fetch(`${this.base}${path}?${qs.toString()}`, { signal: AbortSignal.timeout(8000) });
    if (res.status === 429) throw new Error('Finnhub rate limit exceeded (429)');
    if (!res.ok) throw new Error(`Finnhub HTTP ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }

  async getHistoricalCandles(symbol: string, timeframe: Timeframe, from: number, to: number): Promise<Candle[]> {
    const asset = getAsset(symbol);
    const json = await this.request('/forex/candles', {
      symbol: toFinnhubSymbol(symbol),
      resolution: TF_MAP[timeframe],
      from: String(Math.floor(from / 1000)),
      to: String(Math.floor(to / 1000)),
    });
    if (json.s !== 'ok' || !Array.isArray(json.t)) return [];
    const t = json.t as number[];
    // Edge payloads can omit individual series while s==='ok' — validate all
    // five arrays or the loop below throws out of the provider.
    const series = [json.o, json.h, json.l, json.c] as unknown[];
    if (series.some((arr) => !Array.isArray(arr))) return [];
    const o = json.o as number[];
    const h = json.h as number[];
    const l = json.l as number[];
    const c = json.c as number[];
    const v = (Array.isArray(json.v) ? json.v : []) as number[];
    const tfMs = TIMEFRAME_MS[timeframe];
    const now = Date.now();
    const out: Candle[] = [];
    for (let i = 0; i < t.length; i++) {
      const openTime = t[i] * 1000;
      // A forming bar delivered as COMPLETED mutates retroactively — the live
      // engine builds the current window from real ticks instead.
      if (openTime + tfMs > now) continue;
      out.push({
        symbol,
        timeframe,
        open: Number(o[i].toFixed(asset.pricePrecision)),
        high: Number(h[i].toFixed(asset.pricePrecision)),
        low: Number(l[i].toFixed(asset.pricePrecision)),
        close: Number(c[i].toFixed(asset.pricePrecision)),
        volume: Number(v[i] ?? 0),
        openTime,
        closeTime: openTime + tfMs,
        state: 'COMPLETED',
        completed: true,
        updatedAt: openTime + tfMs,
      });
    }
    return out.sort((a, b) => a.openTime - b.openTime);
  }

  async getLatestPrice(symbol: string): Promise<Tick | null> {
    try {
      // /quote is EQUITIES-ONLY on Finnhub — forex symbols return {"c":0} and
      // the forex feed was permanently dead. The last closed forex candle is
      // the honest latest price this free tier offers.
      const to = Math.floor(Date.now() / 1000);
      const from = to - 2 * 24 * 3600;
      const json = await this.request('/forex/candles', {
        symbol: toFinnhubSymbol(symbol),
        resolution: '1',
        from: String(from),
        to: String(to),
      });
      if (json.s !== 'ok' || !Array.isArray(json.t) || !Array.isArray(json.c)) return null;
      const t = json.t as number[];
      const c = json.c as number[];
      if (t.length === 0) return null;
      const mid = Number(c[c.length - 1]);
      if (!Number.isFinite(mid) || mid <= 0) return null;
      return this.buildTick(symbol, mid, t[t.length - 1] * 1000);
    } catch {
      return null;
    }
  }

  private buildTick(symbol: string, mid: number, timestamp?: number): Tick {
    const asset = getAsset(symbol);
    const spreadPips = TYPICAL_SPREAD_PIPS[symbol] ?? 1.2;
    const spread = spreadPips * asset.pipSize;
    const p = asset.pricePrecision;
    return {
      timestamp: timestamp ?? Date.now(),
      symbol,
      mid: Number(mid.toFixed(p)),
      bid: Number((mid - spread / 2).toFixed(p)),
      ask: Number((mid + spread / 2).toFixed(p)),
      spread: Number(spread.toFixed(p)),
      source: this.name,
      mode: this.mode,
      spreadModeled: true,
    };
  }

  async getBidAsk(symbol: string): Promise<{ bid: number; ask: number } | null> {
    const t = await this.getLatestPrice(symbol);
    return t ? { bid: t.bid, ask: t.ask } : null;
  }

  async getSpread(symbol: string): Promise<number | null> {
    const t = await this.getLatestPrice(symbol);
    return t ? t.spread : null;
  }

  async subscribe(_symbol: string, _onTick: (tick: Tick) => void): Promise<() => void> {
    // No streaming on the free tier; the market data engine polls via getLatestPrice.
    return () => undefined;
  }

  async unsubscribe(_symbol: string): Promise<void> {
    /* noop */
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    if (!this.key) return { ok: false, detail: 'missing FINNHUB_API_KEY' };
    try {
      const first = this.symbols[0];
      if (!first) return { ok: false, detail: 'no symbols configured' };
      const tick = await this.getLatestPrice(first);
      if (!tick) return { ok: false, detail: 'quote check failed (key invalid or rate limited)' };
      return { ok: true, detail: `API key valid, budget left ${this.bucket.available().toFixed(0)}/min` };
    } catch {
      return { ok: false, detail: 'quote check failed (key invalid or rate limited)' };
    }
  }
}
