/**
 * Black-Scholes / Black-76 options mathematics for the Indian derivatives desk.
 *
 * Why this file exists: the broker feed does not carry implied volatility.
 * `brokers/upstox/upstox-market-data.ts` sets `iv: null` with the note "Not
 * provided by Upstox directly", and Zerodha's chain endpoint is not implemented
 * at all. With no IV there are no greeks, so index options were effectively
 * being traded as though they were futures — no theta awareness, and no way to
 * tell whether premium was cheap or expensive.
 *
 * IV does not have to come from the broker. Every option quote already carries
 * its own price, and price is strictly increasing in volatility, so volatility
 * can be recovered from it by inversion. That is all this module does: invert
 * the pricing formula, then differentiate it for the greeks.
 *
 * Conventions, stated once so no call site has to guess:
 *   - Volatility in and out of these functions is a DECIMAL (0.145 = 14.5%).
 *     The broker DTO field `OptionStrikeData.iv` is a PERCENT, by broker
 *     convention; convert at that boundary, never in here.
 *   - Time is in YEARS on a 365-day calendar clock, because that is the clock
 *     the market quotes IV on. A trading-time clock would show truer decay on
 *     expiry day but would not be comparable to any quoted number.
 *   - Greeks are scaled the way a trader reads them: delta per 1 point of spot,
 *     gamma per 1 point of spot, vega per 1 percentage point of vol, theta per
 *     calendar day, rho per 1 percentage point of rate.
 *
 * No dependencies and no I/O. Every function is pure, so all of it is testable
 * without a broker, a clock, or a database.
 */

/** Indian risk-free proxy (roughly the T-bill / MIBOR area). Override per call
 *  if a live curve ever becomes available. */
export const DEFAULT_RISK_FREE_RATE = 0.065;

/** Index options carry no dividend for our purposes; NIFTY is a price index. */
export const DEFAULT_DIVIDEND_YIELD = 0;

/** IST is a fixed +05:30 offset — India has never observed daylight saving. */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Indian equity/derivatives cash session closes at 15:30 IST = 10:00 UTC. */
const CLOSE_HOUR_UTC = 10;

/** Never let time-to-expiry reach zero: it would divide by zero in the greeks
 *  and make the IV solve unbounded. One minute, expressed in years. */
const MIN_YEARS = 1 / (365 * 24 * 60);

const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;

export type OptionKind = 'CE' | 'PE';

export interface OptionGreeks {
  /** Change in option price per 1 point of spot. Calls 0..1, puts -1..0. */
  delta: number;
  /** Change in delta per 1 point of spot. */
  gamma: number;
  /** Change in option price per 1 percentage point of implied volatility. */
  vega: number;
  /** Change in option price per calendar day, holding all else equal. Negative
   *  for long premium — this is the number that quietly empties an account. */
  theta: number;
  /** Change in option price per 1 percentage point of the risk-free rate. */
  rho: number;
}

export interface PricingInputs {
  optionType: OptionKind;
  /** Spot (or index) level. */
  spot: number;
  strike: number;
  /** Time to expiry in years. Use `yearsToExpiry()`. */
  years: number;
  /** Volatility as a decimal (0.145 = 14.5%). */
  volatility: number;
  rate?: number;
  dividendYield?: number;
}

// ---------------------------------------------------------------------------
// Normal distribution
// ---------------------------------------------------------------------------

/** Abramowitz & Stegun 7.1.26. Absolute error < 1.5e-7 — far tighter than the
 *  tick size on any Indian option, so the approximation is free. */
function erf(z: number): number {
  const sign = z < 0 ? -1 : 1;
  const a = Math.abs(z);
  const t = 1 / (1 + 0.3275911 * a);
  const poly =
    t *
    (0.254829592 +
      t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return sign * (1 - poly * Math.exp(-a * a));
}

/** Standard normal CDF. */
export function normCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

/** Standard normal PDF. */
export function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/**
 * The exact instant a contract expires: 15:30 IST on its expiry date.
 *
 * Broker instrument masters give expiry as a bare date, which parses to UTC
 * midnight — 05:30 IST the same calendar day. Taking the IST calendar date and
 * rebuilding it at 15:30 IST is therefore correct for both Zerodha's CSV dump
 * and Upstox's `expiry_date` string, and stays correct if either ever starts
 * sending a real timestamp during the session.
 */
export function expiryInstant(expiryMs: number): number {
  const ist = new Date(expiryMs + IST_OFFSET_MS);
  return Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), CLOSE_HOUR_UTC, 0, 0, 0);
}

/**
 * Time to expiry in years on a 365-day calendar clock, floored just above zero.
 * Returns 0 only when the contract has already expired, which callers should
 * treat as "not tradable" rather than feeding it into the pricer.
 */
export function yearsToExpiry(expiryMs: number, now: number = Date.now()): number {
  const remaining = expiryInstant(expiryMs) - now;
  if (remaining <= 0) return 0;
  return Math.max(MIN_YEARS, remaining / MS_PER_YEAR);
}

/** Whole calendar days to expiry, IST-aware. 0 means it expires today. */
export function daysToExpiry(expiryMs: number, now: number = Date.now()): number {
  const remaining = expiryInstant(expiryMs) - now;
  if (remaining <= 0) return 0;
  return Math.floor(remaining / (24 * 60 * 60 * 1000));
}

/** Minutes remaining until expiry. The number that matters on expiry day. */
export function minutesToExpiry(expiryMs: number, now: number = Date.now()): number {
  const remaining = expiryInstant(expiryMs) - now;
  return remaining <= 0 ? 0 : Math.floor(remaining / 60000);
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

interface Sqrts {
  d1: number;
  d2: number;
  sqrtT: number;
  discount: number;
  carry: number;
}

function terms(p: PricingInputs): Sqrts | null {
  const rate = p.rate ?? DEFAULT_RISK_FREE_RATE;
  const q = p.dividendYield ?? DEFAULT_DIVIDEND_YIELD;
  if (!(p.spot > 0) || !(p.strike > 0) || !(p.years > 0) || !(p.volatility > 0)) return null;
  const sqrtT = Math.sqrt(p.years);
  const vol = p.volatility * sqrtT;
  const d1 = (Math.log(p.spot / p.strike) + (rate - q + 0.5 * p.volatility * p.volatility) * p.years) / vol;
  return {
    d1,
    d2: d1 - vol,
    sqrtT,
    discount: Math.exp(-rate * p.years),
    carry: Math.exp(-q * p.years),
  };
}

/**
 * Generalized Black-Scholes-Merton price. With `dividendYield` left at 0 this is
 * plain Black-Scholes on the index; setting `dividendYield = rate` reduces it to
 * Black-76 on a forward, which is the right form if a futures price is ever
 * substituted for spot.
 *
 * Returns intrinsic value when volatility or time is non-positive, which keeps
 * expiry-day edge cases from producing NaN.
 */
export function optionPrice(p: PricingInputs): number {
  const t = terms(p);
  if (!t) return intrinsicValue(p.optionType, p.spot, p.strike);
  const { d1, d2, discount, carry } = t;
  if (p.optionType === 'CE') {
    return p.spot * carry * normCdf(d1) - p.strike * discount * normCdf(d2);
  }
  return p.strike * discount * normCdf(-d2) - p.spot * carry * normCdf(-d1);
}

/** Payoff if the contract expired right now. */
export function intrinsicValue(optionType: OptionKind, spot: number, strike: number): number {
  return optionType === 'CE' ? Math.max(0, spot - strike) : Math.max(0, strike - spot);
}

/** The part of the premium that decays to nothing by expiry. This is what a
 *  long-premium trade has to overcome before it makes a rupee. */
export function extrinsicValue(optionType: OptionKind, premium: number, spot: number, strike: number): number {
  return Math.max(0, premium - intrinsicValue(optionType, spot, strike));
}

/** Full greek set at a given volatility. */
export function greeks(p: PricingInputs): OptionGreeks | null {
  const t = terms(p);
  if (!t) return null;
  const rate = p.rate ?? DEFAULT_RISK_FREE_RATE;
  const q = p.dividendYield ?? DEFAULT_DIVIDEND_YIELD;
  const { d1, d2, sqrtT, discount, carry } = t;
  const pdf = normPdf(d1);
  const isCall = p.optionType === 'CE';

  const gamma = (carry * pdf) / (p.spot * p.volatility * sqrtT);
  const vegaRaw = p.spot * carry * pdf * sqrtT;
  const decay = -(p.spot * carry * pdf * p.volatility) / (2 * sqrtT);

  const thetaRaw = isCall
    ? decay + q * p.spot * carry * normCdf(d1) - rate * p.strike * discount * normCdf(d2)
    : decay - q * p.spot * carry * normCdf(-d1) + rate * p.strike * discount * normCdf(-d2);

  const rhoRaw = isCall
    ? p.strike * p.years * discount * normCdf(d2)
    : -p.strike * p.years * discount * normCdf(-d2);

  return {
    delta: isCall ? carry * normCdf(d1) : -carry * normCdf(-d1),
    gamma,
    vega: vegaRaw / 100,
    theta: thetaRaw / 365,
    rho: rhoRaw / 100,
  };
}

// ---------------------------------------------------------------------------
// Implied volatility
// ---------------------------------------------------------------------------

export interface ImpliedVolInputs {
  optionType: OptionKind;
  /** Observed market premium — the option's own LTP, or the bid-ask mid. */
  premium: number;
  spot: number;
  strike: number;
  years: number;
  rate?: number;
  dividendYield?: number;
}

/** Widest volatility band we will search: 0.1% to 1000% annualised. Indian
 *  weekly options genuinely trade above 100% on expiry day, so a tight upper
 *  bound would silently clip real quotes. */
const VOL_FLOOR = 0.001;
const VOL_CEILING = 10;

/**
 * Recover implied volatility from an observed premium.
 *
 * Newton-Raphson converges in a handful of steps for anything near the money,
 * but vega collapses toward zero deep in and deep out of the money, which makes
 * Newton diverge exactly where the chain is least liquid. So a bisection
 * fallback runs whenever Newton fails to land — slower, but it cannot diverge,
 * because price is monotonic in volatility.
 *
 * Returns null rather than a wrong number when the quote is unsolvable: no
 * time left, premium below intrinsic (stale or crossed quote), or premium above
 * the theoretical maximum. A null IV should propagate as "unknown", never as 0.
 */
export function impliedVolatility(input: ImpliedVolInputs): number | null {
  const { optionType, premium, spot, strike, years } = input;
  const rate = input.rate ?? DEFAULT_RISK_FREE_RATE;
  const q = input.dividendYield ?? DEFAULT_DIVIDEND_YIELD;

  if (!Number.isFinite(premium) || !Number.isFinite(spot) || !Number.isFinite(strike)) return null;
  if (premium <= 0 || spot <= 0 || strike <= 0 || years <= 0) return null;

  const discount = Math.exp(-rate * years);
  const carry = Math.exp(-q * years);

  // No-arbitrage bounds. Outside them no volatility reproduces the quote.
  const lower =
    optionType === 'CE'
      ? Math.max(0, spot * carry - strike * discount)
      : Math.max(0, strike * discount - spot * carry);
  const upper = optionType === 'CE' ? spot * carry : strike * discount;
  if (premium <= lower + 1e-9 || premium >= upper - 1e-9) return null;

  const priceAt = (vol: number): number =>
    optionPrice({ optionType, spot, strike, years, volatility: vol, rate, dividendYield: q });

  // Brenner-Subrahmanyam gives a good opening guess for near-the-money quotes.
  let vol = Math.min(
    VOL_CEILING,
    Math.max(VOL_FLOOR, (premium / spot) * Math.sqrt((2 * Math.PI) / years)),
  );

  const tolerance = Math.max(1e-8, 1e-6 * premium);

  for (let i = 0; i < 60; i += 1) {
    const diff = priceAt(vol) - premium;
    if (Math.abs(diff) < tolerance) return vol;
    const g = greeks({ optionType, spot, strike, years, volatility: vol, rate, dividendYield: q });
    // `vega` is per percentage point; Newton needs the raw derivative.
    const vegaRaw = g ? g.vega * 100 : 0;
    if (!Number.isFinite(vegaRaw) || Math.abs(vegaRaw) < 1e-10) break;
    const next = vol - diff / vegaRaw;
    if (!Number.isFinite(next) || next <= VOL_FLOOR || next >= VOL_CEILING) break;
    if (Math.abs(next - vol) < 1e-12) return next;
    vol = next;
  }

  // Bisection fallback. Monotonicity guarantees a root inside the bracket.
  let lo = VOL_FLOOR;
  let hi = VOL_CEILING;
  if (priceAt(lo) > premium || priceAt(hi) < premium) return null;
  for (let i = 0; i < 200; i += 1) {
    const mid = 0.5 * (lo + hi);
    const diff = priceAt(mid) - premium;
    if (Math.abs(diff) < tolerance) return mid;
    if (diff > 0) hi = mid;
    else lo = mid;
  }
  const mid = 0.5 * (lo + hi);
  return Number.isFinite(mid) ? mid : null;
}

/** Solve IV and the greeks together, which is the common case at a call site. */
export function solveOption(input: ImpliedVolInputs): { iv: number; greeks: OptionGreeks } | null {
  const iv = impliedVolatility(input);
  if (iv == null) return null;
  const g = greeks({
    optionType: input.optionType,
    spot: input.spot,
    strike: input.strike,
    years: input.years,
    volatility: iv,
    rate: input.rate,
    dividendYield: input.dividendYield,
  });
  return g ? { iv, greeks: g } : null;
}

// ---------------------------------------------------------------------------
// Derived measures the signal engine needs
// ---------------------------------------------------------------------------

/**
 * One-standard-deviation move implied by the market over `years`, in points.
 *
 * This is the honest yardstick for a target: a take-profit beyond the implied
 * move is not a target, it is a hope. It is also how the expiry-day gate decides
 * whether a long-premium trade can clear its own remaining extrinsic value.
 */
export function expectedMove(spot: number, volatility: number, years: number): number {
  if (!(spot > 0) || !(volatility > 0) || !(years > 0)) return 0;
  return spot * volatility * Math.sqrt(years);
}

/** Log-moneyness, normalised by the implied move — how many sigma out a strike
 *  is. Comparable across underlyings and across volatility regimes, unlike a
 *  raw point distance. */
export function standardisedMoneyness(
  spot: number,
  strike: number,
  volatility: number,
  years: number,
): number | null {
  if (!(spot > 0) || !(strike > 0) || !(volatility > 0) || !(years > 0)) return null;
  return Math.log(spot / strike) / (volatility * Math.sqrt(years));
}

/**
 * Break-even move required for a long option to profit by expiry, as a fraction
 * of spot. Directly comparable with `expectedMove / spot`: if the break-even
 * exceeds the implied move, the market is charging more than the move is worth.
 */
export function breakEvenMovePct(
  optionType: OptionKind,
  premium: number,
  spot: number,
  strike: number,
): number | null {
  if (!(premium > 0) || !(spot > 0) || !(strike > 0)) return null;
  const breakEven = optionType === 'CE' ? strike + premium : strike - premium;
  return Math.abs(breakEven - spot) / spot;
}
