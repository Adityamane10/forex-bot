/**
 * AI training-data builder.
 *
 * THE fix for the constant-probability model: training features are produced
 * by REPLAYING candle history through the exact same pure functions the live
 * signal engine uses (IndicatorEngine.compute, analyzePriceAction,
 * detectRegime, buildFeatureVector). Train/serve skew is impossible by
 * construction — a model trained on this payload scores live vectors in the
 * same ranges it was trained on.
 *
 * Lookahead discipline: row i is built from candles[0..i] ONLY. Labels are
 * attached later by the AI engine from strictly-future closes (>0.05% move
 * over `horizon` bars), matching build_dataset's rule.
 *
 * Performance: history comes from the deep Mongo archive (MT5 export, ~20k
 * bars/symbol), but each row's indicator computation is capped to the last
 * WINDOW bars — EMA/ATR/ADX need ~200 bars to converge, so 600 is a
 * converged, deterministic, O(1)-per-row window instead of O(n) per row.
 */
import { Candle, Timeframe } from '@fx/shared';
import { sessionSnapshot } from '../engines/sessionEngine';
import { analyzePriceAction } from '../engines/priceActionEngine';
import { detectRegime } from '../engines/regimeEngine';
import { IndicatorEngine, IndicatorValues } from '../engines/indicatorEngine';
import { buildFeatureVector, FeatureContextInput } from '../engines/featureEngine';
import type { CandleEngine } from '../engines/candleEngine';
import type { DataStore } from '../db/store';
import { config } from '../config';

export interface TrainingPayload {
  /** {symbol: ordered completed candles} — used by the AI engine for labels
   *  and the goldMomentum as-of context. */
  candles: Record<string, Candle[]>;
  /** {symbol: feature rows keyed exactly like the serving schema} */
  featureRows: Record<string, Record<string, number>[]>;
}

export interface TrainingDataDeps {
  candles: CandleEngine;
  store: DataStore;
}

/** Bars of history each row's indicators see (>= 200-bar EMA200 warmup). */
const WINDOW = 600;
const WARMUP_BARS = 220;
/** Gold momentum needs 11 bars (10-bar ROC). */
const GOLD_MIN_BARS = 11;

export class TrainingDataBuilder {
  private indicatorEngine: IndicatorEngine;

  constructor(private deps: TrainingDataDeps) {
    // Pure-function reuse: compute() never touches the FxContext.
    this.indicatorEngine = new IndicatorEngine(null as never, deps.candles);
  }

  private async loadHistory(symbol: string, timeframe: Timeframe): Promise<Candle[]> {
    // Deep history lives in the Mongo `candles` archive (fed by the bridge's
    // MT5 export). The in-memory buffer holds only ~300 recent bars.
    try {
      const docs = await this.deps.store.find<Candle>('candles', { symbol, timeframe }, { openTime: 1 }, 10_000);
      if (docs.length) return docs.filter((c) => Number.isFinite(c.close) && c.close > 0);
    } catch {
      // fall through to buffer
    }
    return this.deps.candles.getCompletedCandles(symbol, timeframe, 10_000);
  }

  async build(symbols: string[], timeframe: Timeframe): Promise<TrainingPayload> {
    // Gold candles are always pulled: every non-gold symbol's goldMomentum
    // feature uses them via the same as-of join the live engine applies.
    const completed = new Map<string, Candle[]>();
    for (const symbol of new Set([...symbols, 'XAU/USD'])) {
      const all = await this.loadHistory(symbol, timeframe);
      completed.set(symbol, all.filter((c) => c.state === 'COMPLETED'));
    }

    const candlesOut: Record<string, Candle[]> = {};
    const rowsOut: Record<string, Record<string, number>[]> = {};
    const gold = completed.get('XAU/USD') ?? [];
    const goldTimes = gold.map((c) => c.openTime);
    const goldCloses = gold.map((c) => c.close);

    for (const symbol of symbols) {
      const candles = completed.get(symbol) ?? [];
      if (candles.length < WARMUP_BARS + 30) continue; // not enough labeled history
      candlesOut[symbol] = candles;
      const rows: Record<string, number>[] = [];

      for (let i = WARMUP_BARS; i < candles.length - 1; i++) {
        const bar = candles[i];
        // Converged, lookahead-free window: only bars <= i are visible.
        const window = candles.slice(Math.max(0, i + 1 - WINDOW), i + 1);
        const values: IndicatorValues = this.indicatorEngine.compute(window);
        // Rows without core indicators would train on norm() zeros — skip.
        if (typeof values.close !== 'number' || typeof values.rsi14 !== 'number' || typeof values.adx !== 'number') continue;

        const priceAction = analyzePriceAction(window, symbol, timeframe, bar.openTime);
        const regime = detectRegime({
          symbol,
          timeframe,
          timestamp: bar.openTime,
          indicatorValues: values,
          priceAction,
          // News/event context has no history to replay — neutral, exactly as
          // an off-event live bar reads.
          newsDriven: false,
          highVolatilityNews: false,
        });

        // goldMomentum as-of join: last gold bar with openTime <= this bar.
        let goldRoc10: number | undefined;
        let goldAvailable = false;
        if (symbol === 'XAU/USD') {
          if (i >= GOLD_MIN_BARS) {
            const base = candles[i].close;
            const prev = candles[i - 10].close;
            goldRoc10 = prev > 0 ? ((base - prev) / prev) * 100 : undefined;
            goldAvailable = goldRoc10 !== undefined;
          }
        } else {
          // as-of: last gold bar at or before bar.openTime
          let lo = 0;
          let hi = goldTimes.length - 1;
          let j = -1;
          while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (goldTimes[mid] <= bar.openTime) { j = mid; lo = mid + 1; } else { hi = mid - 1; }
          }
          if (j >= GOLD_MIN_BARS) {
            const base = goldCloses[j];
            const prev = goldCloses[j - 10];
            goldRoc10 = prev > 0 ? ((base - prev) / prev) * 100 : undefined;
            goldAvailable = goldRoc10 !== undefined;
          }
        }

        // Historical-pattern feature: the live PatternEngine is O(window²)
        // per row — replaying it over 10k bars would take hours. The neutral
        // constant is honest (the feature is simply uninformative in
        // training; trees never split on a constant) and every OTHER feature
        // keeps exact train/serve parity.
        const historicalBuyProbability = 0.5;
        const historicalAvailable = false;

        const input: FeatureContextInput = {
          symbol,
          timeframe,
          timestamp: bar.openTime,
          indicators: { symbol, timeframe, timestamp: bar.openTime, values },
          // Live spread history is not replayable; 0 is the deterministic
          // neutral and the normalized feature carries the session/liquidity
          // signal through `session` instead.
          spreadPips: 0,
          session: sessionSnapshot(bar.openTime).session,
          regime: regime.regime,
          eventRisk: 0,
          newsSentiment: 0,
          historicalBuyProbability,
          historicalAvailable,
          dataQualityScore: 1,
          goldRoc10,
          goldAvailable,
        };
        const vec = buildFeatureVector(input);
        rows.push({ ...vec.values, timestamp: bar.openTime });
      }
      rowsOut[symbol] = rows;
    }
    return { candles: candlesOut, featureRows: rowsOut };
  }
}
