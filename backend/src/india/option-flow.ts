/**
 * IndiaOptionFlowEngine (spec §18, option-chain analytics).
 *
 * Computes OI analytics — Put/Call ratio, Max Pain, and OI change — from the
 * REAL Open Interest already flowing through the tick feed (the `ltpc` mode
 * carries OI per contract). No external service is used; the data is the same
 * broker feed the rest of the India subsystem consumes.
 *
 * The signal engine consumes the posture/confirmation so option flow can
 * confirm or veto a directional signal (soft confirmation, never a hard block).
 */
import type {
  IndiaInstrument,
  IndiaOptionFlowSnapshot,
  IndiaOptionStrikeFlow,
  IndiaTimeframe,
} from '@fx/shared';
import { INDIA_CHANNELS, INDIA_COLLECTIONS, INDIA_REDIS_KEYS } from '@fx/shared';
import { DataStore } from '../db/store';
import { Cache } from '../db/cache';
import { EventEmitter } from 'events';
import { IndiaInstrumentService } from './instruments';
import { IndiaCandleEngine } from './candle-engine';
import { expiryInstant } from './options-math';
import { indiaConfig } from './config';

export interface IndiaOptionFlowEngineOptions {
  store: DataStore;
  cache: Cache;
  events: EventEmitter;
  instruments: IndiaInstrumentService;
  candles: IndiaCandleEngine;
  primaryTimeframe?: IndiaTimeframe;
}

/** Lookback (in candles) used for OI-change comparisons. */
const OI_LOOKBACK = 10;

export class IndiaOptionFlowEngine {
  private static CACHE_TTL_MS = 5000;
  private recent = new Map<string, IndiaOptionFlowSnapshot>();

  constructor(private opts: IndiaOptionFlowEngineOptions) {}

  /** Latest computed snapshot for an underlying/expiry (sync, slightly stale).
   *  Kept fresh by the periodic snapshotAll() refresh in the module timer. */
  cached(underlying: string, expiry: number | null): IndiaOptionFlowSnapshot | null {
    const key = `${underlying.toUpperCase()}:${expiry ?? 'nearest'}`;
    const entry = this.recent.get(key);
    if (!entry) return null;
    // Honor the TTL: the old fallback returned the SAME stale entry from the
    // same map, so the freshness check had no effect at all.
    if (Date.now() - entry.timestamp > IndiaOptionFlowEngine.CACHE_TTL_MS * 3) return null;
    return entry;
  }

  /** Latest OI for a contract, and its value `lookback` candles ago. */
  private oiSeries(token: string, tf: IndiaTimeframe): { latest: number; prev: number } | null {
    const candles = this.opts.candles.getCandles(token, tf, OI_LOOKBACK + 1);
    if (candles.length === 0) return null;
    const latest = candles[candles.length - 1].openInterest ?? 0;
    const prev = candles.length > OI_LOOKBACK ? candles[candles.length - 1 - OI_LOOKBACK].openInterest ?? 0 : latest;
    return { latest, prev };
  }

  private spotFor(underlying: string): number | null {
    const target = underlying.toUpperCase();
    const index = this.opts.instruments
      .executionInstruments()
      .find((i) => i.segment === 'NSE_INDEX' && (i.underlying ?? '').toUpperCase() === target);
    if (!index) return null;
    const candles = this.opts.candles.getCandles(index.instrumentToken, this.opts.primaryTimeframe ?? '5m', 1);
    return candles.length ? candles[candles.length - 1].close : null;
  }

  /** Active expiry for an underlying (nearest future expiry, or the requested one). */
  private expiryFor(underlying: string, requested: number | null): number | null {
    if (requested != null) return requested;
    const now = Date.now();
    const fut = this.opts.instruments.futuresFor(underlying);
    if (fut.length && fut[0].expiry) return fut[0].expiry;
    // Nearest UNEXPIRED option expiry over ALL contracts of this underlying.
    // The old `optionsFor(underlying, 0)` filtered expiry===0 — no instrument
    // ever matched, so with futures disabled the snapshot aggregated strikes
    // across weekly AND monthly expiries into one PCR/max-pain.
    let best: number | null = null;
    for (const i of this.opts.instruments.all()) {
      if (i.contractType !== 'OPT') continue;
      if ((i.underlying ?? '').toUpperCase() !== underlying.toUpperCase()) continue;
      if (!i.expiry || expiryInstant(i.expiry) <= now) continue;
      if (best === null || i.expiry < best) best = i.expiry;
    }
    return best;
  }

  /** Classic max pain: the strike minimizing total writer payout at expiry. */
  private computeMaxPain(strikes: IndiaInstrument[]): { strike: number | null; best: string } {
    if (strikes.length === 0) return { strike: null, best: 'no strikes' };
    const oiBy = new Map<string, { call: number; put: number }>();
    for (const s of strikes) {
      const k = s.strike ?? 0;
      const entry = oiBy.get(String(k)) ?? { call: 0, put: 0 };
      if (s.optionType === 'CE') entry.call += this.opts.candles.getCandles(s.instrumentToken, this.opts.primaryTimeframe ?? '5m', 1)[0]?.openInterest ?? 0;
      if (s.optionType === 'PE') entry.put += this.opts.candles.getCandles(s.instrumentToken, this.opts.primaryTimeframe ?? '5m', 1)[0]?.openInterest ?? 0;
      oiBy.set(String(k), entry);
    }
    const keys = [...oiBy.keys()].map(Number).sort((a, b) => a - b);
    if (keys.length === 0) return { strike: null, best: 'no oi data' };
    // Writer-loss minimization: loss at candidate expiry price K =
    // sum over strikes of [callOI * max(K-C,0) + putOI * max(P-K,0)].
    // Max pain = K minimizing that total payout. Independent of live spot.
    let minLoss = Infinity, bestK = keys[0];
    for (const k of keys) {
      let loss = 0;
      for (const kk of keys) {
        const c = oiBy.get(String(kk))!;
        loss += c.call * Math.max(k - kk, 0) + c.put * Math.max(kk - k, 0);
      }
      if (loss < minLoss) {
        minLoss = loss;
        bestK = k;
      }
    }
    return { strike: bestK, best: 'writer-loss minimization' };
  }

  private posture(pcr: number | null, netOiDelta: number): 'BULLISH' | 'BEARISH' | 'NEUTRAL' {
    if (pcr == null) return 'NEUTRAL';
    if (pcr >= 1.25 || (pcr >= 0.8 && netOiDelta < 0)) return 'BULLISH';
    if (pcr <= 0.7 || (pcr <= 1.2 && netOiDelta > 0)) return 'BEARISH';
    return 'NEUTRAL';
  }

  async snapshot(underlying: string, expiry: number | null = null, timeframe?: IndiaTimeframe): Promise<IndiaOptionFlowSnapshot | null> {
    const tf = timeframe ?? this.opts.primaryTimeframe ?? '5m';
    const resolvedExpiry = this.expiryFor(underlying, expiry);
    const options = resolvedExpiry == null
      ? [] // never aggregate strikes across expiries — the PCR/max-pain would be fiction
      : this.opts.instruments.optionsFor(underlying, resolvedExpiry);
    if (options.length === 0) return null;

    const spot = this.spotFor(underlying);
    let histCall = 0, histPut = 0;
    const byStrike = new Map<number, { call: number; put: number; callChange: number; putChange: number; callToken?: string; putToken?: string }>();
    for (const o of options) {
      const k = o.strike ?? 0;
      const entry = byStrike.get(k) ?? { call: 0, put: 0, callChange: 0, putChange: 0 };
      const series = this.oiSeries(o.instrumentToken, tf);
      const oi = series?.latest ?? 0;
      const prev = series?.prev ?? oi;
      if (o.optionType === 'CE') {
        entry.call = oi;
        entry.callChange = oi - prev;
        entry.callToken = o.instrumentToken;
        histCall += prev;
      } else {
        entry.put = oi;
        entry.putChange = oi - prev;
        entry.putToken = o.instrumentToken;
        histPut += prev;
      }
      byStrike.set(k, entry);
    }

    const strikes: IndiaOptionStrikeFlow[] = [];
    let totalCall = 0, totalPut = 0, callChange = 0, putChange = 0;
    for (const [k, e] of byStrike) {
      totalCall += e.call;
      totalPut += e.put;
      callChange += e.callChange;
      putChange += e.putChange;
    }
    const pcr = totalCall > 0 ? totalPut / totalCall : null;
    const histPcr = histCall > 0 ? histPut / histCall : pcr;
    const pcrChange = pcr != null && histPcr != null ? pcr - histPcr : 0;
    const maxPain = this.computeMaxPain(options);
    for (const [k, e] of byStrike) {
      strikes.push({
        strike: k,
        callOI: e.call,
        putOI: e.put,
        totalOI: e.call + e.put,
        callOIChange: e.callChange,
        putOIChange: e.putChange,
        totalOIChange: e.callChange + e.putChange,
        maxPainCandidate: maxPain.strike === k,
      });
    }
    strikes.sort((a, b) => a.strike - b.strike);

    const netOiDelta = putChange - callChange;
    const snap: IndiaOptionFlowSnapshot = {
      underlying: underlying.toUpperCase(),
      expiry: resolvedExpiry,
      spotPrice: spot,
      totalCallOI: totalCall,
      totalPutOI: totalPut,
      pcr,
      pcrChange: 0,
      maxPain: maxPain.strike,
      callOIChange: callChange,
      putOIChange: putChange,
      netOiDelta,
      strikes,
      posture: this.posture(pcr, netOiDelta),
      timestamp: Date.now(),
    };
    snap.pcrChange = pcrChange;
    const snapKey = `${snap.underlying}:${snap.expiry ?? 'nearest'}`;
    this.recent.set(snapKey, snap);
    // Also keep 'nearest' alias when snapshot was requested as nearest (expiry param null)
    // so cached(null) hits the freshest resolved expiry — tests and UI both use that.
    if (expiry == null && snap.expiry != null) this.recent.set(`${snap.underlying}:nearest`, snap);
    await this.persist(snap, expiry == null);
    this.opts.events.emit(INDIA_CHANNELS.optionFlow, snap);
    return snap;
  }

  private async persist(snap: IndiaOptionFlowSnapshot, alsoNearest = false): Promise<void> {
    try {
      await this.opts.store.insertOne(INDIA_COLLECTIONS.optionFlow, snap);
      const key = `${snap.underlying}:${snap.expiry ?? 'nearest'}`;
      await this.opts.cache.set(
        INDIA_REDIS_KEYS.optionFlow + key,
        JSON.stringify(snap),
        15_000,
      );
      if (alsoNearest && snap.expiry != null) {
        await this.opts.cache.set(
          INDIA_REDIS_KEYS.optionFlow + `${snap.underlying}:nearest`,
          JSON.stringify(snap),
          15_000,
        );
      }
    } catch {
      /* best-effort */
    }
  }

  async snapshotAll(): Promise<IndiaOptionFlowSnapshot[]> {
    const underlyings = this.opts.instruments.underlyings().filter((u) => u.length > 0);
    const out: IndiaOptionFlowSnapshot[] = [];
    for (const u of underlyings) {
      const snap = await this.snapshot(u, null);
      if (snap) out.push(snap);
    }
    return out;
  }
}

export const indiaOptionFlowPostures = ['BULLISH', 'BEARISH', 'NEUTRAL'] as const;
export const _unused = 0;