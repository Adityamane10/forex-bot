/**
 * Position sizing engine. Wraps the pure sizing math with user settings and
 * enforces lot/min/max/leverage constraints. Never increases risk to satisfy
 * a profit target.
 */
import { PositionSizingResult, UserSettings } from '@fx/shared';
import { getAsset } from '@fx/shared';
import { calculateSizing } from '../math/forexMath';

export interface SizingRequest {
  symbol: string;
  entryPrice: number;
  stopLossPrice: number;
  settings: UserSettings;
  usdRate: number;
  /** Sizing currency when the caller wants an explicit unit (wallet currency).
   *  Default: settings.accountCurrency (callers that pass a wallet-currency
   *  rate set this to keep rate and unit consistent). */
  walletCurrency?: string;
  /** optional override for max leverage */
  maxLeverage?: number;
}

export function sizePosition(req: SizingRequest): PositionSizingResult & { valid: boolean; reason: string } {
  const asset = getAsset(req.symbol);
  const sizing = calculateSizing({
    symbol: req.symbol,
    // Sizing is always denominated in the live WALLET currency when the
    // caller supplies one (the paper account's: the user's setting until an
    // MT5 account binds, then the account's own). `usdRate` on the request is
    // supplied for that same currency — mixing units would misstate risk.
    accountCurrency: req.walletCurrency ?? req.settings.accountCurrency,
    capital: req.settings.availableCapital,
    riskPercent: req.settings.maxRiskPercent,
    entryPrice: req.entryPrice,
    stopLossPrice: req.stopLossPrice,
    usdRate: req.usdRate,
    maxLeverage: req.maxLeverage ?? req.settings.maxLeverage,
  });

  return {
    ...sizing,
    pipValuePerLot: sizing.pipValuePerLotAccount,
    marginRequirement: asset.marginRequirement,
    valid: sizing.valid,
    reason: sizing.reason,
  };
}

/**
 * Profit constraint check: given a requested minimum profit, verify it can be
 * reached without violating risk/leverage/R:R constraints. If not => NO TRADE.
 */
export function canAchieveProfit(req: {
  requestedProfit: number;
  position: PositionSizingResult & { valid: boolean; reason: string };
  rr: number;
  settings: UserSettings;
}): { possible: boolean; reason: string } {
  const { requestedProfit, position, rr, settings } = req;
  if (!position.valid) return { possible: false, reason: position.reason };
  const maxProfitAtTp1 = position.expectedLoss * rr;
  if (maxProfitAtTp1 < requestedProfit) {
    return {
      possible: false,
      reason: `requested profit ${requestedProfit} exceeds achievable ${maxProfitAtTp1.toFixed(2)} at R:R ${rr} without violating risk limits`,
    };
  }
  if (position.leverageUsed > settings.maxLeverage) {
    return { possible: false, reason: 'required leverage exceeds max leverage' };
  }
  return { possible: true, reason: 'ok' };
}
