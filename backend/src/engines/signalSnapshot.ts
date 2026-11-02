/**
 * Signal snapshots. Every signal creates an immutable snapshot capturing the
 * full evidence state: price, indicators, all timeframes, price action,
 * support/resistance, news, events, sentiment, regime, ML probability,
 * historical probability, scores, EV, entry/SL/TP, R:R and model versions.
 * This makes every signal answerable: WHY did the bot do that?
 */
import {
  AssetClass, EconomicEvent, IndicatorValues, Levels, MarketRegimeSnapshot, MultiTimeframeAnalysis,
  NewsItem, PriceActionAnalysis, SignalSnapshot, CurrencySentiment, ExpectedValue,
  EntryPlan, StopLossPlan, TakeProfitPlan, DataMode, StrategyName,
} from '@fx/shared';
import { FxContext } from '../core/context';
import { logger } from '../core/logger';

export interface SnapshotInput {
  signalId: string;
  timestamp: number;
  symbol: string;
  direction: 'BUY' | 'SELL';
  price: number;
  bid: number;
  ask: number;
  spread: number;
  indicators: IndicatorValues;
  assetClass?: AssetClass;
  componentScores?: Record<string, number>;
  strategy?: StrategyName;
  strategyVersion?: string;
  strategyReason?: string;
  multiTimeframe: MultiTimeframeAnalysis;
  priceAction: PriceActionAnalysis;
  levels: Levels;
  news: NewsItem[];
  events: EconomicEvent[];
  sentiment: CurrencySentiment[];
  regime: MarketRegimeSnapshot;
  mlProbability: number;
  historicalProbability: number;
  technicalScore: number;
  riskScore: number;
  expectedValue: ExpectedValue;
  entry: EntryPlan;
  stopLoss: StopLossPlan;
  takeProfit: TakeProfitPlan;
  modelVersion: string;
  featureVersion: string;
  datasetVersion: string;
  indicatorVersion?: string;
  configurationVersion?: string;
  dataQualityScore: number;
  mode: DataMode;
}

export class SignalSnapshotEngine {
  constructor(private ctx: FxContext) {}

  async create(input: SnapshotInput): Promise<SignalSnapshot> {
    const snapshot: SignalSnapshot = { ...input };
    try {
      await this.ctx.store.insertOne('signalSnapshots', snapshot);
    } catch (err) {
      logger.warn('snapshot persist failed', { err: String(err) });
    }
    return snapshot;
  }

  async getBySignalId(signalId: string): Promise<SignalSnapshot | null> {
    try {
      return await this.ctx.store.findOne<SignalSnapshot>('signalSnapshots', { signalId });
    } catch {
      return null;
    }
  }
}
