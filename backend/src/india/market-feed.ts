/**
 * IndiaMarketFeedService (spec §3–§6, §8). Owns the broker transport lifecycle:
 * connect → authenticate → instrument master → historical seed → subscribe →
 * live tick stream. Every tick passes through validation, normalization,
 * sequencing, data-health and the candle engine BEFORE it reaches consumers.
 * No broker configured → the feed stays disconnected (NULL adapter) and the
 * health service reports AUTH_FAILED; the UI shows this instead of fake data.
 */
import type { IndiaCandle, IndiaTick, IndiaTimeframe } from '@fx/shared';
import { INDIA_CHANNELS, INDIA_REDIS_KEYS } from '@fx/shared';
import { Cache } from '../db/cache';
import { EventEmitter } from 'events';
import { logger } from '../core/logger';
import { indiaConfig } from './config';
import { IndiaBrokerAdapter } from './brokers/types';
import { validateIndiaTick, normalizeIndiaTick, TickSequencer } from './tick-normalizer';
import { IndiaInstrumentService } from './instruments';
import { IndiaMarketDataHealthService } from './data-health';
import { IndiaCandleEngine, INDIA_CANDLE_BUFFER_MAX } from './candle-engine';
import { IndiaMarketSessionService } from './session';

/**
 * How long an instrument stays in the poll set after the UI last asked for it.
 *
 * Long enough to survive a user reading a chart without touching anything — the
 * frontend re-requests every 15s, so this is roughly twenty missed requests — and short
 * enough that a session spent clicking through strikes does not leave every one of them
 * costing an API call for the rest of the day.
 */
const INDIA_INTEREST_TTL_MS = 5 * 60_000;

export class IndiaMarketFeedService {
  private sequencer = new TickSequencer();
  private started = false;
  private tickCount = 0;
  /**
   * Last accepted tick per instrument, in process memory.
   *
   * The tick already goes to the shared cache, but that read is asynchronous and
   * the signal gates run inside a synchronous scan loop — a gate that awaits a
   * round-trip per instrument would turn one scan into hundreds of sequential
   * I/O calls. This map is the same data with a synchronous reader, bounded by
   * the size of the subscribed universe rather than by time.
   */
  private lastTicks = new Map<string, IndiaTick>();
  /**
   * Instruments the broker websocket is currently carrying.
   *
   * Tracked here rather than inferred from the adapter because `ensureSubscribed` has
   * to answer "is this token already live?" synchronously, on a REST request, without
   * a round-trip — and because a subscribe that failed must not be recorded as done.
   */
  private subscribed = new Set<string>();
  /**
   * Instruments the UI has asked about recently, and when it last asked.
   *
   * The LTP fallback poll used to cover exactly the three primary indices, so with a
   * credential that cannot stream — the read-only analytics token, which is the whole
   * point of this stage — a contract the user opened had no live price source at all.
   * Its chart moved only when the browser re-requested it.
   *
   * Entries expire rather than accumulate: a token nobody has looked at for a few
   * minutes must stop costing an API call on every poll, or an afternoon of browsing
   * strikes would grow the poll without bound and spend the rate-limit budget on charts
   * nobody has open.
   */
  private interest = new Map<string, number>();
  /**
   * When this service last handed an instrument to the LTP poll, successfully.
   *
   * Coverage is relative to this instant: an instrument leaves the poll set only while
   * a tick has arrived MORE RECENTLY than the last time the poll asked for it — proof
   * that something else (the websocket) fed it during that cycle. A threshold measured
   * from the tick itself instead ("younger than N seconds") self-throttles into a
   * sawtooth: every instrument skips until its tick crosses N seconds old, then polls,
   * then skips — an effective cadence of ~2N regardless of the configured interval,
   * which showed up as values stepping every ten-odd seconds and health flapping
   * across the staleness line.
   */
  private lastPolledAt = new Map<string, number>();
  /**
   * Last tick arrival that came off the broker websocket specifically.
   *
   * Tick `source` distinguishes transports (`*-WS` frames vs REST batches), and this
   * is the honest input for "is streaming working" — the connected flag says a
   * handshake succeeded, which on the analytics token happens while the socket
   * ignores every subscribe forever.
   */
  private lastWsTickAt: number | null = null;

  constructor(
    private adapter: IndiaBrokerAdapter,
    private instruments: IndiaInstrumentService,
    private health: IndiaMarketDataHealthService,
    private candles: IndiaCandleEngine,
    private cache: Cache,
    private events: EventEmitter,
    private session: IndiaMarketSessionService,
  ) {}

  get isStarted(): boolean {
    return this.started;
  }

  /**
   * Most recent accepted tick for an instrument, or null if none has arrived.
   *
   * Callers must treat a returned tick as possibly stale and check its
   * `marketTimestamp` themselves: this returns the last tick seen, not a
   * guarantee that the feed is live.
   */
  lastTick(instrumentToken: string): IndiaTick | null {
    return this.lastTicks.get(instrumentToken) ?? null;
  }

  async start(): Promise<void> {
    if (this.started) return;
    const configured = indiaConfig.broker !== 'NONE'
      && (
        Boolean(indiaConfig.apiKey)
        || Boolean(indiaConfig.upstoxAnalyticsToken)
        || Boolean(indiaConfig.accessToken)
        || (indiaConfig.broker === 'ANGELONE' && Boolean(
          indiaConfig.angelApiKey && indiaConfig.angelClientCode
          && indiaConfig.angelPin && indiaConfig.angelTotpSecret,
        ))
      );

    if (!configured) {
      this.health.setAuthenticated(false);
      this.health.setWsConnected(false);
      this.health.evaluate(false).catch(() => undefined);
      logger.warn('india: broker not configured — feed disabled (no fabricated data)');
      return;
    }

    try {
      await this.adapter.connect();
      this.health.setWsConnected(true);
      const auth = await this.adapter.authenticate({
        broker: indiaConfig.broker as 'ZERODHA' | 'UPSTOX' | 'ANGELONE',
        apiKey: indiaConfig.apiKey,
        apiSecret: indiaConfig.apiSecret,
        accessToken: indiaConfig.accessToken || undefined,
        analyticsToken: indiaConfig.upstoxAnalyticsToken || undefined,
        requestToken: indiaConfig.requestToken || undefined,
        redirectUri: indiaConfig.redirectUri || undefined,
        angelApiKey: indiaConfig.angelApiKey || undefined,
        angelClientCode: indiaConfig.angelClientCode || undefined,
        angelPin: indiaConfig.angelPin || undefined,
        angelTotpSecret: indiaConfig.angelTotpSecret || undefined,
      });
      if (!auth.authenticated) {
        this.health.setAuthenticated(false);
        throw new Error(`india: broker auth failed — ${auth.error ?? 'unknown'}`);
      }
      this.health.setAuthenticated(true);
      this.health.setReadOnly(Boolean(auth.readOnly));
      // Run an immediate evaluate so the UI shows MARKET_CLOSED (not DISCONNECTED)
      // as soon as auth succeeds, without waiting for the 5s timer.
      void this.health.evaluate(false).catch(() => undefined);
      logger.info('india: broker authenticated', { broker: auth.broker, userId: auth.userId, readOnly: Boolean(auth.readOnly), feedMode: this.adapter.feedMode });

      // Instrument master (real broker metadata, never fabricated).
      const master = await this.instruments.refresh();
      if (!master.length) {
        const cached = await this.instruments.loadCached();
        if (!cached.length) throw new Error('india: instrument master empty — check broker connectivity');
        // The service now holds cached metadata, but the ADAPTER's own map is cold,
        // and Upstox builds subscription/history keys from it. Left empty it falls
        // back to constructed `NSE_INDEX|26000`-style keys, which the broker rejects
        // ("Invalid Instrument key") — silently killing every history and LTP call
        // on exactly the boots (master download failed) that need the cache most.
        this.adapter.adoptInstruments?.(cached);
      }
      this.events.emit(INDIA_CHANNELS.contract, { action: 'MASTER_LOADED', count: master.length });

      // Usable NOW. `isStarted` gates the LTP fallback poll, the on-demand
      // chart top-up and (via module.start ordering) the health/ML timers —
      // and everything they need, the instrument master, is already loaded.
      // Below this point sit minutes of paced 90-day seeding; gating usability
      // on it kept the whole subsystem dark after every restart, charts frozen
      // while the seed ground through its rate-limit sleeps.
      this.started = true;

      // Boot subscription (fast, best-effort) stays on the startup path.
      const tokens = this.bootSubscriptionTokens();
      if (tokens.length) {
        try {
          await this.adapter.subscribe(tokens);
          this.health.setSubscribed(tokens, true);
          for (const t of tokens) this.subscribed.add(t);
        } catch (subErr) {
          this.health.setWsConnected(false);
          logger.warn('india: websocket subscribe unavailable — REST polling only', {
            instruments: tokens.length,
            err: String(subErr),
          });
        }
      }

      // The 90-day history seed, intraday merge and stream attach are MINUTES
      // of paced REST work — background them so init() resolves and every
      // timer (LTP poll, ML probe, health) starts immediately.
      const primaryTokens = this.instruments.primaryIndexInstruments().map(i => i.instrumentToken);
      const primaryTf: IndiaTimeframe = indiaConfig.primaryTimeframe as IndiaTimeframe;
      void this.warmBootHistory(tokens, primaryTokens, primaryTf).catch((err) =>
        logger.warn('india: boot history warm-up failed', { err: String(err) }));
    } catch (err) {
      this.health.setWsConnected(false);
      logger.error('india: market feed failed to start', { err: String(err) });
    }
  }

  /** Background boot work: 90-day seed → intraday merge → LTP inject → stream. */
  private async warmBootHistory(
    tokens: string[],
    primaryTokens: string[],
    primaryTf: IndiaTimeframe,
  ): Promise<void> {
    // Seed ALL timeframes with 90 days of historical data (3 chunks × 30 days).
    // This gives: 1m=~27k bars, 3m=~9k, 5m=~5.4k, 15m=~1.8k, 30m=~900, 1h=~450
    const now = Date.now();
      const seedInstruments = this.instruments.primaryIndexInstruments();
      const timeframes: IndiaTimeframe[] = ['1m', '3m', '5m', '15m', '30m', '1h'];
      const chunks = 3; // 3 × 30 days = 90 days
      const chunkSize = 30 * 86_400_000;
      
      for (const instr of seedInstruments) {
        for (const tf of timeframes) {
          try {
            const allBars: IndiaCandle[] = [];
            for (let i = 0; i < chunks; i++) {
              const chunkTo = now - (i * chunkSize);
              const chunkFrom = chunkTo - chunkSize;
              try {
                const history = await this.adapter.getHistoricalCandles(instr.instrumentToken, tf, chunkFrom, chunkTo);
                allBars.push(...history);
                await new Promise(r => setTimeout(r, 300)); // rate limit
              } catch (chunkErr) {
                logger.warn('india: history chunk failed', { 
                  token: instr.instrumentToken, timeframe: tf, chunk: i, err: String(chunkErr) 
                });
                break;
              }
            }
            
            if (allBars.length) {
              const dedupe = new Map<string, IndiaCandle>();
              for (const c of allBars) dedupe.set(c.id, c);
              const sorted = [...dedupe.values()].sort((a, b) => a.openTime - b.openTime);
              
              await this.candles.seed(instr.instrumentToken, tf, sorted);
              if (tf === '5m') {
                const oldest = sorted[0] ? new Date(sorted[0].openTime).toISOString().split('T')[0] : 'none';
                logger.info('india: seeded all timeframes', { 
                  token: instr.instrumentToken, symbol: instr.tradingSymbol, 
                  bars: sorted.length, from: oldest,
                });
              }
            }
          } catch (err) {
            logger.warn('india: timeframe seed failed', { 
              token: instr.instrumentToken, symbol: instr.tradingSymbol, timeframe: tf, err: String(err) 
            });
          }
        }
      }

      // Step 1 — Fetch today's candles for primary indices.
      // Strategy (per Upstox documentation):
      //   - Historical Candle Data V3: for past dates up to specified to_date
      //   - Intraday Candle Data V2: specifically for current trading day (may have cache delay)
      //   - WebSocket: for truly real-time tick updates (already handled separately)
      // We fetch historical for past data, then intraday for today, and merge.
      try {
        for (const token of primaryTokens) {
          const instr = this.instruments.getByToken(token);
          if (!instr) continue;
          
          // Fetch intraday for all supported timeframes
          const timeframes: IndiaTimeframe[] = ['1m', '3m', '5m', '15m', '30m', '1h'];
          for (const itf of timeframes) {
            try {
              // 1. Get existing historical data from buffer (already seeded earlier).
              //    Read the full buffer depth: a smaller number here silently drops
              //    the tail of the 90-day seed, because step 5 seeds back exactly
              //    what this returns.
              const existing = this.candles.getCandles(token, itf, INDIA_CANDLE_BUFFER_MAX);
              
              // 2. Fetch current trading day's intraday data
              const intraday = await this.adapter.getIntradayCandles(token, itf);
              
              // 3. Merge: deduplicate by candle ID, keep newest version
              const merged = new Map<string, IndiaCandle>();
              for (const c of [...existing, ...intraday]) merged.set(c.id, c);
              
              // 4. Sort ascending by openTime
              const sortedMerge = [...merged.values()].sort((a, b) => a.openTime - b.openTime);
              
              // 5. Seed back into buffer
              await this.candles.seed(token, itf, sortedMerge);
              
              if (itf === primaryTf && intraday.length) {
                logger.info('india: intraday candles merged', {
                  token, symbol: instr.tradingSymbol, timeframe: itf, 
                  intradayBars: intraday.length, totalBars: sortedMerge.length,
                });
              }
              
              await new Promise(r => setTimeout(r, 300)); // rate limit protection
            } catch (err) {
              logger.warn('india: intraday fetch failed', { token, timeframe: itf, err: String(err) });
            }
          }
        }
      } catch (err) {
        logger.warn('india: intraday seed failed', { err: String(err) });
      }

      // Step 2 — Emit current LTP as a tick to open the live candle bar
      try {
        const ltpTicks = await this.adapter.getLtpBatch(primaryTokens);
        for (const tick of ltpTicks) {
          this.onTick(tick);
          logger.info('india: live LTP tick injected', { token: tick.instrumentToken, symbol: tick.tradingSymbol, ltp: tick.ltp });
        }
      } catch (ltpErr) {
        logger.warn('india: LTP batch fetch failed', { err: String(ltpErr) });
      }

      // Step 3 — Start periodic intraday refresh (every 5 min during market hours)
      this.startIntradayRefresh();

      // Best-effort live streaming: analytics tokens cannot stream ticks; that's
      try {
        await this.adapter.streamTicks((tick) => this.onTick(tick));
        this.health.setWsConnected(true);
        logger.info('india: market feed streaming', { instruments: tokens.length });
      } catch (streamErr) {
        // Read-only / analytics token: stream not available but data is usable.
        this.health.setWsConnected(false);
        logger.warn('india: live tick stream unavailable (analytics token?) — charts use REST polling', { err: String(streamErr) });
      }
  }

  /** Public entry point for external tick injection (e.g. LTP polling).
   *  Runs the full validate → normalize → sequencer → candle → event pipeline. */
  ingestTick(raw: IndiaTick): void {
    this.onTick(raw);
  }

  /**
   * The instruments the boot subscription carries, bounded and priority-ordered.
   *
   * `executionInstruments()` is the right *eligibility* test and the wrong
   * subscription list: every unexpired strike within the 60-day lookahead, thousands
   * of tokens, in one frame. Brokers cap instruments per connection and reject the
   * frame whole, so asking for everything is how you end up subscribed to nothing.
   *
   * Ordered so the cap truncates the least useful tail: indices first, because they
   * are the price reference for every chart and every option calculation and there are
   * only a handful of them; then the remainder by expiry, nearest first, since a
   * contract expiring next week is what gets traded and one expiring in two months is
   * not. Undated instruments sort last rather than first — `Infinity`, not 0, because
   * a missing expiry is not an imminent one.
   */
  private bootSubscriptionTokens(): string[] {
    const eligible = this.instruments.executionInstruments();
    const ranked = [...eligible].sort((a, b) => {
      const ai = a.contractType === 'INDEX' ? 0 : 1;
      const bi = b.contractType === 'INDEX' ? 0 : 1;
      if (ai !== bi) return ai - bi;
      return (a.expiry ?? Infinity) - (b.expiry ?? Infinity);
    });
    const capped = ranked.slice(0, Math.max(1, indiaConfig.wsSubscribeMax));
    if (ranked.length > capped.length) {
      logger.info('india: websocket subscription capped', {
        eligible: ranked.length,
        subscribed: capped.length,
        cap: indiaConfig.wsSubscribeMax,
        note: 'contracts outside the cap are subscribed on demand when opened',
      });
    }
    return capped.map((i) => i.instrumentToken);
  }

  /**
   * Add one instrument to the live websocket feed if it is not already on it.
   *
   * This is what makes a searched contract tick. The boot subscription is capped and
   * ordered by expiry, so an arbitrary strike the user goes looking for is usually not
   * on it — and before this existed there was no way to add one, so its chart advanced
   * only on the 15-second REST poll while the indices moved in real time. Same screen,
   * two different notions of "now".
   *
   * Returns true when the token is live on the feed afterwards. Idempotent, and safe to
   * call on every request: the Set makes a repeat call free, and a failure is not
   * recorded, so a transient error is retried on the next request rather than latching
   * the token off permanently.
   */
  async ensureSubscribed(instrumentToken: string): Promise<boolean> {
    if (!this.started) return false;
    // Recorded before the early return below, and regardless of whether the websocket
    // will take it: a token already on the socket still has to keep its place in the
    // interest map, or it would expire out of the REST poll and be left with no price
    // source at all if the socket later dropped.
    this.interest.set(instrumentToken, Date.now());
    if (this.subscribed.has(instrumentToken)) return true;
    if (!this.instruments.getByToken(instrumentToken)) return false;
    try {
      await this.adapter.subscribe([instrumentToken]);
      this.subscribed.add(instrumentToken);
      this.health.setSubscribed([instrumentToken], true);
      logger.info('india: subscribed on demand', { instrumentToken, live: this.subscribed.size });
      return true;
    } catch (err) {
      // Expected whenever the credential cannot stream at all (analytics token). Logged
      // at debug volume because the caller is a per-request path and this would
      // otherwise emit a line every fifteen seconds for the whole session.
      logger.debug('india: on-demand subscribe failed', { instrumentToken, err: String(err) });
      return false;
    }
  }

  /**
   * The instruments the LTP fallback poll should refresh, most important first.
   *
   * Answers the question "what is someone actually looking at?", which is not the same
   * question as "what is tradable" (thousands of strikes) or "what is streaming" (with a
   * read-only analytics token, nothing). The poll that used to call
   * `primaryIndexInstruments()` directly could only ever answer the first of those, so a
   * contract the user had open on screen was refreshed by nothing.
   *
   * Indices lead because every chart on the page is priced against them and there are
   * only three; then the recently-opened contracts, newest interest first, so if the cap
   * has to bite it bites the tab opened longest ago rather than the one in front of the
   * user. Tokens that are genuinely streaming are excluded — polling a live instrument
   * spends rate-limit budget to learn what the socket already said.
   *
   * "Genuinely streaming" is a data question, not a flag question. `wsConnected` only
   * says the handshake succeeded: the Upstox analytics token authorizes the V3 socket,
   * receives the initial segment-status frame, and then silently ignores every subscribe
   * and ping — connected, subscribed, zero ticks, forever. Trusting the flag excluded
   * every boot-subscribed instrument from this poll, disabled the only price source that
   * credential will ever have, and left the whole page frozen at the startup seed while
   * health correctly reported STALE that nothing acted on. So coverage now requires
   * evidence: a per-instrument tick recent enough that the socket is demonstrably
   * carrying it. The moment ticks stop — mid-session drop, silent entitlement, dead
   * socket — the instrument ages out and the poll picks it up again without a restart.
   */
  pollTokens(max: number): string[] {
    const cutoff = Date.now() - INDIA_INTEREST_TTL_MS;
    for (const [token, at] of this.interest) if (at < cutoff) this.interest.delete(token);

    const snap = this.health.snapshot;
    const covered = (token: string): boolean => {
      if (!snap.wsConnected) return false;
      // Covered only when a tick arrived after the last time the poll asked —
      // evidence the socket delivered during that cycle. Never having asked is
      // the opposite of covered: no cycle has been observed, so the poll must
      // go out (this is also why the boot-time LTP batch does not suppress the
      // first round).
      const lastAsk = this.lastPolledAt.get(token);
      const at = snap.instruments[token]?.lastTickAt ?? null;
      return at !== null && lastAsk !== undefined && at > lastAsk;
    };

    const out: string[] = [];
    const seen = new Set<string>();
    const push = (token: string): void => {
      if (seen.has(token)) return;
      if (this.subscribed.has(token) && covered(token)) return;
      seen.add(token);
      out.push(token);
    };

    for (const i of this.instruments.primaryIndexInstruments()) push(i.instrumentToken);
    const recent = [...this.interest.entries()].sort((a, b) => b[1] - a[1]);
    for (const [token] of recent) push(token);

    return out.slice(0, Math.max(1, max));
  }

  /** Record a completed poll round so per-instrument coverage can be measured
   *  against it. Called on success only: a failed request leaves coverage
   *  unclaimed and the instrument is re-asked next interval. */
  markPolled(tokens: string[]): void {
    const now = Date.now();
    for (const t of tokens) this.lastPolledAt.set(t, now);
  }

  /** Whether the websocket has demonstrably delivered a tick recently. */
  isStreaming(freshMs = Math.max(indiaConfig.tickStaleMs * 2, 10_000)): boolean {
    return this.lastWsTickAt !== null && Date.now() - this.lastWsTickAt < freshMs;
  }

  /**
   * The interval the REST LTP poll is currently running at, as reported by its
   * driver (empty-round backoff included).
   *
   * Position maintenance reads this: force-closing a live position because no
   * tick arrived for 30s is wrong when the poll itself legitimately waits 30s
   * during a broker throttle window. The staleness threshold that may LIQUIDATE
   * must never be smaller than the cadence that FEEDS it.
   */
  private pollBackoffMs = 0;

  notePollBackoff(intervalMs: number): void {
    this.pollBackoffMs = intervalMs;
  }

  currentPollBackoffMs(): number {
    return this.pollBackoffMs;
  }

  /**
   * Instruments worth a day-OHLC refresh: indices first, then recently viewed.
   *
   * Unlike `pollTokens`, this set does not shrink when the websocket is healthy —
   * the LTP endpoint carries none of these fields, so even a perfectly streaming
   * instrument needs this slower request to fill the day open/high/low and option
   * open interest the tiles and gates read.
   */
  ohlcTokens(max: number): string[] {
    const cutoff = Date.now() - INDIA_INTEREST_TTL_MS;
    for (const [token, at] of this.interest) if (at < cutoff) this.interest.delete(token);

    const out: string[] = [];
    const seen = new Set<string>();
    const push = (token: string): void => {
      if (seen.has(token)) return;
      seen.add(token);
      out.push(token);
    };
    for (const i of this.instruments.primaryIndexInstruments()) push(i.instrumentToken);
    const recent = [...this.interest.entries()].sort((a, b) => b[1] - a[1]);
    for (const [token] of recent) push(token);

    return out.slice(0, Math.max(1, max));
  }

  /**
   * One batched OHLC request over the watched set, re-ingested as full ticks.
   *
   * The LTP endpoint answers "what is the price" and nothing else; this answers
   * "what kind of day has it been" — day open/high/low and open interest — which
   * the index tiles, range gates and option analytics all read. Volume is left
   * null on purpose: the field here is cumulative day volume, and feeding it to
   * the candle engine's `volume +=` would compound the whole day into every bar.
   */
  async enrichOhlc(): Promise<number> {
    if (!this.started) return 0;
    const tokens = this.ohlcTokens(indiaConfig.ltpPollMax);
    if (!tokens.length) return 0;
    const rows = await this.adapter.getOhlcBatch(tokens);
    let count = 0;
    for (const r of rows) {
      if (!Number.isFinite(r.ltp) || r.ltp <= 0) continue;
      const instr = this.instruments.getByToken(r.instrumentToken);
      const prev = this.lastTicks.get(r.instrumentToken);
      const now = Date.now();
      this.onTick({
        exchange: instr?.exchange ?? prev?.exchange ?? 'NSE',
        segment: instr?.segment ?? prev?.segment ?? 'NSE_INDEX',
        instrumentToken: r.instrumentToken,
        tradingSymbol: instr?.tradingSymbol ?? prev?.tradingSymbol ?? r.instrumentToken,
        underlying: instr?.underlying ?? prev?.underlying ?? '',
        marketTimestamp: now,
        receivedAt: now,
        timestamp: now,
        ltp: r.ltp,
        bid: prev?.bid ?? null,
        ask: prev?.ask ?? null,
        bidQuantity: prev?.bidQuantity ?? null,
        askQuantity: prev?.askQuantity ?? null,
        volume: null,
        openInterest: r.oi ?? prev?.openInterest ?? null,
        dayOpen: r.open,
        dayHigh: r.high,
        dayLow: r.low,
        previousClose: prev?.previousClose ?? null,
        lastTradeQuantity: null,
        source: `${this.adapter.name}-OHLC`,
        tradable: true,
      });
      count += 1;
    }
    return count;
  }

  private onTick(raw: IndiaTick): void {
    const validation = validateIndiaTick(raw);
    if (!validation.ok) {
      this.health.onDroppedMessages(1);
      return;
    }
    const tick = normalizeIndiaTick(raw);
    if (!this.sequencer.accept(tick)) {
      this.health.onDroppedMessages(1);
      return;
    }
    this.tickCount += 1;
    if (typeof tick.source === 'string' && tick.source.endsWith('-WS')) this.lastWsTickAt = Date.now();
    this.lastTicks.set(tick.instrumentToken, tick);
    this.health.onTick(tick.instrumentToken);
    this.candles.onTick(tick);
    this.cache
      .set(INDIA_REDIS_KEYS.tick + tick.instrumentToken, JSON.stringify(tick), indiaConfig.tickCacheTtlMs)
      .catch(() => undefined);
    this.events.emit(INDIA_CHANNELS.tick, tick);
  }

  stats(): { ticks: number; dropped: number } {
    return { ticks: this.tickCount, dropped: this.sequencer.dropped };
  }

  /** Whether the live websocket is currently carrying this instrument. */
  isSubscribed(instrumentToken: string): boolean {
    return this.subscribed.has(instrumentToken);
  }

  async stop(): Promise<void> {
    this.started = false;
    // Drop the tick book: after a restart these would be pre-restart prices with
    // no indication of their age at the call site.
    this.lastTicks.clear();
    // And the subscription book with it — the socket is about to close, so every entry
    // here is about to become a claim that an instrument is live when it is not.
    this.subscribed.clear();
    // Interest is about which charts are open in a browser, and after a restart the
    // answer is "none until someone asks again". Poll bookkeeping goes with it: the
    // next session must start from "never asked", not from stale timestamps that
    // would suppress the first poll round.
    this.interest.clear();
    this.lastPolledAt.clear();
    this.lastWsTickAt = null;
    if (this.intradayRefreshTimer) {
      clearInterval(this.intradayRefreshTimer);
      this.intradayRefreshTimer = null;
    }
    try {
      await this.adapter.disconnect();
    } catch {
      /* ignore */
    }
  }

  /** Periodic refresh of intraday candles for primary indices during market hours.
   *  Keeps today's candles up-to-date with minimal API calls. */
  private intradayRefreshTimer: ReturnType<typeof setInterval> | null = null;

  private startIntradayRefresh(): void {
    // Refresh every 5 minutes during market hours.
    this.intradayRefreshTimer = setInterval(async () => {
      // Holiday-aware, and boundary-identical to `session.snapshot()`, because it is the
      // same function. This test used to be hand-rolled from the shared minute constants:
      // correct on weekdays, but it had no notion of the exchange calendar, so it woke
      // every five minutes through Saturday, Sunday and every holiday, spending the
      // broker's rate-limit budget on a shut market and re-seeding buffers from an
      // endpoint that returns nothing. It also ran one minute long, treating 15:30 exactly
      // as in-session where `session.ts` treats it as closed — the kind of drift that two
      // copies of one rule always eventually produce.
      if (!this.session.isTradingTime(Date.now())) return;

      const primaryTokens = this.instruments.primaryIndexInstruments().map(i => i.instrumentToken);
      const primaryTf: IndiaTimeframe = indiaConfig.primaryTimeframe as IndiaTimeframe;
      
      for (const token of primaryTokens) {
        try {
          const intraday = await this.adapter.getIntradayCandles(token, primaryTf);
          if (intraday.length) {
            const existing = this.candles.getCandles(token, primaryTf, INDIA_CANDLE_BUFFER_MAX);
            const merged = new Map<string, IndiaCandle>();
            for (const c of [...existing, ...intraday]) merged.set(c.id, c);
            const sorted = [...merged.values()].sort((a, b) => a.openTime - b.openTime);
            await this.candles.seed(token, primaryTf, sorted);
          }
          await new Promise(r => setTimeout(r, 1000)); // rate limit
        } catch { /* non-fatal */ }
      }
    }, 5 * 60 * 1000); // 5 minutes
  }
}