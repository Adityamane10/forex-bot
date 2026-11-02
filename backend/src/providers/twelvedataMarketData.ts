/**
 * Twelve Data market data provider (free tier).
 *
 * Free tier facts (verified at time of writing):
 *  - 800 API credits/day on the free plan
 *  - 1 credit per time-series request (8 credits for 8 symbols)
 *  - No real-time streaming on the free plan; latest price via REST poll
 *  - Historical data depth depends on interval (e.g. years of 1-day data)
 *  - Commercial use allowed per Twelve Data terms
 *  - Rate limit: ~8 requests/second
 *
 * This provider is a thin REST wrapper. If no API key is configured it reports
 * DOWN and the app falls back to DEMO mode (clearly labeled).
 */
import { Candle, Tick, DataMode } from '@fx/shared';
import { Timeframe, TIMEFRAME_MS, getAsset } from '@fx/shared';
import { MarketDataProvider } from './types';
import { config } from '../config';

const TF_MAP: Record<Timeframe, string> = {
  '1m': '1min',
  '5m': '5min',
  '15m': '15min',
  '30m': '30min',
  '1h': '1h',
  '4h': '4h',
  '1D': '1day',
};

export class TwelveDataMarketDataProvider implements MarketDataProvider {
  readonly name = 'TWELVEDATA';
  readonly mode: DataMode = 'LIVE';
  /** REST-only free tier — the engine polls getLatestPrice(). */
  readonly streaming = false;
  /** 8 credits/min free; stay at 7 to leave headroom. */
  readonly pollBudgetPerMinute = 7;
  readonly minPollIntervalMs = { active: 15_000, idle: 60_000 };
  /** Twelve Data free-tier quotes update on a sub-minute cadence. */
  readonly feedLatencyMs = 30_000;
  /** Preload the analysis-critical timeframes; intraday builds live via polling. */
  readonly preloadTimeframes: Timeframe[] = ['15m', '1h', '4h', '1D'];
  readonly description =
    'Twelve Data free tier (800 credits/day). REST historical + latest price. No free streaming. Requires API key.';
  private symbols: string[] = [];
  private connected = false;

  async connect(): Promise<void> {
    if (!config.marketDataApiKey) {
      throw new Error('TWELVEDATA requires MARKET_DATA_API_KEY');
    }
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

  private base = 'https://api.twelvedata.com';

  private async request(path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
    const qs = new URLSearchParams({ ...params, apikey: config.marketDataApiKey });
    const res = await fetch(`${this.base}${path}?${qs.toString()}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`TwelveData HTTP ${res.status}`);
    const json = (await res.json()) as Record<string, unknown>;
    if (json.status === 'error') {
      throw new Error(`TwelveData: ${String(json.message ?? 'error')}`);
    }
    return json;
  }

  async getHistoricalCandles(symbol: string, timeframe: Timeframe, from: number, to: number): Promise<Candle[]> {
    const asset = getAsset(symbol);
    const json = await this.request('/time_series', {
      symbol: symbol.replace('/', ''),
      interval: TF_MAP[timeframe],
      start_date: new Date(from).toISOString().slice(0, 10),
      end_date: new Date(to).toISOString().slice(0, 10),
      outputsize: '5000',
      // Twelve Data returns exchange-local naive datetimes; forex defaults to
      // UTC only when the request pins the zone — otherwise timestamps drift.
      timezone: 'UTC',
    });
    const values = (json.values as Array<Record<string, string>>) ?? [];
    const tfMs = TIMEFRAME_MS[timeframe];
    const now = Date.now();
    return values
      .map((v) => {
        const openTime = new Date(`${v.datetime}Z`).getTime();
        return {
          symbol,
          timeframe,
          open: Number(v.open),
          high: Number(v.high),
          low: Number(v.low),
          close: Number(v.close),
          volume: Number(v.volume ?? 0),
          openTime,
          closeTime: openTime + tfMs,
          state: 'COMPLETED' as const,
          completed: true,
          updatedAt: openTime + tfMs,
        };
      })
      // A forming bar delivered as COMPLETED mutates retroactively; drop it.
      .filter((c) => !Number.isNaN(c.open) && c.openTime + tfMs <= now)
      .sort((a, b) => a.openTime - b.openTime)
      .map((c) => ({
        ...c,
        open: Number(c.open.toFixed(asset.pricePrecision)),
        high: Number(c.high.toFixed(asset.pricePrecision)),
        low: Number(c.low.toFixed(asset.pricePrecision)),
        close: Number(c.close.toFixed(asset.pricePrecision)),
      }));
  }

  async getLatestPrice(symbol: string): Promise<Tick | null> {
    try {
      const json = await this.request('/price', { symbol: symbol.replace('/', '') });
      const mid = Number(json.price);
      if (!Number.isFinite(mid)) return null;
      const asset = getAsset(symbol);
      // Modeled spread in PIPS (pipSize × pips), not a raw half-tick that
      // prices crypto at $0.005. Labeled spreadModeled like every provider.
      const spreadPips = asset.assetClass === 'CRYPTO'
        ? Math.max(2, asset.maxSpreadPips ? asset.maxSpreadPips * 0.4 : 5)
        : 0.8;
      const spread = asset.pipSize * spreadPips;
      return {
        timestamp: Date.now(),
        symbol,
        bid: Number((mid - spread / 2).toFixed(asset.pricePrecision)),
        ask: Number((mid + spread / 2).toFixed(asset.pricePrecision)),
        mid,
        spread,
        source: this.name,
        mode: this.mode,
        spreadModeled: true,
      };
    } catch {
      return null;
    }
  }

  async getBidAsk(symbol: string): Promise<{ bid: number; ask: number } | null> {
    const t = await this.getLatestPrice(symbol);
    return t ? { bid: t.bid, ask: t.ask } : null;
  }

  async getSpread(symbol: string): Promise<number | null> {
    const t = await this.getLatestPrice(symbol);
    return t ? t.spread : null;
  }

  async subscribe(symbol: string, _onTick: (tick: Tick) => void): Promise<() => void> {
    // Free tier has no streaming; polling is handled by the market data engine.
    return () => undefined;
  }

  async unsubscribe(_symbol: string): Promise<void> {
    /* noop */
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    if (!config.marketDataApiKey) return { ok: false, detail: 'missing MARKET_DATA_API_KEY' };
    try {
      await this.request('/api_usage', {});
      return { ok: true, detail: 'API key valid' };
    } catch {
      return { ok: false, detail: 'API usage check failed (key invalid or rate limited)' };
    }
  }
}
