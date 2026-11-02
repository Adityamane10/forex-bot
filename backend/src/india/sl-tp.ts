/**
 * Engine-generated stop-loss and take-profit (spec §13, §22, §24). The user does
 * NOT define technical SL for every trade — the engine calculates it from ATR,
 * swing structure, support/resistance and volatility. SL is instrument-aware
 * (NIFTY/BANKNIFTY/FINNIFTY futures & options) and strategy/timeframe-aware.
 */
import type { IndiaInstrument, IndiaIndicatorValues, IndiaTakeProfitPlan, IndiaStopLossPlan, StrategyName } from '@fx/shared';

export interface IndiaSlTpInput {
  instrument: IndiaInstrument;
  indicators: IndiaIndicatorValues;
  side: 'BUY' | 'SELL';
  entry: number;
  strategy: StrategyName;
  /** Minimum acceptable risk/reward. */
  minRr: number;
  /** Timeframe label used for SL tuning. */
  timeframe: string;
}

/** Engine-generated stop loss — never a fixed arbitrary distance. */
export function generateIndiaStopLoss(input: IndiaSlTpInput): IndiaStopLossPlan {
  const { instrument, indicators, side, entry } = input;
  const tickSize = instrument.tickSize || 0.05;
  const atr = (indicators.atr14 as number | undefined) ?? entry * 0.004;
  const swingHigh = indicators.swingHigh as number | undefined;
  const swingLow = indicators.swingLow as number | undefined;
  const support = indicators.support as number | undefined;
  const resistance = indicators.resistance as number | undefined;

  const refBufferCap = entry * 0.006;
  const buffer = Math.max(atr * 0.5, Math.min(tickSize * 3, refBufferCap));
  let distance: number | null = null;
  let basis = 'ATR-based';

  if (side === 'BUY') {
    // Below nearest support/swing low with a volatility buffer.
    const ref = support ?? swingLow;
    if (ref !== undefined && ref < entry) {
      distance = entry - ref + buffer;
      basis = 'below support/swing low + ATR buffer';
    } else {
      distance = Math.max(atr * 1.5, tickSize * 6);
      basis = 'ATR × 1.5 below entry';
    }
  } else {
    const ref = resistance ?? swingHigh;
    if (ref !== undefined && ref > entry) {
      distance = ref - entry + buffer;
      basis = 'above resistance/swing high + ATR buffer';
    } else {
      distance = Math.max(atr * 1.5, tickSize * 6);
      basis = 'ATR × 1.5 above entry';
    }
  }

  // Sanity band: the stop must sit between 0.2% and 5% of the entry price.
  //
  // The tick-derived floor assumes index-scale prices. On a low-premium option
  // it exceeds the price itself — ₹0.85 premium with ₹5 ticks demanded a ₹25
  // "minimum" stop and produced SL = −25, a stop that is already triggered at
  // fill. When the tick multiple would swallow the price, the percentage band
  // takes over; the tick size still governs rounding only.
  const maxDistance = entry * 0.05;
  let minDistance = tickSize * 5;
  if (minDistance > maxDistance) minDistance = entry * 0.002;
  distance = Math.max(minDistance, Math.min(distance, maxDistance));

  const price = side === 'BUY' ? entry - distance : entry + distance;
  return { price: roundToTick(price, tickSize), distance: roundToTick(distance, tickSize), basis };
}

/** Engine-generated take profit — R-multiple based, structural override when levels are near. */
export function generateIndiaTakeProfit(input: IndiaSlTpInput, stopLoss: IndiaStopLossPlan): IndiaTakeProfitPlan {
  const { entry, indicators, side, minRr } = input;
  const risk = Math.abs(entry - stopLoss.price);
  const resistance = indicators.resistance as number | undefined;
  const support = indicators.support as number | undefined;

  let rr = Math.max(minRr, 1.5);
  let basis = `risk/reward ${rr.toFixed(1)}R`;

  // Structural override: if a clean level sits closer than the default target,
  // prefer the level (smaller risk, high probability) but never below minRr.
  if (side === 'BUY' && resistance !== undefined && resistance > entry) {
    const distToRes = resistance - entry;
    if (distToRes > risk * minRr && distToRes < risk * 4) {
      rr = distToRes / risk;
      basis = 'target at resistance level';
    }
  } else if (side === 'SELL' && support !== undefined && support < entry) {
    const distToSup = entry - support;
    if (distToSup > risk * minRr && distToSup < risk * 4) {
      rr = distToSup / risk;
      basis = 'target at support level';
    }
  }

  const target = side === 'BUY' ? entry + risk * rr : entry - risk * rr;
  return { target, rr, basis };
}

function roundToTick(price: number, tickSize: number): number {
  return Math.round(price / tickSize) * tickSize;
}

/** INR per-lot value of a 1-point move for an instrument. */
export function pointsToInr(instrument: IndiaInstrument, points: number): number {
  return points * instrument.lotSize;
}

/** Convert an INR amount into the required price distance for a quantity. */
export function inrToPoints(instrument: IndiaInstrument, quantity: number, inr: number): number {
  if (quantity <= 0) return 0;
  return inr / quantity;
}