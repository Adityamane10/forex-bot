/**
 * Expected value engine. EV = P(win) * avgWin - P(loss) * avgLoss - costs.
 * Trading costs include spread, commission, slippage and swap. Only setups
 * with validated positive EV are eligible for signals.
 */
import { ExpectedValue, ForexAsset } from '@fx/shared';
import { getAsset } from '@fx/shared';
import { SLIPPAGE_PIPS } from '@fx/shared';

export interface EvInput {
  symbol: string;
  probabilityWin: number; // 0..1
  averageWinPerLot: number; // account currency per standard lot
  averageLossPerLot: number; // positive number
  spreadPerLot: number;
  commissionPerLot: number;
  /** Swap cost per day per lot: POSITIVE = cost, NEGATIVE = rebate. */
  swapPerDayPerLot: number;
  daysHeld: number;
  slippagePips?: number;
  currentPrice?: number;
}

export function calculateExpectedValue(input: EvInput): ExpectedValue {
  const asset = getAsset(input.symbol);
  const pWin = Math.min(1, Math.max(0.001, input.probabilityWin));
  const pLoss = 1 - pWin;

  const slippagePips = input.slippagePips ?? SLIPPAGE_PIPS;
  // slippage in quote currency per lot
  const slippagePerLot = slippagePips * asset.pipSize * asset.contractSize;

  const spreadCost = input.spreadPerLot;
  const commission = input.commissionPerLot;
  const swap = input.swapPerDayPerLot * input.daysHeld;
  const tradingCosts = spreadCost + commission + slippagePerLot + swap;

  const gross = pWin * input.averageWinPerLot - pLoss * input.averageLossPerLot;
  const ev = gross - tradingCosts;

  const riskPerTrade = input.averageLossPerLot;
  return {
    evPerTrade: ev,
    evPerRisk: riskPerTrade > 0 ? ev / riskPerTrade : 0,
    probabilityWin: pWin,
    probabilityLoss: pLoss,
    averageWin: input.averageWinPerLot,
    averageLoss: input.averageLossPerLot,
    tradingCosts,
    positive: ev > 0,
    breakdown: {
      spread: spreadCost,
      commission,
      slippage: slippagePerLot,
      swap,
    },
  };
}
