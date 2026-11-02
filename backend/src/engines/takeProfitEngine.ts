/**
 * Take profit engine. Derives TP1/TP2 (optionally TP3) from support/resistance
 * structure and ATR multiples, then computes R:R. If the minimum R:R is not
 * met the setup must be rejected by the caller.
 */
import { TakeProfitPlan, Levels } from '@fx/shared';
import { getAsset } from '@fx/shared';

export interface TpInput {
  symbol: string;
  direction: 'BUY' | 'SELL';
  entry: number;
  stopLoss: number;
  atr: number | null;
  levels: Levels;
}

export function buildTakeProfit(input: TpInput): TakeProfitPlan {
  const asset = getAsset(input.symbol);
  const atr = input.atr ?? asset.pipSize * 15;
  const risk = Math.abs(input.entry - input.stopLoss);
  const riskMult = risk > 0 ? risk / (atr || risk) : 1;

  let tp1Target = Math.max(1.5, Math.min(3, riskMult * 1.2));
  let tp2Target = Math.max(2, Math.min(5, riskMult * 2.2));
  let tp3Target: number | null = Math.max(3, Math.min(7, riskMult * 3.4));

  // Prefer structural targets when they exist
  if (input.direction === 'BUY' && input.levels.nearestResistance !== null) {
    const distToRes = input.levels.nearestResistance - input.entry;
    if (distToRes > risk) {
      tp1Target = distToRes / risk;
      tp2Target = tp1Target * 1.6;
    }
  }
  if (input.direction === 'SELL' && input.levels.nearestSupport !== null) {
    const distToSup = input.entry - input.levels.nearestSupport;
    if (distToSup > risk) {
      tp1Target = distToSup / risk;
      tp2Target = tp1Target * 1.6;
    }
  }

  const tp1 = input.direction === 'BUY' ? input.entry + risk * tp1Target : input.entry - risk * tp1Target;
  const tp2 = input.direction === 'BUY' ? input.entry + risk * tp2Target : input.entry - risk * tp2Target;
  const tp3 = tp3Target ? (input.direction === 'BUY' ? input.entry + risk * tp3Target : input.entry - risk * tp3Target) : null;

  return {
    tp1: Number(tp1.toFixed(asset.pricePrecision)),
    tp2: Number(tp2.toFixed(asset.pricePrecision)),
    tp3: tp3 ? Number(tp3.toFixed(asset.pricePrecision)) : null,
    rr1: Number(tp1Target.toFixed(2)),
    rr2: Number(tp2Target.toFixed(2)),
    rr3: tp3Target ? Number(tp3Target.toFixed(2)) : null,
  };
}
