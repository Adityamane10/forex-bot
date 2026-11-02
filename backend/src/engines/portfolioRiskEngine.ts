/**
 * Portfolio risk engine. Tracks account-level risk: open-position risk, total
 * portfolio risk, currency exposure, leverage, margin, drawdown and
 * daily/weekly P&L. Detects overlapping currency exposure (e.g. several long
 * USD pairs) and can block excessive exposure.
 */
import { PaperPosition, UserSettings } from '@fx/shared';
import { getAsset } from '@fx/shared';

export interface ExposureReport {
  currencyExposure: Record<string, { long: number; short: number; net: number }>;
  maxCurrencyExposure: { currency: string; net: number };
  openPositionRisk: number;
  totalPortfolioRisk: number;
  leverage: number;
  marginUsed: number;
  drawdownPct: number;
  dailyPnl: number;
  weeklyPnl: number;
  blocked: string[];
}

export class PortfolioRiskEngine {
  constructor(private settings: UserSettings) {}

  updateSettings(settings: UserSettings): void {
    this.settings = settings;
  }

  /**
   * Compute exposure from open positions. `netExposureUsd` maps currency ->
   * net notional in USD. `equityUsd` used for percent computations.
   *
   * NOTE: per-currency notionals are RAW QUOTE-currency amounts (JPY pairs
   * read ~100× larger than USD pairs) — advisory/display only. Breaker and
   * risk-classification inputs use the account-currency netting computed by
   * the signal engine. Orphaned positions (symbol left the asset master) are
   * skipped, never thrown on.
   */
  assess(positions: PaperPosition[], equityUsd: number, dailyPnl: number, weeklyPnl: number, peakEquityUsd: number): ExposureReport {
    const exposure: Record<string, { long: number; short: number; net: number }> = {};
    let openPositionRisk = 0;
    let marginUsed = 0;
    const blocked: string[] = [];

    for (const p of positions) {
      if (p.status !== 'OPEN') continue;
      let asset: ReturnType<typeof getAsset>;
      try {
        asset = getAsset(p.symbol);
      } catch {
        continue;
      }
      const [base, quote] = p.symbol.split('/');
      const notional = p.lots * asset.contractSize * p.entryPrice; // quote currency approx
      // BUY: long the base, short the quote. SELL: short the base, long the quote.
      const longCur = p.direction === 'BUY' ? base : quote;
      const shortCur = p.direction === 'BUY' ? quote : base;
      const eLong = exposure[longCur] ?? { long: 0, short: 0, net: 0 };
      eLong.long += notional;
      exposure[longCur] = eLong;
      const eShort = exposure[shortCur] ?? { long: 0, short: 0, net: 0 };
      eShort.short += notional;
      exposure[shortCur] = eShort;
      // approximate risk per position: 1R based on entry-SL distance
      const riskPerUnit = Math.abs(p.entryPrice - p.stopLoss);
      openPositionRisk += riskPerUnit * p.lots * asset.contractSize;
      marginUsed += notional * asset.marginRequirement;
    }

    // net exposure
    const netExposure: Record<string, number> = {};
    for (const [c, e] of Object.entries(exposure)) {
      e.net = e.long - e.short;
      netExposure[c] = e.net;
    }
    const sorted = Object.entries(netExposure).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    const maxExposure = sorted.length ? { currency: sorted[0][0], net: sorted[0][1] } : { currency: '', net: 0 };

    const exposureLimit = (this.settings.maxCurrencyExposurePercent ?? 30) / 100 * equityUsd;
    for (const [c, net] of sorted) {
      if (Math.abs(net) > exposureLimit && equityUsd > 0) {
        blocked.push(`currency exposure ${c} (${(Math.abs(net) / equityUsd * 100).toFixed(1)}%) exceeds limit`);
      }
    }

    const drawdownPct = peakEquityUsd > 0 ? Math.max(0, (peakEquityUsd - equityUsd) / peakEquityUsd * 100) : 0;

    return {
      currencyExposure: exposure,
      maxCurrencyExposure: maxExposure,
      openPositionRisk,
      totalPortfolioRisk: openPositionRisk,
      leverage: equityUsd > 0 ? marginUsed / equityUsd : 0,
      marginUsed,
      drawdownPct,
      dailyPnl,
      weeklyPnl,
      blocked,
    };
  }

  /**
   * Would opening a new position violate limits? `toAccountPositionRisk` (when
   * provided) converts a position's 1R risk from its QUOTE currency into the
   * account currency — without it, JPY-quoted positions overstate aggregate
   * risk ~100× and spuriously block the whole book.
   */
  preflightCheck(
    positions: PaperPosition[],
    newRiskPct: number,
    equityUsd: number,
    toAccountPositionRisk?: (p: PaperPosition) => number,
  ): { allowed: boolean; reason?: string } {
    const open = positions.filter((p) => p.status === 'OPEN').length;
    if (this.settings.maxOpenPositions > 0 && open >= this.settings.maxOpenPositions) {
      return { allowed: false, reason: `max open positions (${this.settings.maxOpenPositions}) reached` };
    }
    const existingRiskPct = positions
      .filter((p) => p.status === 'OPEN')
      .reduce((acc, p) => {
        let riskAccount: number;
        if (toAccountPositionRisk) {
          try {
            riskAccount = toAccountPositionRisk(p);
          } catch {
            return acc; // orphaned position — excluded
          }
        } else {
          let asset: ReturnType<typeof getAsset>;
          try {
            asset = getAsset(p.symbol);
          } catch {
            return acc;
          }
          const riskPerUnit = Math.abs(p.entryPrice - p.stopLoss);
          riskAccount = riskPerUnit * p.lots * asset.contractSize;
        }
        return acc + (riskAccount / Math.max(1, equityUsd)) * 100;
      }, 0);
    const totalRiskPct = existingRiskPct + newRiskPct;
    if (totalRiskPct > (this.settings.maxRiskPercent * this.settings.maxOpenPositions) * 0.8) {
      return { allowed: false, reason: `total portfolio risk ${totalRiskPct.toFixed(2)}% exceeds safe aggregate` };
    }
    return { allowed: true };
  }
}
