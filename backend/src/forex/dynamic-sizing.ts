/**
 * DynamicLotSizingService (spec §1–§8, §11–§13).
 *
 * Sizes every new Forex position as the LARGEST lot that is valid under ALL
 * configured constraints simultaneously:
 *
 *   finalLots = MIN( marginMax, riskMax, capitalMax, brokerMax, userMax )
 *   → floored to the broker's lot step (never rounded up past a limit)
 *   → TRADE BLOCKED with the exact reason when the result is below minLot
 *
 * Constraints are computed independently from LIVE account state each time —
 * balance/equity/freeMargin are re-read per trade, never carried over.
 * Leverage divides exposure into required margin; it never multiplies P&L.
 */
import { getAsset } from '@fx/shared';
import { CurrencyConversionService } from './currency-conversion';
import { requiredMargin } from './pip-margin';

export interface DynamicSizingInput {
  symbol: string;
  accountCurrency: string;
  /** Live wallet snapshot (INR when the account is INR) — read fresh per trade. */
  balanceAccount: number;
  equityAccount: number;
  usedMarginAccount: number;
  /** User's "amount to use" allocation (INR). Acts as the capital boundary. */
  allocatedAccount: number;
  /** Max margin per trade as % of the allocation (0/absent = unlimited). */
  maxMarginPercent: number;
  /** Max risk for this trade in account currency (INR). 0 = unlimited. */
  maxRiskAccount: number;
  entryPrice: number;
  stopLossPrice: number;
  direction: 'BUY' | 'SELL';
  fx: CurrencyConversionService;
  /** Optional user ceiling in lots. Undefined/0 = disabled. */
  userMaxLots?: number;
}

export interface SizingLimits {
  marginBasedLots: number;
  riskBasedLots: number;
  capitalBasedLots: number;
  brokerMaxLots: number;
  userMaxLots: number | null;
}

export interface LotBreakdown {
  valid: boolean;
  reason: string;
  finalLots: number;

  // Wallet snapshot actually used (fresh at calculation time)
  balanceAccount: number;
  equityAccount: number;
  freeMarginAccount: number;
  usedMarginAccount: number;
  amountAllocatedAccount: number;
  maxMarginAllowedAccount: number;
  maxRiskAllowedAccount: number;

  // Per-lot economics at the current price
  priceUsed: number;
  marginPerLotAccount: number;
  riskPerLotAccount: number;
  notionalPerLotAccount: number;
  quotePipValuePerLot: number;
  slDistancePips: number;
  leverage: number;

  limits: SizingLimits;

  // Expected outcome AT THE FINAL LOT (§10)
  expectedProfitAtTp?: number;
  expectedLossAtSl?: number;
}

function floorToStep(value: number, step: number): number {
  const steps = Math.floor(value / step + 1e-9);
  return Number((steps * step).toFixed(8));
}

const INF = Number.POSITIVE_INFINITY;

/**
 * Largest valid lot for one candidate trade. Never throws for business
 * reasons — an unsizable trade returns valid=false with the binding reason.
 */
export function computeDynamicLots(input: DynamicSizingInput): LotBreakdown {
  const asset = getAsset(input.symbol);
  const freeMargin = Math.max(0, input.equityAccount - input.usedMarginAccount);
  const allocated = Math.max(0, input.allocatedAccount);

  // ── Per-lot economics at the live price (account currency) ──────────────
  const marginPerLot = requiredMargin(input.symbol, 1, input.entryPrice, input.accountCurrency, input.fx);
  const slDistance = Math.abs(input.entryPrice - input.stopLossPrice);
  const quotePipValuePerLot = asset.pipSize * asset.contractSize;
  let riskPerLot = INF;
  let slPips = 0;
  if (slDistance > 0) {
    slPips = slDistance / asset.pipSize;
    const conv = input.fx.quoteToAccount(input.symbol, input.accountCurrency, quotePipValuePerLot * slPips);
    riskPerLot = conv.amount; // loss per 1.0 lot if SL is hit (quote→INR)
  }

  // ── Independent limits (lots) ────────────────────────────────────────────
  // Margin: allowed = min(free margin, allocated × maxMargin%) — a disabled
  // pct (0) means the allocation alone bounds it, never the whole wallet.
  const pctCap = input.maxMarginPercent > 0 ? allocated * (input.maxMarginPercent / 100) : allocated;
  const maxMarginAllowed = Math.min(freeMargin, pctCap);
  const marginBasedLots = marginPerLot.requiredMarginAccount > 0
    ? maxMarginAllowed / marginPerLot.requiredMarginAccount
    : 0;

  const riskBasedLots = input.maxRiskAccount > 0 && riskPerLot > 0
    ? input.maxRiskAccount / riskPerLot
    : INF;

  // Capital boundary: the whole allocation may back this trade's margin.
  const capitalBasedLots = marginPerLot.requiredMarginAccount > 0
    ? allocated / marginPerLot.requiredMarginAccount
    : 0;

  const brokerMaxLots = asset.maximumLot;
  const userMaxLots = input.userMaxLots && input.userMaxLots > 0 ? input.userMaxLots : INF;

  const rawMin = Math.min(marginBasedLots, riskBasedLots, capitalBasedLots, brokerMaxLots, userMaxLots);
  const finalLots = floorToStep(rawMin, asset.lotStep);

  const breakdown: LotBreakdown = {
    valid: false,
    reason: '',
    finalLots,
    balanceAccount: input.balanceAccount,
    equityAccount: input.equityAccount,
    freeMarginAccount: freeMargin,
    usedMarginAccount: input.usedMarginAccount,
    amountAllocatedAccount: allocated,
    maxMarginAllowedAccount: maxMarginAllowed,
    maxRiskAllowedAccount: input.maxRiskAccount,
    priceUsed: input.entryPrice,
    marginPerLotAccount: marginPerLot.requiredMarginAccount,
    riskPerLotAccount: Number.isFinite(riskPerLot) ? riskPerLot : 0,
    notionalPerLotAccount: marginPerLot.notionalAccount,
    quotePipValuePerLot,
    slDistancePips: slPips,
    leverage: marginPerLot.leverage,
    limits: {
      marginBasedLots: Number.isFinite(marginBasedLots) ? Math.floor(marginBasedLots * 10000) / 10000 : 9999,
      riskBasedLots: Number.isFinite(riskBasedLots) ? Math.floor(riskBasedLots * 10000) / 10000 : 9999,
      capitalBasedLots: Number.isFinite(capitalBasedLots) ? Math.floor(capitalBasedLots * 10000) / 10000 : 9999,
      brokerMaxLots,
      userMaxLots: Number.isFinite(userMaxLots) ? userMaxLots : null,
    },
  };

  // ── Validity gates (§8): block honestly, never force minLot ─────────────
  if (!(input.entryPrice > 0)) return { ...breakdown, finalLots: 0, reason: 'invalid entry price' };
  if (slDistance <= 0) return { ...breakdown, finalLots: 0, reason: 'stop-loss must differ from entry' };
  if (finalLots < asset.minimumLot) {
    const binding =
      marginBasedLots <= riskBasedLots && marginBasedLots <= capitalBasedLots
        ? `insufficient margin for minimum valid lot (margin allows ${Math.floor(marginBasedLots * 100) / 100} of ${asset.minimumLot})`
        : `risk cap allows only ${Math.floor(riskBasedLots * 100) / 100} of minimum ${asset.minimumLot} lot`;
    return { ...breakdown, finalLots: 0, reason: `TRADE BLOCKED — ${binding}` };
  }
  if (input.maxRiskAccount <= 0 && input.maxRiskAccount !== 0) {
    return { ...breakdown, finalLots: 0, reason: 'invalid risk cap' };
  }

  breakdown.valid = true;
  breakdown.reason = 'ok';
  return breakdown;
}
