/**
 * Routing market data provider. The platform trades FOREX and CRYPTO, each
 * served by its own provider. This composite exposes a single MarketDataProvider
 * to the engines and routes every symbol to the provider that owns its asset
 * class. Polling stays enabled (composite.streaming = false) so REST-only forex
 * feeds are refreshed; the crypto provider's own WebSocket also streams.
 */
import { Candle, DataMode, Tick, Timeframe, assetClassFor } from '@fx/shared';
import { logger } from '../core/logger';
import { MarketDataProvider } from './types';

export class RoutingMarketDataProvider implements MarketDataProvider {
  readonly name = 'ROUTING';
  readonly streaming = false;
  readonly description = 'Routes each symbol to its asset-class provider (forex vs crypto).';
  readonly pollBudgetPerMinute = 60;
  readonly minPollIntervalMs = { active: 5_000, idle: 30_000 };

  constructor(private forex: MarketDataProvider, private crypto: MarketDataProvider) {}

  get mode(): DataMode {
    // Informational for stats/health; per-tick mode comes from each provider.
    return this.forex.mode === 'LIVE' || this.crypto.mode === 'LIVE' ? 'LIVE' : 'DEMO';
  }

  get preloadTimeframes(): Timeframe[] | undefined {
    // Union of both providers' preload sets (superset is fine; each request
    // is routed to the owning provider which handles its own timeframes).
    const a = this.forex.preloadTimeframes ?? [];
    const b = this.crypto.preloadTimeframes ?? [];
    return [...new Set([...a, ...b])];
  }

  get feedLatencyMs(): number {
    return Math.max(this.forex.feedLatencyMs ?? 0, this.crypto.feedLatencyMs ?? 0);
  }

  private owner(symbol: string): MarketDataProvider {
    try {
      return assetClassFor(symbol) === 'CRYPTO' ? this.crypto : this.forex;
    } catch {
      return this.forex;
    }
  }

  /**
   * Name of the provider REST polling reaches for this symbol ('YAHOO',
   * 'BINANCE', …). Lets consumers distinguish "the poll feed's own tick" from
   * an external stream (MT5 bridge) that has taken a symbol over.
   */
  pollSourceName(symbol: string): string {
    return this.owner(symbol).name;
  }

  async connect(): Promise<void> {
    await Promise.allSettled([this.forex.connect(), this.crypto.connect()]);
  }

  async disconnect(): Promise<void> {
    await Promise.allSettled([this.forex.disconnect(), this.crypto.disconnect()]);
  }

  async getSymbols(): Promise<string[]> {
    const [a, b] = await Promise.all([this.forex.getSymbols(), this.crypto.getSymbols()]);
    return [...a, ...b];
  }

  setSymbols(symbols: string[]): void {
    const forex: string[] = [];
    const crypto: string[] = [];
    for (const s of symbols) {
      try {
        if (assetClassFor(s) === 'CRYPTO') crypto.push(s);
        else forex.push(s);
      } catch {
        forex.push(s);
      }
    }
    this.forex.setSymbols?.(forex);
    this.crypto.setSymbols?.(crypto);
    logger.info('routing provider configured', { forex: forex.length, crypto: crypto.length });
  }

  getHistoricalCandles(symbol: string, timeframe: Timeframe, from: number, to: number): Promise<Candle[]> {
    return this.owner(symbol).getHistoricalCandles(symbol, timeframe, from, to);
  }

  getLatestPrice(symbol: string): Promise<Tick | null> {
    return this.owner(symbol).getLatestPrice(symbol);
  }

  getBidAsk(symbol: string): Promise<{ bid: number; ask: number } | null> {
    return this.owner(symbol).getBidAsk(symbol);
  }

  getSpread(symbol: string): Promise<number | null> {
    return this.owner(symbol).getSpread(symbol);
  }

  subscribe(symbol: string, onTick: (tick: Tick) => void): Promise<() => void> {
    return this.owner(symbol).subscribe(symbol, onTick);
  }

  unsubscribe(symbol: string): Promise<void> {
    return this.owner(symbol).unsubscribe(symbol);
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    const [f, c] = await Promise.allSettled([this.forex.health(), this.crypto.health()]);
    const fh = f.status === 'fulfilled' ? f.value : { ok: false, detail: 'forex health probe failed' };
    const ch = c.status === 'fulfilled' ? c.value : { ok: false, detail: 'crypto health probe failed' };
    return {
      ok: fh.ok || ch.ok,
      detail: `forex: ${fh.detail} | crypto: ${ch.detail}`,
    };
  }
}
