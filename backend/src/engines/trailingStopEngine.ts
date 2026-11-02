/**
 * Trailing stop engine (spec §63). Pure, deterministic math: a trailing stop
 * activates after `activateR` × risk in profit, then ratchets the stop behind
 * price at `atrMultiplier` × ATR. It only ratchets in the profitable direction
 * and never loosens; for BUY it never goes below entry (profit is locked).
 *
 * CE mode (adopted from the geraked/metatrader5 CEZLSMA Expert Advisor, MIT):
 * instead of trailing from the CURRENT price, the stop hangs the ATR multiple
 * off the HIGHEST HIGH / LOWEST LOW of the lookback window (Chandelier Exit).
 * This keeps the stop anchored to the swing extreme instead of hugging price,
 * which survives pullbacks the price-anchored trail gets clipped by.
 */
export interface TrailingInput {
  direction: 'BUY' | 'SELL';
  entry: number;
  mid: number;
  currentStop: number;
  atr: number;
  atrMultiplier: number;
  activateR: number;
  /** price precision for rounding (optional). */
  pricePrecision?: number;
  /**
   * CE mode inputs (optional; absent = classic price-anchored trail):
   * highestHigh/lowestLow over the CE lookback at this bar.
   */
  highestHigh?: number;
  lowestLow?: number;
  /** 'price' (default) | 'chandelier' — CE anchors to the swing extreme. */
  mode?: 'price' | 'chandelier';
}

export interface TrailingResult {
  /** New stop price, or null when the trailing stop should not move. */
  stop: number | null;
  activated: boolean;
}

export function computeTrailingStop(input: TrailingInput): TrailingResult {
  const { direction, entry, mid, currentStop, atr, atrMultiplier, activateR } = input;
  if (!Number.isFinite(atr) || atr <= 0 || atrMultiplier <= 0) return { stop: null, activated: false };

  const risk = Math.abs(entry - currentStop);
  const activation = Math.max(0, activateR * risk);
  const trailDist = atrMultiplier * atr;
  if (trailDist <= 0) return { stop: null, activated: false };

  let candidate: number | null = null;
  if (direction === 'BUY' && mid - entry >= activation) {
    // Chandelier mode anchors to the swing HIGH, not the current price.
    const anchor = input.mode === 'chandelier' && Number.isFinite(input.highestHigh ?? NaN)
      ? (input.highestHigh as number)
      : mid;
    const c = anchor - trailDist;
    if (c > currentStop && c >= entry) candidate = c;
  } else if (direction === 'SELL' && entry - mid >= activation) {
    const anchor = input.mode === 'chandelier' && Number.isFinite(input.lowestLow ?? NaN)
      ? (input.lowestLow as number)
      : mid;
    const c = anchor + trailDist;
    if (c < currentStop && c <= entry) candidate = c;
  }

  if (candidate === null) return { stop: null, activated: false };
  const rounded = input.pricePrecision !== undefined
    ? Number(candidate.toFixed(input.pricePrecision))
    : candidate;
  return { stop: rounded, activated: true };
}
