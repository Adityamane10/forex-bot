/**
 * Stop loss engine. Places SL below the nearest structural support (BUY) or
 * above the nearest resistance (SELL), bounded by ATR. The SL must make
 * logical sense relative to the trade thesis; invalid placements are rejected.
 */
import { StopLossPlan, Levels } from '@fx/shared';
import { getAsset, priceToPips } from '@fx/shared';
import { hasValidSlPlacement } from './supportResistanceEngine';

export interface SlInput {
  symbol: string;
  direction: 'BUY' | 'SELL';
  entry: number;
  atr: number | null;
  levels: Levels;
  /** buffer in pips beyond the level */
  bufferPips?: number;
}

export function buildStopLoss(input: SlInput): { plan: StopLossPlan; valid: boolean; reason?: string } {
  const asset = getAsset(input.symbol);
  const atr = input.atr ?? asset.pipSize * 15;
  const bufferPips = input.bufferPips ?? asset.slBufferPips ?? 4;
  const buffer = bufferPips * asset.pipSize;
  let price: number;
  let basis: string;

  if (input.direction === 'BUY') {
    if (input.levels.nearestSupport !== null && input.levels.nearestSupport < input.entry) {
      price = input.levels.nearestSupport - buffer;
      basis = 'below nearest support';
    } else {
      price = input.entry - atr * 1.5;
      basis = 'ATR-based';
    }
  } else {
    if (input.levels.nearestResistance !== null && input.levels.nearestResistance > input.entry) {
      price = input.levels.nearestResistance + buffer;
      basis = 'above nearest resistance';
    } else {
      price = input.entry + atr * 1.5;
      basis = 'ATR-based';
    }
  }

  const check = hasValidSlPlacement(price, input.levels, input.symbol, input.direction);
  const pips = priceToPips(input.symbol, Math.abs(input.entry - price));
  const plan: StopLossPlan = {
    price: Number(price.toFixed(asset.pricePrecision)),
    pips: Number(pips.toFixed(1)),
    basis,
  };
  const minSlPips = asset.slMinPips ?? 4;
  if (pips < minSlPips) {
    return { plan, valid: false, reason: `SL too tight (${pips.toFixed(1)} pips)` };
  }
  if (!check.valid) {
    return { plan, valid: false, reason: check.reason };
  }
  return { plan, valid: true };
}
