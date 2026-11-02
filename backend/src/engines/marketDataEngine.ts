/**
 * Market data engine. Owns provider subscriptions, validates every tick and
 * keeps the latest price per symbol in the cache. If data becomes unreliable
 * the engine reports it so signal generation can be stopped.
 */
import { Tick, INR_RATE_SYMBOL } from '@fx/shared';
import { FxContext, CHANNELS } from '../core/context';
import { logger } from '../core/logger';
import { config } from '../config';
import { scheduleIntervals } from '../providers/polling';
import type { MarketDataProvider } from '../providers/types';
import { METRICS } from '../ops/metrics';

export interface MarketHealth {
  ok: boolean;
  detail: string;
  lastTickMs: Record<string, number>;
  /** Median provider→engine latency (ms) — spec §1 pipeline measurement. */
  medianLatencyMs: number;
}

interface ValidationResult {
  valid: boolean;
  reason?: string;
}

export class MarketDataEngine {
  private unsubs = new Map<string, () => void>();
  private lastTicks = new Map<string, Tick>();
  /** Provider symbol list (independent of whether ticks have arrived yet). */
  private symbols: string[] = [];
  /**
   * Rate-only symbols (e.g. USD/INR): always polled so non-USD accounts get a
   * live conversion rate. Deliberately NOT exposed via getSymbols() — they are
   * not tradable instruments and must never enter the analysis universe.
   */
  private rateSymbols: string[] = [INR_RATE_SYMBOL];
  private stats = {
    received: 0,
    rejected: 0,
    rejectedBy: new Map<string, number>(),
  };
  private persistenceCounter = 0;

  // ---- adaptive polling (for non-streaming providers) ----
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollIntervals: Record<string, number> = {};
  private lastPolled = new Map<string, number>();
  private pollingInFlight = new Set<string>();
  private pollErrors = 0;
  private weightsProvider: (() => Record<string, number>) | null = null;
  private lastScheduleRecalc = 0;
  /** Staggered next-poll times so symbols don't queue behind the token bucket. */
  private nextPollAt = new Map<string, number>();

  constructor(private ctx: FxContext) {}

  getSymbols(): string[] {
    return this.symbols;
  }

  /** Everything the engine polls: tradable symbols + rate-only feeds. */
  private pollSymbols(): string[] {
    return [...this.symbols, ...this.rateSymbols];
  }

  async start(weightsProvider?: () => Record<string, number>): Promise<void> {
    this.symbols = await this.ctx.providers.marketData.getSymbols();
    for (const symbol of this.symbols) {
      await this.subscribe(symbol);
    }
    // Rate-only feeds (USD/INR): subscribe + poll regardless of the tradable
    // universe so INR-denominated accounts always have a live conversion rate.
    for (const symbol of this.rateSymbols) {
      await this.subscribe(symbol);
    }
    if (!this.ctx.providers.marketData.streaming) this.startPolling(weightsProvider);
    logger.info('market data engine started', {
      provider: this.ctx.providers.marketData.name,
      streaming: this.ctx.providers.marketData.streaming,
      symbols: this.symbols,
    });
  }

  async stop(): Promise<void> {
    this.stopPolling();
    for (const unsub of this.unsubs.values()) await unsub();
    this.unsubs.clear();
    await this.ctx.providers.marketData.disconnect();
  }

  /**
   * Adaptive polling for REST-only providers. The provider's free-tier budget
   * is never exceeded: hot symbols (active signals / candidates, supplied via
   * weightsProvider) are polled fast, idle symbols slowly.
   */
  startPolling(weightsProvider?: () => Record<string, number>): void {
    if (this.pollTimer) return;
    this.weightsProvider = weightsProvider ?? null;
    this.recalculateSchedule();
    // Stagger phases: symbols poll at evenly spread offsets across their
    // interval instead of all at once (which would serialize them behind the
    // provider's token bucket and starve the last ones).
    const symbols = this.pollSymbols();
    const base = Date.now();
    symbols.forEach((s, i) => {
      const interval = this.pollIntervals[s] ?? 30_000;
      this.nextPollAt.set(s, base + (interval * i) / Math.max(1, symbols.length));
    });
    this.pollTimer = setInterval(() => void this.pollCycle(), 1000);
    // § realtime measurement: staleness gauge per symbol, sampled alongside
    // the poll loop (1 Hz is plenty for an alerting gauge).
    const stalenessTimer = setInterval(() => this.recordStaleness(), 1000);
    stalenessTimer.unref?.();
    void this.pollCycle();
    logger.info('adaptive polling started', { budgetPerMinute: this.ctx.providers.marketData.pollBudgetPerMinute });
  }

  stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  /** Recompute per-symbol intervals from weights (called by consumers when priorities change). */
  recalculateSchedule(): void {
    const provider = this.ctx.providers.marketData;
    const budget = provider.pollBudgetPerMinute ?? 60;
    const caps = provider.minPollIntervalMs ?? { active: 5_000, idle: 30_000 };
    const weights = this.weightsProvider?.() ?? {};
    this.pollIntervals = scheduleIntervals(this.pollSymbols(), weights, {
      budgetPerMinute: Math.max(1, budget),
      activeIntervalMs: caps.active,
      idleIntervalMs: caps.idle,
    });
    // Re-stagger next-poll times so symbols with changed intervals aren't stuck
    // on an old far-future phase.
    const base = Date.now();
    const symbols = this.pollSymbols();
    symbols.forEach((s, i) => {
      const interval = this.pollIntervals[s] ?? 30_000;
      this.nextPollAt.set(s, Math.min(this.nextPollAt.get(s) ?? Infinity, base + (interval * i) / Math.max(1, symbols.length)));
    });
    this.lastScheduleRecalc = Date.now();
  }

  private async pollCycle(): Promise<void> {
    if (this.pollingInFlight.size > this.pollSymbols().length) return;
    // Refresh the schedule when weights may have changed (cheap: a few symbols).
    if (Date.now() - this.lastScheduleRecalc > 5_000) this.recalculateSchedule();
    const now = Date.now();
    for (const symbol of this.pollSymbols()) {
      const interval = this.pollIntervals[symbol] ?? 30_000;
      if (now < (this.nextPollAt.get(symbol) ?? 0)) continue;
      if (this.pollingInFlight.has(symbol)) continue;
      // An EXTERNAL stream owns this symbol right now (MT5 bridge): REST
      // standing-down is not just budget economy — a polled quote carries a
      // newer server timestamp than the stream's last tick, and validate()
      // then rejects incoming stream ticks as out-of-order. Only declared
      // external sources qualify (registered via noteExternalSource by their
      // ingestion path); the poll's own provider name never matches, so
      // DEMO/Yahoo/Binance polling behaves exactly as before.
      const prev = this.lastTicks.get(symbol);
      if (
        prev && this.externalSources.has(prev.source)
        && now - (prev.receivedAt ?? prev.timestamp) < this.staleGraceFor(symbol)
      ) continue;
      this.pollingInFlight.add(symbol);
      this.lastPolled.set(symbol, now);
      // Next poll one full interval after THIS one (drift-corrected).
      this.nextPollAt.set(symbol, now + interval);
      void this.pollOnce(symbol);
    }
  }

  private async pollOnce(symbol: string): Promise<void> {
    try {
      const tick = await this.ctx.providers.marketData.getLatestPrice(symbol);
      if (tick) await this.handleTick(tick);
      this.pollErrors = 0;
    } catch (err) {
      this.pollErrors++;
      logger.warn('poll failed', { symbol, err: String(err), consecutive: this.pollErrors });
    } finally {
      this.pollingInFlight.delete(symbol);
    }
  }

  /** Current poll interval for a symbol (ms), or 0 for streaming providers. */
  pollIntervalFor(symbol: string): number {
    return this.pollIntervals[symbol] ?? 0;
  }

  /** Record per-symbol feed staleness (§ realtime measurement): the age of the
   *  freshest tick, observed on every poll cycle so dashboards can alert on a
   *  dying bridge instead of discovering it through frozen charts. */
  recordStaleness(): void {
    const now = Date.now();
    for (const [symbol, tick] of this.lastTicks) {
      METRICS.feedStalenessMs().set({ symbol }, now - (tick.receivedAt ?? tick.timestamp));
    }
  }

  /**
   * Staleness grace for a symbol: poll cadence (with headroom) plus the
   * provider's own quote freshness ceiling. A polled feed can never deliver a
   * fresher quote than the feed publishes, so grace must include it.
   */
  staleGraceFor(symbol: string): number {
    const feedLatency = this.ctx.providers.marketData.feedLatencyMs ?? 0;
    return Math.max(config.staleTickMs, this.pollIntervals[symbol] ?? 0) * 2.5 + feedLatency;
  }

  /**
   * Name of the source REST polling produces for a symbol ('YAHOO', 'BINANCE',
   * …). With the routing composite this is the ASSET-CLASS provider, not the
   * composite itself — ticks stored during polling carry the delegate's name.
   */
  private pollSourceName(symbol: string): string {
    const p = this.ctx.providers.marketData as MarketDataProvider & { pollSourceName?: (s: string) => string };
    return p.pollSourceName ? p.pollSourceName(symbol) : p.name;
  }

  /**
   * Sources that push ticks from OUTSIDE this engine's polling loop (the MT5
   * bridge ingestion registers 'MT5'). Only these may suppress REST polling
   * for a symbol — a polled feed must never be suppressed by its own ticks,
   * and a test-pushed tick must never masquerade as one either.
   */
  private externalSources = new Set<string>(['MT5']);

  noteExternalSource(source: string): void {
    if (source) this.externalSources.add(source);
  }

  /**
   * Last evidence the FEED for this symbol was contacted successfully —
   * poll time or tick receive time, whichever is newer.
   *
   * Distinct from tick.timestamp/receivedAt on purpose: a rate whose VALUE is
   * unchanged gets its ticks duplicate-rejected in validate(), so a perfectly
   * healthy poll of a flat market would otherwise read as infinitely stale to
   * anything judging freshness by the stored tick alone.
   */
  lastFeedContact(symbol: string): number | null {
    const t = this.lastTicks.get(symbol);
    const polled = this.lastPolled.get(symbol) ?? 0;
    return Math.max(polled, t?.receivedAt ?? t?.timestamp ?? 0) || null;
  }

  /** Per-symbol poll intervals, for health/UI. */
  pollingState(): Record<string, unknown> {
    return {
      enabled: this.pollTimer !== null,
      intervals: { ...this.pollIntervals },
      lastPolledMs: Object.fromEntries(this.lastPolled),
      errors: this.pollErrors,
      budgetPerMinute: this.ctx.providers.marketData.pollBudgetPerMinute ?? null,
    };
  }

  private validate(tick: Tick): ValidationResult {
    if (!Number.isFinite(tick.bid) || !Number.isFinite(tick.ask) || !Number.isFinite(tick.mid)) {
      return { valid: false, reason: 'non-finite price' };
    }
    if (tick.bid <= 0 || tick.ask <= 0 || tick.ask < tick.bid) {
      return { valid: false, reason: 'invalid bid/ask' };
    }
    if (tick.timestamp <= 0) return { valid: false, reason: 'invalid timestamp' };
    const now = Date.now();
    if (tick.timestamp > now + 60_000) return { valid: false, reason: 'future timestamp' };
    const prev = this.lastTicks.get(tick.symbol);
    if (prev && prev.timestamp === tick.timestamp && prev.mid === tick.mid) {
      return { valid: false, reason: 'duplicate tick' };
    }
    if (prev && prev.timestamp > tick.timestamp) {
      return { valid: false, reason: 'out-of-order tick' };
    }
    if (prev) {
      const jump = Math.abs(tick.mid - prev.mid) / prev.mid;
      if (jump > 0.05) {
        return { valid: false, reason: `abnormal price jump ${(jump * 100).toFixed(2)}%` };
      }
    }
    return { valid: true };
  }

  async subscribe(symbol: string): Promise<void> {
    const unsub = await this.ctx.providers.marketData.subscribe(symbol, (tick) => {
      void this.handleTick(tick);
    });
    this.unsubs.set(symbol, unsub);
    // Seed with latest price so downstream has immediate data.
    const latest = await this.ctx.providers.marketData.getLatestPrice(symbol);
    if (latest) void this.handleTick(latest);
  }

  async handleTick(tick: Tick): Promise<void> {
    this.stats.received++;
    const check = this.validate(tick);
    if (!check.valid) {
      this.stats.rejected++;
      this.stats.rejectedBy.set(check.reason!, (this.stats.rejectedBy.get(check.reason!) ?? 0) + 1);
      return;
    }
    // Pipeline latency (spec §1): stamp the engine receive time on the tick.
    tick.receivedAt = tick.receivedAt ?? Date.now();
    this.lastTicks.set(tick.symbol, tick);
    await this.ctx.cache.set(`market:latest:${tick.symbol}`, JSON.stringify(tick), 60_000);

    this.ctx.events.emit(CHANNELS.tick, tick);
    if (this.ctx.events.listenerCount(CHANNELS.tick) === 0) {
      // no listeners yet (e.g. engines starting); still forward via candle engine hook below
    }

    // Throttle snapshot persistence: every ~20th tick per symbol persist a snapshot.
    this.persistenceCounter++;
    if (this.persistenceCounter % 20 === 0) {
      try {
        await this.ctx.store.insertOne('marketSnapshots', {
          timestamp: tick.timestamp,
          symbol: tick.symbol,
          bid: tick.bid,
          ask: tick.ask,
          mid: tick.mid,
          spread: tick.spread,
          source: tick.source,
          mode: tick.mode,
          retentionMs: config.tickRetentionMs,
        });
      } catch (err) {
        logger.warn('snapshot persist failed', { err: String(err) });
      }
    }
  }

  getLatest(symbol: string): Tick | undefined {
    return this.lastTicks.get(symbol);
  }

  /** True when the MT5 bridge is the live feed (any MT5-sourced tick seen). */
  isBridgeActive(): boolean {
    for (const tick of this.lastTicks.values()) {
      if (tick.source === 'MT5') return true;
    }
    return false;
  }

  /** All latest ticks — used to populate the UI instantly on page load. */
  getAllLatest(): Tick[] {
    return [...this.lastTicks.values()];
  }

  async getLatestFromCache(symbol: string): Promise<Tick | null> {
    const raw = await this.ctx.cache.get(`market:latest:${symbol}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Tick;
    } catch {
      return null;
    }
  }

  health(): MarketHealth {
    const now = Date.now();
    const stale: string[] = [];
    for (const [symbol, tick] of this.lastTicks) {
      if (now - tick.timestamp > this.staleGraceFor(symbol)) stale.push(symbol);
    }
    const total = this.lastTicks.size;
    const fresh = total - stale.length;
    // Median provider→engine latency (spec §1): how old the quotes actually are.
    const ages = [...this.lastTicks.values()].map((t) => now - t.timestamp).filter((a) => a >= 0).sort((a, b) => a - b);
    const medianLatencyMs = ages.length ? ages[Math.floor(ages.length / 2)] : 0;
    // Healthy when the feed is alive: at least one fresh symbol and the
    // majority fresh. A couple of slowly-updating pairs must not flag the whole
    // feed DOWN (that would block trading on every symbol).
    const ok = total > 0 && fresh > 0 && fresh / total >= 0.8;
    const detail = ok
      ? `receiving ticks for ${fresh}/${total} symbols (median latency ${medianLatencyMs}ms)`
      : total === 0
        ? 'no market data received'
        : `data feed degraded: stale for ${stale.join(', ')}`;
    return { ok, detail, lastTickMs: Object.fromEntries([...this.lastTicks].map(([s, t]) => [s, t.timestamp])), medianLatencyMs };
  }

  statsSummary(): Record<string, unknown> {
    return {
      received: this.stats.received,
      rejected: this.stats.rejected,
      rejectedBy: Object.fromEntries(this.stats.rejectedBy),
      symbols: this.getSymbols(),
      mode: this.ctx.providers.marketData.mode,
      provider: this.ctx.providers.marketData.name,
      streaming: this.ctx.providers.marketData.streaming,
      polling: this.pollingState(),
    };
  }
}
