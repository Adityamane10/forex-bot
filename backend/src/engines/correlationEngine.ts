/**
 * Correlation engine. Computes rolling correlations between pairs (20/50/100
 * period) from aligned candle closes. Used to block excessive correlated
 * positions. Pure and unit-testable.
 */
export function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  const as = a.slice(-n);
  const bs = b.slice(-n);
  const ma = as.reduce((x, y) => x + y, 0) / n;
  const mb = bs.reduce((x, y) => x + y, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = as[i] - ma;
    const y = bs[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  const den = Math.sqrt(da * db);
  return den === 0 ? 0 : num / den;
}

/** Rolling correlation series (aligned to the shorter series). */
export function rollingCorrelation(a: number[], b: number[], period: number): number[] {
  const n = Math.min(a.length, b.length);
  const out: number[] = [];
  for (let i = period - 1; i < n; i++) {
    const as = a.slice(i - period + 1, i + 1);
    const bs = b.slice(i - period + 1, i + 1);
    out.push(pearson(as, bs));
  }
  return out;
}

/**
 * Align two candle close series by openTime so correlations are meaningful
 * even when pair histories differ in length.
 */
export function alignCloses(
  a: Array<{ openTime: number; close: number }>,
  b: Array<{ openTime: number; close: number }>,
): { a: number[]; b: number[] } {
  const mapB = new Map(b.map((c) => [c.openTime, c.close]));
  const aOut: number[] = [];
  const bOut: number[] = [];
  for (const c of a) {
    const bc = mapB.get(c.openTime);
    if (bc !== undefined) {
      aOut.push(c.close);
      bOut.push(bc);
    }
  }
  return { a: aOut, b: bOut };
}

export class CorrelationEngine {
  constructor(private candlesBySymbol: Map<string, Array<{ openTime: number; close: number }>>) {}

  setCandles(symbol: string, candles: Array<{ openTime: number; close: number }>): void {
    this.candlesBySymbol.set(symbol, candles);
  }

  /** Correlation matrix between all known symbols for the last `period` bars. */
  matrix(symbols: string[], period = 50): Record<string, Record<string, number>> {
    const out: Record<string, Record<string, number>> = {};
    for (const s of symbols) {
      out[s] = {};
      for (const t of symbols) {
        if (s === t) {
          out[s][t] = 1;
          continue;
        }
        const a = this.candlesBySymbol.get(s) ?? [];
        const b = this.candlesBySymbol.get(t) ?? [];
        const { a: aa, b: bb } = alignCloses(a, b);
        out[s][t] = Number(pearson(aa.slice(-period), bb.slice(-period)).toFixed(3));
      }
    }
    return out;
  }

  /** Check a candidate symbol against already-open correlated positions. */
  checkNewPosition(
    symbol: string,
    openSymbols: string[],
    maxCorrelated: number,
    period = 50,
    threshold = 0.7,
  ): { allowed: boolean; reason?: string } {
    if (openSymbols.length === 0) return { allowed: true };
    let correlatedCount = 0;
    const correlatedWith: string[] = [];
    const a = this.candlesBySymbol.get(symbol) ?? [];
    for (const other of openSymbols) {
      const b = this.candlesBySymbol.get(other) ?? [];
      const { a: aa, b: bb } = alignCloses(a, b);
      const corr = Math.abs(pearson(aa.slice(-period), bb.slice(-period)));
      if (corr >= threshold) {
        correlatedCount++;
        correlatedWith.push(`${other}(${corr.toFixed(2)})`);
      }
    }
    if (correlatedCount >= maxCorrelated) {
      return { allowed: false, reason: `correlated with ${correlatedWith.join(', ')} (limit ${maxCorrelated})` };
    }
    return { allowed: true };
  }
}
