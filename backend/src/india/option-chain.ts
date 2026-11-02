/**
 * Option-chain analytics for the Indian index derivatives desk.
 *
 * This module owns every calculation that reads a broker option chain: implied
 * volatility, greeks, PCR, max pain, ATM, OI activity, OI-derived levels and
 * per-strike liquidity. It replaced the internals of `option-analytics.ts`,
 * which had never produced a real number — that engine declared its own flat
 * `OptionChainData` while the broker returns a nested one, and bridged the two
 * with `as any`, so every field arrived `undefined` and every ratio came out
 * NaN.
 *
 * Three rules this module holds to, because breaking them is what went wrong
 * before:
 *
 *   1. Work on the real broker shape (`OptionStrikeData`, nested call/put) and
 *      never cast it. If the shape is wrong the compiler should say so.
 *   2. No randomness. Confidence is derived from the data or it is not reported.
 *      The previous engine used `Math.random()` for neutral confidence, which
 *      made every run unreproducible and every backtest meaningless.
 *   3. A high PCR reads BULLISH. Put writers dominating is support, which is the
 *      standard Indian market reading, the one `option-flow.ts` uses, and the
 *      one the UI already colours for. The old engine had it exactly inverted.
 *
 * Unknowns are reported as `null`, never as `0`. A zero IV and an unknown IV
 * lead to opposite trading decisions.
 */
import type { OptionChainData, OptionStrikeData } from './brokers/types';
import type {
  IndiaEnrichedStrike,
  IndiaOptionAnalytics,
  IndiaOptionSentiment,
  IndiaStrikeSignificance,
} from '@fx/shared';
import {
  DEFAULT_RISK_FREE_RATE,
  daysToExpiry,
  expectedMove,
  expiryInstant,
  greeks,
  impliedVolatility,
  minutesToExpiry,
  yearsToExpiry,
  type OptionGreeks,
} from './options-math';

// ---------------------------------------------------------------------------
// Output shape
//
// The payload types live in `@fx/shared` so the backend and the React panel read
// one definition. Re-exported under their original local names because this
// module's callers already import them from here, and aliasing costs nothing.
// ---------------------------------------------------------------------------

export type OptionSentiment = IndiaOptionSentiment;
export type StrikeSignificance = IndiaStrikeSignificance;
export type EnrichedStrike = IndiaEnrichedStrike;
export type { IndiaOptionAnalytics };

/** The part of a leg this module derives rather than receives. Structurally the
 *  extra fields on `IndiaOptionLeg` beyond the broker's own quote. */
export interface LegAnalytics {
  /** Implied volatility as a DECIMAL (0.145 = 14.5%), or null if unsolvable. */
  iv: number | null;
  greeks: OptionGreeks | null;
  /** Bid-ask spread as a fraction of premium — the real cost of being wrong. */
  spreadPct: number | null;
}

export interface ChainAnalysisOptions {
  rate?: number;
  now?: number;
  /** Reject a strike as untradable above this bid-ask fraction of premium. */
  maxSpreadPct?: number;
  /** Reject a strike as untradable below this open interest. */
  minOpenInterest?: number;
  /**
   * What kind of feed produced this chain, reported verbatim in `dataQuality`.
   * `OI_ONLY` means open interest is real but premium, volume and quotes are
   * absent, so IV, greeks and spreads are unavailable by construction rather
   * than by failure. A consumer must be able to tell those two apart.
   */
  source?: 'BROKER_CHAIN' | 'OI_ONLY';
}

const DEFAULT_MAX_SPREAD_PCT = 0.05;
const DEFAULT_MIN_OI = 1000;

// ---------------------------------------------------------------------------
// Session baseline tracking (real OI change, real IV history)
// ---------------------------------------------------------------------------

interface Baseline {
  /** First observation of the session, keyed by strike. */
  strikes: Map<number, { callOI: number; putOI: number; callLtp: number | null; putLtp: number | null }>;
  spot: number | null;
  capturedAt: number;
}

interface IvSample {
  at: number;
  atmIv: number;
}

/**
 * Holds what a single chain snapshot cannot know: what changed since the
 * session opened, and where today's volatility sits against its own history.
 *
 * The broker sets `oiChange: null` on every leg (`upstox-market-data.ts:667`
 * — "Calculate from historical snapshots"), so OI change has to be derived
 * here or not at all. The previous engine kept a history map but never read it,
 * and then compared absolute contract counts against a `0.1` threshold
 * commented "10% OI change" — so every strike tripped every rule.
 */
export class OptionChainTracker {
  private baselines = new Map<string, Baseline>();
  private ivIntraday = new Map<string, IvSample[]>();
  private ivDaily = new Map<string, Map<string, number>>();

  private static MAX_INTRADAY = 2000;
  private static MAX_DAYS = 400;

  private key(underlying: string, expiry: number | null): string {
    return `${underlying.toUpperCase()}:${expiry ?? 'nearest'}`;
  }

  /** IST calendar day, used to bucket one IV close per trading day. */
  private static dayKey(at: number): string {
    const ist = new Date(at + 5.5 * 3600_000);
    return `${ist.getUTCFullYear()}-${ist.getUTCMonth() + 1}-${ist.getUTCDate()}`;
  }

  /** Capture the first snapshot of a session as the OI baseline. Later calls in
   *  the same session are ignored; a new IST day resets it. */
  captureBaseline(
    underlying: string,
    strikes: OptionStrikeData[],
    spot: number | null,
    expiry: number | null,
    now: number,
  ): Baseline {
    const k = this.key(underlying, expiry);
    const existing = this.baselines.get(k);
    if (existing && OptionChainTracker.dayKey(existing.capturedAt) === OptionChainTracker.dayKey(now)) {
      return existing;
    }
    const map = new Map<number, { callOI: number; putOI: number; callLtp: number | null; putLtp: number | null }>();
    for (const s of strikes) {
      map.set(s.strikePrice, {
        callOI: s.call.oi ?? 0,
        putOI: s.put.oi ?? 0,
        callLtp: s.call.ltp,
        putLtp: s.put.ltp,
      });
    }
    const fresh: Baseline = { strikes: map, spot, capturedAt: now };
    this.baselines.set(k, fresh);
    return fresh;
  }

  baseline(underlying: string, expiry: number | null): Baseline | null {
    return this.baselines.get(this.key(underlying, expiry)) ?? null;
  }

  recordAtmIv(underlying: string, atmIv: number, now: number): void {
    const k = underlying.toUpperCase();
    const series = this.ivIntraday.get(k) ?? [];
    series.push({ at: now, atmIv });
    if (series.length > OptionChainTracker.MAX_INTRADAY) series.shift();
    this.ivIntraday.set(k, series);

    const days = this.ivDaily.get(k) ?? new Map<string, number>();
    days.set(OptionChainTracker.dayKey(now), atmIv);
    if (days.size > OptionChainTracker.MAX_DAYS) {
      const oldest = days.keys().next();
      if (!oldest.done) days.delete(oldest.value);
    }
    this.ivDaily.set(k, days);
  }

  /**
   * Restore an IV history from persisted snapshots.
   *
   * Samples are bucketed by IST day, so replaying them out of order would keep
   * whichever arrived last as that day's close. Sorting first makes the restored
   * series deterministic and matches what live recording would have produced.
   * Without this, IV rank would restart with zero history on every deploy and
   * would never reach its 20-day threshold on a machine that restarts daily.
   */
  seedAtmIv(underlying: string, samples: Array<{ at: number; atmIv: number }>): void {
    const ordered = [...samples]
      .filter((s) => Number.isFinite(s.at) && Number.isFinite(s.atmIv) && s.atmIv > 0)
      .sort((a, b) => a.at - b.at);
    for (const s of ordered) this.recordAtmIv(underlying, s.atmIv, s.at);
  }

  /**
   * Where the current ATM IV sits in its own history.
   *
   * A true IV rank wants a year of daily closes, which we cannot conjure — the
   * series only starts when this process first ran. So `percentile` is reported
   * over whatever window exists, `windowDays` says how big that window is, and
   * `rank` stays null until there are at least 20 daily observations. Better a
   * null than a confident number computed from two days of data.
   */
  ivStats(underlying: string, currentAtmIv: number | null): { percentile: number; rank: number | null; windowDays: number } {
    const k = underlying.toUpperCase();
    const days = this.ivDaily.get(k);
    const daily = days ? [...days.values()] : [];
    const windowDays = daily.length;

    if (currentAtmIv == null) return { percentile: 0, rank: null, windowDays };

    const sample = daily.length >= 5 ? daily : (this.ivIntraday.get(k) ?? []).map((s) => s.atmIv);
    if (sample.length < 2) return { percentile: 0, rank: null, windowDays };

    const below = sample.filter((v) => v <= currentAtmIv).length;
    const percentile = (below / sample.length) * 100;

    let rank: number | null = null;
    if (daily.length >= 20) {
      const lo = Math.min(...daily);
      const hi = Math.max(...daily);
      rank = hi > lo ? ((currentAtmIv - lo) / (hi - lo)) * 100 : 50;
    }
    return { percentile, rank, windowDays };
  }
}

// ---------------------------------------------------------------------------
// Enrichment
// ---------------------------------------------------------------------------

/**
 * Restrict a chain to a single expiry, nearest-unexpired by default.
 *
 * Upstox's `/option/chain` returns every strike for every listed expiry in one
 * response and tags each with its own `expiry_date`. Aggregating that as-is
 * would sum weekly and monthly open interest together, which corrupts PCR and
 * puts max pain somewhere between two unrelated ladders. Anything that reads a
 * chain has to pick one expiry first.
 */
export function singleExpiry(chain: OptionChainData, now: number, requested: number | null = null): {
  strikes: OptionStrikeData[];
  expiry: number | null;
} {
  if (chain.strikes.length === 0) return { strikes: [], expiry: null };

  if (requested != null) {
    const exact = chain.strikes.filter((s) => s.expiryDate === requested);
    if (exact.length > 0) return { strikes: exact, expiry: requested };
  }

  const expiries = [...new Set(chain.strikes.map((s) => s.expiryDate))].filter((e) => e > 0);
  if (expiries.length === 0) return { strikes: chain.strikes, expiry: null };

  const future = expiries.filter((e) => expiryInstant(e) > now).sort((a, b) => a - b);
  const chosen = future.length > 0 ? future[0] : expiries.sort((a, b) => b - a)[0];
  return { strikes: chain.strikes.filter((s) => s.expiryDate === chosen), expiry: chosen };
}

function spreadPct(bid: number | null, ask: number | null, ltp: number | null): number | null {
  if (bid == null || ask == null || !(bid > 0) || !(ask > 0) || ask < bid) return null;
  const mid = (bid + ask) / 2;
  const reference = mid > 0 ? mid : ltp;
  if (reference == null || !(reference > 0)) return null;
  return (ask - bid) / reference;
}

/**
 * Solve IV and greeks for both legs of every strike.
 *
 * Uses the bid-ask mid when both sides are quoted and the LTP otherwise: a mid
 * is the fairer input, but an illiquid strike may have no quotes at all while
 * still carrying a last trade.
 */
export function enrichChain(
  strikes: OptionStrikeData[],
  spot: number | null,
  expiry: number | null,
  opts: ChainAnalysisOptions = {},
): EnrichedStrike[] {
  const now = opts.now ?? Date.now();
  const rate = opts.rate ?? DEFAULT_RISK_FREE_RATE;

  return strikes.map((s) => {
    const expiryMs = s.expiryDate || expiry || 0;
    const years = expiryMs > 0 ? yearsToExpiry(expiryMs, now) : 0;

    const solve = (leg: OptionStrikeData['call'], optionType: 'CE' | 'PE'): LegAnalytics => {
      const mid = leg.bid != null && leg.ask != null && leg.bid > 0 && leg.ask > 0 && leg.ask >= leg.bid ? (leg.bid + leg.ask) / 2 : null;
      const premium = mid ?? leg.ltp;
      const sp = spreadPct(leg.bid, leg.ask, leg.ltp);
      if (premium == null || spot == null || years <= 0) return { iv: null, greeks: null, spreadPct: sp };
      const iv = impliedVolatility({
        optionType,
        premium,
        spot,
        strike: s.strikePrice,
        years,
        rate,
      });
      if (iv == null) return { iv: null, greeks: null, spreadPct: sp };
      return {
        iv,
        greeks: greeks({ optionType, spot, strike: s.strikePrice, years, volatility: iv, rate }),
        spreadPct: sp,
      };
    };

    const callAnalytics = solve(s.call, 'CE');
    const putAnalytics = solve(s.put, 'PE');

    return {
      strike: s.strikePrice,
      expiryDate: expiryMs,
      call: { ...s.call, ...callAnalytics },
      put: { ...s.put, ...putAnalytics },
      // Seed from whatever the feed supplied. The broker chain sends null here,
      // so this is normally null and the session baseline fills it in below;
      // the OI-only path does carry a real change and keeps it.
      callOIChange: s.call.oiChange,
      putOIChange: s.put.oiChange,
      callLtpChange: null,
      putLtpChange: null,
    };
  });
}

/** Attach real OI and premium deltas from the session baseline. */
function applyBaseline(strikes: EnrichedStrike[], baseline: Baseline | null): boolean {
  if (!baseline) return false;
  let matched = 0;
  for (const s of strikes) {
    const base = baseline.strikes.get(s.strike);
    if (!base) continue;
    matched += 1;
    s.callOIChange = (s.call.oi ?? 0) - base.callOI;
    s.putOIChange = (s.put.oi ?? 0) - base.putOI;
    s.callLtpChange = s.call.ltp != null && base.callLtp != null ? s.call.ltp - base.callLtp : null;
    s.putLtpChange = s.put.ltp != null && base.putLtp != null ? s.put.ltp - base.putLtp : null;
  }
  return matched > 0;
}

// ---------------------------------------------------------------------------
// Individual measures
// ---------------------------------------------------------------------------

function computePcr(strikes: EnrichedStrike[]): IndiaOptionAnalytics['pcr'] {
  let callOI = 0;
  let putOI = 0;
  let callVol = 0;
  let putVol = 0;
  let callValue = 0;
  let putValue = 0;
  for (const s of strikes) {
    callOI += s.call.oi ?? 0;
    putOI += s.put.oi ?? 0;
    callVol += s.call.volume ?? 0;
    putVol += s.put.volume ?? 0;
    callValue += (s.call.oi ?? 0) * (s.call.ltp ?? 0);
    putValue += (s.put.oi ?? 0) * (s.put.ltp ?? 0);
  }
  return {
    byOI: callOI > 0 ? putOI / callOI : 0,
    byVolume: callVol > 0 ? putVol / callVol : 0,
    byValue: callValue > 0 ? putValue / callValue : 0,
  };
}

/**
 * Classic max pain: the expiry price that minimises total option-writer payout.
 *
 * Confidence is how decisively that strike wins, measured as the gap between
 * the best and second-best candidate relative to the best. A chain where two
 * adjacent strikes are nearly tied has no meaningful pin, and says so.
 */
function computeMaxPain(strikes: EnrichedStrike[], spot: number | null): IndiaOptionAnalytics['maxPain'] {
  if (strikes.length === 0) return { strike: spot ?? 0, totalPain: 0, confidence: 0 };
  const losses: Array<{ strike: number; pain: number }> = [];
  for (const candidate of strikes) {
    let pain = 0;
    for (const s of strikes) {
      if (s.strike < candidate.strike) pain += (s.call.oi ?? 0) * (candidate.strike - s.strike);
      if (s.strike > candidate.strike) pain += (s.put.oi ?? 0) * (s.strike - candidate.strike);
    }
    losses.push({ strike: candidate.strike, pain });
  }
  losses.sort((a, b) => a.pain - b.pain);
  const best = losses[0];
  const runnerUp = losses[1];
  const confidence =
    runnerUp && best.pain > 0 ? Math.min(1, (runnerUp.pain - best.pain) / best.pain) : 0;
  return { strike: best.strike, totalPain: best.pain, confidence };
}

function findAtm(strikes: EnrichedStrike[], spot: number | null): EnrichedStrike | null {
  if (strikes.length === 0) return null;
  if (spot == null) return strikes[Math.floor(strikes.length / 2)];
  let closest = strikes[0];
  let minDiff = Math.abs(strikes[0].strike - spot);
  for (const s of strikes) {
    const diff = Math.abs(s.strike - spot);
    if (diff < minDiff) {
      minDiff = diff;
      closest = s;
    }
  }
  return closest;
}

/**
 * Support from concentrated put OI, resistance from concentrated call OI.
 *
 * Only strikes on the correct side of spot qualify — put OI above spot is not
 * support. Ranked by OI, capped at three each, returned nearest-first so a
 * consumer can take the first as the active level.
 */
function computeOiLevels(strikes: EnrichedStrike[], spot: number | null): IndiaOptionAnalytics['oiLevels'] {
  if (spot == null) return { support: [], resistance: [] };
  const support = strikes
    .filter((s) => s.strike < spot && (s.put.oi ?? 0) > 0)
    .sort((a, b) => (b.put.oi ?? 0) - (a.put.oi ?? 0))
    .slice(0, 3)
    .map((s) => s.strike)
    .sort((a, b) => b - a);
  const resistance = strikes
    .filter((s) => s.strike > spot && (s.call.oi ?? 0) > 0)
    .sort((a, b) => (b.call.oi ?? 0) - (a.call.oi ?? 0))
    .slice(0, 3)
    .map((s) => s.strike)
    .sort((a, b) => a - b);
  return { support, resistance };
}

/**
 * Read OI activity the way it actually has to be read: with price.
 *
 * Rising open interest alone says nothing about direction. Rising OI with a
 * rising premium is fresh buying; rising OI with a falling premium is writing,
 * which is the opposite signal. The previous engine checked `callLTP > 0` —
 * "the option has a price" — and called that a price increase, so its buildup
 * and unwinding labels were arbitrary.
 */
function computeOiActivity(strikes: EnrichedStrike[], hasOiChange: boolean): IndiaOptionAnalytics['oiActivity'] {
  if (!hasOiChange) {
    return {
      type: 'NEUTRAL',
      side: 'MIXED',
      strength: 0,
      description: 'no session baseline yet — OI change unavailable',
    };
  }

  let callOiDelta = 0;
  let putOiDelta = 0;
  let callOiBase = 0;
  let putOiBase = 0;
  let callPremiumUp = 0;
  let putPremiumUp = 0;
  let premiumKnown = 0;

  for (const s of strikes) {
    callOiDelta += s.callOIChange ?? 0;
    putOiDelta += s.putOIChange ?? 0;
    callOiBase += (s.call.oi ?? 0) - (s.callOIChange ?? 0);
    putOiBase += (s.put.oi ?? 0) - (s.putOIChange ?? 0);
    if (s.callLtpChange != null || s.putLtpChange != null) premiumKnown += 1;
    if ((s.callLtpChange ?? 0) > 0) callPremiumUp += 1;
    if ((s.putLtpChange ?? 0) > 0) putPremiumUp += 1;
  }

  const callPct = callOiBase > 0 ? callOiDelta / callOiBase : 0;
  const putPct = putOiBase > 0 ? putOiDelta / putOiBase : 0;
  const dominant = Math.abs(callPct) >= Math.abs(putPct) ? 'CALL' : 'PUT';
  const pct = dominant === 'CALL' ? callPct : putPct;
  const premiumRising = dominant === 'CALL' ? callPremiumUp > strikes.length / 2 : putPremiumUp > strikes.length / 2;

  // 3% of session-open OI is a real shift; below that it is noise.
  if (Math.abs(pct) < 0.03) {
    return {
      type: 'NEUTRAL',
      side: 'MIXED',
      strength: Math.min(1, Math.abs(pct) / 0.03),
      description: `OI flat (calls ${(callPct * 100).toFixed(1)}%, puts ${(putPct * 100).toFixed(1)}%)`,
    };
  }

  const type = pct > 0 ? 'BUILDUP' : 'UNWINDING';
  const strength = Math.min(1, Math.abs(pct) / 0.25);
  const leg = dominant === 'CALL' ? 'call' : 'put';

  // Without premium direction, buildup cannot be told from writing. Say that
  // rather than picking one — the two readings point opposite ways.
  const action =
    premiumKnown === 0
      ? `${leg} OI ${pct > 0 ? 'building' : 'unwinding'} (premium direction unknown)`
      : pct > 0
        ? premiumRising
          ? `fresh ${leg} buying`
          : `${leg} writing`
        : premiumRising
          ? `${leg} short covering`
          : `long ${leg} unwinding`;

  const both = Math.abs(callPct) > 0.03 && Math.abs(putPct) > 0.03;
  return {
    type,
    side: both ? 'MIXED' : dominant,
    strength,
    description: `${action} — ${dominant} OI ${pct > 0 ? '+' : ''}${(pct * 100).toFixed(1)}% vs open`,
  };
}

/**
 * Directional read, scored rather than branched, so every contribution is
 * visible in `reasons` and the strength is proportional to agreement.
 *
 * PCR level and PCR direction deliberately point opposite ways: a high standing
 * PCR is support (bullish), but puts actively *building* right now is fresh
 * bearish positioning. Both readings are standard and they are not in conflict —
 * one is a level, the other a rate of change.
 */
function computeSentiment(
  pcr: IndiaOptionAnalytics['pcr'],
  activity: IndiaOptionAnalytics['oiActivity'],
  maxPain: IndiaOptionAnalytics['maxPain'],
  spot: number | null,
  strikes: EnrichedStrike[],
  hasBaseline: boolean,
): IndiaOptionAnalytics['sentiment'] {
  const reasons: string[] = [];
  let score = 0;

  if (pcr.byOI >= 1.25) {
    score += 2;
    reasons.push(`PCR ${pcr.byOI.toFixed(2)} — put writers dominant, supportive`);
  } else if (pcr.byOI <= 0.7 && pcr.byOI > 0) {
    score -= 2;
    reasons.push(`PCR ${pcr.byOI.toFixed(2)} — call writers dominant, capped`);
  } else if (pcr.byOI > 0) {
    reasons.push(`PCR ${pcr.byOI.toFixed(2)} — balanced`);
  }

  if (hasBaseline) {
    let callDelta = 0;
    let putDelta = 0;
    for (const s of strikes) {
      callDelta += s.callOIChange ?? 0;
      putDelta += s.putOIChange ?? 0;
    }
    const net = putDelta - callDelta;
    const magnitude = Math.abs(callDelta) + Math.abs(putDelta);
    if (magnitude > 0 && Math.abs(net) / magnitude > 0.15) {
      if (net > 0) {
        score -= 1;
        reasons.push('puts building faster than calls — fresh downside positioning');
      } else {
        score += 1;
        reasons.push('calls building faster than puts — fresh upside positioning');
      }
    }
  }

  if (spot != null && maxPain.strike > 0 && maxPain.confidence > 0.05) {
    const gapPct = (maxPain.strike - spot) / spot;
    if (Math.abs(gapPct) > 0.002) {
      if (gapPct > 0) {
        score += 1;
        reasons.push(`max pain ${maxPain.strike} sits ${(gapPct * 100).toFixed(2)}% above spot`);
      } else {
        score -= 1;
        reasons.push(`max pain ${maxPain.strike} sits ${(Math.abs(gapPct) * 100).toFixed(2)}% below spot`);
      }
    }
  }

  if (activity.type !== 'NEUTRAL' && activity.strength > 0.2) {
    reasons.push(activity.description);
  }

  const signal: OptionSentiment = score >= 2 ? 'BULLISH' : score <= -2 ? 'BEARISH' : 'NEUTRAL';
  // Four is the practical maximum score, so strength is the fraction of the
  // available evidence that agreed. Deterministic, unlike the previous
  // Math.random() neutral case.
  const strength = Math.min(1, Math.abs(score) / 4);
  return {
    signal,
    strength,
    reason: reasons[0] ?? 'insufficient option data',
    reasons,
  };
}

function computeIvAnalysis(
  strikes: EnrichedStrike[],
  atm: EnrichedStrike | null,
  tracker: OptionChainTracker | null,
  underlying: string,
  now: number,
): IndiaOptionAnalytics['ivAnalysis'] {
  const ivs: number[] = [];
  for (const s of strikes) {
    if (s.call.iv != null) ivs.push(s.call.iv);
    if (s.put.iv != null) ivs.push(s.put.iv);
  }
  const averageIV = ivs.length ? ivs.reduce((a, b) => a + b, 0) / ivs.length : 0;

  // ATM IV as the average of the two ATM legs — either alone can be stale.
  const atmLegs = [atm?.call.iv, atm?.put.iv].filter((v): v is number => v != null);
  const atmIV = atmLegs.length ? atmLegs.reduce((a, b) => a + b, 0) / atmLegs.length : null;

  // Skew: OTM put IV minus OTM call IV, taken a few strikes either side of ATM
  // so the comparison is at roughly matched moneyness.
  let ivSkew = 0;
  if (atm) {
    const index = strikes.findIndex((s) => s.strike === atm.strike);
    const offset = 3;
    const otmPut = strikes[index - offset]?.put.iv ?? null;
    const otmCall = strikes[index + offset]?.call.iv ?? null;
    if (otmPut != null && otmCall != null) ivSkew = otmPut - otmCall;
  }

  if (tracker && atmIV != null) tracker.recordAtmIv(underlying, atmIV, now);
  const stats = tracker
    ? tracker.ivStats(underlying, atmIV)
    : { percentile: 0, rank: null as number | null, windowDays: 0 };

  return {
    averageIV,
    atmIV,
    ivSkew,
    ivPercentile: stats.percentile,
    ivRank: stats.rank,
    ivWindowDays: stats.windowDays,
  };
}

function computeTopStrikes(strikes: EnrichedStrike[]): StrikeSignificance[] {
  const withTotal = strikes.map((s) => ({
    strike: s.strike,
    callOI: s.call.oi ?? 0,
    putOI: s.put.oi ?? 0,
    callOIChange: s.callOIChange ?? 0,
    putOIChange: s.putOIChange ?? 0,
    total: (s.call.oi ?? 0) + (s.put.oi ?? 0),
  }));
  const maxTotal = withTotal.reduce((m, s) => Math.max(m, s.total), 0);
  return withTotal
    .sort((a, b) => b.total - a.total)
    .slice(0, 8)
    .map((s) => ({
      strike: s.strike,
      callOI: s.callOI,
      putOI: s.putOI,
      callOIChange: s.callOIChange,
      putOIChange: s.putOIChange,
      significance:
        maxTotal > 0 && s.total >= maxTotal * 0.7
          ? ('HIGH' as const)
          : maxTotal > 0 && s.total >= maxTotal * 0.4
            ? ('MEDIUM' as const)
            : ('LOW' as const),
    }));
}

function computeLiquidity(
  strikes: EnrichedStrike[],
  atm: EnrichedStrike | null,
  opts: ChainAnalysisOptions,
): IndiaOptionAnalytics['liquidity'] {
  const maxSpread = opts.maxSpreadPct ?? DEFAULT_MAX_SPREAD_PCT;
  const minOi = opts.minOpenInterest ?? DEFAULT_MIN_OI;
  let tradable = 0;
  for (const s of strikes) {
    const callOk = (s.call.oi ?? 0) >= minOi && s.call.spreadPct != null && s.call.spreadPct <= maxSpread;
    const putOk = (s.put.oi ?? 0) >= minOi && s.put.spreadPct != null && s.put.spreadPct <= maxSpread;
    if (callOk || putOk) tradable += 1;
  }
  const atmSpreads = [atm?.call.spreadPct, atm?.put.spreadPct].filter((v): v is number => v != null);
  return {
    atmSpreadPct: atmSpreads.length ? atmSpreads.reduce((a, b) => a + b, 0) / atmSpreads.length : null,
    tradableStrikes: tradable,
    totalStrikes: strikes.length,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Full analytics for one broker option chain.
 *
 * `tracker` is optional but strongly recommended: without it there is no session
 * baseline, so OI change and IV percentile are unavailable and the result says
 * so in `dataQuality` rather than reporting zeros as though they were readings.
 */
export function analyseChain(
  chain: OptionChainData,
  tracker: OptionChainTracker | null,
  opts: ChainAnalysisOptions = {},
): IndiaOptionAnalytics {
  const now = opts.now ?? Date.now();
  const { strikes: raw, expiry } = singleExpiry(chain, now);

  if (tracker) tracker.captureBaseline(chain.underlying, raw, chain.spotPrice, expiry, now);
  const strikes = enrichChain(raw, chain.spotPrice, expiry, opts).sort((a, b) => a.strike - b.strike);
  const hasBaseline = applyBaseline(strikes, tracker ? tracker.baseline(chain.underlying, expiry) : null);

  const spot = chain.spotPrice;
  // OI change is usable if the tracker matched a baseline OR the feed already
  // carried its own change figure. Distinguishing "flat" from "unknown" here is
  // what keeps a first-snapshot-of-the-day from being read as no activity.
  const hasOiChange =
    hasBaseline || strikes.some((s) => s.callOIChange != null || s.putOIChange != null);

  const atm = findAtm(strikes, spot);
  const pcr = computePcr(strikes);
  const maxPain = computeMaxPain(strikes, spot);
  const oiLevels = computeOiLevels(strikes, spot);
  const oiActivity = computeOiActivity(strikes, hasOiChange);
  const ivAnalysis = computeIvAnalysis(strikes, atm, tracker, chain.underlying, now);
  const sentiment = computeSentiment(pcr, oiActivity, maxPain, spot, strikes, hasOiChange);
  const liquidity = computeLiquidity(strikes, atm, opts);

  const years = expiry ? yearsToExpiry(expiry, now) : 0;
  const move =
    spot != null && ivAnalysis.atmIV != null && years > 0
      ? expectedMove(spot, ivAnalysis.atmIV, years)
      : null;

  const straddle =
    atm && atm.call.ltp != null && atm.put.ltp != null ? atm.call.ltp + atm.put.ltp : null;

  return {
    underlying: chain.underlying.toUpperCase(),
    spotPrice: spot,
    expiryDate: expiry,
    timestamp: chain.timestamp || now,
    pcr,
    maxPain,
    atm: {
      strike: atm?.strike ?? 0,
      callOI: atm?.call.oi ?? 0,
      putOI: atm?.put.oi ?? 0,
      callIV: atm?.call.iv ?? null,
      putIV: atm?.put.iv ?? null,
      straddlePremium: straddle,
    },
    sentiment,
    ivAnalysis,
    oiActivity,
    topStrikes: computeTopStrikes(strikes),
    oiLevels,
    expectedMove: move,
    daysToExpiry: expiry ? daysToExpiry(expiry, now) : null,
    minutesToExpiry: expiry ? minutesToExpiry(expiry, now) : null,
    liquidity,
    dataQuality: {
      strikesTotal: strikes.length,
      strikesWithOi: strikes.filter((s) => (s.call.oi ?? 0) > 0 || (s.put.oi ?? 0) > 0).length,
      strikesWithIv: strikes.filter((s) => s.call.iv != null || s.put.iv != null).length,
      hasBaseline: hasOiChange,
      source: opts.source ?? 'BROKER_CHAIN',
    },
  };
}

/** The enriched strike ladder, for the UI chain view. Exposed separately so the
 *  analytics call and the chain render share one computation path. */
export function enrichedLadder(
  chain: OptionChainData,
  tracker: OptionChainTracker | null,
  opts: ChainAnalysisOptions = {},
): EnrichedStrike[] {
  const now = opts.now ?? Date.now();
  const { strikes: raw, expiry } = singleExpiry(chain, now);
  if (tracker) tracker.captureBaseline(chain.underlying, raw, chain.spotPrice, expiry, now);
  const strikes = enrichChain(raw, chain.spotPrice, expiry, opts).sort((a, b) => a.strike - b.strike);
  applyBaseline(strikes, tracker ? tracker.baseline(chain.underlying, expiry) : null);
  return strikes;
}
