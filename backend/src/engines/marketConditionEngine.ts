/**
 * Market condition engine (Phases 4-5). Tracks ROLLING spread statistics per
 * symbol from the live tick stream and rolling ATR% percentiles from completed
 * 1h candles, then classifies the current condition:
 *
 *   spread:     NORMAL / ELEVATED / ABNORMAL   (ABNORMAL blocks new entries)
 *   volatility: LOW / NORMAL / HIGH / EXTREME  (EXTREME shrinks size, raises EV bar)
 *
 * Never closes an open position because of a temporary spread increase — the
 * paper engine's SL/TP/trailing management stays independent of this gate.
 */
import { Candle, Tick } from '@fx/shared';
import { priceToPips } from '@fx/shared';
import { FxContext, CHANNELS } from '../core/context';

export type SpreadLevel = 'NORMAL' | 'ELEVATED' | 'ABNORMAL';
export type VolatilityLevel = 'LOW' | 'NORMAL' | 'HIGH' | 'EXTREME';

export interface SpreadStatus {
  level: SpreadLevel;
  median: number; // pips
  p95: number; // pips
  sampleCount: number;
}

export interface VolatilityStatus {
  level: VolatilityLevel;
  p25: number;
  p75: number;
  p95: number;
  sampleCount: number;
}

const MAX_SPREAD_SAMPLES = 300;
const MAX_VOL_SAMPLES = 120;
const MIN_SPREAD_SAMPLES = 10;
const MIN_VOL_SAMPLES = 20;

export class MarketConditionEngine {
  private spreads = new Map<string, number[]>();
  private atr = new Map<string, { lastClose: number; atr: number | null; history: number[] }>();

  constructor(ctx: FxContext) {
    ctx.events.on(CHANNELS.tick, (tick: Tick) => {
      const pips = priceToPips(tick.symbol, tick.ask - tick.bid);
      if (!Number.isFinite(pips) || pips <= 0) return;
      let arr = this.spreads.get(tick.symbol);
      if (!arr) {
        arr = [];
        this.spreads.set(tick.symbol, arr);
      }
      arr.push(pips);
      if (arr.length > MAX_SPREAD_SAMPLES) arr.shift();
    });
    ctx.events.on(CHANNELS.candle, (c: Candle) => {
      if (c.timeframe !== '1h' || !c.completed) return;
      const e = this.atr.get(c.symbol) ?? { lastClose: 0, atr: null, history: [] };
      if (e.lastClose > 0 && c.close > 0) {
        const tr = Math.max(c.high - c.low, Math.abs(c.high - e.lastClose), Math.abs(c.low - e.lastClose));
        e.atr = e.atr === null ? tr : e.atr * (13 / 14) + tr * (1 / 14);
        if (e.atr > 0) {
          e.history.push((e.atr / c.close) * 100);
          if (e.history.length > MAX_VOL_SAMPLES) e.history.shift();
        }
      }
      e.lastClose = c.close;
      this.atr.set(c.symbol, e);
    });
  }

  /**
   * Spread regime (Phase 4): classify the current spread against the symbol's
   * own recent distribution. ABNORMAL (>> median) blocks new entries; the
   * static per-asset cap remains the hard fallback when history is thin.
   */
  spreadStatus(symbol: string, currentPips: number): SpreadStatus {
    const arr = this.spreads.get(symbol) ?? [];
    const base: SpreadStatus = { level: 'NORMAL', median: 0, p95: 0, sampleCount: arr.length };
    if (arr.length < MIN_SPREAD_SAMPLES) return base;
    const sorted = [...arr].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    const level: SpreadLevel =
      currentPips > Math.max(p95, median * 3) ? 'ABNORMAL'
        : currentPips > median * 1.5 ? 'ELEVATED' : 'NORMAL';
    return { level, median: Number(median.toFixed(2)), p95: Number(p95.toFixed(2)), sampleCount: arr.length };
  }

  /**
   * Volatility regime (Phase 5): classify the current ATR% against the symbol's
   * recent distribution. EXTREME (> p95) shrinks position size and raises the
   * expected-value bar — it never widens the stop to keep a trade alive.
   */
  volatilityStatus(symbol: string, currentAtrPct: number | null): VolatilityStatus {
    const hist = this.atr.get(symbol)?.history ?? [];
    const base: VolatilityStatus = { level: 'NORMAL', p25: 0, p75: 0, p95: 0, sampleCount: hist.length };
    if (currentAtrPct === null || hist.length < MIN_VOL_SAMPLES) return base;
    const sorted = [...hist].sort((a, b) => a - b);
    const at = (f: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * f))];
    const p25 = at(0.25);
    const p75 = at(0.75);
    const p95 = at(0.95);
    const level: VolatilityLevel =
      currentAtrPct > p95 ? 'EXTREME'
        : currentAtrPct > p75 ? 'HIGH'
          : currentAtrPct < p25 ? 'LOW' : 'NORMAL';
    return { level, p25: Number(p25.toFixed(3)), p75: Number(p75.toFixed(3)), p95: Number(p95.toFixed(3)), sampleCount: hist.length };
  }

  /** Rolling spread stats for observability. */
  statsSummary(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [symbol, arr] of this.spreads) {
      const sorted = [...arr].sort((a, b) => a - b);
      out[symbol] = {
        samples: arr.length,
        median: sorted[Math.floor(sorted.length / 2)]?.toFixed(2) ?? null,
        p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]?.toFixed(2) ?? null,
      };
    }
    return out;
  }
}
