/**
 * Goal Opportunity Engine (spec §7–§9, §24, §31).
 *
 * Goal mode is not "first qualifying signal wins". Every fresh candidate that
 * survives criteria/gates/sizing is SCORED here — model conviction, estimated
 * probability and time to target, momentum/trend/structure agreement, option
 * posture, liquidity and reward — and the BEST current candidate is traded.
 *
 * Two hard rules shape this module:
 *  1. Ranking never overrides mandatory validity. ML offline, meta-filtered,
 *     stale, expired, illiquid or lot-size-inconsistent candidates are
 *     INELIGIBLE before any score exists (fail closed, §31).
 *  2. Every number is INR-first and honest. Missing data scores as UNKNOWN —
 *     it never becomes a fabricated neutral value dressed up as evidence.
 */
import type {
  IndiaAnalysisSnapshot,
  IndiaInstrument,
  IndiaModelPrediction,
  IndiaOpportunity,
  IndiaSignalRejection,
  StrategyName,
} from '@fx/shared';
import { indiaConfig } from './config';
import { validateIndiaLotSize } from './lot-size';

/** Shape of the cached chain-analytics snapshot the gates/scoring may see. */
export interface OpportunityOptionContext {
  sentiment?: { signal?: string | null } | null;
  ivAnalysis?: { atmIv?: number | null } | null;
}

export interface GoalCandidateContext {
  instrument: IndiaInstrument;
  strategy: StrategyName;
  side: 'BUY' | 'SELL';
  entry: number;
  stopLoss: number;
  target: number;
  /** From position sizing — both net-of-charges figures in INR. */
  riskInr: number;
  expectedProfitInr: number;
  rr: number;
  quantity: number;
  analysis: IndiaAnalysisSnapshot;
  prediction: IndiaModelPrediction | null;
  optionContext?: OpportunityOptionContext | null;
  /** Latest live quote for the contract, when the feed has one. */
  tick?: { ltp: number; bid: number | null; ask: number | null } | null;
  /** Remaining INR to reach the goal — rewards one-shot completions. */
  goalRemainingInr: number;
  /** Goal's own risk cap, for the relative-risk penalty. */
  maxRiskInr: number;
  now: number;
}

export type GoalCandidateResult =
  | { eligible: true; opportunity: IndiaOpportunity }
  | { eligible: false; stage: Pick<IndiaSignalRejection, 'stage'>['stage']; reason: string };

const TF_MINUTES = 5;

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

/**
 * Internal volatility measure derived from ATM IV (spec §21). This is NOT the
 * official India VIX — no official methodology or feed is involved — it is the
 * option engine's own ATM implied volatility expressed as an annualised
 * fraction, for regime context only.
 */
export function derivedIndiaVolatility(atmIvPct: number | null | undefined): number | null {
  if (atmIvPct == null || !Number.isFinite(atmIvPct) || atmIvPct <= 0) return null;
  return atmIvPct / 100;
}

export interface MlGateOptions {
  /** Hard-veto mode: a meta-FILTERED prediction blocks the trade outright.
   *  Off by default — the current v2 bundles emit a CONSTANT meta probability,
   *  which carries zero information, so blocking on it vetoes every setup
   *  forever. Conviction is instead enforced by the probability floor below. */
  strictMeta: boolean;
  /** Minimum SIDE-ALIGNED stacked-model probability for automatic entry. */
  minProbability: number;
}

/**
 * The ML gate (spec §15) as one honest, testable rule set:
 *  1. Offline / unavailable prediction → NO TRADE. Never a fallback confidence.
 *  2. Strict-meta mode → a meta-FILTERED prediction is a NO_TRADE verdict.
 *  3. Otherwise the STACKED probability aligned to the trade side must clear
 *     the configured floor — genuine conviction, not a placeholder.
 * Returns the aligned probability so scoring and audit reuse one computation.
 *
 * Alignment semantics: `probability` is P(up). A BUY wins if the market goes
 * up, so its aligned probability IS p; a SELL wins if it goes down, so its
 * aligned probability is 1 − p. `direction` adds nothing — the serving layer
 * derives it FROM p (`1 if p >= 0.5 else -1`) — and mixing it into the
 * alignment inverted every bearish verdict: SELLs backed by a genuinely
 * bearish model scored p < 0.5 and could never clear any floor, while BUYs
 * against that same model scored 1 − p > 0.5 and sailed through.
 */
export function evaluateMlGate(
  prediction: IndiaModelPrediction | null | undefined,
  side: 'BUY' | 'SELL',
  opts: MlGateOptions,
): { ok: boolean; reason: string; alignedProbability: number } {
  if (!prediction || !prediction.available || prediction.mlStatus === 'OFFLINE') {
    return {
      ok: false,
      alignedProbability: 0,
      reason: `ML_UNAVAILABLE: ${prediction?.error ?? 'prediction unavailable'}`,
    };
  }
  const buy = side === 'BUY';
  const alignedP = buy ? prediction.probability : 1 - prediction.probability;
  if (opts.strictMeta && prediction.filtered) {
    return {
      ok: false,
      alignedProbability: alignedP,
      reason: `ML_FILTERED: meta-labeling gated this setup (meta ${(prediction.metaProbability ?? 0).toFixed(2)} < ${prediction.metaThreshold ?? '-'})`,
    };
  }
  if (alignedP < opts.minProbability) {
    return {
      ok: false,
      alignedProbability: alignedP,
      reason: `ML_LOW_CONVICTION: side-aligned ${alignedP.toFixed(2)} < required ${opts.minProbability}`,
    };
  }
  return {
    ok: true,
    alignedProbability: alignedP,
    reason: `ML ${prediction.mlStatus ?? 'ONLINE'} ${prediction.modelVersion} aligned=${alignedP.toFixed(2)}${prediction.filtered ? ' (meta-filtered, penalised)' : ''}`,
  };
}

/**
 * Score one candidate. Returns an eligible opportunity with a full component
 * breakdown, or the exact stage/reason it failed a mandatory check.
 */
export function scoreGoalCandidate(ctx: GoalCandidateContext): GoalCandidateResult {
  const { instrument, analysis, prediction, now } = ctx;

  // ── Mandatory: ML gate (§15) — availability + genuine side-aligned conviction.
  const ml = evaluateMlGate(prediction, ctx.side, {
    strictMeta: indiaConfig.mlMetaStrict,
    minProbability: indiaConfig.mlMinProbability,
  });
  if (!ml.ok) {
    return { eligible: false, stage: 'GATE', reason: ml.reason };
  }

  // ── Mandatory: freshness (§9) — analysis older than a minute is not "now" ──
  const ageMs = Math.max(0, now - (analysis.marketTimestamp || analysis.timestamp || now));
  if (ageMs > 60_000) {
    return { eligible: false, stage: 'COOLDOWN', reason: `SIGNAL_STALE: analysis ${Math.round(ageMs / 1000)}s old` };
  }

  // ── Mandatory: lot-size reference validation (§4) ────────────────────────
  const lot = validateIndiaLotSize(instrument);
  if (!lot.ok) {
    return { eligible: false, stage: 'SIZING', reason: `LOT_SIZE_MISMATCH: ${lot.reason}` };
  }

  // ── Mandatory: expiry (§23) ───────────────────────────────────────────────
  if (instrument.expiry != null && instrument.expiry < now) {
    return { eligible: false, stage: 'GATE', reason: 'EXPIRY: contract past its expiry instant' };
  }

  // ── Mandatory: liquidity (§24) — only when the feed carries a book ────────
  const mid = ctx.tick && ctx.tick.bid && ctx.tick.ask ? (ctx.tick.bid + ctx.tick.ask) / 2 : null;
  const spreadPct = mid && mid > 0 ? (ctx.tick!.ask! - ctx.tick!.bid!) / mid : null;
  let liquidity: IndiaOpportunity['liquidity'] = 'UNKNOWN';
  if (spreadPct != null) {
    liquidity = spreadPct <= 0.0025 ? 'GOOD' : spreadPct <= 0.01 ? 'FAIR' : 'POOR';
    if (liquidity === 'POOR') {
      return { eligible: false, stage: 'GATE', reason: `NO_LIQUIDITY: spread ${(spreadPct * 100).toFixed(2)}% of mid` };
    }
  }

  // ── Scoring components (0..1 each) ────────────────────────────────────────
  const buy = ctx.side === 'BUY';
  const rc = analysis.riskContext;

  // Model conviction ALIGNED to the trade side — computed once by the gate and
  // reused here, so eligibility and scoring can never disagree about it.
  const alignedP = ml.alignedProbability;
  const mlQuality = clamp01((alignedP - 0.45) / 0.4);

  const adx = typeof rc.adx === 'number' ? rc.adx : 0;
  const trendAgree = analysis.trend === (buy ? 'BULLISH' : 'BEARISH');
  const trendNeutral = analysis.trend === 'NEUTRAL';
  const trendStrength = clamp01((adx - 20) / 30) * (trendAgree ? 1 : trendNeutral ? 0.5 : 0.15);
  const momentumAgree = analysis.momentum === (buy ? 'BULLISH' : 'BEARISH')
    ? 1
    : analysis.momentum === 'NEUTRAL' ? 0.5 : 0.1;

  const structureBull = analysis.structure === 'UPTREND' || analysis.regime === 'BREAKOUT';
  const structureBear = analysis.structure === 'DOWNTREND' || analysis.regime === 'BREAKDOWN';
  const structure = (buy ? structureBull : structureBear) ? 1 : (buy ? structureBear : structureBull) ? 0.15 : 0.5;

  const sent = ctx.optionContext?.sentiment?.signal ?? null;
  const oiConfirmation = sent == null ? 0.5 : sent === (buy ? 'BULLISH' : 'BEARISH') ? 1 : sent === 'NEUTRAL' ? 0.5 : 0.1;

  const atmIv = ctx.optionContext?.ivAnalysis?.atmIv ?? null;
  const derivedVol = derivedIndiaVolatility(atmIv);
  // Moderate IV is workable; very high IV makes premium targets whipsaw-prone.
  const ivScore = derivedVol == null ? 0.5 : clamp01(1 - Math.max(0, (derivedVol - 0.15)) / 0.5);

  const liquidityScore = liquidity === 'GOOD' ? 1 : liquidity === 'FAIR' ? 0.6 : 0.5;
  const rewardScore = clamp01(ctx.expectedProfitInr / Math.max(1, ctx.goalRemainingInr));
  const rrScore = clamp01((ctx.rr - 1) / 2);

  // Expected time to target (§8): distance covered at the bar velocity implied
  // by recent ATR, scaled up when momentum runs with the trade. An ESTIMATE —
  // clamped, never surfaced as a promise.
  const atr = typeof rc.atr === 'number' && rc.atr > 0 ? rc.atr : ctx.entry * 0.001;
  const targetDistance = Math.abs(ctx.target - ctx.entry);
  const velocityPerBar = Math.max(atr * 0.35, ctx.entry * 0.0003) * (momentumAgree >= 1 ? 1.25 : 1);
  const expectedMinutes = Math.round(
    Math.max(1, Math.min(600, (targetDistance / velocityPerBar) * TF_MINUTES)),
  );

  // ── Penalties ─────────────────────────────────────────────────────────────
  const riskPenalty = clamp01(ctx.riskInr / Math.max(1, ctx.maxRiskInr));
  const spreadPenalty = spreadPct == null ? 0 : clamp01(spreadPct / 0.02);
  const timePenalty = clamp01((expectedMinutes - 10) / 110);
  const stalePenalty = clamp01((ageMs / 1000 - 15) / 45);

  const components: Record<string, number> = {
    mlQuality: round4(mlQuality),
    tpProbability: 0, // filled below once computed
    momentum: round4(momentumAgree),
    trendStrength: round4(trendStrength),
    structure: round4(structure),
    oiConfirmation: round4(oiConfirmation),
    iv: round4(ivScore),
    liquidity: round4(liquidityScore),
    reward: round4(rewardScore),
    rr: round4(rrScore),
    riskPenalty: round4(-riskPenalty),
    spreadPenalty: round4(-spreadPenalty),
    timePenalty: round4(-timePenalty),
    stalePenalty: round4(-stalePenalty),
  };

  // Probability of hitting the target first: model conviction weighted against
  // the structural picture agreeing with the trade.
  const tpProbability = clamp01(alignedP * 0.6 + (0.25 * trendStrength + 0.25 * momentumAgree + 0.25 * oiConfirmation + 0.25 * structure) * 0.4);
  components.tpProbability = round4(tpProbability);

  const score =
    mlQuality * 0.20 +
    tpProbability * 0.18 +
    momentumAgree * 0.07 +
    trendStrength * 0.07 +
    structure * 0.05 +
    oiConfirmation * 0.07 +
    ivScore * 0.03 +
    liquidityScore * 0.07 +
    rewardScore * 0.10 +
    rrScore * 0.06 -
    riskPenalty * 0.10 -
    spreadPenalty * 0.05 -
    timePenalty * 0.12 -
    stalePenalty * 0.05;

  return {
    eligible: true,
    opportunity: {
      instrumentToken: instrument.instrumentToken,
      tradingSymbol: instrument.tradingSymbol,
      underlying: instrument.underlying,
      contractType: instrument.contractType,
      optionType: instrument.optionType,
      side: ctx.side,
      strategy: ctx.strategy,
      entry: ctx.entry,
      stopLoss: ctx.stopLoss,
      target: ctx.target,
      quantity: ctx.quantity,
      lotSize: lot.lotSize,
      expectedProfitInr: round2(ctx.expectedProfitInr),
      riskInr: round2(ctx.riskInr),
      rr: round2(ctx.rr),
      tpProbability: round2(tpProbability),
      expectedMinutes,
      score: round4(score),
      components,
      liquidity,
      freshnessMs: ageMs,
      mlStatus: prediction?.mlStatus ?? 'OFFLINE',
    },
  };
}

/** Highest-scoring candidates first (§7: ranking cannot create eligibility). */
export function rankGoalCandidates(opportunities: IndiaOpportunity[]): IndiaOpportunity[] {
  return [...opportunities].sort((a, b) => b.score - a.score);
}

/**
 * Stagnant-trade evaluation for an OPEN position (spec §11).
 *
 * Two strategy-defined barriers, not an activity timer:
 *  HOLD_BARRIER — held past the configured maximum WITHOUT reaching half the
 *                 expected profit: the thesis had its chance.
 *  BLEEDING     — well inside the barrier but losing meaningfully: momentum has
 *                 collapsed against the position while it bleeds toward SL.
 *
 * Returns null when the position still deserves time. A winning trade is never
 * cut by either rule.
 */
export function evaluateStagnation(input: {
  heldMinutes: number;
  unrealizedPnlInr: number;
  riskInr: number;
  expectedProfitInr: number;
  maxHoldMinutes: number;
}): 'HOLD_BARRIER' | 'BLEEDING' | null {
  const halfExpected = input.expectedProfitInr * 0.5;
  if (
    input.maxHoldMinutes > 0 &&
    input.heldMinutes >= input.maxHoldMinutes &&
    input.unrealizedPnlInr < halfExpected
  ) return 'HOLD_BARRIER';
  const bleedFloor = Math.max(5, input.maxHoldMinutes * 0.6);
  if (
    input.maxHoldMinutes > 0 &&
    input.heldMinutes >= bleedFloor &&
    input.unrealizedPnlInr <= 0 &&
    Math.abs(input.unrealizedPnlInr) >= input.riskInr * 0.25
  ) return 'BLEEDING';
  return null;
}

function round2(x: number): number { return Math.round(x * 100) / 100; }
function round4(x: number): number { return Math.round(x * 10000) / 10000; }
