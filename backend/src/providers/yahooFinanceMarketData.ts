/**
 * Yahoo Finance market data provider — REAL market data, no API key.
 *
 * Facts (verified at time of writing from this build):
 *  - The public `v8/finance/chart` endpoint returns real forex prices and
 *    candles with sub-minute freshness (~10-60s depending on symbol) when
 *    called with a browser User-Agent.
 *  - No bid/ask, no tick stream, no formal SLA, and it is an UNOFFICIAL
 *    endpoint (Yahoo may throttle or break it at any time). Intended for
 *    personal/development use. The clean, licensed free paths remain
 *    FINNHUB (60 req/min) and TWELVEDATA (800 credits/day); the MT5 bridge
 *    is the zero-delay tick stream.
 *
 * Honesty: mid prices are real (from the exchange feed Yahoo exposes);
 * bid/ask is modeled from typical per-pair spreads and marked
 * `spreadModeled: true`. Every request carries a browser User-Agent and a
 * token bucket keeps the request rate well under Yahoo's throttling.
 */
import { Candle, Tick, DataMode } from '@fx/shared';
import { Timeframe, TIMEFRAME_MS, getAsset } from '@fx/shared';
import { MarketDataProvider } from './types';
import { TokenBucket } from './rateLimiter';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

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
  // Retail spot gold trades ~$0.20-0.40 wide; 25 pips ($2.50) overstated
  // paper costs ~10× (the GC=F futures basis is a separate, documented issue).
  'XAU/USD': 3,
  // Rate-only feed (account currency conversion), never traded.
  'USD/INR': 25,
};

function toYahooSymbol(symbol: string): string {
  if (symbol === 'XAU/USD') return 'GC=F'; // COMEX gold futures on Yahoo
  return `${symbol.replace('/', '')}=X`;
}

interface YahooInterval {
  interval: string;
  range: string;
}

const TF_MAP: Record<Exclude<Timeframe, '4h'>, YahooInterval> = {
  '1m': { interval: '1m', range: '1d' },
  '5m': { interval: '5m', range: '5d' },
  '15m': { interval: '15m', range: '1mo' },
  '30m': { interval: '30m', range: '1mo' },
  '1h': { interval: '60m', range: '3mo' },
  '1D': { interval: '1d', range: '1y' },
};

interface ChartBar {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  openTime: number;
}

export class YahooFinanceMarketDataProvider implements MarketDataProvider {
  readonly name = 'YAHOO';
  readonly mode: DataMode = 'LIVE';
  readonly description =
    'Yahoo Finance public chart API (real forex mid prices, sub-minute freshness). No key. UNOFFICIAL endpoint: may throttle or break; personal/development use. Spread is modeled and labeled.';
  /** REST-only — the engine polls getLatestPrice(). */
  readonly streaming = false;
  /** Budget raised 45→55 (audit MED-1), then 55→90 (forex charts moving like
   *  crypto), now 90→120 (user request: no visible quote/P&L lag on ANY
   *  symbol): 11 polled symbols (10 forex + the USD/INR rate feed) at the 6 s
   *  active interval cost 110/min, so every symbol now holds the fast cadence
   *  permanently — idle 10 s left individual charts stepping in visible jumps.
   *  ~1.8 req/s aggregate on the unofficial chart endpoint — the same order it
   *  already tolerated at 90/min for months. */
  readonly pollBudgetPerMinute = 120;
  readonly minPollIntervalMs = { active: 6_000, idle: 10_000 };
  /** Yahoo's quote freshness ceiling (~1 min for slow pairs). */
  readonly feedLatencyMs = 60_000;
  /**
   * Preload EVERY timeframe at boot (the budget is free then). This makes
   * every asset/timeframe chart instant to open — no runtime lazy-seed that
   * would queue behind live polling tokens (which read as a "stuck chart"
   * on asset switch). Idle polling is 45 s (Yahoo's own quote cadence is up
   * to ~60 s anyway), leaving budget headroom for the rare lazy seed.
   */
  readonly preloadTimeframes: Timeframe[] = ['1m', '5m', '15m', '30m', '1h', '4h', '1D'];

  private symbols: string[] = [];
  private connected = false;
  private bucket = new TokenBucket(90, 90 / 60_000);
  private base = 'https://query1.finance.yahoo.com';

  async connect(): Promise<void> {
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
    const qs = new URLSearchParams(params);
    const res = await fetch(`${this.base}${path}?${qs.toString()}`, {
      signal: AbortSignal.timeout(10_000),
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }

  private async chart(symbol: string, interval: string, range: string): Promise<Record<string, unknown>> {
    return this.request(`/v8/finance/chart/${toYahooSymbol(symbol)}`, { interval, range });
  }

  private parseBars(json: Record<string, unknown>): ChartBar[] {
    const result = (json.chart as { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<{ open?: number[]; high?: number[]; low?: number[]; close?: number[]; volume?: number[] }> } }> })?.result?.[0];
    if (!result || !result.timestamp) return [];
    const q = result.indicators?.quote?.[0];
    if (!q) return [];
    const bars: ChartBar[] = [];
    for (let i = 0; i < result.timestamp.length; i++) {
      const open = q.open?.[i];
      const close = q.close?.[i];
      if (open == null || close == null || Number.isNaN(open) || Number.isNaN(close)) continue;
      bars.push({
        open,
        high: q.high?.[i] ?? Math.max(open, close),
        low: q.low?.[i] ?? Math.min(open, close),
        close,
        volume: q.volume?.[i] ?? 0,
        openTime: result.timestamp[i] * 1000,
      });
    }
    return bars;
  }

  private aggregate4h(bars: ChartBar[], symbol: string, tfMs: number): Candle[] {
    const asset = getAsset(symbol);
    const out: Candle[] = [];
    let cur: ChartBar | null = null;
    for (const b of bars) {
      const bucketStart = Math.floor(b.openTime / tfMs) * tfMs;
      if (!cur || Math.floor(cur.openTime / tfMs) * tfMs !== bucketStart) {
        if (cur) out.push(this.toCandle(cur, symbol, '4h', asset.pricePrecision));
        cur = { ...b, openTime: bucketStart };
      } else {
        cur.high = Math.max(cur.high, b.high);
        cur.low = Math.min(cur.low, b.low);
        cur.close = b.close;
        cur.volume += b.volume;
      }
    }
    // The trailing bucket is IN PROGRESS — pushing it as COMPLETED let a bar
    // mutate retroactively and double-count once live ticks rebuilt it.
    if (cur && cur.openTime + tfMs <= Date.now()) {
      out.push(this.toCandle(cur, symbol, '4h', asset.pricePrecision));
    }
    return out;
  }

  private toCandle(b: ChartBar, symbol: string, timeframe: Timeframe, precision: number): Candle {
    const open = Number(b.open.toFixed(precision));
    const close = Number(b.close.toFixed(precision));
    const highRaw = Number(b.high.toFixed(precision));
    const lowRaw = Number(b.low.toFixed(precision));
    // Independent rounding of OHLC to the pair's precision can produce tiny
    // violations (close < low) when Yahoo reports high==open or close==low at
    // raw precision. Clip to the true range — the fix is ≤ 1 tick, not a change
    // of the bar's meaning.
    const high = Math.max(highRaw, open, close);
    const low = Math.min(lowRaw, open, close);
    return {
      symbol,
      timeframe,
      open,
      high,
      low,
      close,
      volume: b.volume,
      openTime: b.openTime,
      closeTime: b.openTime + TIMEFRAME_MS[timeframe],
      state: 'COMPLETED',
      completed: true,
      updatedAt: b.openTime + TIMEFRAME_MS[timeframe],
    };
  }

  async getHistoricalCandles(symbol: string, timeframe: Timeframe, _from: number, _to: number): Promise<Candle[]> {
    const asset = getAsset(symbol);
    if (timeframe === '4h') {
      const y = TF_MAP['1h'];
      const json = await this.chart(symbol, y.interval, y.range);
      return this.aggregate4h(this.parseBars(json), symbol, TIMEFRAME_MS['4h']);
    }
    const y = TF_MAP[timeframe];
    const json = await this.chart(symbol, y.interval, y.range);
    const tfMs = TIMEFRAME_MS[timeframe];
    const now = Date.now();
    return this.parseBars(json)
      // Drop bars whose window has not closed — a forming bar delivered as
      // COMPLETED mutates retroactively and double-counts when the live
      // engine builds the same window from real ticks. The grid-alignment
      // check applies only to intraday TFs: futures daily stamps (GC=F) sit
      // at the session open, and modulo-filtering them wiped XAU/USD 1D
      // history entirely.
      .filter((b) => (timeframe === '1D' || b.openTime % tfMs === 0) && b.openTime + tfMs <= now)
      .map((b) => this.toCandle(b, symbol, timeframe, asset.pricePrecision));
  }

  async getLatestPrice(symbol: string): Promise<Tick | null> {
    try {
      const json = await this.chart(symbol, '1m', '1d');
      const meta = (json.chart as { result?: Array<{ meta?: { regularMarketPrice?: number; regularMarketTime?: number } }> })?.result?.[0]?.meta;
      if (!meta) return null;
      const mid = meta.regularMarketPrice;
      if (mid == null || !Number.isFinite(mid) || mid <= 0) return null;
      return this.buildTick(symbol, mid, (meta.regularMarketTime ?? Math.floor(Date.now() / 1000)) * 1000);
    } catch {
      return null;
    }
  }

  private buildTick(symbol: string, mid: number, timestamp: number): Tick {
    const asset = getAsset(symbol);
    const spreadPips = TYPICAL_SPREAD_PIPS[symbol] ?? 1.2;
    const spread = spreadPips * asset.pipSize;
    const p = asset.pricePrecision;
    return {
      timestamp,
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
    // No streaming endpoint; the market data engine polls getLatestPrice().
    return () => undefined;
  }

  async unsubscribe(_symbol: string): Promise<void> {
    /* noop */
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      const first = this.symbols[0];
      if (!first) return { ok: false, detail: 'no symbols configured' };
      const tick = await this.getLatestPrice(first);
      if (!tick) return { ok: false, detail: 'quote check failed (throttled or blocked)' };
      const ageS = Math.round((Date.now() - tick.timestamp) / 1000);
      return { ok: true, detail: `real quotes, ${ageS}s old, budget ${this.bucket.available().toFixed(0)}/min` };
    } catch {
      return { ok: false, detail: 'quote check failed (throttled or blocked)' };
    }
  }
}
