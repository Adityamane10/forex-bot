/**
 * Option analytics engine for NIFTY / BANKNIFTY / FINNIFTY / MIDCPNIFTY.
 *
 * This file used to contain the analytics themselves, and none of them worked.
 * It declared its own flat `OptionChainData` (`{ strike, callOI, callLTP, ... }`)
 * while every broker adapter returns a nested one (`{ strikePrice, call: {...},
 * put: {...} }`), and bridged the two with `await (this.adapter as any)
 * .getOptionChain(...)`. The cast silenced the compiler, so at runtime every
 * field read `undefined`: PCR was NaN, max pain degenerated, ATM compared NaN
 * against NaN. It also scored a high put-call ratio as *bearish* — the inverse
 * of standard Indian practice and the inverse of what `option-flow.ts` and the
 * UI both assume — and filled neutral confidence with `Math.random()`, which
 * made every run unreproducible.
 *
 * So the maths moved to `option-chain.ts`, written against the real broker type
 * with no casts, and this file is now only what an engine should be: fetch,
 * cache, fall back, persist, emit. The public surface is unchanged on purpose —
 * `routes.ts` and the React panel keep working, and the panel finally receives
 * the fields it has always declared but never been sent.
 *
 * Two feed qualities are supported and are reported distinctly:
 *   - BROKER_CHAIN — the full chain (premium, volume, bid/ask), so IV, greeks,
 *     spreads and every PCR variant are available.
 *   - OI_ONLY — open interest from the tick feed via `option-flow.ts`, used when
 *     the chain endpoint is unavailable (Zerodha has not implemented it; Upstox
 *     needs a live token). PCR by OI, max pain and OI levels still work; IV and
 *     spreads are absent by construction, not by failure.
 *
 * A consumer that cannot tell "neutral" from "no data" will eventually trade on
 * the difference, which is why `dataQuality` exists and why nothing here reports
 * zero in place of unknown.
 */
import { logger } from '../core/logger';
import type { IndiaOptionFlowSnapshot } from '@fx/shared';
import { INDIA_CHANNELS, INDIA_COLLECTIONS, INDIA_REDIS_KEYS } from '@fx/shared';
import type { EventEmitter } from 'events';
import type { IndiaBrokerAdapter, OptionChainData, OptionStrikeData } from './brokers/types';
import type { DataStore } from '../db/store';
import type { Cache } from '../db/cache';
import type { IndiaOptionFlowEngine } from './option-flow';
import {
  OptionChainTracker,
  analyseChain,
  enrichedLadder,
  type ChainAnalysisOptions,
  type EnrichedStrike,
  type IndiaOptionAnalytics,
} from './option-chain';

export type { EnrichedStrike, IndiaOptionAnalytics } from './option-chain';

/** Previous name for the analytics payload. Kept so older imports still compile. */
export type OptionAnalytics = IndiaOptionAnalytics;

export interface OptionAnalyticsDeps {
  /** Emitted on `INDIA_CHANNELS.optionAnalytics` so the socket layer can fan out. */
  events?: EventEmitter;
  cache?: Cache;
  /** OI-only fallback source when the broker chain endpoint is unavailable. */
  optionFlow?: IndiaOptionFlowEngine;
}

/** Recompute at most this often per underlying. The chain endpoint is rate
 *  limited and the numbers do not move meaningfully inside a few seconds. */
const ANALYTICS_TTL_MS = 5_000;

/** Persist at most this often per underlying. The point of persistence is a
 *  daily IV series, not a tick archive. */
const PERSIST_INTERVAL_MS = 60_000;

/** How much persisted history to replay into the IV window on startup. */
const WARM_LIMIT = 800;

const EMPTY_LEG = {
  instrumentToken: '',
  tradingSymbol: '',
  ltp: null,
  volume: null,
  iv: null,
  bid: null,
  ask: null,
} as const;

export class OptionAnalyticsEngine {
  private tracker = new OptionChainTracker();
  private recent = new Map<string, IndiaOptionAnalytics>();
  private inFlight = new Map<string, Promise<IndiaOptionAnalytics | null>>();
  private lastPersist = new Map<string, number>();
  private warmed = new Set<string>();

  constructor(
    private adapter: IndiaBrokerAdapter,
    private store: DataStore,
    private deps: OptionAnalyticsDeps = {},
  ) {}

  /** Attach the OI-only fallback after construction, for wiring order reasons. */
  useOptionFlow(engine: IndiaOptionFlowEngine): void {
    this.deps.optionFlow = engine;
  }

  /**
   * Last computed analytics, synchronously.
   *
   * The signal engine runs inside a tick handler and cannot await a REST call,
   * so it reads this. Returns whatever was last computed regardless of age —
   * `timestamp` is on the payload, and a caller that cares about staleness is
   * better placed to decide the tolerance than this method is.
   */
  cached(underlying: string): IndiaOptionAnalytics | null {
    return this.recent.get(underlying.toUpperCase()) ?? null;
  }

  /**
   * Analytics for one underlying, from the broker chain if it is available and
   * from open interest alone if it is not.
   *
   * Concurrent callers share one computation: the route handler, the periodic
   * refresh and the socket fan-out all ask for the same underlying, and three
   * simultaneous chain fetches would only earn a rate-limit rejection.
   */
  async analyze(underlying: string): Promise<IndiaOptionAnalytics | null> {
    const key = underlying.toUpperCase();
    const cached = this.recent.get(key);
    if (cached && Date.now() - cached.timestamp < ANALYTICS_TTL_MS) return cached;

    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const job = this.compute(key).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, job);
    return job;
  }

  private async compute(underlying: string): Promise<IndiaOptionAnalytics | null> {
    // Warm once per underlying, not once per process: the IV window is keyed by
    // underlying, so warming only whichever one happened to be asked for first
    // would leave the others with no history at all.
    if (!this.warmed.has(underlying)) {
      this.warmed.add(underlying);
      await this.warmIvHistory(underlying);
    }

    const now = Date.now();
    const opts: ChainAnalysisOptions = { now };

    try {
      const chain = await this.fetchChain(underlying);
      if (chain) {
        const analytics = analyseChain(chain, this.tracker, opts);
        return this.publish(analytics);
      }

      const fallback = await this.fromOptionFlow(underlying, now);
      if (fallback) return this.publish(fallback);

      logger.warn('option-analytics: no chain and no OI fallback', { underlying });
      return null;
    } catch (err) {
      logger.error('option-analytics: analysis failed', { underlying, err: String(err) });
      return null;
    }
  }

  /**
   * The broker chain, or null.
   *
   * `getOptionChain` is on `IndiaBrokerAdapter`, so no cast is needed and a
   * shape change would now be a compile error rather than a silent NaN. Both
   * adapters return null when they cannot serve it — Zerodha always, Upstox
   * without a session — and that is a normal state, not an error.
   */
  private async fetchChain(underlying: string): Promise<OptionChainData | null> {
    try {
      const chain = await this.adapter.getOptionChain(underlying);
      if (!chain || chain.strikes.length === 0) return null;
      return chain;
    } catch (err) {
      logger.warn('option-analytics: chain fetch failed, will try OI fallback', {
        underlying,
        err: String(err),
      });
      return null;
    }
  }

  /**
   * Build analytics from open interest alone.
   *
   * `option-flow.ts` already reconstructs per-strike OI from the tick feed, so
   * the fallback is a shape translation rather than a second implementation:
   * the flow snapshot is projected onto the broker chain type with the missing
   * quote fields left null, then run through the same `analyseChain`. One code
   * path means the two feeds cannot drift apart in their conclusions.
   *
   * The tracker is deliberately not passed here. The flow snapshot carries its
   * own OI change over a candle lookback, which is a truer reading than a
   * session baseline assembled from a degraded feed, and `enrichChain` keeps a
   * feed-supplied change in preference to none.
   */
  private async fromOptionFlow(underlying: string, now: number): Promise<IndiaOptionAnalytics | null> {
    const flow = this.deps.optionFlow;
    if (!flow) return null;

    const snap = flow.cached(underlying, null) ?? (await flow.snapshot(underlying, null));
    if (!snap) return null;

    const chain = this.chainFromFlow(snap);
    if (!chain) return null;

    return analyseChain(chain, null, { now, source: 'OI_ONLY' });
  }

  private chainFromFlow(snap: IndiaOptionFlowSnapshot): OptionChainData | null {
    if (snap.strikes.length === 0) return null;
    // Expiry may be unknown; 0 makes `singleExpiry` treat the ladder as a single
    // untagged expiry and report DTE as null rather than as a date in 1970.
    const expiryDate = snap.expiry ?? 0;
    const strikes: OptionStrikeData[] = snap.strikes.map((s) => ({
      strikePrice: s.strike,
      expiryDate,
      call: { ...EMPTY_LEG, oi: s.callOI, oiChange: s.callOIChange },
      put: { ...EMPTY_LEG, oi: s.putOI, oiChange: s.putOIChange },
    }));
    return {
      underlying: snap.underlying,
      spotPrice: snap.spotPrice,
      timestamp: snap.timestamp,
      strikes,
    };
  }

  /**
   * Summary analytics and the strike ladder from one fetch.
   *
   * The chain view needs both, and fetching twice would double the load on a
   * rate-limited endpoint and — worse — could show a ladder built from a later
   * snapshot than the max pain drawn on top of it. One fetch, one moment in time.
   */
  async chainView(underlying: string): Promise<{
    analytics: IndiaOptionAnalytics | null;
    strikes: EnrichedStrike[];
  }> {
    const key = underlying.toUpperCase();
    const now = Date.now();

    try {
      const chain = await this.fetchChain(key);
      if (chain) {
        const analytics = this.publish(analyseChain(chain, this.tracker, { now }));
        // `enrichedLadder` re-reads the same baseline the analytics just used, so
        // the two are computed against identical inputs.
        return { analytics, strikes: enrichedLadder(chain, this.tracker, { now }) };
      }

      const flow = this.deps.optionFlow;
      const snap = flow ? (flow.cached(key, null) ?? (await flow.snapshot(key, null))) : null;
      const fromFlow = snap ? this.chainFromFlow(snap) : null;
      if (!fromFlow) return { analytics: null, strikes: [] };

      const opts: ChainAnalysisOptions = { now, source: 'OI_ONLY' };
      return {
        analytics: this.publish(analyseChain(fromFlow, null, opts)),
        strikes: enrichedLadder(fromFlow, null, opts),
      };
    } catch (err) {
      logger.error('option-analytics: chain view failed', { underlying: key, err: String(err) });
      return { analytics: null, strikes: [] };
    }
  }

  private publish(analytics: IndiaOptionAnalytics): IndiaOptionAnalytics {
    this.recent.set(analytics.underlying, analytics);
    this.deps.events?.emit(INDIA_CHANNELS.optionAnalytics, analytics);
    void this.persist(analytics);

    logger.info('option-analytics: computed', {
      underlying: analytics.underlying,
      source: analytics.dataQuality.source,
      pcr: analytics.pcr.byOI.toFixed(2),
      maxPain: analytics.maxPain.strike,
      sentiment: analytics.sentiment.signal,
      atmIv: analytics.ivAnalysis.atmIV != null ? (analytics.ivAnalysis.atmIV * 100).toFixed(1) : null,
      dte: analytics.daysToExpiry,
      strikesWithIv: analytics.dataQuality.strikesWithIv,
    });
    return analytics;
  }

  private async persist(analytics: IndiaOptionAnalytics): Promise<void> {
    try {
      await this.deps.cache?.set(
        INDIA_REDIS_KEYS.optionAnalytics + analytics.underlying,
        JSON.stringify(analytics),
        15_000,
      );

      // Only ATM IV needs a long history, and one sample a minute is plenty for
      // a daily series. Writing every recomputation would grow the collection
      // by ~17k documents a session per underlying for no extra information.
      const last = this.lastPersist.get(analytics.underlying) ?? 0;
      if (analytics.ivAnalysis.atmIV == null) return;
      if (analytics.timestamp - last < PERSIST_INTERVAL_MS) return;
      this.lastPersist.set(analytics.underlying, analytics.timestamp);
      await this.store.insertOne(INDIA_COLLECTIONS.optionAnalytics, analytics);
    } catch {
      /* best-effort: analytics are derived data and can always be recomputed */
    }
  }

  /**
   * Replay persisted ATM IV into the tracker so the IV percentile survives a
   * restart. Without this the percentile window would begin empty every deploy
   * and IV rank would never clear its 20-day honesty threshold.
   */
  private async warmIvHistory(underlying: string): Promise<void> {
    try {
      const docs = await this.store.find<IndiaOptionAnalytics>(
        INDIA_COLLECTIONS.optionAnalytics,
        { underlying },
        { timestamp: -1 },
        WARM_LIMIT,
      );
      const samples = docs
        .filter((d) => d?.ivAnalysis?.atmIV != null && typeof d.timestamp === 'number')
        .map((d) => ({ at: d.timestamp, atmIv: d.ivAnalysis.atmIV as number }));
      if (samples.length === 0) return;
      this.tracker.seedAtmIv(underlying, samples);
      logger.info('option-analytics: warmed IV history', { underlying, samples: samples.length });
    } catch (err) {
      logger.warn('option-analytics: IV warm-up skipped', { underlying, err: String(err) });
    }
  }

  /**
   * Analytics for every underlying the desk trades.
   *
   * The old version hardcoded three underlyings and then cast the result to
   * `Record<IndiaUnderlying, ...>`, which was a lie once MIDCPNIFTY joined the
   * union — the key was simply absent. Keyed by string and returned as a partial
   * map, so a missing underlying is visibly missing.
   */
  async analyzeAll(underlyings?: readonly string[]): Promise<Record<string, IndiaOptionAnalytics | null>> {
    const list = underlyings ?? ['NIFTY', 'BANKNIFTY', 'FINNIFTY'];
    const results: Record<string, IndiaOptionAnalytics | null> = {};
    await Promise.all(
      list.map(async (u) => {
        results[u.toUpperCase()] = await this.analyze(u);
      }),
    );
    return results;
  }
}
