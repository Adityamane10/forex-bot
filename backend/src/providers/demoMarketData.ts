/**
 * Demo market data provider.
 *
 * IMPORTANT: this feed is SIMULATED. It generates a realistic random walk with
 * per-pair spreads for development and demonstration. Everything that consumes
 * this data is labeled with mode=DEMO and the UI shows a DEMO badge. The
 * provider interface is identical to live providers so swapping in a real feed
 * (TwelveData, OANDA, FXCM, ...) requires zero downstream changes.
 */
import { Candle, Tick, DataMode } from '@fx/shared';
import { Timeframe, TIMEFRAME_MS, getAsset } from '@fx/shared';
import { MarketDataProvider } from './types';

const BASE_PRICES: Record<string, number> = {
  'EUR/USD': 1.085,
  'GBP/USD': 1.27,
  'USD/JPY': 154.5,
  'USD/CHF': 0.89,
  'AUD/USD': 0.66,
  'USD/CAD': 1.36,
  'NZD/USD': 0.61,
  'EUR/GBP': 0.855,
  'EUR/JPY': 167.6,
  'GBP/JPY': 196.2,
  'XAU/USD': 2380,
};

function seededRand(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export class DemoMarketDataProvider implements MarketDataProvider {
  readonly name = 'DEMO';
  readonly mode: DataMode = 'DEMO';
  /** Demo pushes ticks itself (interval timers) — no polling needed. */
  readonly streaming = true;
  readonly description =
    'Simulated random-walk feed for development. Not real market data. Free, no API key, no limits.';
  private symbols: string[] = [];
  private state = new Map<string, { mid: number; bid: number; ask: number; seed: () => number; lastTick: number }>();
  private listeners = new Map<string, Set<(t: Tick) => void>>();
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  private connected = false;

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    for (const t of this.timers.values()) clearInterval(t);
    this.timers.clear();
    this.listeners.clear();
    this.connected = false;
  }

  async getSymbols(): Promise<string[]> {
    return this.symbols;
  }

  setSymbols(symbols: string[]): void {
    this.symbols = symbols;
  }

  private ensureState(symbol: string) {
    if (!this.state.has(symbol)) {
      const asset = getAsset(symbol);
      const base = BASE_PRICES[symbol] ?? 1.0;
      const rand = seededRand([...symbol].reduce((a, c) => a + c.charCodeAt(0), 7) * 2654435761);
      const mid = base * (1 + (rand() - 0.5) * 0.01);
      // realistic spread: 0.1 - 1.2 pips depending on pair
      const spreadPips = 0.1 + rand() * 1.1;
      const spread = spreadPips * asset.pipSize;
      this.state.set(symbol, {
        mid,
        bid: mid - spread / 2,
        ask: mid + spread / 2,
        seed: rand,
        lastTick: Date.now(),
      });
    }
    return this.state.get(symbol)!;
  }

  private step(symbol: string): Tick {
    const s = this.ensureState(symbol);
    const asset = getAsset(symbol);
    const now = Date.now();
    // mean-reverting random walk with regime bursts (bounded, realistic range)
    const r = s.seed();
    const vol = (asset.pipSize * 2.5) * (r < 0.03 ? 4 : 1); // occasional volatility burst
    const drift = (BASE_PRICES[symbol] - s.mid) * 0.001;
    const change = drift + (r - 0.5) * 2 * vol;
    s.mid += change;
    // spread jitter
    const spread = asset.pipSize * (0.1 + s.seed() * 1.3);
    s.bid = s.mid - spread / 2;
    s.ask = s.mid + spread / 2;
    s.lastTick = now;
    return {
      timestamp: now,
      symbol,
      bid: Number(s.bid.toFixed(asset.pricePrecision)),
      ask: Number(s.ask.toFixed(asset.pricePrecision)),
      mid: Number(s.mid.toFixed(asset.pricePrecision)),
      spread: Number(spread.toFixed(asset.pricePrecision)),
      source: this.name,
      mode: this.mode,
    };
  }

  async getLatestPrice(symbol: string): Promise<Tick | null> {
    return this.step(symbol);
  }

  async getBidAsk(symbol: string): Promise<{ bid: number; ask: number } | null> {
    const t = await this.getLatestPrice(symbol);
    return t ? { bid: t.bid, ask: t.ask } : null;
  }

  async getSpread(symbol: string): Promise<number | null> {
    const t = await this.getLatestPrice(symbol);
    return t ? t.spread : null;
  }

  async subscribe(symbol: string, onTick: (tick: Tick) => void): Promise<() => void> {
    this.ensureState(symbol);
    let set = this.listeners.get(symbol);
    if (!set) {
      set = new Set();
      this.listeners.set(symbol, set);
    }
    set.add(onTick);
    if (!this.timers.has(symbol)) {
      const intervalMs = 400 + Math.floor(this.ensureState(symbol).seed() * 400);
      const timer = setInterval(() => {
        const tick = this.step(symbol);
        for (const cb of this.listeners.get(symbol) ?? []) cb(tick);
      }, intervalMs);
      this.timers.set(symbol, timer);
    }
    return () => {
      set.delete(onTick);
      if (set.size === 0) {
        const t = this.timers.get(symbol);
        if (t) {
          clearInterval(t);
          this.timers.delete(symbol);
        }
      }
    };
  }

  async unsubscribe(symbol: string): Promise<void> {
    const t = this.timers.get(symbol);
    if (t) clearInterval(t);
    this.timers.delete(symbol);
    this.listeners.delete(symbol);
  }

  async getHistoricalCandles(symbol: string, timeframe: Timeframe, from: number, to: number): Promise<Candle[]> {
    // Generate a simulated history with realistic OHLC structure.
    const asset = getAsset(symbol);
    const tf = TIMEFRAME_MS[timeframe];
    const rand = seededRand([...symbol].join('').charCodeAt(0) + tf);
    const out: Candle[] = [];
    const base = BASE_PRICES[symbol] ?? 1.0;
    let mid = base * 0.98;
    for (let t = from; t < to; t += tf) {
      const r1 = rand();
      const r2 = rand();
      const vol = asset.pipSize * (2 + r1 * 8) * (timeframe === '1D' ? 60 : timeframe === '4h' ? 30 : timeframe === '1h' ? 14 : timeframe === '1m' ? 3 : 7);
      const open = mid;
      // strong mean reversion toward base so the walk stays in a realistic band
      const reversion = (base - mid) * 0.02;
      const close = open + reversion + (r1 - 0.5) * 2 * vol;
      const high = Math.max(open, close) + r2 * vol * 0.6;
      const low = Math.min(open, close) - (1 - r2) * vol * 0.6;
      mid = close;
      out.push({
        symbol,
        timeframe,
        open: Number(open.toFixed(asset.pricePrecision)),
        high: Number(high.toFixed(asset.pricePrecision)),
        low: Number(low.toFixed(asset.pricePrecision)),
        close: Number(close.toFixed(asset.pricePrecision)),
        volume: Math.floor(rand() * 500) + 50,
        openTime: t,
        closeTime: t + tf,
        state: 'COMPLETED',
        completed: true,
        updatedAt: t + tf,
      });
    }
    return out;
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    return { ok: this.connected, detail: this.connected ? 'demo feed running' : 'demo feed not connected' };
  }
}
