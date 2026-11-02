/**
 * Data quality engine. Every decision receives a dataQualityScore (0..1)
 * covering freshness, missing candles, duplicates, invalid OHLC, spread,
 * provider health and news/calendar availability. Low quality => WAIT.
 */
import { Candle, DataQualityReport, SystemStatus, Tick, priceToPips } from '@fx/shared';
import { config } from '../config';

export interface QualityInput {
  symbol: string;
  timestamp: number;
  latestTick: Tick | null;
  candles: Partial<Record<string, Candle[]>>; // by timeframe
  providerHealth: { ok: boolean; detail: string };
  newsAvailable: boolean;
  calendarAvailable: boolean;
  maxSpreadPips: number;
  /** Timeframes the decision genuinely requires; missing others don't penalize. */
  requiredTimeframes?: string[];
  /** Staleness threshold for this symbol (poll-aware for REST providers). */
  staleThresholdMs?: number;
}

export function assessQuality(input: QualityInput): DataQualityReport {
  const checks: string[] = [];
  let score = 1;
  const staleThreshold = input.staleThresholdMs ?? config.staleTickMs;
  const freshnessMs = input.latestTick ? input.timestamp - input.latestTick.timestamp : Infinity;

  if (!input.latestTick) {
    score -= 0.4;
    checks.push('no market data');
  } else if (freshnessMs > staleThreshold) {
    score -= 0.3;
    checks.push(`stale data (${(freshnessMs / 1000).toFixed(0)}s)`);
  } else {
    checks.push(`data fresh (${(freshnessMs / 1000).toFixed(0)}s)`);
  }

  const required = input.requiredTimeframes?.length ? input.requiredTimeframes : Object.keys(input.candles);
  let missing = 0;
  let duplicates = 0;
  let invalidOhlc = 0;
  for (const tf of required) {
    const candles = input.candles[tf];
    if (!candles || candles.length < 20) {
      missing++;
      continue;
    }
    const seen = new Set<number>();
    for (const c of candles) {
      if (seen.has(c.openTime)) duplicates++;
      seen.add(c.openTime);
      if (!(c.high >= c.low && c.high >= c.open && c.high >= c.close && c.low <= c.open && c.low <= c.close)) {
        invalidOhlc++;
      }
    }
  }
  if (missing > 0) {
    score -= 0.05 * missing;
    checks.push(`${missing} timeframe(s) with insufficient candles`);
  }
  if (duplicates > 0) {
    score -= Math.min(0.15, duplicates * 0.01);
    checks.push(`${duplicates} duplicate candles`);
  }
  if (invalidOhlc > 0) {
    score -= Math.min(0.3, invalidOhlc * 0.05);
    checks.push(`${invalidOhlc} invalid OHLC candles`);
  }

  // Proper per-pair pip conversion (handles JPY pairs and non-4-decimal quotes).
  const spreadPipsValue = input.latestTick ? priceToPips(input.symbol, input.latestTick.spread) : Infinity;
  if (input.latestTick && spreadPipsValue > input.maxSpreadPips) {
    score -= 0.25;
    checks.push(`spread ${spreadPipsValue.toFixed(1)} pips exceeds limit`);
  }

  if (!input.providerHealth.ok) {
    score -= 0.3;
    checks.push(`provider unhealthy: ${input.providerHealth.detail}`);
  }
  if (!input.newsAvailable) {
    score -= 0.05;
    checks.push('news unavailable');
  }
  if (!input.calendarAvailable) {
    score -= 0.05;
    checks.push('economic calendar unavailable');
  }

  score = Math.max(0, Math.min(1, score));
  return {
    symbol: input.symbol,
    timestamp: input.timestamp,
    score: Number(score.toFixed(3)),
    freshnessMs,
    missingCandles: missing,
    duplicates,
    invalidOhlc,
    spreadPips: Number((spreadPipsValue || 0).toFixed(2)),
    providerHealth: input.providerHealth.ok ? 'HEALTHY' : 'DOWN',
    newsAvailable: input.newsAvailable,
    calendarAvailable: input.calendarAvailable,
    checks,
  };
}
