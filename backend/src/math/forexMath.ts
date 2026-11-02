/**
 * Pure forex math: pip values, position sizing, margin, P&L, R:R and
 * expected value. Every function is deterministic and unit-testable.
 */
import {
  ForexAsset,
  getAsset,
  priceToPips,
  pipValueInQuote,
  roundLotUp,
} from '@fx/shared';
import { effectiveSpec } from '../forex/symbol-spec';

/**
 * Effective pip value per standard lot in the QUOTE currency, from the
 * broker-issued contract size when a bound account provides one (XM/MT5
 * pattern: pip value = pipSize × contractSize of the account's own terms).
 */
function effectivePipValueQuote(symbol: string, contractSize: number): number {
  const a = getAsset(symbol);
  return a.pipSize * contractSize;
}

export interface SizingInput {
  symbol: string;
  accountCurrency: string;
  capital: number; // available capital in account currency
  riskPercent: number; // % of capital to risk
  entryPrice: number;
  stopLossPrice: number;
  /** USD price of 1 unit of account currency (1 if account is USD). */
  usdRate: number;
  /** Current price used to convert pip value for non-USD accounts. */
  currentPrice?: number;
  maxLeverage: number;
}

export interface SizingOutput {
  lots: number;
  units: number;
  riskAmount: number;
  pipDistance: number;
  pipValuePerLotAccount: number;
  marginRequired: number;
  expectedLoss: number;
  expectedProfit: number;
  rr: number;
  leverageUsed: number;
  minimumLotReached: boolean;
  maximumLotReached: boolean;
  valid: boolean;
  reason: string;
}

export function calculateSizing(input: SizingInput): SizingOutput {
  const asset = getAsset(input.symbol);
  const accountCurrency = canonicalAccountCurrency(input.accountCurrency);
  const fail = (reason: string): SizingOutput => ({
    lots: 0, units: 0, riskAmount: 0, pipDistance: 0, pipValuePerLotAccount: 0,
    marginRequired: 0, expectedLoss: 0, expectedProfit: 0, rr: 0, leverageUsed: 0,
    minimumLotReached: false, maximumLotReached: false, valid: false, reason,
  });

  if (input.capital <= 0) return fail('capital must be positive');
  if (input.riskPercent <= 0 || input.riskPercent > 100) return fail('riskPercent must be in (0, 100]');
  if (input.entryPrice <= 0 || input.stopLossPrice <= 0) return fail('invalid prices');
  if (input.entryPrice === input.stopLossPrice) return fail('SL must differ from entry');

  // Broker-issued terms (XM/MT5 pattern): contract size and lot geometry come
  // from the bound account when it reports them; the catalog is only the
  // fallback. This keeps lots, pip value and margin identical to MT5's.
  const spec = effectiveSpec(input.symbol);
  const riskAmount = input.capital * (input.riskPercent / 100);

  // pip value per standard lot in account currency
  const pipValueQuote = effectivePipValueQuote(input.symbol, spec.contractSize);
  // usdRate semantics: units of QUOTE currency per 1 unit of ACCOUNT currency
  // (from accountQuoteRate). When the pair's quote IS the account currency no
  // conversion applies; otherwise the rate MUST be live — sizing at an
  // invented parity silently mis-prices risk by ~100× on JPY/CHF/CAD/GBP pairs.
  let pipValueAccount = pipValueQuote;
  let quotePerAccount = 1;
  const needsConversion = asset.quoteCurrency !== accountCurrency
    && !(asset.quoteCurrency === 'USDT' && accountCurrency === 'USD');
  if (needsConversion) {
    if (!Number.isFinite(input.usdRate) || input.usdRate <= 0) {
      return fail(`no live ${asset.quoteCurrency}/${accountCurrency} conversion rate — cannot size safely`);
    }
    quotePerAccount = input.usdRate;
    pipValueAccount = pipValueQuote / quotePerAccount;
  }

  const pipDistance = Math.abs(priceToPips(input.symbol, input.entryPrice - input.stopLossPrice));
  if (pipDistance <= 0 || !Number.isFinite(pipDistance)) return fail('SL distance must be positive');

  // Floor to the lot step WITHOUT clamping up to the minimum lot: a position
  // forced up to the broker minimum could risk multiples of the configured
  // risk percent (the dynamic-sizing engine already blocks honestly).
  const rawLots = riskAmount / (pipDistance * pipValueAccount);
  const stepped = Number((Math.floor(rawLots / spec.lotStep + 1e-9) * spec.lotStep).toFixed(asset.quantityPrecision));
  if (!Number.isFinite(stepped) || stepped < spec.minLot) {
    return fail('risk too small for minimum lot');
  }
  const lots = Math.min(stepped, spec.maxLot);
  const minimumLotReached = lots <= spec.minLot;
  const maximumLotReached = lots >= spec.maxLot;

  const units = lots * spec.contractSize;
  const notionalQuote = units * input.entryPrice;
  // margin + effective leverage are measured in ACCOUNT currency against the
  // account-currency capital (quote-currency notionals are ~100× larger on
  // JPY pairs and would trip the leverage cap for every non-USD-quote pair).
  // While an account is bound, ITS leverage defines the margin rate — the
  // same number the MT5/XM terminal enforces on the real order.
  const notionalAccount = notionalQuote / quotePerAccount;
  const marginRate = spec.marginRequirement > 0 ? spec.marginRequirement : asset.marginRequirement;
  const marginRequired = notionalAccount * marginRate;
  const leverageUsed = notionalAccount / input.capital;
  const actualRisk = pipDistance * pipValueAccount * lots;
  const expectedProfit = actualRisk; // placeholder; TP engine sets R:R
  const rr = 1; // placeholder until TP1 exists (see computeRr)

  if (!Number.isFinite(leverageUsed)) return fail('leverage computation failed');
  if (leverageUsed > input.maxLeverage) return fail(`leverage ${leverageUsed.toFixed(1)} exceeds max ${input.maxLeverage}`);

  return {
    lots, units, riskAmount, pipDistance, pipValuePerLotAccount: pipValueAccount,
    marginRequired, expectedLoss: actualRisk, expectedProfit, rr,
    leverageUsed, minimumLotReached, maximumLotReached, valid: true, reason: 'ok',
  };
}

/** P&L uses the CONTRACT SIZE PASSED BY THE CALLER — the paper engine passes
 *  the effective (broker-issued) size so the number equals what MT5 shows. */
export function pnlForPosition(asset: { contractSize: number }, lots: number, direction: 'BUY' | 'SELL', entry: number, exit: number): number {
  const perUnit = direction === 'BUY' ? exit - entry : entry - exit;
  return perUnit * lots * asset.contractSize;
}

/** Quote-currency price of 1 USD for a pair, from live cross rates. Falls
 *  back to an implicit rate of 1 ONLY for USD/USDT-quoted pairs; callers that
 *  cannot tolerate an unconverted amount must use quotePerUsdStrict. */
function quotePerUsdFor(symbol: string, getMid: (s: string) => number | undefined): number {
  const a = getAsset(symbol);
  if (a.quoteCurrency === 'USD' || a.quoteCurrency === 'USDT') return 1;
  const direct = getMid(`USD/${a.quoteCurrency}`);
  if (direct && direct > 0) return direct;
  if (a.quoteCurrency === 'GBP') {
    const g = getMid('GBP/USD');
    if (g && g > 0) return 1 / g;
  }
  return 1;
}

/** Strict quote-per-USD lookup: undefined when no reliable cross-rate path
 *  exists. Sizing paths MUST use this — silently treating JPY/CHF/CAD as USD
 *  mis-sizes positions by ~100×. */
function quotePerUsdStrict(symbol: string, getMid: (s: string) => number | undefined): number | undefined {
  const a = getAsset(symbol);
  if (a.quoteCurrency === 'USD' || a.quoteCurrency === 'USDT') return 1;
  const direct = getMid(`USD/${a.quoteCurrency}`);
  if (direct && Number.isFinite(direct) && direct > 0) return direct;
  if (a.quoteCurrency === 'GBP') {
    const g = getMid('GBP/USD');
    if (g && Number.isFinite(g) && g > 0) return 1 / g;
  }
  return undefined;
}

/**
 * Live quote-per-USD rate for a symbol's quote currency (null when no honest
 * cross-rate path exists). Used to convert USD-denominated costs (commission,
 * swap) into a pair's quote currency before they are netted against
 * quote-currency P&L — mixing the two units understated JPY-pair costs ~150×.
 */
export function quotePerUsdLive(symbol: string, getMid: (s: string) => number | undefined): number | null {
  return quotePerUsdStrict(symbol, getMid) ?? null;
}

/**
 * Converts an amount in a pair's QUOTE currency into the ACCOUNT currency,
 * using live cross rates (USD/INR for INR accounts). USD accounts keep the
 * existing quote-currency behavior. Falls back to the raw amount while the
 * rate feed has not produced a price yet (never invents prices).
 * quotePerUsdFor = units of quote currency per 1 USD, so the conversion is
 * quoteAmount ÷ quotePerUsd × accountPerUsd (e.g. JPY→₹: ÷145 × 84).
 */
export function toAccountCurrency(
  symbol: string,
  accountCurrency: string,
  quoteAmount: number,
  getMid: (s: string) => number | undefined,
): number {
  if (accountCurrency === 'USD' || !Number.isFinite(quoteAmount)) return quoteAmount;
  const accountPerUsd = getMid(`USD/${accountCurrency}`);
  if (!accountPerUsd || accountPerUsd <= 0) return quoteAmount;
  const perUsd = quotePerUsdFor(symbol, getMid);
  if (perUsd <= 0) return quoteAmount;
  return (quoteAmount / perUsd) * accountPerUsd;
}

/**
 * STRICT quote-currency → account-currency conversion for MONEY GATES:
 * returns undefined when no honest cross-rate path exists. Unlike
 * toAccountCurrency this never degrades to parity — a JPY/CHF/CAD-quoted
 * notional treated as USD overstates exposure/risk/margin ~100-150× and
 * silently mis-gates entries (circuit breakers, margin, min-profit).
 */
export function quoteToAccountStrict(
  symbol: string,
  accountCurrency: string,
  quoteAmount: number,
  getMid: (s: string) => number | undefined,
): number | undefined {
  if (!Number.isFinite(quoteAmount)) return undefined;
  const q = getAsset(symbol).quoteCurrency;
  const sameCcy = accountCurrency === q || (q === 'USDT' && accountCurrency === 'USD');
  if (sameCcy) return quoteAmount;
  const perUsd = quotePerUsdStrict(symbol, getMid);
  if (perUsd === undefined) return undefined;
  if (accountCurrency === 'USD') return quoteAmount / perUsd;
  const accountPerUsd = getMid(`USD/${accountCurrency}`);
  if (!accountPerUsd || accountPerUsd <= 0) return undefined;
  return (quoteAmount / perUsd) * accountPerUsd;
}

/**
 * Converts a USD-denominated amount into the ACCOUNT currency (₹ for INR)
 * using the live USD/INR rate. USD accounts pass through unchanged. Falls back
 * to the raw amount while the rate feed is silent.
 */
export function usdToAccount(
  accountCurrency: string,
  usdAmount: number,
  getMid: (s: string) => number | undefined,
): number {
  if (accountCurrency === 'USD' || !Number.isFinite(usdAmount)) return usdAmount;
  const accountPerUsd = getMid(`USD/${accountCurrency}`);
  if (!accountPerUsd || accountPerUsd <= 0) return usdAmount;
  return usdAmount * accountPerUsd;
}

/**
 * Sizing rate (usdRate semantics): units of a pair's QUOTE currency per 1 unit
 * of the ACCOUNT currency, from live cross rates. Returns NaN when no reliable
 * rate path exists — callers must fail closed rather than size at an invented
 * parity (a silent 1 here mis-sized every JPY/CHF/CAD/GBP-quoted pair on USD
 * accounts by ~100–150×). USDT-quoted pairs convert through USD at parity.
 */
export function accountQuoteRate(
  symbol: string,
  accountCurrency: string,
  getMid: (s: string) => number | undefined,
): number {
  const account = canonicalAccountCurrency(accountCurrency);
  const quotePerUsd = quotePerUsdStrict(symbol, getMid);
  if (quotePerUsd === undefined) return NaN;
  if (account === 'USD') return quotePerUsd;
  const accountPerUsd = getMid(`USD/${account}`);
  if (!accountPerUsd || !Number.isFinite(accountPerUsd) || accountPerUsd <= 0) return NaN;
  return quotePerUsd / accountPerUsd;
}

/** Stablecoin parity: a USDT account currency converts through USD at 1:1. */
function canonicalAccountCurrency(c: string): string {
  return c === 'USDT' ? 'USD' : c;
}

export function pipsBetween(asset: ForexAsset, a: number, b: number): number {
  return Math.abs(a - b) / asset.pipSize;
}

export interface EvInput {
  probabilityWin: number; // 0..1
  averageWin: number; // per standard lot, account currency
  averageLoss: number; // per standard lot, account currency (positive number)
  spread: number; // per standard lot cost
  commission: number;
  slippage: number;
  swap: number; // per day cost (approximated for trade horizon)
  riskReward: number; // average win / average loss
  positionLots: number;
}

export function expectedValue(input: EvInput): number {
  const pWin = Math.min(1, Math.max(0, input.probabilityWin));
  const pLoss = 1 - pWin;
  // Inputs are per standard lot; scale by the actual position size so EV is
  // expressed for the trade as sized (multi-lot positions must not report
  // single-lot economics).
  const lots = Number.isFinite(input.positionLots) ? Math.max(0, input.positionLots) : 1;
  const gross = (pWin * input.averageWin - pLoss * input.averageLoss) * lots;
  const costs = (input.spread + input.commission + input.slippage + input.swap) * lots;
  return gross - costs;
}

/** Probability needed for breakeven at a given R:R including costs. */
export function breakevenProbability(rr: number, costRR: number): number {
  if (rr <= 0) return 1;
  return (1 + costRR) / (1 + rr);
}

export interface RrResult {
  rr: number;
  valid: boolean;
  minRr: number;
}

export function computeRr(entry: number, sl: number, tp1: number): RrResult {
  const risk = Math.abs(entry - sl);
  const reward = Math.abs(tp1 - entry);
  const rr = risk > 0 ? reward / risk : 0;
  return { rr, valid: Number.isFinite(rr) && rr > 0, minRr: 0 };
}

export interface GoalFeasibilityInput {
  symbol: string;
  accountCurrency: string;
  capital: number;
  riskPercent: number; // max % of capital the position may risk
  goalProfit: number; // minimum net profit target in account currency
  entryPrice: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  /** units of quote currency per 1 unit of account currency */
  usdRate: number;
  maxLeverage: number;
  maxMarginUsedPct: number; // 0 = unlimited
  /** Live cross-rate lookup for margin/leverage conversion (USD accounts can
   *  omit; a USD rate feed is REQUIRED for non-USD accounts — without it the
   *  position is reported not achievable rather than mis-priced). */
  getMid?: (s: string) => number | undefined;
}

export interface GoalFeasibility {
  lots: number;
  riskAmount: number;
  riskPctRequired: number;
  expectedProfit: number;
  marginPct: number;
  leverageUsed: number;
  rr: number;
  achievable: boolean;
  reason: string;
}

/**
 * Goal-driven sizing: sizes the position UP to the next lot step so the TP1
 * move covers the goal (consuming as much margin as the caps allow), then
 * checks the position against the user's risk, margin and leverage caps. Never
 * raises risk beyond the cap to chase the goal — if the goal needs more than
 * allowed, it reports exactly which cap binds.
 */
export function goalFeasibility(input: GoalFeasibilityInput): GoalFeasibility {
  const fail = (reason: string): GoalFeasibility => ({
    lots: 0, riskAmount: 0, riskPctRequired: 0, expectedProfit: 0,
    marginPct: 0, leverageUsed: 0, rr: 0, achievable: false, reason,
  });
  const asset = getAsset(input.symbol);
  if (input.goalProfit <= 0) return fail('goal profit must be positive');
  if (input.capital <= 0) return fail('capital must be positive');
  if (input.riskPercent <= 0 || input.riskPercent > 100) return fail('riskPercent must be in (0, 100]');
  // Broker-issued terms for the goal hunt too (lot step, contract size).
  const spec = effectiveSpec(input.symbol);

  const direction = input.stopLossPrice < input.entryPrice ? 'BUY' : 'SELL';
  const tpInDirection = direction === 'BUY'
    ? input.takeProfitPrice > input.entryPrice
    : input.takeProfitPrice < input.entryPrice;
  if (!tpInDirection) return fail('take profit is on the wrong side of entry');

  const pipValueQuote = effectivePipValueQuote(input.symbol, spec.contractSize);
  let pipValueAccount = pipValueQuote;
  if (asset.quoteCurrency !== input.accountCurrency && !(asset.quoteCurrency === 'USDT' && input.accountCurrency === 'USD')) {
    if (!Number.isFinite(input.usdRate) || input.usdRate <= 0) {
      return fail(`no live ${asset.quoteCurrency}/${input.accountCurrency} conversion rate — cannot price goal safely`);
    }
    pipValueAccount = pipValueQuote / input.usdRate;
  }

  const tpPips = priceToPips(input.symbol, Math.abs(input.takeProfitPrice - input.entryPrice));
  const slPips = priceToPips(input.symbol, Math.abs(input.stopLossPrice - input.entryPrice));
  if (tpPips <= 0) return fail('take profit distance must be positive');
  if (slPips <= 0) return fail('SL distance must be positive');

  const rr = tpPips / slPips;

  // Size so the TP move alone covers the goal — round UP to the next lot step
  // so the goal is actually reached (consumes margin up to the caps below).
  // When margin is available we then SCALE UP to the max the caps allow —
  // the user asked to "use lots as much can margin available" so a small
  // goal like ₹500 still trades at 85% margin rather than 0.01 lots and
  // reaches the target in fewer, larger winning ticks (fast markets only).
  let lotsForGoal = input.goalProfit / (tpPips * pipValueAccount);
  lotsForGoal = roundLotUp(input.symbol, lotsForGoal);
  if (lotsForGoal <= 0) return fail('goal profit too small for minimum lot size');
  if (lotsForGoal > spec.maxLot) {
    const maxProfit = tpPips * pipValueAccount * spec.maxLot;
    return fail(`goal ${input.goalProfit} unreachable — max profit at maximum lot is ${maxProfit.toFixed(2)}`);
  }

  // Max lots the caps allow (risk/margin/leverage), floored to the lot step.
  // quotePerAccount is already pipValueQuote/pipValueAccount; margin/notional
  // per lot in ACCOUNT currency is quote-figure / quotePerAccount.
  let quotePerAccountForMargin = 1;
  if (asset.quoteCurrency !== input.accountCurrency && !(asset.quoteCurrency === 'USDT' && input.accountCurrency === 'USD')) {
    quotePerAccountForMargin = Number.isFinite(input.usdRate) && input.usdRate > 0 ? input.usdRate : 1;
  }
  const riskAmountAllowed = input.capital * (input.riskPercent / 100);
  const maxLotsByRiskRaw = riskAmountAllowed / (slPips * pipValueAccount);
  const maxLotsByRisk = Number((Math.floor(maxLotsByRiskRaw / spec.lotStep + 1e-9) * spec.lotStep).toFixed(asset.quantityPrecision));

  const marginPerLotAccount = (spec.contractSize * input.entryPrice * (spec.marginRequirement > 0 ? spec.marginRequirement : asset.marginRequirement)) / quotePerAccountForMargin;
  const maxLotsByMargin = input.maxMarginUsedPct > 0 && marginPerLotAccount > 0
    ? Number((Math.floor((input.capital * (input.maxMarginUsedPct / 100) / marginPerLotAccount) / spec.lotStep + 1e-9) * spec.lotStep).toFixed(asset.quantityPrecision))
    : spec.maxLot;

  const notionalPerLotAccount = (spec.contractSize * input.entryPrice) / quotePerAccountForMargin;
  const maxLotsByLeverage = notionalPerLotAccount > 0
    ? Number((Math.floor((input.capital * input.maxLeverage / notionalPerLotAccount) / spec.lotStep + 1e-9) * spec.lotStep).toFixed(asset.quantityPrecision))
    : spec.maxLot;

  let maxAllowed = Math.min(maxLotsByRisk, maxLotsByMargin, maxLotsByLeverage, spec.maxLot);
  // Clamp to broker minimum — if caps leave less than one lot, the goal is not
  // tradable rather than silently trading a dust size that misstates risk.
  if (maxAllowed < spec.minLot) maxAllowed = 0;

  // Use as much margin as the caps allow — the TP still covers the goal, but
  // the larger size reaches it on the first fast move rather than many small ones.
  // If maxAllowed is smaller than what's needed for the goal, the later
  // risk/margin/leverage gates will report the exact blocker.
  let lots = lotsForGoal;
  if (maxAllowed > lotsForGoal) lots = maxAllowed;
  // Re-clamp to exact lot step after the max() (maxAllowed is already stepped).
  lots = Number((Math.floor(lots / spec.lotStep + 1e-9) * spec.lotStep).toFixed(asset.quantityPrecision));

  const riskAmount = slPips * pipValueAccount * lots;
  const riskPctRequired = Number(((riskAmount / input.capital) * 100).toFixed(6));
  const expectedProfit = Number((tpPips * pipValueAccount * lots).toFixed(6));
  // Keep the original risk gate for the final size (fast path may have pushed
  // risk to the cap edge; reject rather than silently exceed it).
  if (riskPctRequired > input.riskPercent + 1e-9) {
    return {
      ...{ lots, riskAmount, riskPctRequired, expectedProfit, marginPct: 0, leverageUsed: 0, rr },
      achievable: false,
      reason: `goal ${input.goalProfit} ${input.accountCurrency} needs ${riskPctRequired.toFixed(1)}% risk > max ${input.riskPercent}% (${riskAmount.toFixed(0)} ${input.accountCurrency} at risk)`,
    };
  }

  const units = lots * spec.contractSize;
  const notionalQuote = units * input.entryPrice;
  const marginQuote = notionalQuote * (spec.marginRequirement > 0 ? spec.marginRequirement : asset.marginRequirement);
  const getMid = input.getMid ?? (() => undefined);
  // STRICT conversion: a JPY/CHF/CAD-quoted margin silently treated as USD
  // overstates margin ~100-150× (marginPct ~11500% — blocked every honest
  // trade) or understates it. No honest rate ⇒ fail closed with the reason.
  const marginAccount = quoteToAccountStrict(input.symbol, input.accountCurrency, marginQuote, getMid);
  const notionalAccount = quoteToAccountStrict(input.symbol, input.accountCurrency, notionalQuote, getMid);
  if (marginAccount === undefined || notionalAccount === undefined) {
    return {
      lots, riskAmount, riskPctRequired, expectedProfit, marginPct: 0, leverageUsed: 0, rr,
      achievable: false,
      reason: `no live ${getAsset(input.symbol).quoteCurrency}/${input.accountCurrency} conversion rate — cannot price margin safely`,
    };
  }
  const marginPct = Number((input.capital > 0 ? (marginAccount / input.capital) * 100 : 0).toFixed(6));
  const leverageUsed = Number((input.capital > 0 ? notionalAccount / input.capital : 0).toFixed(6));

  if (input.maxMarginUsedPct > 0 && marginPct > input.maxMarginUsedPct) {
    return {
      lots, riskAmount, riskPctRequired, expectedProfit, marginPct, leverageUsed, rr,
      achievable: false,
      reason: `margin ${marginPct.toFixed(1)}% exceeds max ${input.maxMarginUsedPct}%`,
    };
  }
  if (leverageUsed > input.maxLeverage) {
    return {
      lots, riskAmount, riskPctRequired, expectedProfit, marginPct, leverageUsed, rr,
      achievable: false,
      reason: `leverage ${leverageUsed.toFixed(1)} exceeds max ${input.maxLeverage}`,
    };
  }
  if (expectedProfit < input.goalProfit) {
    return {
      lots, riskAmount, riskPctRequired, expectedProfit, marginPct, leverageUsed, rr,
      achievable: false,
      reason: `expected profit ${expectedProfit.toFixed(2)} below goal ${input.goalProfit}`,
    };
  }
  return {
    lots, riskAmount, riskPctRequired, expectedProfit, marginPct, leverageUsed, rr,
    achievable: true,
    reason: 'ok',
  };
}
