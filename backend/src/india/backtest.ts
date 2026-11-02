/**
 * IndiaBacktestEngine (spec §52–§53). Runs the SAME strategy rules as the live
 * signal engine (shared indiaSignalCriteria) over REAL broker history with the
 * same SL/TP/sizing math. Supports a train/validation/out-of-sample split.
 * Paper-fill modeling: slippage + per-lot commission are applied to every trade.
 */
import type {
  IndiaBacktestConfig,
  IndiaBacktestMetrics,
  IndiaBacktestRun,
  IndiaCandle,
  IndiaInstrument,
  IndiaTick,
  IndiaTimeframe,
  IndiaTrade,
  MarketRegime,
} from '@fx/shared';
import { INDIA_COLLECTIONS, INDIA_TIMEFRAME_MS } from '@fx/shared';
import { DataStore } from '../db/store';
import { Cache } from '../db/cache';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { computeIndiaIndicators } from './indicator-engine';
import { strategyForRegime, indiaSignalCriteria } from './strategies';
import { generateIndiaStopLoss, generateIndiaTakeProfit } from './sl-tp';
import { sizeIndiaPosition } from './risk-engine';
import { IndiaInstrumentService } from './instruments';
import { IndiaHistoricalService } from './historical';
import { indiaConfig } from './config';
import { logger } from '../core/logger';

interface BacktestBarContext {
  strategy: string;
  regime: string;
  trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  support: number | null;
  resistance: number | null;
}

export class IndiaBacktestEngine {
  private runs = new Map<string, IndiaBacktestRun>();

  constructor(
    private store: DataStore,
    private cache: Cache,
    private events: EventEmitter,
    private instruments: IndiaInstrumentService,
    private historical: IndiaHistoricalService,
  ) {}

  async run(config: IndiaBacktestConfig): Promise<IndiaBacktestRun> {
    const run: IndiaBacktestRun = {
      runId: config.runId,
      config,
      createdAt: Date.now(),
      status: 'RUNNING',
    };
    this.runs.set(run.runId, run);
    await this.persist(run);
    this.events.emit('india:backtest', run);

    try {
      const result = await this.execute(config);
      run.status = 'COMPLETED';
      run.metrics = result.metrics;
      run.trades = result.trades;
      run.equityCurve = result.equityCurve;
      run.validation = result.validation;
      await this.persist(run);
      this.events.emit('india:backtest', run);
      return run;
    } catch (err) {
      run.status = 'FAILED';
      run.error = err instanceof Error ? err.message : String(err);
      await this.persist(run);
      this.events.emit('india:backtest', run);
      return run;
    }
  }

  getRun(runId: string): IndiaBacktestRun | undefined {
    return this.runs.get(runId);
  }

  private async execute(config: IndiaBacktestConfig) {
    const trades: IndiaTrade[] = [];
    const equityCurve: Array<{ time: number; equity: number }> = [];
    let equity = config.startingCapitalInr;
    let peak = equity;
    let maxDrawdownPct = 0;

    const split = this.computeSplit(config);
    const candlesByInstrument = new Map<string, IndiaCandle[]>();
    for (const token of config.instruments) {
      const candles = await this.historical.loadStored(token, config.timeframe, config.start, config.end);
      if (!candles.length) {
        const instrument = this.instruments.getByToken(token);
        if (instrument) {
          try {
            await this.historical.fetchAndSeed(token, config.timeframe, config.start, config.end);
            const refetched = await this.historical.loadStored(token, config.timeframe, config.start, config.end);
            if (refetched.length) candles.push(...refetched);
          } catch (err) {
            logger.warn('india: backtest history unavailable', { token, err: String(err) });
          }
        }
      }
      candlesByInstrument.set(token, candles);
    }

    // Walk each instrument independently (sequential trades per instrument).
    // Equity is accrued on EVERY close (SL/TP inside walkInstrument), not
    // just the force-closed leftover — the old code left the curve flat at
    // starting capital until a final jump, so drawdown/return were fiction.
    const equityState = { value: equity, peak, maxDrawdownPct };
    for (const token of config.instruments) {
      const candles = candlesByInstrument.get(token) ?? [];
      if (candles.length < 100) continue;
      const instrument = this.instruments.getByToken(token);
      if (!instrument) continue;

      const open = this.walkInstrument(token, instrument, candles, config, split, trades, equityState);
      if (open !== null) {
        // Force-close anything still open at the end of the out-of-sample window.
        const closedTrade = this.closeAt(candles, config, instrument, open);
        if (closedTrade) {
          trades.push(closedTrade);
          equityState.value += closedTrade.netPnl;
          equityState.peak = Math.max(equityState.peak, equityState.value);
          equityState.maxDrawdownPct = Math.max(equityState.maxDrawdownPct, equityState.peak > 0 ? (equityState.peak - equityState.value) / equityState.peak : 0);
        }
      }
      equityCurve.push({ time: candles[candles.length - 1]?.openTime ?? config.end, equity: equityState.value });
    }
    equity = equityState.value;
    peak = equityState.peak;
    maxDrawdownPct = equityState.maxDrawdownPct;

    const metrics = this.computeMetrics(trades, config, maxDrawdownPct, equity, config.startingCapitalInr);
    return { metrics, trades, equityCurve, validation: split };
  }

  private walkInstrument(
    token: string,
    instrument: IndiaInstrument,
    candles: IndiaCandle[],
    config: IndiaBacktestConfig,
    split: { trainEnd: number; validationEnd: number; testEnd: number },
    trades: IndiaTrade[],
    equityState: { value: number; peak: number; maxDrawdownPct: number },
  ): { side: 'BUY' | 'SELL'; entry: number; quantity: number; stopLoss: number; target: number; lotSize: number; openedAt: number } | null {
    let open: { side: 'BUY' | 'SELL'; entry: number; quantity: number; stopLoss: number; target: number; lotSize: number; openedAt: number } | null = null;

    for (let i = 60; i < candles.length; i++) {
      const c = candles[i];
      if (open) {
        const exit = this.intrabarExit(open, c);
        if (exit) {
          // Gap-aware: SL fills at the worse side when price jumped through it
          const gapPrice = open.side === 'BUY'
            ? (exit.reason === 'STOP_LOSS' ? Math.min(exit.price, c.low) : exit.price)
            : (exit.reason === 'STOP_LOSS' ? Math.max(exit.price, c.high) : exit.price);
          const trade = this.makeTrade(token, instrument, open, gapPrice, exit.reason, c, config);
          trades.push(trade);
          equityState.value += trade.netPnl;
          equityState.peak = Math.max(equityState.peak, equityState.value);
          equityState.maxDrawdownPct = Math.max(equityState.maxDrawdownPct, equityState.peak > 0 ? (equityState.peak - equityState.value) / equityState.peak : 0);
          open = null;
        } else if (c.openTime > split.testEnd) {
          // Out of the test window: force close at the last price.
          const trade = this.makeTrade(token, instrument, open, c.close, 'ENGINE_EXIT', c, config);
          trades.push(trade);
          equityState.value += trade.netPnl;
          equityState.peak = Math.max(equityState.peak, equityState.value);
          equityState.maxDrawdownPct = Math.max(equityState.maxDrawdownPct, equityState.peak > 0 ? (equityState.peak - equityState.value) / equityState.peak : 0);
          open = null;
        }
        continue;
      }

      // Only trade inside the validation+test windows (spec §53 out-of-sample).
      if (c.openTime <= split.trainEnd) continue;
      const values = computeIndiaIndicators(candles.slice(0, i + 1));
      if (Object.keys(values).length < 10) continue;
      const context = this.contextFor(values);
      const strategy = strategyForRegime(context.regime);
      const side = indiaSignalCriteria(strategy, values, {
        trend: context.trend,
        support: context.support,
        resistance: context.resistance,
      });
      if (!side) continue;

      const entry = c.close;
      const sl = generateIndiaStopLoss({ instrument, indicators: values, side, entry, strategy, minRr: config.minRr, timeframe: config.timeframe });
      const tp = generateIndiaTakeProfit({ instrument, indicators: values, side, entry, strategy, minRr: config.minRr, timeframe: config.timeframe }, sl);
      const sizing = sizeIndiaPosition({
        instrument,
        amountInr: config.startingCapitalInr,
        maxRiskInr: config.maxRiskInr,
        maxMarginPercent: config.maxMarginPercent,
        side,
        entry,
        stopLoss: sl.price,
        target: tp.target,
      });
      if (!sizing.valid || sizing.quantity <= 0) continue;

      const slip = config.slippageTicks * instrument.tickSize;
      const fill = side === 'BUY' ? entry + slip : entry - slip;
      open = {
        side,
        entry: fill,
        quantity: sizing.quantity,
        stopLoss: sl.price,
        target: tp.target,
        lotSize: instrument.lotSize,
        openedAt: c.openTime,
      };
    }
    return open;
  }

  private intrabarExit(
    open: { side: 'BUY' | 'SELL'; entry: number; stopLoss: number; target: number },
    bar: IndiaCandle,
  ): { price: number; reason: IndiaTrade['exitReason'] } | null {
    if (open.side === 'BUY') {
      if (bar.low <= open.stopLoss) return { price: open.stopLoss, reason: 'STOP_LOSS' };
      if (bar.high >= open.target) return { price: open.target, reason: 'TARGET_REACHED' };
    } else {
      if (bar.high >= open.stopLoss) return { price: open.stopLoss, reason: 'STOP_LOSS' };
      if (bar.low <= open.target) return { price: open.target, reason: 'TARGET_REACHED' };
    }
    return null;
  }

  private closeAt(
    candles: IndiaCandle[],
    config: IndiaBacktestConfig,
    instrument: IndiaInstrument,
    open: { side: 'BUY' | 'SELL'; entry: number; quantity: number; stopLoss: number; target: number; lotSize: number; openedAt: number },
  ): IndiaTrade | null {
    const last = candles[candles.length - 1];
    return this.makeTrade(instrument.instrumentToken, instrument, open, last.close, 'ENGINE_EXIT', last, config);
  }

  private makeTrade(
    token: string,
    instrument: IndiaInstrument,
    open: { side: 'BUY' | 'SELL'; entry: number; quantity: number; stopLoss: number; target: number; lotSize: number; openedAt: number },
    exitPrice: number,
    reason: IndiaTrade['exitReason'],
    bar: IndiaCandle,
    config: IndiaBacktestConfig,
  ): IndiaTrade {
    const gross = (exitPrice - open.entry) * open.quantity * (open.side === 'BUY' ? 1 : -1);
    const lots = open.quantity / Math.max(1, open.lotSize);
    const charges = config.commissionPerLot * lots + config.slippageTicks * instrument.tickSize * open.quantity;
    const net = gross - charges;
    return {
      tradeId: randomUUID(),
      positionId: `bt-${token}-${open.openedAt}`,
      signalId: null,
      goalId: null,
      instrumentToken: token,
      tradingSymbol: instrument.tradingSymbol,
      underlying: instrument.underlying,
      side: open.side,
      quantity: open.quantity,
      lotSize: open.lotSize,
      entryPrice: open.entry,
      exitPrice,
      grossPnl: gross,
      charges,
      netPnl: net,
      riskInr: 0,
      targetInr: 0,
      marginInr: 0,
      capitalUsedInr: open.quantity * open.entry,
      exitReason: reason,
      openedAt: open.openedAt,
      closedAt: bar.closeTime,
      strategy: null,
      owner: 'UNIVERSAL',
    };
  }

  private contextFor(values: Record<string, number | null>): BacktestBarContext {
    const trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL' =
      values.trend === 1 ? 'BULLISH' : values.trend === -1 ? 'BEARISH' : 'NEUTRAL';
    const adx = values.adx as number | null;
    const regime: MarketRegime =
      trend === 'BULLISH' ? 'TRENDING_BULLISH' :
      trend === 'BEARISH' ? 'TRENDING_BEARISH' :
      adx !== null && adx >= 25 ? 'BREAKOUT' :
      (values.bbWidth as number | null) !== null && (values.bbWidth as number) < 0.03 ? 'RANGING' : 'UNCERTAIN';
    return {
      strategy: strategyForRegime(regime),
      regime,
      trend,
      support: values.support as number | null,
      resistance: values.resistance as number | null,
    };
  }

  private computeSplit(config: IndiaBacktestConfig): { trainEnd: number; validationEnd: number; testEnd: number } {
    const span = config.end - config.start;
    return {
      trainEnd: config.start + span * 0.6,
      validationEnd: config.start + span * 0.8,
      testEnd: config.end,
    };
  }

  private computeMetrics(
    trades: IndiaTrade[],
    config: IndiaBacktestConfig,
    maxDrawdownPct: number,
    finalEquity: number,
    startingCapital: number,
  ): IndiaBacktestMetrics {
    const n = trades.length;
    if (!n) {
      return {
        winRate: 0, lossRate: 0, expectancy: 0, profitFactor: 0, maxDrawdownPct,
        sharpe: 0, averageWin: 0, averageLoss: 0, consecutiveLosses: 0, tradeCount: 0,
        slippageSensitivity: 0, feeSensitivity: 0, targetAchievement: 0, stopLossFrequency: 0,
        totalReturnPct: 0,
      };
    }
    const wins = trades.filter((t) => t.netPnl > 0);
    const losses = trades.filter((t) => t.netPnl <= 0);
    const avgWin = wins.length ? wins.reduce((a, t) => a + t.netPnl, 0) / wins.length : 0;
    const avgLoss = losses.length ? Math.abs(losses.reduce((a, t) => a + t.netPnl, 0)) / losses.length : 0;
    const grossWin = wins.reduce((a, t) => a + t.netPnl, 0);
    const grossLoss = Math.abs(losses.reduce((a, t) => a + t.netPnl, 0));
    let streak = 0;
    let maxStreak = 0;
    for (const t of trades) {
      if (t.netPnl <= 0) { streak += 1; maxStreak = Math.max(maxStreak, streak); }
      else streak = 0;
    }
    const returns = trades.map((t) => t.netPnl / startingCapital);
    const mean = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
    const variance = returns.length > 1 ? returns.reduce((a, r) => a + (r - mean) ** 2, 0) / (returns.length - 1) : 0;
    const std = Math.sqrt(variance);
    const totalPnl = trades.reduce((a, t) => a + t.netPnl, 0);
    return {
      winRate: n ? wins.length / n : 0,
      lossRate: n ? losses.length / n : 0,
      expectancy: n ? totalPnl / n : 0,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
      maxDrawdownPct: maxDrawdownPct * 100,
      sharpe: std > 0 ? mean / std * Math.sqrt(252) : 0,
      averageWin: avgWin,
      averageLoss: avgLoss,
      consecutiveLosses: maxStreak,
      tradeCount: n,
      slippageSensitivity: config.slippageTicks * 2,
      feeSensitivity: config.commissionPerLot * 2,
      targetAchievement: config.goalTargetInr && totalPnl > 0 ? Math.min(1, totalPnl / config.goalTargetInr) : 0,
      stopLossFrequency: n ? trades.filter((t) => t.exitReason === 'STOP_LOSS').length / n : 0,
      totalReturnPct: startingCapital > 0 ? (finalEquity - startingCapital) / startingCapital * 100 : 0,
    };
  }

  private async persist(run: IndiaBacktestRun): Promise<void> {
    try {
      await this.store.insertOne(INDIA_COLLECTIONS.backtests, run);
    } catch {
      /* best-effort */
    }
  }
}