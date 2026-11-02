/**
 * The shared type contract. Everything the backend emits, the frontend renders,
 * the AI engine consumes and the backtester replays is typed here.
 */
import type {
  AlertType,
  AssetClass,
  BreakerType,
  CandlePattern,
  CandleState,
  DataMode,
  Decision,
  ForexSession,
  ImpactLevel,
  MarketRegime,
  MlAlgorithm,
  MlTarget,
  PriceAction,
  RiskLevel,
  SentimentClass,
  SignalState,
  StrategyName,
  SystemStatus,
  Timeframe,
} from './constants';
// Type-only: broker.ts is self-contained, so there is no runtime cycle.
import type { TermsProvenance } from './broker';

// ---------------------------------------------------------------------------
// Market data
// ---------------------------------------------------------------------------

export interface Tick {
  timestamp: number;
  /** Engine-side receive time (spec §1) — pipeline latency = receivedAt - timestamp. */
  receivedAt?: number;
  symbol: string;
  assetClass?: AssetClass;
  bid: number;
  ask: number;
  mid: number;
  spread: number; // in price units
  source: string;
  mode: DataMode;
  /** Venue that produced the quote (exchange/broker name). */
  venue?: string;
  /** True when bid/ask/spread were modeled from a typical spread, not quoted by the provider. */
  spreadModeled?: boolean;
}

export interface Candle {
  symbol: string;
  assetClass?: AssetClass;
  timeframe: Timeframe;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number; // tick volume where available
  openTime: number; // epoch ms of candle open
  closeTime: number; // epoch ms of candle close (open + tf)
  state: CandleState;
  completed: boolean;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Indicators
// ---------------------------------------------------------------------------

export interface IndicatorValues {
  [key: string]: number | null;
}

export interface IndicatorSnapshot {
  symbol: string;
  timeframe: Timeframe;
  timestamp: number;
  values: IndicatorValues;
  /** Raw series for charting (bounded length). */
  series?: Record<string, Array<{ time: number; value: number }>>;
}

// ---------------------------------------------------------------------------
// Multi-timeframe analysis
// ---------------------------------------------------------------------------

export interface TimeframeAnalysis {
  timeframe: Timeframe;
  trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  momentum: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  volatility: 'HIGH' | 'MEDIUM' | 'LOW';
  emaStructure: 'BULLISH' | 'BEARISH' | 'MIXED';
  rsi: number | null;
  macd: { histogram: number | null; signal: number | null; line: number | null };
  adx: number | null;
  atr: number | null;
  priceStructure: PriceAction;
}

export interface MultiTimeframeAnalysis {
  symbol: string;
  timestamp: number;
  timeframes: TimeframeAnalysis[];
  /** Overall agreement across timeframes. */
  consensus: 'BULLISH' | 'BEARISH' | 'MIXED';
  /** Alignment -1..1: (bullish - bearish) / available timeframes (spec §3). */
  alignment?: number;
  /** True when higher timeframes (1D/4h/1h) and lower (15m/5m/1m) trend in
   *  OPPOSITE directions — strong disagreement must reduce confidence. */
  conflict?: boolean;
  description: string;
}

// ---------------------------------------------------------------------------
// Price action & levels
// ---------------------------------------------------------------------------

export interface PriceActionAnalysis {
  symbol: string;
  timeframe: Timeframe;
  timestamp: number;
  patterns: PriceAction[];
  candlePatterns: CandlePattern[];
  swingHigh: number | null;
  swingLow: number | null;
  trendStructure: 'UPTREND' | 'DOWNTREND' | 'RANGE' | 'UNCLEAR';
  description: string;
}

export interface Levels {
  support: number[];
  resistance: number[];
  pivot: number;
  prevDayHigh: number | null;
  prevDayLow: number | null;
  prevWeekHigh: number | null;
  prevWeekLow: number | null;
  distanceToSupportPips: number | null;
  distanceToResistancePips: number | null;
  nearestSupport: number | null;
  nearestResistance: number | null;
}

// ---------------------------------------------------------------------------
// Sessions, news, events, sentiment
// ---------------------------------------------------------------------------

export interface SessionSnapshot {
  session: ForexSession;
  utcHour: number;
  active: boolean;
}

export interface NewsItem {
  id: string;
  headline: string;
  source: string;
  timestamp: number;
  currencies: string[];
  assets: string[];
  category: string;
  importance: ImpactLevel;
  url?: string;
  body?: string;
  dedupeKey: string;
}

export interface SentimentResult {
  symbol?: string;
  currency?: string;
  class: SentimentClass;
  confidence: number;
  score: number; // -1..1
  model: string;
  source: 'FINBERT' | 'VADER' | 'RULE_BASED' | 'UNAVAILABLE';
  timestamp: number;
}

export interface CurrencySentiment {
  currency: string;
  score: number; // -1..1 aggregated
  confidence: number;
  count: number;
  timestamp: number;
}

export interface EconomicEvent {
  id: string;
  event: string;
  currency: string;
  timestamp: number;
  impact: ImpactLevel;
  forecast: number | null;
  previous: number | null;
  actual: number | null;
  source: string;
  /** ms until event from evaluation time; negative means passed */
  timeToEventMs?: number;
  eventRisk?: number; // 0..1
  postEventState?: 'UNEVENTFUL' | 'SURPRISE' | 'IN_LINE' | 'UNKNOWN';
}

// ---------------------------------------------------------------------------
// Features & ML
// ---------------------------------------------------------------------------

export interface FeatureVector {
  symbol: string;
  timeframe: Timeframe;
  timestamp: number;
  featureVersion: string;
  values: Record<string, number>;
  [key: string]: unknown;
}

export interface MlPrediction {
  symbol: string;
  timeframe: Timeframe;
  timestamp: number;
  rawProbability: number; // P(up) in 0..1
  calibratedProbability: number;
  probability: number;
  confidence: number; // 0..1
  modelVersion: string;
  featureVersion: string;
  datasetVersion: string;
  algorithm: MlAlgorithm;
  target: MlTarget;
  brierScore: number | null;
  calibrationError: number | null;
  shadow: boolean; // challenger in shadow mode
  available: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Regime / EV / risk
// ---------------------------------------------------------------------------

export interface MarketRegimeSnapshot {
  symbol: string;
  timeframe: Timeframe;
  timestamp: number;
  regime: MarketRegime;
  adx: number | null;
  atrPct: number | null;
  volatility: 'HIGH' | 'MEDIUM' | 'LOW';
  description: string;
  /** Regime transition tracking (Phase 6). */
  previousRegime?: MarketRegime | null;
  regimeChanged?: boolean;
  regimeChangeTimestamp?: number | null;
}

export interface ExpectedValue {
  evPerTrade: number; // in account currency per 1 standard lot
  evPerRisk: number; // R multiple expected
  probabilityWin: number;
  probabilityLoss: number;
  averageWin: number;
  averageLoss: number;
  tradingCosts: number;
  positive: boolean;
  breakdown: {
    spread: number;
    commission: number;
    slippage: number;
    swap: number;
  };
  /**
   * Where each cost came from — the account type the trade was priced on, and
   * the source of the spread/commission/swap. Stored with the signal, the
   * position and the resulting trade so the journal never has to re-derive the
   * cost basis from settings that may have changed since.
   */
  costProvenance?: {
    profileId: string;
    label: string;
    spread: string;
    commission: string;
    swap: string;
    /** Round-turn commission in USD per lot that was applied (null = unknown). */
    commissionPerLotUsdRoundTurn: number | null;
    /** True when every cost component came from the bound broker account. */
    brokerSourced: boolean;
  };
}

export interface EntryPlan {
  entryMin: number;
  entryMax: number;
  preferredEntry: number;
  status: 'READY' | 'MISSED' | 'NOT_YET' | 'INVALID';
  reason: string;
  /** Entry style (spec §22): MARKET / LIMIT / BREAKOUT / PULLBACK. */
  entryType?: 'MARKET' | 'LIMIT' | 'BREAKOUT' | 'PULLBACK';
}

export interface StopLossPlan {
  price: number;
  pips: number;
  basis: string;
}

export interface TakeProfitPlan {
  tp1: number;
  tp2: number;
  tp3: number | null;
  rr1: number;
  rr2: number;
  rr3: number | null;
}

export interface PositionSizingResult {
  lots: number;
  units: number;
  riskAmount: number;
  pipDistance: number;
  pipValuePerLot: number;
  marginRequired: number;
  expectedLoss: number;
  expectedProfit: number;
  leverageUsed: number;
  marginRequirement: number;
  minimumLotReached: boolean;
  maximumLotReached: boolean;
}

export interface CircuitBreakerState {
  symbol?: string;
  triggered: boolean;
  activeBreakers: BreakerType[];
  details: Partial<Record<BreakerType, { limit: number; current: number }>>;
  updatedAt: number;
}

export interface RiskAssessment {
  symbol: string;
  timestamp: number;
  level: RiskLevel;
  score: number; // 0..100, higher = riskier
  components: Record<string, number>;
  critical: string[];
  blocked: boolean;
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

export interface SignalEvidence {
  technical: string[];
  multiTimeframe: string[];
  priceAction: string[];
  historical: string[];
  ml: string[];
  news: string[];
  risk: string[];
  opposing: string[];
}

export interface SignalSnapshot {
  signalId: string;
  timestamp: number;
  symbol: string;
  assetClass?: AssetClass;
  direction: 'BUY' | 'SELL';
  price: number;
  bid: number;
  ask: number;
  spread: number;
  indicators: IndicatorValues;
  multiTimeframe: MultiTimeframeAnalysis;
  priceAction: PriceActionAnalysis;
  levels: Levels;
  news: NewsItem[];
  events: EconomicEvent[];
  sentiment: CurrencySentiment[];
  regime: MarketRegimeSnapshot;
  mlProbability: number;
  historicalProbability: number;
  /** Combined ensemble score (-100..100) — every component recorded in componentScores. */
  technicalScore: number;
  /** Ensemble component scores (spec §27): technical, pattern, ml, news, event, combined. */
  componentScores?: Record<string, number>;
  riskScore: number;
  expectedValue: ExpectedValue;
  entry: EntryPlan;
  stopLoss: StopLossPlan;
  takeProfit: TakeProfitPlan;
  modelVersion: string;
  featureVersion: string;
  datasetVersion: string;
  /** Reproducibility (spec §27): the exact indicator + configuration versions. */
  indicatorVersion?: string;
  configurationVersion?: string;
  dataQualityScore: number;
  mode: DataMode;
  /** Strategy routed from the market regime (spec §28). */
  strategy?: StrategyName;
  strategyVersion?: string;
  strategyReason?: string;
}

export interface Signal {
  id: string;
  signalId: string;
  symbol: string;
  direction: 'BUY' | 'SELL';
  state: SignalState;
  decision: Decision;
  timestamp: number;
  /** Hard expiry (spec §93): pre-entry signals EXPIRED past this time, then a
   *  fresh analysis runs — a signal never remains valid indefinitely. */
  expiresAt: number;
  updatedAt: number;
  price: number;
  entry: EntryPlan;
  stopLoss: StopLossPlan;
  takeProfit: TakeProfitPlan;
  confidence: number;
  probability: number;
  risk: RiskAssessment;
  expectedValue: ExpectedValue;
  regime: MarketRegimeSnapshot;
  rr: number;
  evidence: SignalEvidence;
  snapshotId: string;
  modelVersion: string;
  featureVersion: string;
  indicatorVersion?: string;
  configurationVersion?: string;
  strategy?: StrategyName;
  strategyVersion?: string;
  strategyReason?: string;
  mode: DataMode;
  reasonBlocked?: string;
  positionId?: string;
  /** Goal mode: the exact pre-computed size that covers the profit goal within
   *  the user's caps. When present, the fill-time gate validates THIS size
   *  (goal feasibility) instead of re-sizing by risk percent. */
  plannedLots?: number;
  /** Evolution tracking (Phase 8): version increments on meaningful updates.
   *  Historical versions are preserved in the signalVersions store. */
  signalVersion?: number;
  previousVersion?: number | null;
  lastChangeReason?: string;
  events: Array<{ state: SignalState; timestamp: number; note: string }>;
}

export interface SignalUpdate {
  signalId: string;
  symbol: string;
  timestamp: number;
  price: number;
  state: SignalState;
  note: string;
}

// ---------------------------------------------------------------------------
// Paper trading
// ---------------------------------------------------------------------------

export interface PaperAccount {
  accountId: string;
  userId: string | null;
  currency: string;
  startingBalance: number;
  balance: number;
  equity: number;
  margin: number;
  freeMargin: number;
  leverage: number;
  unrealizedPnl: number;
  realizedPnl: number;
  fees: number;
  maxDrawdownPct: number;
  /** High-water mark of EQUITY (balance + floating P&L) used for drawdown. */
  equityPeak?: number;
  dailyPnl: number;
  weeklyPnl: number;
  /** Consecutive losing trades (spec §34) — trips MAX_CONSECUTIVE_LOSSES. */
  consecutiveLosses: number;
  dailyPnlResetAt: number;
  weeklyPnlResetAt: number;
  openPositionCount: number;
  updatedAt: number;
}

export interface PaperOrder {
  id: string;
  signalId: string;
  /** Idempotency key (spec §71/§123): one order per signal, never duplicated. */
  clientOrderId?: string;
  /** Signal version at order time (Phase 20). */
  signalVersion?: number;
  symbol: string;
  direction: 'BUY' | 'SELL';
  status: 'PENDING' | 'FILLED' | 'REJECTED' | 'EXPIRED' | 'CANCELLED';
  requestedPrice: number;
  fillPrice: number | null;
  lots: number;
  createdAt: number;
  filledAt: number | null;
}

export interface PaperPosition {
  id: string;
  signalId: string;
  symbol: string;
  direction: 'BUY' | 'SELL';
  lots: number;
  entryPrice: number;
  stopLoss: number;
  /** Stop the trade was PLANNED with — rr is measured against this, never a
   *  trailed/breakeven-moved stop. Falls back to `stopLoss` for legacy rows. */
  initialStopLoss?: number;
  /** null when no TP is configured (0 is the disabled sentinel upstream). */
  takeProfit1: number | null;
  takeProfit2: number | null;
  openTime: number;
  currentPrice: number;
  unrealizedPnl: number;
  fees: number;
  swap: number;
  durationMs: number;
  status: 'OPEN' | 'CLOSED';
  /** Original size at entry — partial TP (Phase 17) reduces `lots` in place. */
  entryLots: number;
  /** ATR at open (price units) — used by the trailing stop (spec §63). */
  atr?: number;
  /** User's configured minimum net profit in account currency — the auto-exit goal (spec §38). */
  targetProfit?: number;
  /** True once the breakeven stop has been applied (Phase 19). */
  breakevenApplied?: boolean;
  /** True once the trailing stop has ratcheted the SL into profit. */
  trailingActive?: boolean;
  /** Swing extreme since entry (position-anchored Chandelier, geraked/metatrader5
   *  CEZLSMA adoption): the highest bid / lowest ask observed while OPEN. The
   *  CE trailing mode anchors its ATR trail to this instead of hugging price. */
  swingExtreme?: { high: number; low: number };
  /** Prediction-vs-reality record (spec §48): the signal's state at entry. */
  confidence?: number | null;
  probability?: number | null;
  expectedValue?: number | null;
  strategy?: string;
  strategyVersion?: string;
  modelVersion?: string;
  featureVersion?: string;
  indicatorVersion?: string;
  configurationVersion?: string;
  /** Slippage (bps) applied to the fill — never a perfect execution (spec §40-41). */
  slippageBps?: number;
  /** Risk level at entry (spec §24 attribution). */
  riskLevel?: string;
  /**
   * Terms this position was opened under: broker account type, the numbers
   * that sized it with their provenance, its costs and the live gate state.
   * Frozen at open so history cannot be re-priced by later settings changes.
   */
  terms?: TermsProvenance;
  // ── Forex canonical view (§16/§28) — enriched live by the paper engine,
  //    never computed client-side. Optional so legacy stored docs stay valid.
  baseCurrency?: string;
  quoteCurrency?: string;
  accountCurrency?: string;
  contractSize?: number;
  /** lots × contractSize. */
  units?: number;
  currentBid?: number | null;
  currentAsk?: number | null;
  pipSize?: number;
  /** Signed pips since entry (direction-aware: positive = in profit). */
  pipMovement?: number;
  /** Floating P&L in the pair's quote currency (executable-side mark). */
  quotePnl?: number;
  /** Pip value for the CURRENT lot size, in the quote currency. */
  quotePipValue?: number;
  /** Quote→account conversion rate actually used for the live mark. */
  convRate?: number;
  convRateTimestamp?: number;
  convSource?: string;
  /** True when the conversion rate exceeded the freshness window. */
  convStale?: boolean;
  /** Gross (pre-cost) floating P&L in account currency. */
  grossPnlAccount?: number;
  /** Projected close commission in account currency. */
  projectedCommission?: number;
  /** Notional exposure in account currency. */
  notionalAccount?: number;
  /** Required margin in account currency (exposure ÷ leverage). */
  marginAccount?: number;
  leverage?: number;
  /** Broker minimum lot for this symbol — drives the ½-close button's availability. */
  minimumLot?: number;
}

export interface PaperTrade {
  id: string;
  positionId: string;
  signalId: string;
  symbol: string;
  direction: 'BUY' | 'SELL';
  lots: number;
  entryPrice: number;
  exitPrice: number;
  exitReason: 'TP1' | 'TP2' | 'SL' | 'MANUAL' | 'EXPIRED' | 'INVALIDATED' | 'TRAILING' | 'OPPOSITE_SIGNAL' | 'REGIME_REVERSAL' | 'PROFIT_TARGET_REACHED' | 'WEEKEND_FLATTEN' | 'MT5_MIRROR_FAILED';
  pnl: number;
  fees: number;
  swap: number;
  rr: number;
  openTime: number;
  closeTime: number;
  durationMs: number;
  session: ForexSession;
  regime: MarketRegime | null;
  modelVersion: string;
  /** Prediction-vs-reality record (spec §48). */
  confidence: number | null;
  probability: number | null;
  expectedValue: number | null;
  strategy?: string;
  strategyVersion?: string;
  featureVersion?: string;
  indicatorVersion?: string;
  configurationVersion?: string;
  slippageBps?: number;
  // ── Realized-P&L provenance (§18): the quote→account conversion actually
  //    used AT EXIT, stored with the trade so history never re-prices.
  grossQuotePnl?: number;
  fxRate?: number;
  fxRateAt?: number;
  fxRateSource?: string;
  fxStale?: boolean;
  /** Terms this trade was priced and exited under (see PaperPosition.terms). */
  terms?: TermsProvenance;
}

// ---------------------------------------------------------------------------
// Backtesting
// ---------------------------------------------------------------------------

export interface BacktestConfig {
  symbols: string[];
  timeframes: Timeframe[];
  start: number;
  end: number;
  startingCapital: number;
  riskPercent: number;
  minRr: number;
  minConfidence: number;
  maxOpenPositions: number;
  commissionPerLot: number;
  slippagePips: number;
  spreadMultiplier: number;
  useMl: boolean;
  includeNews: boolean;
  includeEvents: boolean;
}

export interface BacktestResult {
  backtestId: string;
  config: BacktestConfig;
  createdAt: number;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  error?: string;
  metrics?: BacktestMetrics;
  trades?: PaperTrade[];
  equityCurve?: Array<{ time: number; equity: number }>;
  /** Monte Carlo robustness analysis (Phase 30), when enough trades exist. */
  monteCarlo?: MonteCarloResult;
  /** Honest note when the provider could not supply the exact requested window. */
  dataNote?: string;
}

export interface BacktestMetrics {
  totalReturnPct: number;
  /** Annualized compound growth rate (spec §66); 0 when the window is too short. */
  cagrPct: number;
  /** Net profit / max absolute drawdown (spec §66); Infinity when no drawdown. */
  recoveryFactor: number;
  winRate: number;
  profitFactor: number;
  expectancy: number; // avg R
  sharpe: number;
  sortino: number;
  maxDrawdownPct: number;
  averageWin: number;
  averageLoss: number;
  maxLoss: number;
  maxWinStreak: number;
  maxLossStreak: number;
  tradeCount: number;
  averageTradeDurationMs: number;
  byPair: Record<string, { trades: number; winRate: number; pnl: number }>;
  byTimeframe: Record<string, { trades: number; winRate: number; pnl: number }>;
  bySession: Record<string, { trades: number; winRate: number; pnl: number }>;
  byRegime: Record<string, { trades: number; winRate: number; pnl: number }>;
  /** Performance attribution (spec §24): which strategy/direction actually works. */
  byStrategy: Record<string, { trades: number; winRate: number; pnl: number }>;
  byDirection: Record<string, { trades: number; winRate: number; pnl: number }>;
}

/** Monte Carlo robustness (Phase 30): resampled trade-outcome distribution. */
export interface MonteCarloResult {
  iterations: number;
  p50DrawdownPct: number;
  p95DrawdownPct: number;
  worstDrawdownPct: number;
  maxLossStreak: number;
  riskOfRuinPct: number;
}

/** Replay journal entry (Phase 24-25) — the decision at one historical point. */
export interface ReplayJournalEntry {
  time: number;
  price: number;
  decision: Decision;
  state: string;
  reason: string;
}

export interface ReplayResult {
  runId: string;
  environment: 'REPLAY';
  symbol: string;
  timeframe: Timeframe;
  start: number;
  end: number;
  speed: number;
  createdAt: number;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED';
  error?: string;
  journal: ReplayJournalEntry[];
  candlesBuilt: number;
  ticksFed: number;
  signals: number;
  trades: number;
}

export interface WalkForwardResult {
  experimentId: string;
  datasetVersion: string;
  folds: Array<{
    trainStart: number;
    trainEnd: number;
    validateStart: number;
    validateEnd: number;
    testStart: number;
    testEnd: number;
    modelVersion: string;
    testMetrics: Record<string, number>;
  }>;
  averageTestMetrics: Record<string, number>;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Versioning / MLOps
// ---------------------------------------------------------------------------

export interface DatasetVersion {
  datasetVersion: string;
  provider: string;
  assets: string[];
  timeframes: Timeframe[];
  startDate: number;
  endDate: number;
  features: string[];
  target: MlTarget;
  preprocessingVersion: string;
  rows: number;
  createdAt: number;
}

export interface ModelVersion {
  modelVersion: string;
  algorithm: MlAlgorithm;
  target: MlTarget;
  datasetVersion: string;
  featureVersion: string;
  trainingPeriod: { start: number; end: number };
  validationPeriod: { start: number; end: number };
  testPeriod: { start: number; end: number };
  hyperparameters: Record<string, number | string | boolean>;
  metrics: Record<string, number>;
  createdAt: number;
  status: 'CHAMPION' | 'CHALLENGER' | 'ARCHIVED' | 'FAILED';
  shadow: boolean;
}

// ---------------------------------------------------------------------------
// System / quality
// ---------------------------------------------------------------------------

export interface ComponentStatus {
  name: string;
  status: SystemStatus;
  detail: string;
  lastChecked: number;
  latencyMs?: number;
}

export interface SystemStatusReport {
  generatedAt: number;
  components: ComponentStatus[];
  overall: SystemStatus;
  signalGenerationAllowed: boolean;
}

export interface DataQualityReport {
  symbol: string;
  timestamp: number;
  score: number; // 0..1
  freshnessMs: number;
  missingCandles: number;
  duplicates: number;
  invalidOhlc: number;
  spreadPips: number;
  providerHealth: SystemStatus;
  newsAvailable: boolean;
  calendarAvailable: boolean;
  checks: string[];
}

export interface UserSettings {
  userId?: string;
  minimumProfit: number;
  availableCapital: number;
  accountCurrency: string;
  maxRiskPercent: number;
  minRr: number;
  minConfidence: number;
  maxDailyLossPercent: number;
  maxWeeklyLossPercent: number;
  maxDrawdownPercent: number;
  maxConsecutiveLosses: number;
  maxOpenPositions: number;
  maxCorrelatedPositions: number;
  maxLeverage: number;
  maxCurrencyExposurePercent: number;
  /** Investment filters (spec §18): a sized position whose notional falls
   *  outside [minimumInvestment, maximumPositionSize] is rejected with
   *  NO SUITABLE OPPORTUNITY — never force a trade to fit the money. */
  minimumInvestment: number;
  maximumPositionSize: number;
  selectedPairs: string[];
  /** Symbol lock (XM/MT5 pattern): when set, signals are scanned ONLY for this
   *  symbol and every auto/manual entry — paper, MT5 demo and real — is
   *  refused for any other symbol. null/undefined = trade the whole watchlist. */
  symbolLock?: string | null;
  /**
   * Goal-session trade cap (§ goal): when set, the paper wallet stops opening
   * NEW automatic entries after this many CLOSED trades since goalBaselineAt
   * — even if the ₹ target has not been reached. null = unlimited.
   */
  goalMaxTrades?: number | null;
  /** Epoch ms: baseline for counting the current goal session's trades. */
  goalBaselineAt?: number | null;
  selectedTimeframes: Timeframe[];
  preferredSessions: ForexSession[];
  newsTrading: boolean;
  highImpactNewsRestriction: boolean;
  /** Trailing stop (spec §63): enable ATR-based trailing after a profit target. */
  trailingStopEnabled: boolean;
  /** 'price' (default): trail hangs off the current price. 'chandelier'
   *  (CEZLSMA adoption, geraked/metatrader5): trail hangs off the swing
   *  extreme since entry — survives pullbacks that clip a price trail. */
  trailingStopMode?: 'price' | 'chandelier';
  /** Trailing distance = ATR × multiplier. */
  trailingStopAtrMultiplier: number;
  /** Lot sizing mode (§ user-lot): 'auto' = engine computes the largest safe
   *  valid lot within every cap; 'manual' = the user's exact size is used —
   *  validated against broker rules and the caps, never silently adjusted. */
  lotMode: 'auto' | 'manual';
  /** The user's exact lot size when lotMode = 'manual'. */
  manualLot: number;
  /** Activate the trailing stop after this many R of profit. */
  trailingStopActivateR: number;
  /** Paper fill slippage in basis points (spec §40-41): BUY fills above ask,
   *  SELL below bid. Never a perfect execution. */
  slippageBps: number;
  /** Pre-entry signal expiry (ms); EXPIRED past this, then fresh analysis. */
  signalExpiryMs: number;
  /** Kill switches (Phase 23): disabled asset classes / assets / strategies. */
  disabledAssetClasses: AssetClass[];
  disabledAssets: string[];
  disabledStrategies: StrategyName[];
  /** Weekend forex (Phase 1-3): forex is closed on weekends unless enabled. */
  weekendTradingEnabled: boolean;
  /** FXBot adoption: auto-close open positions before the Friday FX close so
   *  nothing is held across the weekend gap. Default ON. */
  weekendFlattenEnabled?: boolean;
  /** Partial take profit (Phase 17): % of the ORIGINAL size closed at TP1/TP2. */
  tp1ClosePct: number;
  tp2ClosePct: number;
  /** Breakeven (Phase 19): move SL to entry after this many R of profit. */
  breakevenEnabled: boolean;
  breakevenActivateR: number;
  /** Trailing method (Phase 18). */
  trailingMethod: 'ATR' | 'PERCENT' | 'FIXED';
  /** PERCENT trailing: distance = price × trailingPercent / 100. */
  trailingPercent: number;
  /** FIXED trailing: distance in price units. */
  trailingFixedDistance: number;
  /** Portfolio limits (Phase 15). 0 = unlimited. */
  maxForexPositions: number;
  maxCryptoPositions: number;
  maxTradesPerAsset: number;
  maxTradesPerCurrency: number;
  /** Legacy flag: entries are no longer hard-blocked to one position — the
   *  aggregate margin/leverage caps (maxMarginUsedPct, maxLeverage) decide how
   *  many positions open at once. Kept for UI/config compatibility. */
  singlePositionMode: boolean;
  /** Auto-execution: when ON, signals that reach ENTRY_REACHED open a paper
   *  position automatically (after the full fill-time gate). When OFF, the
   *  signal is shown and the user trades it manually with the Trade button. */
  autoTradeEnabled: boolean;
  /** Max margin % of equity a new auto-trade may use (0 = unlimited). */
  maxMarginUsedPct: number;
  paperStartingCapital: number;
  /** Signal source: 'goal' hunts every symbol for a setup that can cover the
   *  minimumProfit goal within risk limits; 'strict' uses the full ML-gated
   *  pipeline. */
  signalMode: 'goal' | 'strict';
}

export interface Alert {
  id: string;
  type: AlertType;
  symbol?: string;
  message: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  timestamp: number;
  read: boolean;
}

export interface AuditEntry {
  id: string;
  action: string;
  entity: string;
  entityId?: string;
  userId?: string;
  meta: Record<string, unknown>;
  timestamp: number;
}

export interface OpportunityRanking {
  symbol: string;
  decision: Decision;
  score: number;
  probability: number;
  confidence: number;
  riskLevel: RiskLevel;
  regime: MarketRegime;
  spreadPips: number;
  expectedValue: number;
  reason: string;
  updatedAt: number;
  /** Opportunity board (Phase 41). */
  strategy?: string;
  status?: 'READY' | 'WATCH' | 'BLOCKED';
}

/** Goal-driven market search result (Goal mode): whether the minimumProfit
 *  goal is reachable on a symbol within the user's risk/margin/leverage caps,
 *  and the exact plan (entry/SL/TP/lots) if it is. All prices are real live
 *  quotes — never fabricated. */
export interface GoalAnalysis {
  symbol: string;
  direction: 'BUY' | 'SELL' | null;
  entry: number;
  entryMin: number;
  entryMax: number;
  stopLoss: number;
  takeProfit: number;
  rr: number;
  lots: number;
  goalProfit: number;
  expectedProfit: number;
  riskAmount: number;
  riskPctRequired: number;
  marginPct: number;
  leverageUsed: number;
  probability: number | null;
  confidence: number;
  /** AI gate (never bypassed): the live model prediction validating this
   *  analysis. PASS = fresh prediction on the current market state; BLOCKED =
   *  the AI engine is unavailable/stale/refused — the setup may still be
   *  DISPLAYED but can never execute (auto or manual). */
  aiGate?: 'PASS' | 'BLOCKED';
  aiProbability?: number | null;
  aiConfidence?: number | null;
  aiModelVersion?: string;
  aiReason?: string;
  /** True when the goal is reachable on this symbol right now within the
   *  user's caps — an actionable Trade-able signal exists. */
  achievable: boolean;
  reason: string;
  updatedAt: number;
  signalId?: string;
}

export interface AuthUser {
  id: string;
  email: string;
  role: 'ADMIN' | 'USER';
  createdAt: number;
}

export interface AuthResponse {
  token: string;
  user: AuthUser;
}
