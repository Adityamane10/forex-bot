/**
 * Pre-trade gates for the Indian signal engine.
 *
 * Everything here is a pure function of a snapshot. No I/O, no clock reads
 * except the `now` that is passed in, so every verdict is reproducible from its
 * inputs — which is the whole point: a gate that cannot be replayed cannot be
 * reviewed after a losing trade.
 *
 * What changed, and why it matters:
 *
 *   - Option flow used to be a `+0.15` confidence nudge that "never blocks a
 *     signal" (the old comment said so explicitly). Agreement was rewarded and
 *     disagreement cost nothing, so the option book could be screaming the other
 *     way and the trade still went through at full size. It is now a gate that
 *     can veto.
 *
 *   - That old check also compared `side === 'BUY'` against a BULLISH posture,
 *     which is simply wrong for puts: buying a PE is a *bearish* position. So on
 *     every put signal the confirmation was inverted, rewarding exactly the
 *     trades the option book disagreed with. `directionalBias()` fixes it.
 *
 *   - There were no time-of-day, days-to-expiry or expiry-day checks at all. An
 *     index option on expiry afternoon is a different instrument from the same
 *     contract three days earlier, and the engine had no way to know that.
 *
 *   - Nothing looked at the traded contract's own order book, only at the chain's
 *     average spread. A ladder can be perfectly tradable in aggregate and still
 *     contain the illiquid strike the engine picked, so `book-depth` reads the
 *     quantity resting on the side the position will have to exit into.
 *
 *   - Open interest was only ever read chain-wide. `strike-oi` adds the local
 *     reading at the strike being traded, which is a different fact and is
 *     weighted as the weaker one.
 *
 * A gate returns SKIPPED, not PASS, when it lacks the data to judge. PASS means
 * "checked and fine"; SKIPPED means "not checked". Collapsing the two would make
 * a degraded feed look like a clean bill of health.
 */
import type {
  IndiaGateResult,
  IndiaInstrument,
  IndiaOptionFlowSnapshot,
  IndiaSignalGateTrail,
  IndiaTick,
} from '@fx/shared';
import { INDIA_ENTRY_WINDOW, INDIA_SESSION_CLOSE_MIN, INDIA_SESSION_OPEN_MIN } from '@fx/shared';
import type { IndiaOptionAnalytics } from './option-chain';
import { breakEvenMovePct, daysToExpiry, expectedMove, minutesToExpiry } from './options-math';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const SESSION_OPEN_MIN = INDIA_SESSION_OPEN_MIN;
const SESSION_CLOSE_MIN = INDIA_SESSION_CLOSE_MIN;
const MINUTES_PER_YEAR = 365 * 24 * 60;

/** Minute of the IST day, 0..1439. */
export function istMinuteOfDay(now: number): number {
  const ist = new Date(now + IST_OFFSET_MS);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

export interface GateConfig {
  /** Reject new entries within this many minutes of the open. The opening
   *  auction leaves spreads wide and every indicator's first bar unformed. */
  openBlockMinutes: number;
  /** Flag but allow, for this many minutes after the open. */
  openWarnMinutes: number;
  /** Reject new entries within this many minutes of the close — there is no time
   *  left for the trade to work, and an intraday position must be squared off. */
  closeBlockMinutes: number;
  closeWarnMinutes: number;
  /** On expiry day, refuse long premium with less than this many minutes left. */
  expiryDayMinMinutes: number;
  /** Beyond this many days to expiry the contract is usually too thin. */
  maxDte: number;
  maxAtmSpreadPct: number;
  minTradableStrikes: number;
  /** Option sentiment strength above which a disagreement becomes a veto. */
  opposeBlockStrength: number;
  /** Target distance as a multiple of the implied move: warn, then block. */
  moveWarnMultiple: number;
  moveBlockMultiple: number;
  ivPercentileHigh: number;
  ivPercentileLow: number;
  /** Below this many days of IV history, the IV regime gate stays SKIPPED. */
  minIvWindowDays: number;
  /** Lots resting on the exit side below which the position cannot be got out of
   *  at all — under one lot the top of book cannot absorb the minimum tradeable
   *  size, so the exit would have to walk the ladder before it filled. */
  minExitDepthLots: number;
  /** Exit-side depth below this many lots is thin enough to flag. */
  thinExitDepthLots: number;
  /** Top-of-book imbalance, −1..1, at which a lean against the trade is worth
   *  flagging. Deliberately loose: one level of a book is noisy evidence. */
  depthImbalanceWarn: number;
  /** A quote older than this is a memory, not a book. */
  depthMaxAgeMs: number;
  /** Strike OI change smaller than this fraction of the strike's standing OI is
   *  noise. Matches the band `computeOiActivity` uses on the chain aggregate. */
  strikeOiNoisePct: number;
}

export const DEFAULT_GATE_CONFIG: GateConfig = {
  // The four session-edge windows come from `shared` rather than being written
  // out here: the UI draws a session arc from the same numbers, and a picture
  // that disagrees with the rule it illustrates is worse than no picture.
  openBlockMinutes: INDIA_ENTRY_WINDOW.openBlockMinutes,
  openWarnMinutes: INDIA_ENTRY_WINDOW.openWarnMinutes,
  closeBlockMinutes: INDIA_ENTRY_WINDOW.closeBlockMinutes,
  closeWarnMinutes: INDIA_ENTRY_WINDOW.closeWarnMinutes,
  expiryDayMinMinutes: 60,
  maxDte: 45,
  maxAtmSpreadPct: 0.05,
  minTradableStrikes: 6,
  opposeBlockStrength: 0.5,
  moveWarnMultiple: 1.5,
  moveBlockMultiple: 2.5,
  ivPercentileHigh: 80,
  ivPercentileLow: 20,
  minIvWindowDays: 5,
  minExitDepthLots: 1,
  thinExitDepthLots: 5,
  depthImbalanceWarn: 0.4,
  depthMaxAgeMs: 20_000,
  strikeOiNoisePct: 0.03,
};

export interface GateContext {
  instrument: IndiaInstrument;
  side: 'BUY' | 'SELL';
  /** Price of the traded instrument — a premium for options, an index level
   *  otherwise. The two are not interchangeable and the gates keep them apart. */
  entry: number;
  stopLoss: number;
  target: number;
  baseConfidence: number;
  now: number;
  analytics: IndiaOptionAnalytics | null;
  flow: IndiaOptionFlowSnapshot | null;
  /**
   * Last quote seen for the *traded* contract, not the underlying.
   *
   * Everything else here describes the chain or the clock; this is the only input
   * that says whether this particular contract can actually be dealt in right
   * now. Null on a cold feed, and possibly stale even when present, so the gate
   * that reads it checks `marketTimestamp` itself.
   */
  tick: IndiaTick | null;
  config?: Partial<GateConfig>;
}

/**
 * The market view a position actually expresses.
 *
 * Buying a call and selling a put are both bullish; buying a put and selling a
 * call are both bearish. Reading BUY as bullish regardless of `optionType` — as
 * the old confirmation did — inverts the check on every put.
 */
export function directionalBias(instrument: IndiaInstrument, side: 'BUY' | 'SELL'): 'BULLISH' | 'BEARISH' {
  const long = side === 'BUY';
  if (instrument.contractType === 'OPT' && instrument.optionType === 'PE') {
    return long ? 'BEARISH' : 'BULLISH';
  }
  return long ? 'BULLISH' : 'BEARISH';
}

/** True when the position pays theta rather than collecting it. */
export function isLongPremium(instrument: IndiaInstrument, side: 'BUY' | 'SELL'): boolean {
  return instrument.contractType === 'OPT' && side === 'BUY';
}

/** Minutes left in the cash session; 0 once it has closed. */
function minutesLeftInSession(now: number): number {
  const minute = istMinuteOfDay(now);
  if (minute >= SESSION_CLOSE_MIN) return 0;
  return SESSION_CLOSE_MIN - Math.max(minute, SESSION_OPEN_MIN);
}

function pass(gate: string, label: string, detail: string, confidenceDelta = 0): IndiaGateResult {
  return { gate, label, verdict: 'PASS', detail, confidenceDelta };
}
function warn(gate: string, label: string, detail: string, confidenceDelta = 0): IndiaGateResult {
  return { gate, label, verdict: 'WARN', detail, confidenceDelta };
}
function block(gate: string, label: string, detail: string): IndiaGateResult {
  return { gate, label, verdict: 'BLOCK', detail, confidenceDelta: 0 };
}
function skip(gate: string, label: string, detail: string): IndiaGateResult {
  return { gate, label, verdict: 'SKIPPED', detail, confidenceDelta: 0 };
}

// ---------------------------------------------------------------------------
// Individual gates
// ---------------------------------------------------------------------------

/** Time of day. The first and last quarter-hour of an Indian session behave
 *  nothing like the middle of it. */
function gateSessionWindow(ctx: GateContext, cfg: GateConfig): IndiaGateResult {
  const minute = istMinuteOfDay(ctx.now);
  const sinceOpen = minute - SESSION_OPEN_MIN;
  const toClose = SESSION_CLOSE_MIN - minute;
  const clock = `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')} IST`;

  if (sinceOpen < 0 || toClose <= 0) {
    return block('session-window', 'Session window', `${clock} — outside 09:15–15:30`);
  }
  if (sinceOpen < cfg.openBlockMinutes) {
    return block(
      'session-window',
      'Session window',
      `${clock} — only ${sinceOpen}m since the open, spreads and first-bar indicators unreliable`,
    );
  }
  if (toClose < cfg.closeBlockMinutes) {
    return block('session-window', 'Session window', `${clock} — ${toClose}m to close, no time for the trade to work`);
  }
  if (sinceOpen < cfg.openWarnMinutes) {
    return warn('session-window', 'Session window', `${clock} — ${sinceOpen}m since the open, still settling`, -0.05);
  }
  if (toClose < cfg.closeWarnMinutes) {
    return warn('session-window', 'Session window', `${clock} — ${toClose}m to close, squaring off soon`, -0.05);
  }
  return pass('session-window', 'Session window', `${clock} — mid-session`);
}

/** Days to expiry, and the special case of expiry day itself. */
function gateExpiry(ctx: GateContext, cfg: GateConfig): IndiaGateResult {
  const { instrument } = ctx;
  if (instrument.contractType === 'INDEX' || instrument.expiry == null) {
    return skip('dte', 'Days to expiry', 'not a dated contract');
  }

  const dte = daysToExpiry(instrument.expiry, ctx.now);
  const minutes = minutesToExpiry(instrument.expiry, ctx.now);

  if (minutes <= 0) {
    return block('dte', 'Days to expiry', 'contract has expired');
  }
  if (dte > cfg.maxDte) {
    return warn('dte', 'Days to expiry', `${dte}d out — far-month liquidity is usually thin`, -0.1);
  }
  if (dte > 0) {
    return pass('dte', 'Days to expiry', `${dte}d to expiry`);
  }

  // Expiry day. Gamma is enormous and theta is measured in minutes, so a long
  // premium entry has to be early enough to have any chance of clearing its own
  // decay. A short premium position is the beneficiary of that decay, so the
  // same clock is not a reason to refuse it.
  if (isLongPremium(instrument, ctx.side) && minutes < cfg.expiryDayMinMinutes) {
    return block('dte', 'Days to expiry', `expiry day, ${minutes}m left — too late to buy premium`);
  }
  return warn('dte', 'Days to expiry', `expiry day, ${minutes}m left — gamma and theta both extreme`, -0.1);
}

/**
 * Does the option book agree with the trade?
 *
 * Prefers full chain analytics (PCR by OI/volume/value, max pain, OI activity)
 * and falls back to the OI-only posture from `option-flow.ts`. Absence of data
 * is a WARN, not a BLOCK: on a cold start there is no option context at all, and
 * refusing every trade until it arrives would be a worse failure than trading
 * without it.
 */
function gateOptionPosture(ctx: GateContext, cfg: GateConfig): IndiaGateResult {
  const bias = directionalBias(ctx.instrument, ctx.side);
  const a = ctx.analytics;

  if (a && a.dataQuality.strikesWithOi > 0) {
    const view = a.sentiment.signal;
    const strength = a.sentiment.strength;
    const detail = `${view} (${(strength * 100).toFixed(0)}%) vs ${bias} trade — ${a.sentiment.reason}`;

    if (view === 'NEUTRAL') {
      return pass('option-posture', 'Option book', `option book neutral — ${a.sentiment.reason}`);
    }
    if (view === bias) {
      return pass('option-posture', 'Option book', detail, Math.min(0.15, 0.15 * strength));
    }
    if (strength >= cfg.opposeBlockStrength) {
      return block('option-posture', 'Option book', `option book opposes the trade — ${detail}`);
    }
    return warn('option-posture', 'Option book', `option book leans against the trade — ${detail}`, -0.1);
  }

  const flow = ctx.flow;
  if (flow && flow.pcr != null) {
    const detail = `OI-only posture ${flow.posture}, PCR ${flow.pcr.toFixed(2)} vs ${bias} trade`;
    if (flow.posture === 'NEUTRAL') return pass('option-posture', 'Option book', detail);
    if (flow.posture === bias) return pass('option-posture', 'Option book', detail, 0.1);
    // OI alone is weaker evidence than the full chain, so it warns rather than
    // vetoes even on a clear disagreement.
    return warn('option-posture', 'Option book', detail, -0.1);
  }

  return warn('option-posture', 'Option book', 'no option context available', -0.05);
}

/**
 * Where implied volatility sits in its own history.
 *
 * Buying premium at the top of the IV range means an IV mean-reversion works
 * against the position even when the direction is right; selling it there is the
 * favourable side of the same trade. Stays SKIPPED until the history is long
 * enough to make the percentile mean something.
 */
function gateIvRegime(ctx: GateContext, cfg: GateConfig): IndiaGateResult {
  const a = ctx.analytics;
  if (!a || a.ivAnalysis.atmIV == null) {
    return skip('iv-regime', 'IV regime', 'no implied volatility available');
  }
  const { ivPercentile, ivWindowDays, atmIV, ivRank } = a.ivAnalysis;
  const ivPct = `${(atmIV * 100).toFixed(1)}%`;

  if (ivWindowDays < cfg.minIvWindowDays) {
    return skip(
      'iv-regime',
      'IV regime',
      `ATM IV ${ivPct}, only ${ivWindowDays}d of history — percentile not meaningful yet`,
    );
  }
  const where = ivRank != null ? `rank ${ivRank.toFixed(0)}` : `pctile ${ivPercentile.toFixed(0)}`;
  const detail = `ATM IV ${ivPct}, ${where} over ${ivWindowDays}d`;
  const longPremium = isLongPremium(ctx.instrument, ctx.side);

  if (ivPercentile >= cfg.ivPercentileHigh) {
    return longPremium
      ? warn('iv-regime', 'IV regime', `${detail} — buying premium into rich volatility`, -0.1)
      : pass('iv-regime', 'IV regime', `${detail} — selling premium into rich volatility`, 0.05);
  }
  if (ivPercentile <= cfg.ivPercentileLow) {
    return longPremium
      ? pass('iv-regime', 'IV regime', `${detail} — premium is cheap`, 0.05)
      : warn('iv-regime', 'IV regime', `${detail} — little premium left to collect`, -0.1);
  }
  return pass('iv-regime', 'IV regime', detail);
}

/** Can the position be got out of? A wide ATM spread is a guaranteed loss taken
 *  on entry and again on exit, before the market has moved at all. */
function gateLiquidity(ctx: GateContext, cfg: GateConfig): IndiaGateResult {
  if (ctx.instrument.contractType !== 'OPT') {
    return skip('liquidity', 'Liquidity', 'not an option contract');
  }
  const a = ctx.analytics;
  if (!a || a.liquidity.atmSpreadPct == null) {
    return skip('liquidity', 'Liquidity', 'no quote depth available');
  }
  const spread = a.liquidity.atmSpreadPct;
  const { tradableStrikes, totalStrikes } = a.liquidity;
  const detail = `ATM spread ${(spread * 100).toFixed(2)}%, ${tradableStrikes}/${totalStrikes} strikes tradable`;

  if (spread > cfg.maxAtmSpreadPct) {
    return block('liquidity', 'Liquidity', `${detail} — above the ${(cfg.maxAtmSpreadPct * 100).toFixed(0)}% limit`);
  }
  if (tradableStrikes < cfg.minTradableStrikes) {
    return warn('liquidity', 'Liquidity', `${detail} — thin ladder`, -0.1);
  }
  return pass('liquidity', 'Liquidity', detail);
}

/**
 * Is there anyone on the other side, right now, in this contract?
 *
 * `gateLiquidity` asks about the ladder as a whole from the chain snapshot. This
 * asks the narrower and more immediate question the chain cannot answer: how much
 * is resting at the top of *this* contract's book, on the side the position will
 * have to exit into. A 2% ATM spread is meaningless if the bid behind it is one
 * lot — the exit walks the ladder and gives back more than the spread ever
 * suggested.
 *
 * The direction test here is `side`, not `directionalBias()`, and that is not an
 * oversight. This reads the traded contract's own book, so what helps the
 * position is pressure in the contract's own price: a buyer wants bids stacked
 * beneath it, a seller wants offers above. For a put those point the opposite way
 * from the index view, which is exactly why routing this through the index bias
 * would invert it — the mirror image of the bug `directionalBias` was written to
 * fix in `gateOptionPosture`.
 */
function gateBookDepth(ctx: GateContext, cfg: GateConfig): IndiaGateResult {
  const gate = 'book-depth';
  const label = 'Book depth';

  if (ctx.instrument.contractType === 'INDEX') {
    return skip(gate, label, 'an index is computed, not traded — it has no order book');
  }
  const tick = ctx.tick;
  if (!tick) {
    return skip(gate, label, 'no quote received for this contract yet');
  }
  const age = ctx.now - tick.marketTimestamp;
  if (age > cfg.depthMaxAgeMs) {
    return skip(gate, label, `last quote is ${(age / 1000).toFixed(0)}s old — too stale to read depth from`);
  }
  const bidQty = tick.bidQuantity;
  const askQty = tick.askQuantity;
  if (bidQty == null || askQty == null) {
    return skip(gate, label, 'feed carries no bid/ask quantities');
  }
  const lotSize = ctx.instrument.lotSize;
  if (!(lotSize > 0)) {
    return skip(gate, label, 'instrument lot size unknown');
  }

  // Exiting a long means selling into the bid; exiting a short means buying from
  // the ask. The relevant depth is the side the exit will hit, not the side the
  // entry hits — an entry that cannot be closed is the expensive half.
  const exitQty = ctx.side === 'BUY' ? bidQty : askQty;
  const exitSide = ctx.side === 'BUY' ? 'bid' : 'ask';
  const exitLots = exitQty / lotSize;
  const depth = `${exitLots.toFixed(1)} lots on the ${exitSide}`;

  if (exitLots < cfg.minExitDepthLots) {
    return block(gate, label, `${depth} — cannot exit even one lot without walking the book`);
  }

  const total = bidQty + askQty;
  const imbalance = total > 0 ? (bidQty - askQty) / total : 0;
  // Positive imbalance is bid-heavy, which favours a long in this contract.
  const against = ctx.side === 'BUY' ? -imbalance : imbalance;
  const lean = `${imbalance >= 0 ? '+' : ''}${(imbalance * 100).toFixed(0)}% ${imbalance >= 0 ? 'bid' : 'ask'}-heavy`;
  const detail = `${depth}, ${lean}`;

  if (exitLots < cfg.thinExitDepthLots) {
    return warn(gate, label, `${detail} — thin exit, expect slippage beyond the quoted spread`, -0.1);
  }
  if (against > cfg.depthImbalanceWarn) {
    return warn(gate, label, `${detail} — book leans against the ${ctx.side.toLowerCase()}`, -0.05);
  }
  if (-against > cfg.depthImbalanceWarn) {
    return pass(gate, label, `${detail} — book leans with the ${ctx.side.toLowerCase()}`, 0.03);
  }
  return pass(gate, label, detail);
}

/**
 * What is open interest doing at the strike being traded?
 *
 * Deliberately narrower than it looks. `computeSentiment` already folds the
 * *chain aggregate* OI change into `sentiment`, which `gateOptionPosture` already
 * converts into a confidence delta — so an aggregate-OI gate here would count the
 * same evidence twice and quietly double its weight. What is genuinely new is the
 * local fact: "you are buying the 24700 CE, and 24700 calls are the heaviest
 * writing on the chain today" is a different statement from "the chain is net
 * put-building", and only the first one is about this trade.
 *
 * Read with the standard OI-only convention, the same one `computeOiActivity`
 * uses: calls building is resistance forming (bearish), puts building is support
 * (bullish), and unwinding reverses each. That convention assumes the build is
 * writing rather than buying, which cannot be confirmed without premium direction
 * — absent from this snapshot. So the detail says so, and the confidence deltas
 * stay small. This gate never blocks: a strike-local reading is a tilt, not a
 * veto.
 */
function gateStrikeOi(ctx: GateContext, cfg: GateConfig): IndiaGateResult {
  const gate = 'strike-oi';
  const label = 'Strike OI';
  const { instrument, analytics } = ctx;

  if (instrument.contractType !== 'OPT' || instrument.optionType == null || instrument.strike == null) {
    return skip(gate, label, 'not an option contract');
  }
  if (!analytics) {
    return skip(gate, label, 'no chain analytics available');
  }
  if (!analytics.dataQuality.hasBaseline) {
    return skip(gate, label, 'no session baseline yet — OI change is unavailable, not zero');
  }
  const strike = instrument.strike;
  const row = analytics.topStrikes.find((s) => s.strike === strike);
  if (!row) {
    return skip(gate, label, `${strike} is not among the chain's significant strikes`);
  }

  const isCall = instrument.optionType === 'CE';
  const change = isCall ? row.callOIChange : row.putOIChange;
  const standing = isCall ? row.callOI : row.putOI;
  const legName = isCall ? 'call' : 'put';

  if (!(standing > 0)) {
    return skip(gate, label, `${strike} ${legName} carries no open interest`);
  }
  const movePct = change / standing;
  if (Math.abs(movePct) < cfg.strikeOiNoisePct) {
    return pass(gate, label, `${strike} ${legName} OI flat (${(movePct * 100).toFixed(1)}%) — no local read`);
  }

  const building = change > 0;
  // BUILDUP: calls → resistance (bearish), puts → support (bullish).
  // UNWINDING: calls → short covering (bullish), puts → support lifting (bearish).
  const read: 'BULLISH' | 'BEARISH' = isCall ? (building ? 'BEARISH' : 'BULLISH') : (building ? 'BULLISH' : 'BEARISH');
  const bias = directionalBias(instrument, ctx.side);
  const action = building ? 'building' : 'unwinding';
  const magnitude = `${change > 0 ? '+' : '−'}${Math.abs(change).toLocaleString('en-IN')} (${(Math.abs(movePct) * 100).toFixed(0)}% of standing OI)`;
  const caveat = building ? ', read as writing — premium direction unavailable' : '';
  const detail = `${strike} ${legName} OI ${action} ${magnitude} → ${read}${caveat}, vs ${bias} trade`;

  // Strength is capped well below what the chain-aggregate evidence earns: this
  // is one strike, and the writing-vs-buying ambiguity above is unresolved.
  const weight = Math.min(1, Math.abs(movePct) / 0.25);
  if (read === bias) {
    return pass(gate, label, detail, 0.06 * weight);
  }
  return warn(gate, label, detail, -0.06 * weight);
}

/**
 * A take-profit beyond what implied volatility says the market can travel before
 * the close is not a target, it is a hope. The comparison is scaled to the
 * remaining session rather than to expiry, because these are intraday signals.
 *
 * Options and index instruments are checked differently on purpose: an option's
 * entry and target are premium levels, so comparing a premium move against an
 * index-point move would be a unit error. For a long option the equivalent
 * question is whether the break-even sits inside the implied move.
 */
function gateReachableTarget(ctx: GateContext, cfg: GateConfig): IndiaGateResult {
  const a = ctx.analytics;
  const spot = a?.spotPrice ?? null;
  const iv = a?.ivAnalysis.atmIV ?? null;
  const minutesLeft = minutesLeftInSession(ctx.now);

  if (spot == null || iv == null || minutesLeft < 5) {
    return skip('reachable-target', 'Target reach', 'no implied move available for this session');
  }
  const move = expectedMove(spot, iv, minutesLeft / MINUTES_PER_YEAR);
  if (!(move > 0)) return skip('reachable-target', 'Target reach', 'implied move is zero');

  if (ctx.instrument.contractType === 'OPT') {
    const strike = ctx.instrument.strike;
    const optionType = ctx.instrument.optionType;
    if (strike == null || optionType == null) {
      return skip('reachable-target', 'Target reach', 'option contract missing strike');
    }
    if (!isLongPremium(ctx.instrument, ctx.side)) {
      return pass('reachable-target', 'Target reach', `short premium — implied move ${move.toFixed(0)}pt works for the position`);
    }
    const breakEven = breakEvenMovePct(optionType, ctx.entry, spot, strike);
    if (breakEven == null) {
      return skip('reachable-target', 'Target reach', 'break-even not computable');
    }
    const needed = breakEven * spot;
    const ratio = needed / move;
    const detail = `needs ${needed.toFixed(0)}pt to break even, implied move ${move.toFixed(0)}pt over ${minutesLeft}m (${ratio.toFixed(2)}x)`;
    if (ratio > cfg.moveBlockMultiple) return block('reachable-target', 'Target reach', detail);
    if (ratio > cfg.moveWarnMultiple) return warn('reachable-target', 'Target reach', detail, -0.1);
    return pass('reachable-target', 'Target reach', detail);
  }

  const needed = Math.abs(ctx.target - ctx.entry);
  const ratio = needed / move;
  const detail = `target ${needed.toFixed(0)}pt away, implied move ${move.toFixed(0)}pt over ${minutesLeft}m (${ratio.toFixed(2)}x)`;
  if (ratio > cfg.moveBlockMultiple) return block('reachable-target', 'Target reach', detail);
  if (ratio > cfg.moveWarnMultiple) return warn('reachable-target', 'Target reach', detail, -0.1);
  return pass('reachable-target', 'Target reach', detail);
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Run every gate and fold the result into one trail.
 *
 * All gates always run, even after one has blocked. A trail that stops at the
 * first failure hides the other three things that were also wrong, and the
 * point of the trail is to be able to see the whole picture of a decision.
 */
export function runIndiaGates(ctx: GateContext): IndiaSignalGateTrail {
  const cfg: GateConfig = { ...DEFAULT_GATE_CONFIG, ...(ctx.config ?? {}) };
  const gates: IndiaGateResult[] = [
    gateSessionWindow(ctx, cfg),
    gateExpiry(ctx, cfg),
    gateOptionPosture(ctx, cfg),
    // Straight after the chain-wide posture, because it qualifies it: the book can
    // be net bullish while the one strike being traded is the heaviest resistance
    // on the ladder.
    gateStrikeOi(ctx, cfg),
    gateIvRegime(ctx, cfg),
    gateLiquidity(ctx, cfg),
    // Beside the ladder-wide spread check, for the same reason — a tradable chain
    // can still have an untradable contract in it.
    gateBookDepth(ctx, cfg),
    gateReachableTarget(ctx, cfg),
  ];

  const blocked = gates.find((g) => g.verdict === 'BLOCK') ?? null;
  const delta = gates.reduce((sum, g) => sum + (g.confidenceDelta ?? 0), 0);
  const finalConfidence = Math.max(0, Math.min(1, ctx.baseConfidence + delta));

  return {
    passed: blocked == null,
    baseConfidence: ctx.baseConfidence,
    finalConfidence,
    gates,
    blockedBy: blocked?.gate ?? null,
  };
}

/** One-line summary of a trail, for logs and the rejection feed. */
export function summariseTrail(trail: IndiaSignalGateTrail): string {
  if (trail.passed) {
    const warns = trail.gates.filter((g) => g.verdict === 'WARN');
    return warns.length === 0
      ? 'all gates passed'
      : `passed with ${warns.length} warning(s): ${warns.map((g) => g.detail).join('; ')}`;
  }
  const blocking = trail.gates.filter((g) => g.verdict === 'BLOCK');
  return blocking.map((g) => `${g.label}: ${g.detail}`).join('; ');
}
