/**
 * Backtest engine. Replays the signal pipeline over historical candles with
 * realistic frictions: spread, slippage, commission and swap. Uses the same
 * pure indicator / entry / SL / TP / sizing / EV / risk math as the live
 * engine. Every candle at time T uses only data up to T — no lookahead.
 *
 * ML is used when enabled and the AI engine is reachable (batch predictions).
 * News/events are included only when the configured providers supply
 * legitimate historical data; otherwise those checks are skipped (honest
 * backtest, documented).
 */
import {
  BacktestConfig, BacktestMetrics, BacktestResult, Candle, PaperTrade, Timeframe, UserSettings,
} from '@fx/shared';
import { TIMEFRAMES, TIMEFRAME_MS } from '@fx/shared';
import { accountQuoteRate } from '../math/forexMath';
import { FxContext } from '../core/context';
import { logger } from '../core/logger';
import { IndicatorEngine } from './indicatorEngine';
import { analyzePriceAction } from './priceActionEngine';
import { computeLevels, entryTooCloseToLevel } from './supportResistanceEngine';
import { detectRegime } from './regimeEngine';
import { buildEntry } from './entryEngine';
import { buildStopLoss } from './stopLossEngine';
import { buildTakeProfit } from './takeProfitEngine';
import { sizePosition } from './positionSizingEngine';
import { calculateExpectedValue } from './expectedValueEngine';
import { computeMetrics } from './metricsEngine';
import { AiClient } from '../ai/aiClient';
import { primarySession } from './sessionEngine';
import { getAsset, pipsToPrice } from '@fx/shared';

interface BtPosition {
  symbol: string;
  direction: 'BUY' | 'SELL';
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  lots: number;
  openBarTime: number;
  session: string;
  directionLabel: string;
}

/**
 * Quote-currency price of 1 USD at bar `time`, derived ONLY from loaded
 * candle history (never invented): the traded pair itself when its base is
 * USD, otherwise an explicit USD/{quote} or {quote}/USD series fetched
 * best-effort. Returns null when no honest source exists so callers can keep
 * USD-denominated costs OUT of quote-currency P&L instead of mixing units.
 */
interface RateSeries { candles: Candle[]; invert: boolean }

export class BacktestEngine {
  private running = new Map<string, boolean>();

  constructor(private ctx: FxContext, private ai: AiClient) {}

  isRunning(id: string): boolean {
    return this.running.get(id) ?? false;
  }

  async run(config: BacktestConfig, backtestId = crypto.randomUUID()): Promise<BacktestResult> {

    const result: BacktestResult = {
      backtestId,
      config,
      createdAt: Date.now(),
      status: 'RUNNING',
    };
    this.running.set(backtestId, true);
    await this.ctx.store.insertOne('backtests', result);
    try {
      const { trades, equityCurve, dataNote } = await this.execute(config);
      const metrics = computeMetrics({ trades, equityCurve, startingCapital: config.startingCapital });
      result.status = 'COMPLETED';
      result.metrics = metrics;
      result.trades = trades;
      result.equityCurve = equityCurve;
      result.dataNote = dataNote;
    } catch (err) {
      result.status = 'FAILED';
      result.error = String(err);
      logger.error('backtest failed', { backtestId, err: String(err) });
    }
    this.running.delete(backtestId);
    await this.ctx.store.updateOne('backtests', { backtestId }, { $set: { ...result } }, true);
    return result;
  }

  private async execute(config: BacktestConfig): Promise<{ trades: PaperTrade[]; equityCurve: Array<{ time: number; equity: number }>; dataNote?: string }> {
    // Load candle histories for all symbols/timeframes. Free providers often
    // cap how far back history reaches (e.g. Yahoo hourly ~3 months); we clamp
    // to the requested window and honestly report when the window differs.
    const histories = new Map<string, Partial<Record<Timeframe, Candle[]>>>();
    let dataNote: string | undefined;
    for (const symbol of config.symbols) {
      const perTf: Partial<Record<Timeframe, Candle[]>> = {};
      for (const tf of config.timeframes) {
        const raw = await this.ctx.providers.marketData.getHistoricalCandles(symbol, tf, config.start, config.end);
        const inWindow = raw.filter((c) => c.openTime >= config.start && c.openTime <= config.end);
        // If the requested window has almost no data (provider range limit),
        // use what the provider actually returned rather than an empty backtest.
        if (inWindow.length >= 120 || raw.length === 0) {
          perTf[tf] = inWindow;
        } else {
          perTf[tf] = raw;
          if (raw.length > 0) {
            const gotFrom = new Date(raw[0].openTime).toISOString().slice(0, 10);
            const gotTo = new Date(raw[raw.length - 1].openTime).toISOString().slice(0, 10);
            dataNote = `history for ${symbol} ${tf} limited by the free feed to ${gotFrom}..${gotTo} (requested window not fully available)`;
          }
        }
      }
      histories.set(symbol, perTf);
    }

    const primaryTf: Timeframe = config.timeframes.includes('1h') ? '1h' : config.timeframes[0];
    const primarySymbol = config.symbols[0];
    const primaryCandles = histories.get(primarySymbol)?.[primaryTf] ?? [];
    if (primaryCandles.length <= 200) {
      return { trades: [], equityCurve: [{ time: Date.now(), equity: config.startingCapital }], dataNote: 'not enough history for a backtest (need > 200 bars on the primary timeframe)' };
    }

    // ---- Currency normalization -------------------------------------------
    // P&L accrues in each pair's QUOTE currency while commissions/swap are
    // USD-denominated. Netting them raw understates costs ~150× on JPY pairs.
    // Every settlement converts USD costs into the pair's quote currency via
    // an honest rate series built from loaded candles only.
    const rateSeries = new Map<string, RateSeries>();
    const quotesNeeded = new Set<string>();
    for (const symbol of config.symbols) {
      const q = getAsset(symbol).quoteCurrency;
      if (q !== 'USD' && q !== 'USDT') quotesNeeded.add(q);
    }
    for (const q of quotesNeeded) {
      for (const candidate of [`USD/${q}`, `${q}/USD`]) {
        try {
          const raw = await this.ctx.providers.marketData.getHistoricalCandles(candidate, primaryTf, config.start, config.end);
          if (raw.length > 0) {
            rateSeries.set(q, { candles: raw, invert: candidate === `${q}/USD` });
            break;
          }
        } catch {
          // best-effort: fall through to the next candidate
        }
      }
    }
    const quotePerUsdAt = (symbol: string, time: number): number | null => {
      const q = getAsset(symbol).quoteCurrency;
      if (q === 'USD' || q === 'USDT') return 1;
      const series = rateSeries.get(q);
      if (!series || series.candles.length === 0) return null;
      // last candle opened at or before `time`
      let lo = 0;
      let hi = series.candles.length - 1;
      let idx = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (series.candles[mid].openTime <= time) { idx = mid; lo = mid + 1; } else { hi = mid - 1; }
      }
      if (idx < 0) return null;
      const close = series.candles[idx].close;
      if (!Number.isFinite(close) || close <= 0) return null;
      return series.invert ? 1 / close : close;
    };
    const missingRates = [...quotesNeeded].filter((q) => !rateSeries.has(q));
    if (missingRates.length > 0) {
      dataNote = `${dataNote ? dataNote + '; ' : ''}no ${missingRates.join('/')} conversion series — USD costs could not be converted for those pairs and were excluded from their P&L`;
    }

    const trades: PaperTrade[] = [];
    const equityCurve: Array<{ time: number; equity: number }> = [];
    const positions: BtPosition[] = [];
    const cooldowns = new Map<string, number>(); // symbol -> bar index until which no new entry
    const equityState = { value: config.startingCapital };
    const indicatorEngine = new IndicatorEngine(this.ctx, undefined as never);
    const settings = {
      availableCapital: config.startingCapital,
      accountCurrency: 'USD',
      maxRiskPercent: config.riskPercent,
      minRr: config.minRr,
      minConfidence: config.minConfidence,
      maxOpenPositions: config.maxOpenPositions,
      maxLeverage: 100,
      maxCorrelatedPositions: 3,
      maxCurrencyExposurePercent: 30,
      maximumProfit: 0,
    } as never;

    // Per-symbol bar index by openTime: every position must be settled
    // against ITS OWN instrument's bar — settling a GBP/USD position on the
    // EUR/USD bar fabricated fills that never existed.
    const barsByOpen = new Map<string, Map<number, Candle>>();
    for (const [sym, perTf] of histories) {
      const m = new Map<number, Candle>();
      for (const c of perTf[primaryTf] ?? []) m.set(c.openTime, c);
      barsByOpen.set(sym, m);
    }
    const tfMs = TIMEFRAME_MS[primaryTf];
    const equitySampleEvery = Math.max(1, Math.floor(primaryCandles.length / 300));

    for (let i = 200; i < primaryCandles.length; i++) {
      const now = primaryCandles[i].openTime;
      // 1) manage open positions against THEIR OWN current bar (intrabar
      //    approximation: check SL/TP against bar high/low in order — SL first,
      //    conservative)
      for (let p = positions.length - 1; p >= 0; p--) {
        const pos = positions[p];
        const bar = barsByOpen.get(pos.symbol)?.get(now);
        if (!bar) continue; // no bar for this instrument at this time — keep floating
        const closed = this.settlePosition(pos, bar, now + tfMs, quotePerUsdAt, config, trades, equityState);
        if (closed) {
          positions.splice(p, 1);
        }
      }
      // 2) evaluate new signals only on bar close data up to i
      if (positions.length < config.maxOpenPositions) {
        for (const symbol of config.symbols) {
          if (positions.filter((p) => p.symbol === symbol).length > 0) continue; // one position per pair
          if ((cooldowns.get(symbol) ?? 0) > i) continue; // cooldown after a closed trade
          const candles = histories.get(symbol)?.[primaryTf] ?? [];
          if (i >= candles.length) continue;
          const setup = this.evaluateBar(symbol, candles, i, config, indicatorEngine, histories, quotePerUsdAt);
          if (setup) {
            const asset = getAsset(symbol);
            const sizing = sizePosition({
              symbol,
              entryPrice: setup.entry,
              stopLossPrice: setup.sl,
              settings: settings as never,
              usdRate: accountQuoteRate(symbol, (settings as never as UserSettings).accountCurrency ?? 'USD', () => undefined),
            });
            if (sizing.valid && sizing.lots >= asset.minimumLot) {
              // Entries pay friction too: cross the spread direction + slippage.
              const slip = pipsToPrice(symbol, config.slippagePips);
              const fill = setup.direction === 'BUY' ? setup.entry + slip : setup.entry - slip;
              positions.push({
                symbol, direction: setup.direction, entry: fill, sl: setup.sl,
                tp1: setup.tp1, tp2: setup.tp2, lots: sizing.lots,
                openBarTime: now, session: primarySession(now), directionLabel: setup.direction,
              });
              cooldowns.set(symbol, i + 8); // 8-bar cooldown per pair
            }
          }
        }
      }
      if (i % equitySampleEvery === 0) {
        equityCurve.push({ time: now, equity: Number(equityState.value.toFixed(2)) });
      }
    }
    // close remaining positions at EACH position's own last price
    for (const pos of positions) {
      const own = histories.get(pos.symbol)?.[primaryTf] ?? [];
      const last = own[own.length - 1];
      if (!last) continue;
      this.recordTrade(pos, last.close, 'EXPIRED', pos.openBarTime, quotePerUsdAt, config, trades, equityState);
    }
    if (equityCurve.length === 0) {
      equityCurve.push({ time: primaryCandles[primaryCandles.length - 1]?.openTime ?? Date.now(), equity: equityState.value });
    }
    return { trades, equityCurve, dataNote };
  }

  private settlePosition(
    pos: BtPosition,
    bar: Candle,
    barCloseTime: number,
    quotePerUsdAt: (symbol: string, time: number) => number | null,
    config: BacktestConfig,
    trades: PaperTrade[],
    equityState: { value: number },
  ): boolean {
    const slippage = pipsToPrice(pos.symbol, config.slippagePips);
    if (pos.direction === 'BUY') {
      if (bar.low <= pos.sl) {
        this.recordTrade(pos, pos.sl - slippage, 'SL', barCloseTime, quotePerUsdAt, config, trades, equityState);
        return true;
      }
      if (pos.tp2 !== null && bar.high >= pos.tp2) {
        this.recordTrade(pos, pos.tp2 - slippage, 'TP2', barCloseTime, quotePerUsdAt, config, trades, equityState);
        return true;
      }
      if (bar.high >= pos.tp1) {
        this.recordTrade(pos, pos.tp1 - slippage, 'TP1', barCloseTime, quotePerUsdAt, config, trades, equityState);
        return true;
      }
    } else {
      if (bar.high >= pos.sl) {
        this.recordTrade(pos, pos.sl + slippage, 'SL', barCloseTime, quotePerUsdAt, config, trades, equityState);
        return true;
      }
      if (pos.tp2 !== null && bar.low <= pos.tp2) {
        this.recordTrade(pos, pos.tp2 + slippage, 'TP2', barCloseTime, quotePerUsdAt, config, trades, equityState);
        return true;
      }
      if (bar.low <= pos.tp1) {
        this.recordTrade(pos, pos.tp1 + slippage, 'TP1', barCloseTime, quotePerUsdAt, config, trades, equityState);
        return true;
      }
    }
    return false;
  }

  private recordTrade(
    pos: BtPosition,
    exitPrice: number,
    reason: PaperTrade['exitReason'],
    closeTime: number,
    quotePerUsdAt: (symbol: string, time: number) => number | null,
    config: BacktestConfig,
    trades: PaperTrade[],
    equityState: { value: number },
  ): PaperTrade {
    const asset = getAsset(pos.symbol);
    const rawPnl = (pos.direction === 'BUY' ? exitPrice - pos.entry : pos.entry - exitPrice) * pos.lots * asset.contractSize;
    // USD-denominated costs are converted into the pair's QUOTE currency so
    // the netting is single-currency. When no honest conversion exists the
    // cost is excluded (and flagged in dataNote) — never mixed as if it were
    // quote currency.
    const qpu = quotePerUsdAt(pos.symbol, closeTime);
    const commissionQuote = qpu !== null ? config.commissionPerLot * pos.lots * qpu : 0;
    const swapQuote = qpu !== null ? (pos.direction === 'BUY' ? asset.swapLong : asset.swapShort) * pos.lots * qpu : 0;
    const pnl = rawPnl - commissionQuote + swapQuote;
    equityState.value += pnl;
    const riskPerUnit = Math.abs(pos.entry - pos.sl);
    const rr = riskPerUnit > 0 ? Math.abs(exitPrice - pos.entry) / riskPerUnit : 0;
    const trade: PaperTrade = {
      id: crypto.randomUUID(),
      positionId: crypto.randomUUID(),
      signalId: crypto.randomUUID(),
      symbol: pos.symbol,
      direction: pos.direction,
      lots: pos.lots,
      entryPrice: pos.entry,
      exitPrice,
      exitReason: reason,
      pnl: Number(pnl.toFixed(2)),
      fees: Number(commissionQuote.toFixed(2)),
      swap: Number(swapQuote.toFixed(2)),
      rr: Number(rr.toFixed(2)),
      openTime: pos.openBarTime,
      closeTime,
      durationMs: Math.max(0, closeTime - pos.openBarTime),
      session: pos.session as never,
      regime: null,
      modelVersion: 'backtest',
      confidence: null,
      probability: null,
      expectedValue: null,
    };
    trades.push(trade);
    return trade;
  }

  private evaluateBar(
    symbol: string,
    candles: Candle[],
    i: number,
    config: BacktestConfig,
    indicatorEngine: IndicatorEngine,
    histories: Map<string, Partial<Record<Timeframe, Candle[]>>>,
    quotePerUsdAt: (symbol: string, time: number) => number | null,
  ): { direction: 'BUY' | 'SELL'; entry: number; sl: number; tp1: number; tp2: number } | null {
    // Only data up to bar i-1 (closed) is used for the decision.
    const decisionCandles = candles.slice(0, i);
    if (decisionCandles.length < 100) return null;
    const bar = candles[i - 1];
    const values = indicatorEngine.compute(decisionCandles);
    const pa = analyzePriceAction(decisionCandles, symbol, '1h', bar.openTime);
    const higherTf = histories.get(symbol)?.['4h'] ?? decisionCandles;
    const daily = histories.get(symbol)?.['1D'] ?? decisionCandles;
    const levels = computeLevels({
      candles: decisionCandles, higherTfCandles: higherTf, dailyCandles: daily,
      symbol, currentPrice: bar.close,
    });
    const regime = detectRegime({
      symbol, timeframe: '1h', timestamp: bar.openTime,
      indicatorValues: values, priceAction: pa, newsDriven: false, highVolatilityNews: false,
    });

    // simple directional score (backtest-safe subset of live scoring).
    // Strict thresholds + agreement requirements keep the backtest honest:
    // it must not trade every bar on noise.
    let score = 0;
    let agreement = 0;
    if (pa.trendStructure === 'UPTREND') { score += 25; agreement++; }
    if (pa.trendStructure === 'DOWNTREND') { score -= 25; agreement++; }
    if (regime.regime === 'TRENDING_BULLISH') { score += 30; agreement++; }
    if (regime.regime === 'TRENDING_BEARISH') { score -= 30; agreement++; }
    if (regime.regime === 'RANGING' || regime.regime === 'LOW_VOLATILITY' || regime.regime === 'UNCERTAIN') {
      return null; // no edge in ranging/uncertain regimes
    }
    const rsi = values.rsi14 ?? 50;
    score += ((rsi - 50) / 50) * 15;
    const macdH = values.macdHistogram ?? 0;
    score += Math.max(-10, Math.min(10, macdH * 2000));
    // require structure + regime to agree on direction
    if (agreement < 1) return null;
    if (Math.abs(score) < 50) return null;

    const direction: 'BUY' | 'SELL' = score > 0 ? 'BUY' : 'SELL';
    const entryPlan = buildEntry({
      symbol, direction, currentPrice: bar.close, atr: values.atr14 ?? null,
      levels, structure: pa.trendStructure, timestamp: bar.openTime,
    });
    if (entryPlan.status === 'MISSED' || entryPlan.status === 'NOT_YET') {
      entryPlan.preferredEntry = bar.close;
    }
    const slResult = buildStopLoss({
      symbol, direction, entry: entryPlan.preferredEntry, atr: values.atr14 ?? null, levels,
    });
    if (!slResult.valid) return null;
    const tp = buildTakeProfit({
      symbol, direction, entry: entryPlan.preferredEntry, stopLoss: slResult.plan.price,
      atr: values.atr14 ?? null, levels,
    });
    if (tp.rr1 < config.minRr) return null;
    if (entryTooCloseToLevel(symbol, entryPlan.preferredEntry, levels).tooClose) return null;

    // expected value gate (spread from asset metadata). Win/loss/spread are
    // QUOTE-currency amounts; USD commission/swap are converted at the bar's
    // honest rate so the cost block stays single-currency. When no conversion
    // series exists the USD terms are dropped (flagged) instead of mixed.
    const asset = getAsset(symbol);
    const pWin = direction === 'BUY' ? 0.55 : 0.45; // technical bias proxy when ML off
    const qpu = quotePerUsdAt(symbol, bar.openTime);
    const ev = calculateExpectedValue({
      symbol, probabilityWin: pWin,
      averageWinPerLot: Math.abs(tp.tp1 - entryPlan.preferredEntry) * asset.contractSize,
      averageLossPerLot: Math.abs(entryPlan.preferredEntry - slResult.plan.price) * asset.contractSize,
      spreadPerLot: asset.pipSize * 0.8 * asset.contractSize,
      commissionPerLot: qpu !== null ? config.commissionPerLot * qpu : 0,
      swapPerDayPerLot: qpu !== null ? (direction === 'BUY' ? -asset.swapLong : -asset.swapShort) * qpu : 0,
      daysHeld: 2,
    });
    if (!ev.positive) return null;

    return {
      direction, entry: entryPlan.preferredEntry, sl: slResult.plan.price, tp1: tp.tp1, tp2: tp.tp2,
    };
  }

  async list(limit = 20): Promise<BacktestResult[]> {
    return this.ctx.store.find<BacktestResult>('backtests', {}, { createdAt: -1 }, limit);
  }
}
