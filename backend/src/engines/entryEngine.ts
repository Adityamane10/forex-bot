/**
 * Entry engine. Derives an entry zone (entryMin..entryMax) around a preferred
 * entry based on ATR, market structure, support/resistance and volatility.
 * If price moves beyond the zone, the entry is marked MISSED — never chased.
 */
import { EntryPlan, Levels } from '@fx/shared';
import { getAsset } from '@fx/shared';

export interface EntryInput {
  symbol: string;
  direction: 'BUY' | 'SELL';
  currentPrice: number;
  atr: number | null;
  levels: Levels;
  /** Prefer entries at pullbacks towards value for BUY. */
  structure: 'UPTREND' | 'DOWNTREND' | 'RANGE' | 'UNCLEAR';
  timestamp: number;
  /** Strategy name (spec §22): BREAKOUT/MOMENTUM entries stop chasing pullbacks
   *  and anchor on the market price; RANGE/MEAN_REVERSION prefer limit zones. */
  strategy?: string;
}

export function buildEntry(input: EntryInput): EntryPlan {
  const asset = getAsset(input.symbol);
  const atr = input.atr ?? asset.pipSize * 15;
  const atrPips = atr / asset.pipSize;

  // Entry style (spec §22) — recorded for auditability; BREAKOUT/MOMENTUM do
  // not wait for a pullback (the zone anchors on the current price).
  const strategy = input.strategy ?? '';
  const entryType: EntryPlan['entryType'] = ['BREAKOUT', 'MOMENTUM'].includes(strategy)
    ? 'BREAKOUT'
    : ['RANGE', 'MEAN_REVERSION'].includes(strategy)
      ? 'LIMIT'
      : ['TREND_FOLLOWING', 'PULLBACK'].includes(strategy)
        ? 'PULLBACK'
        : 'MARKET';

  let preferred = input.currentPrice;
  // BREAKOUT entries anchor on the market price — no pullback bias.
  const pullbackBias = entryType !== 'BREAKOUT';
  if (input.direction === 'BUY' && pullbackBias) {
    // pullback zone: 0.2 - 0.5 ATR below current price, not below support
    const supportFloor = input.levels.nearestSupport ?? input.currentPrice - atr * 3;
    const pullback = Math.max(input.currentPrice - atr * 0.35, supportFloor + asset.pipSize * 2);
    preferred = pullback;
  } else if (input.direction === 'SELL' && pullbackBias) {
    const resistanceCeil = input.levels.nearestResistance ?? input.currentPrice + atr * 3;
    const pullback = Math.min(input.currentPrice + atr * 0.35, resistanceCeil - asset.pipSize * 2);
    preferred = pullback;
  }

  // Zone is centered on the preferred entry with a radius that guarantees the
  // current price sits inside it at creation time. Whether the price later
  // exits the zone (MISSED / ENTRY_REACHED) is evaluated by the live signal
  // refresh against this stored, fixed zone — never re-derived from price.
  // Bounds are per-asset: forex uses 6-12 pips; crypto uses tick-based bounds
  // (e.g. BTC 30-200 ticks) because absolute pip thresholds do not scale.
  const zoneMin = asset.entryZoneMinPips ?? 6;
  const zoneMax = asset.entryZoneMaxPips ?? 12;
  const zonePips = Math.max(zoneMin, Math.min(zoneMax, atrPips * 0.6));
  const zone = zonePips * asset.pipSize;
  const half = zone / 2;
  // pullback depth must stay inside the zone so current price is within it
  const pullbackPips = input.direction === 'BUY' ? input.currentPrice - preferred : preferred - input.currentPrice;
  const pullback = Math.max(0, Math.min(Math.max(pullbackPips, 0), half - asset.pipSize * 2));
  const entryCenter = input.direction === 'BUY' ? input.currentPrice - pullback : input.currentPrice + pullback;
  const entryMin = entryCenter - half;
  const entryMax = entryCenter + half;

  return {
    entryMin: Number(entryMin.toFixed(asset.pricePrecision)),
    entryMax: Number(entryMax.toFixed(asset.pricePrecision)),
    preferredEntry: Number(entryCenter.toFixed(asset.pricePrecision)),
    status: 'READY',
    reason: 'entry zone defined around current price; status evaluated live',
    entryType,
  };
}
