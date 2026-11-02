/**
 * IndiaRiskEngine + position sizing (spec §14, §25, §46, §47). All calculations
 * are INR-first. Position size is ENGINE-controlled and risk comes first:
 * quantity is NEVER derived from the desired profit — it is derived from the
 * maximum allowed risk divided by the per-lot risk.
 */
import type { IndiaInstrument, IndiaPositionSizingResult, IndiaRejectionReason } from '@fx/shared';
import { INDIA_REJECTION_REASONS } from '@fx/shared';
import { indiaConfig } from './config';

export interface IndiaSizingInput {
  instrument: IndiaInstrument;
  amountInr: number;
  maxRiskInr: number;
  maxMarginPercent: number;
  side: 'BUY' | 'SELL';
  entry: number;
  stopLoss: number;
  target: number;
  /** Margin factor (0..1) for the instrument; falls back to the index-futures default. */
  marginFactor?: number;
}

export interface IndiaRiskValidation {
  ok: boolean;
  reason?: IndiaRejectionReason;
  detail?: string;
}

/**
 * Margin per lot for the Indian market — contract-type aware.
 *
 * FUT: SPAN margin ≈ notional × factor (entry is futures price ≈ spot).
 * OPT (CE/PE): premium × lotSize for both BUY and SELL in paper trading with
 * small capital (₹5k). Real broker SPAN for shorts is strike×lot×15% (≈₹2.4L)
 * and would block every 5k short — the previous SPAN fallback made 5k shorts
 * impossible, so per user request paper sizing uses premium×lot for CE/PE on
 * both sides. Live SPAN should be fetched from broker basket-margin API when
 * available.
 */
function marginPerLotFor(instrument: IndiaInstrument, side: 'BUY' | 'SELL', entry: number, factor: number): number {
  const lotSize = Math.max(1, instrument.lotSize);
  if (instrument.contractType === 'OPT') {
    // CE/PE: premium × lot on both sides for ₹5k paper trading.
    return lotSize * entry;
  }
  // FUT / INDEX / other: margin on notional.
  return lotSize * entry * factor;
}

/**
 * Size an Indian position. Returns quantity, lots, margin, max loss and target
 * profit. Risk-first: lots = floor(maxRiskInr / (riskPerUnit × lotSize)).
 */
export function sizeIndiaPosition(input: IndiaSizingInput): IndiaPositionSizingResult {
  const { instrument, maxRiskInr, amountInr, maxMarginPercent, entry, stopLoss, target } = input;
  const lotSize = Math.max(1, instrument.lotSize);
  const tickSize = instrument.tickSize || 0.05;
  const riskPerUnit = Math.abs(entry - stopLoss);
  if (riskPerUnit <= 0 || !Number.isFinite(riskPerUnit)) {
    return { quantity: 0, lots: 0, requiredCapital: 0, marginEstimate: 0, maximumLoss: 0, targetProfit: 0, risk: 0, rr: 0, valid: false, reason: 'invalid stop-loss distance' };
  }

  // Risk-first, but margin-aware: lots must satisfy BOTH caps. The old code
  // sized purely by risk and then refused the whole trade when the margin
  // check tripped — a ₹5,000 account was told "₹14,771 exceeds ₹5,000" over
  // and over while two lots would have fit comfortably. Shrink to the budget;
  // refuse only when even one lot cannot be funded.
  const riskPerLot = riskPerUnit * lotSize;
  const marginLimit = amountInr * (maxMarginPercent / 100);
  const factor = input.marginFactor ?? 0.15;
  const marginPerLot = marginPerLotFor(instrument, input.side, entry, factor);
  const maxLotsByRisk = Math.floor(maxRiskInr / riskPerLot);
  const maxLotsByMargin = Math.floor(marginLimit / marginPerLot);
  const lots = Math.min(maxLotsByRisk, maxLotsByMargin);
  if (lots < 1) {
    // Decide which cap actually blocked the trade for the rejection message.
    const riskBlocked = maxLotsByRisk < 1;
    const marginBlocked = maxLotsByMargin < 1;
    let reason: string;
    if (riskBlocked && !marginBlocked) {
      reason = `minimum lot size not affordable: risk/lot ₹${Math.round(riskPerLot)} exceeds max risk ₹${Math.round(maxRiskInr)}`;
    } else if (marginBlocked) {
      // CE/PE now premium×lot on both sides for ₹5k paper trading.
      reason = `minimum lot not affordable: margin/lot ₹${Math.round(marginPerLot).toLocaleString('en-IN')} (premium ₹${entry} × ${lotSize}) exceeds margin limit ₹${Math.round(marginLimit).toLocaleString('en-IN')} — increase capital or reduce margin %`;
    } else {
      reason = `minimum lot not affordable: risk/lot ₹${Math.round(riskPerLot)} / margin/lot ₹${Math.round(marginPerLot).toLocaleString('en-IN')} exceeds caps`;
    }
    return {
      quantity: 0, lots: 0, requiredCapital: 0, marginEstimate: 0, maximumLoss: 0, targetProfit: 0, risk: 0, rr: 0,
      valid: false, reason,
    };
  }
  const quantity = lots * lotSize;
  const maximumLoss = Math.min(lots * riskPerLot, maxRiskInr);
  const marginEstimate = lots * marginPerLot;

  if (marginEstimate > marginLimit) {
    return {
      quantity, lots, requiredCapital: quantity * entry, marginEstimate, maximumLoss, targetProfit: 0, risk: maximumLoss, rr: 0,
      valid: false,
      reason: `margin estimate ₹${Math.round(marginEstimate).toLocaleString('en-IN')} exceeds limit ₹${Math.round(marginLimit).toLocaleString('en-IN')}`,
    };
  }

  const targetProfit = Math.abs(target - entry) * quantity;
  const rr = maximumLoss > 0 ? targetProfit / maximumLoss : 0;

  return {
    quantity,
    lots,
    requiredCapital: quantity * entry,
    marginEstimate,
    maximumLoss,
    targetProfit,
    risk: maximumLoss,
    rr,
    valid: true,
    reason: 'sized',
  };
}

/** Full risk validation performed before ANY execution (paper or live). */
export function validateIndiaRisk(input: {
  instrument: IndiaInstrument;
  sizing: IndiaPositionSizingResult;
  maxRiskInr: number;
  amountInr: number;
  maxMarginPercent: number;
  rr: number;
  minRr: number;
  targetInr: number;
}): IndiaRiskValidation {
  if (!input.sizing.valid) {
    return { ok: false, reason: 'RISK_TOO_HIGH', detail: input.sizing.reason };
  }
  if (input.sizing.maximumLoss > input.maxRiskInr) {
    return { ok: false, reason: 'RISK_TOO_HIGH', detail: `max loss ₹${Math.round(input.sizing.maximumLoss)} > risk cap ₹${input.maxRiskInr}` };
  }
  const marginLimit = input.amountInr * (input.maxMarginPercent / 100);
  if (input.sizing.marginEstimate > marginLimit) {
    return { ok: false, reason: 'MARGIN_TOO_HIGH', detail: `margin ₹${Math.round(input.sizing.marginEstimate)} > ₹${Math.round(marginLimit)}` };
  }
  if (input.rr < input.minRr) {
    return { ok: false, reason: 'RISK_TOO_HIGH', detail: `rr ${input.rr.toFixed(2)} < minRr ${input.minRr}` };
  }
  if (input.sizing.targetProfit < input.targetInr) {
    return { ok: false, reason: 'TARGET_NOT_FEASIBLE', detail: `expected profit ₹${Math.round(input.sizing.targetProfit)} < target ₹${Math.round(input.targetInr)}` };
  }
  if (!input.instrument.tradable || input.instrument.status !== 'ACTIVE') {
    return { ok: false, reason: 'CONTRACT_NOT_TRADABLE', detail: 'instrument not tradable' };
  }
  return { ok: true };
}

export { INDIA_REJECTION_REASONS };

/** Default margin factor used when the broker does not provide one. */
export const DEFAULT_INDEX_MARGIN_FACTOR = 0.15;
export const INDIA_ESTIMATED_CHARGES_PER_LOT = indiaConfig.commissionPerLotInr;