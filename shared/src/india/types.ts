/**
 * Shared type contract for the INDIAN MARKET subsystem.
 *
 * Architecturally isolated from Forex/Crypto: these types are Indian-specific and
 * namespaced under `India*`. They reuse only market-agnostic primitives from the
 * shared package (CandleState, DataMode, etc.).
 */
import type {
  CandleState,
  DataMode,
  MarketRegime,
  StrategyName,
  SystemStatus,
  Timeframe,
} from '../constants';
import type {
  IndiaContractType,
  IndiaDataHealthState,
  IndiaDteBucket,
  IndiaExchange,
  IndiaExecutionMode,
  IndiaExecutionOwner,
  IndiaGoalState,
  IndiaInstrumentStatus,
  IndiaMarketStatus,
  IndiaOptionType,
  IndiaOrderStatus,
  IndiaRejectionReason,
  IndiaSegment,
  IndiaSessionPhase,
  IndiaSignalState,
  IndiaTimeframe,
  IndiaTradeExitReason,
  IndiaUnderlying,
} from './constants';

// ---------------------------------------------------------------------------
// Market data
// ---------------------------------------------------------------------------

/**
 * Normalized Indian market tick (spec §7). The exchange/broker timestamp is
 * NEVER overwritten with the server receive time — both are stored so latency
 * and debugging stay honest.
 */
export interface IndiaTick {
  exchange: IndiaExchange;
  segment: IndiaSegment;
  instrumentToken: string;
  tradingSymbol: string;
  underlying: string;
  /** Broker/exchange timestamp (epoch ms). */
  marketTimestamp: number;
  /** Server receive timestamp (epoch ms). */
  receivedAt: number;
  /** Alias of marketTimestamp for consumers that expect `timestamp`. */
  timestamp: number;
  ltp: number;
  bid: number | null;
  ask: number | null;
  bidQuantity: number | null;
  askQuantity: number | null;
  volume: number | null;
  openInterest: number | null;
  dayOpen: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  previousClose: number | null;
  lastTradeQuantity: number | null;
  /** Which broker/exchange produced this tick (e.g. ZERODHA / UPSTOX). */
  source: string;
  /** True when the contract is tradable at the moment of the tick. */
  tradable: boolean;
}

/** Broker instrument metadata (spec §11 contract master). */
export interface IndiaInstrument {
  instrumentToken: string;
  exchange: IndiaExchange;
  segment: IndiaSegment;
  tradingSymbol: string;
  underlying: string;
  name: string;
  contractType: IndiaContractType;
  expiry: number | null;
  strike: number | null;
  optionType: IndiaOptionType | null;
  lotSize: number;
  tickSize: number;
  freezeQuantity: number | null;
  status: IndiaInstrumentStatus;
  tradable: boolean;
  /** Position sizing margin factor (0..1) as reported by the broker when available. */
  marginRequirement?: number;
  minimumLot?: number;
  /**
   * Broker-specific instrument key used for WebSocket subscription and REST calls.
   * Upstox format: 'NSE_INDEX|26000'. Zerodha: same as instrumentToken.
   * Always set by the broker adapter; consumers should prefer instrumentToken for
   * all internal lookups and only use this field for broker API calls.
   */
  instrumentKey?: string;
}

// ---------------------------------------------------------------------------
// Candles (internal normalized format, spec §13)
// ---------------------------------------------------------------------------

export interface IndiaCandle {
  id: string;
  exchange: IndiaExchange;
  segment: IndiaSegment;
  instrumentToken: string;
  tradingSymbol: string;
  underlying: string;
  timeframe: IndiaTimeframe;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  openInterest: number | null;
  openTime: number;
  closeTime: number;
  state: CandleState;
  completed: boolean;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Market session & calendar (spec §9)
// ---------------------------------------------------------------------------

export interface IndiaMarketSessionInfo {
  status: IndiaMarketStatus;
  isHoliday: boolean;
  /** Current IST wall-clock fields (derived from UTC, never the client clock). */
  ist: { year: number; month: number; day: number; weekday: number; hour: number; minute: number };
  /** Epoch ms of the trading-day open/close (null outside a trading day). */
  marketOpenAt: number | null;
  marketCloseAt: number | null;
  /** True only during continuous trading 09:15–15:30 IST on a trading day. */
  marketOpen: boolean;
  /** Segment-level status: only the listed segments are tradable right now. */
  segments: Partial<Record<IndiaSegment, boolean>>;
  generatedAt: number;
}

// ---------------------------------------------------------------------------
// Data health (spec §8)
// ---------------------------------------------------------------------------

export interface IndiaDataHealth {
  state: IndiaDataHealthState;
  wsConnected: boolean;
  authenticated: boolean;
  subscribed: boolean;
  lastTickAt: number | null;
  lastHeartbeatAt: number | null;
  /** Age in ms of the most recent tick (Infinity when none). */
  tickAgeMs: number | null;
  reconnectCount: number;
  droppedMessages: number;
  stale: boolean;
  /** Per-instrument subscription health. */
  instruments: Record<string, { subscribed: boolean; lastTickAt: number | null; tickAgeMs: number | null }>;
  detail: string;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Indicators (spec §16)
// ---------------------------------------------------------------------------

export interface IndiaIndicatorValues {
  [key: string]: number | null;
}

export interface IndiaIndicatorSnapshot {
  instrumentToken: string;
  tradingSymbol: string;
  underlying: string;
  timeframe: IndiaTimeframe;
  timestamp: number;
  values: IndiaIndicatorValues;
  series?: Record<string, Array<{ time: number; value: number }>>;
}

// ---------------------------------------------------------------------------
// Analysis (spec §15, §18)
// ---------------------------------------------------------------------------

export interface IndiaAnalysisSnapshot {
  id: string;
  instrumentToken: string;
  tradingSymbol: string;
  underlying: string;
  segment: IndiaSegment;
  timeframe: IndiaTimeframe;
  timestamp: number;
  marketTimestamp: number;
  trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  regime: MarketRegime;
  momentum: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  volatility: 'HIGH' | 'MEDIUM' | 'LOW';
  structure: 'UPTREND' | 'DOWNTREND' | 'RANGE' | 'BREAKOUT' | 'BREAKDOWN' | 'UNCLEAR';
  /** Swing structure derived from real data (spec §18). */
  swingHigh: number | null;
  swingLow: number | null;
  higherHighs: boolean;
  higherLows: boolean;
  lowerHighs: boolean;
  lowerLows: boolean;
  support: number | null;
  resistance: number | null;
  signalQuality: number; // 0..1
  confidence: number; // 0..1
  featureSnapshot: Record<string, number>;
  prediction: IndiaModelPrediction | null;
  riskContext: Partial<Record<string, number | string>>;
  description: string;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// ML prediction (spec §19)
// ---------------------------------------------------------------------------

/** ML serving state for a prediction (spec §15). OFFLINE means the automatic
 *  trading path must stop; SHADOW means a challenger bundle answered (real
 *  probabilities, not yet promoted). */
export type IndiaMlStatus = 'ONLINE' | 'SHADOW' | 'OFFLINE';

export interface IndiaModelPrediction {
  instrumentToken: string;
  tradingSymbol: string;
  underlying: string;
  timeframe: IndiaTimeframe;
  timestamp: number;
  /** P(direction up) in 0..1. Meaningless when available=false — never read it
   *  without checking availability (spec §15 forbids fake-confidence fallbacks). */
  probability: number;
  /** 0..1. */
  confidence: number;
  modelVersion: string;
  featureVersion: string;
  /** Prediction horizon in bars/timeframe units. */
  horizon: number;
  available: boolean;
  error?: string;
  /** Serving state behind this prediction. */
  mlStatus?: IndiaMlStatus;
  /** V2 stacked+meta pipeline: meta-label probability and its gate. When
   *  `filtered` is true the model itself says NO_TRADE for this setup. */
  metaProbability?: number | null;
  metaThreshold?: number | null;
  filtered?: boolean;
  /** V2 stacked-model direction: +1 up, −1 down. */
  direction?: number;
}

// ---------------------------------------------------------------------------
// SL / TP / sizing (spec §13, §22, §25)
// ---------------------------------------------------------------------------

export interface IndiaStopLossPlan {
  price: number;
  /** Risk distance in index points / rupees. */
  distance: number;
  basis: string;
}

export interface IndiaTakeProfitPlan {
  target: number;
  /** R multiple of the SL distance. */
  rr: number;
  basis: string;
}

export interface IndiaPositionSizingResult {
  quantity: number;
  lots: number;
  requiredCapital: number;
  marginEstimate: number;
  maximumLoss: number;
  targetProfit: number;
  risk: number;
  rr: number;
  valid: boolean;
  reason: string;
}

// ---------------------------------------------------------------------------
// Signals (spec §20, §21)
// ---------------------------------------------------------------------------

/**
 * Outcome of one pre-trade check.
 *
 * `WARN` exists because most trading context is not binary. A signal taken into
 * an 85th-percentile volatility regime is worse than the same signal in a calm
 * one, but it is not disqualified — it deserves a smaller confidence, and the
 * reason deserves to be visible.
 */
export type IndiaGateVerdict = 'PASS' | 'WARN' | 'BLOCK' | 'SKIPPED';

export interface IndiaGateResult {
  /** Stable machine id, e.g. 'session-window', 'option-posture', 'dte'. */
  gate: string;
  /** Short human label for the UI. */
  label: string;
  verdict: IndiaGateVerdict;
  /** One line carrying the numbers that produced the verdict, not just a label.
   *  This is what makes a rejected signal reviewable after the fact. */
  detail: string;
  /** Additive confidence adjustment this gate applied. Negative penalises. */
  confidenceDelta?: number;
}

/**
 * The full reasoning trail behind a signal — or behind the absence of one.
 *
 * Kept on the signal so that a trade can be audited later without re-deriving
 * the market state that produced it, and emitted on rejection so the UI can show
 * why the engine stayed out. A system that silently declines to trade is
 * indistinguishable from a broken one.
 */
export interface IndiaSignalGateTrail {
  passed: boolean;
  /** Confidence from analysis, before any gate adjusted it. */
  baseConfidence: number;
  /** Confidence after every gate's adjustment, clamped to 0..1. */
  finalConfidence: number;
  gates: IndiaGateResult[];
  /** `gate` id of the first BLOCK verdict, or null when nothing blocked. */
  blockedBy: string | null;
}

/** A setup the engine considered and did not take, with the reason. Emitted on
 *  `INDIA_CHANNELS.signalRejected` to feed the "why no trade" view. */
export interface IndiaSignalRejection {
  instrumentToken: string;
  tradingSymbol: string;
  underlying: string;
  side: 'BUY' | 'SELL' | null;
  strategy: StrategyName | null;
  at: number;
  /** Which stage of the pipeline stopped it. */
  stage: 'NO_SETUP' | 'COOLDOWN' | 'GATE' | 'SIZING';
  reason: string;
  gateTrail?: IndiaSignalGateTrail;
  /** Set when the setup was found during a goal run rather than a universal scan. */
  goalId?: string;
}

export interface IndiaSignal {
  signalId: string;
  instrumentToken: string;
  tradingSymbol: string;
  underlying: string;
  exchange: IndiaExchange;
  segment: IndiaSegment;
  contractType: IndiaContractType;
  side: 'BUY' | 'SELL';
  entry: number;
  stopLoss: number;
  target: number;
  quantity: number;
  lotSize: number;
  riskInr: number;
  expectedProfitInr: number;
  rr: number;
  confidence: number;
  strategy: StrategyName;
  timeframe: IndiaTimeframe;
  createdAt: number;
  marketTimestamp: number;
  expiresAt: number;
  status: IndiaSignalState;
  analysis: IndiaAnalysisSnapshot | null;
  owner: IndiaExecutionOwner;
  executionMode: IndiaExecutionMode;
  /** Option-flow posture confirmation (PCR/OI) when the flow engine is live. */
  optionConfirmation?: IndiaOptionFlowSnapshot['posture'] | null;
  /** Every pre-trade check that ran, and what it concluded. */
  gateTrail?: IndiaSignalGateTrail;
  /** Execution authority signals blocked by GOAL mode display this. */
  blockedReason?: string;
  invalidatedReason?: IndiaRejectionReason | null;
  positionId?: string;
  goalId?: string;
}

// ---------------------------------------------------------------------------
// Orders / positions / trades (spec §37, §48, §50)
// ---------------------------------------------------------------------------

export interface IndiaOrder {
  orderId: string;
  clientOrderId: string;
  positionId: string | null;
  signalId: string | null;
  goalId: string | null;
  instrumentToken: string;
  tradingSymbol: string;
  exchange: IndiaExchange;
  segment: IndiaSegment;
  side: 'BUY' | 'SELL';
  quantity: number;
  status: IndiaOrderStatus;
  requestedPrice: number | null;
  averagePrice: number | null;
  filledQuantity: number;
  remainingQuantity: number;
  createdAt: number;
  updatedAt: number;
  rejectionReason?: string;
  /** Where this order was sent: PAPER or LIVE. */
  mode: 'PAPER' | 'LIVE';
  source: string;
}

export interface IndiaPosition {
  positionId: string;
  /** Ownership: only the owning engine can modify this position (spec §37). */
  strategyOwner: IndiaExecutionOwner;
  executionMode: IndiaExecutionMode;
  goalId: string | null;
  signalId: string | null;
  instrumentToken: string;
  tradingSymbol: string;
  underlying: string;
  exchange: IndiaExchange;
  segment: IndiaSegment;
  contractType: IndiaContractType;
  side: 'BUY' | 'SELL';
  quantity: number;
  entry: number;
  stopLoss: number;
  target: number;
  openedAt: number;
  closedAt: number | null;
  currentPrice: number | null;
  unrealizedPnl: number;
  realizedPnl: number;
  status: 'OPEN' | 'CLOSED';
  exitReason: IndiaTradeExitReason | null;
  trailingStop: number | null;
  breakevenApplied: boolean;
  audit: Array<{ timestamp: number; action: string; note: string }>;
}

export interface IndiaTrade {
  tradeId: string;
  positionId: string;
  signalId: string | null;
  goalId: string | null;
  instrumentToken: string;
  tradingSymbol: string;
  underlying: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  lotSize: number;
  entryPrice: number;
  exitPrice: number;
  grossPnl: number;
  charges: number;
  netPnl: number;
  riskInr: number;
  targetInr: number;
  marginInr: number;
  capitalUsedInr: number;
  exitReason: IndiaTradeExitReason;
  openedAt: number;
  closedAt: number;
  strategy: StrategyName | null;
  owner: IndiaExecutionOwner;

  /**
   * Contract facts captured at close, because they cannot be recovered later.
   *
   * Performance analysis wants to know whether the engine loses money on expiry
   * day, and the only way to answer that is days-to-expiry at entry. But the
   * instrument master only carries ACTIVE contracts, so by the time anyone asks,
   * the weekly option this trade was in has been dropped from it. Resolving the
   * token after the fact would silently return nothing and the whole DTE
   * segmentation would read as "unknown".
   *
   * Optional so trades already in the collection stay valid documents; a reader
   * must treat absence as "not recorded", which is what it is.
   */
  contractType?: IndiaContractType;
  optionType?: IndiaOptionType | null;
  strike?: number | null;
  /** Expiry of the traded contract, epoch ms. Null for an index. */
  expiry?: number | null;
}

// ---------------------------------------------------------------------------
// Performance analytics — the payload of GET /india/performance
// ---------------------------------------------------------------------------

/**
 * One slice of the closed book, reduced to the same shape for every cut.
 *
 * Every breakdown — by strategy, underlying, exit reason, session phase, days to
 * expiry, side — reports these same fields, so a row from one table is directly
 * comparable to a row from another and the UI needs one renderer rather than six.
 *
 * This contract lives in `shared` deliberately. It used to be declared twice:
 * once in the backend engine and once again, by hand, inside the React panel.
 * The two drifted, the panel kept compiling because the fetch was typed
 * `unknown` and cast, and it rendered fields the server had stopped sending.
 */
export interface IndiaSegmentMetrics {
  trades: number;
  wins: number;
  losses: number;
  /** Fraction in 0..1, not a percentage. Multiply at the point of display. */
  winRate: number;
  totalPnl: number;
  avgPnl: number;
  /**
   * Gross profit over gross loss, or null when the slice has no losses yet.
   *
   * Null rather than a large sentinel: a sentinel gets formatted, sorted and
   * charted as though it were a measurement. A slice with no losing trades has
   * no profit factor, and that should read as a fact about the sample.
   */
  profitFactor: number | null;
  /** Average P&L as a multiple of average risk taken. Null when no trade in the
   *  slice recorded a risk figure. */
  expectancyR: number | null;
}

export interface IndiaRecentPerformance {
  wins: number;
  losses: number;
  /** Fraction in 0..1. */
  winRate: number;
  pnl: number;
}

/** Best or worst slice by win rate, once a slice has enough trades to mean it. */
export interface IndiaSegmentExtreme<K extends string = string> {
  phase: K;
  winRate: number;
  trades: number;
}

/**
 * A sparse map of segment key to metrics.
 *
 * Sparse on purpose: a bucket with no trades is absent rather than present with
 * zeros, because "the engine has never traded on expiry day" and "the engine
 * traded on expiry day and broke even" are different findings and a row of zeros
 * cannot tell them apart. A reader iterating the canonical bucket order therefore
 * has to handle a miss, which is exactly the case worth handling.
 */
export type IndiaSegmentBreakdown<K extends string = string> = Partial<Record<K, IndiaSegmentMetrics>>;

export interface IndiaPerformanceMetrics {
  startDate: number;
  endDate: number;
  /**
   * Distinct IST days on which a trade closed — not calendar days in the window.
   * "12 trades over 3 days" is a different book from "12 trades over 30 days",
   * and only the first figure distinguishes them.
   */
  daysTraded: number;

  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  breakEvenTrades: number;

  /** Fraction in 0..1. */
  winRate: number;
  /** Pre-formatted for display; '—' when there are no trades. */
  winRatePercent: string;

  /** Gross profit from winners, in INR. */
  totalProfit: number;
  /** Gross loss from losers, positive, in INR. */
  totalLoss: number;
  netProfit: number;
  /** Brokerage plus modelled slippage, already deducted from netProfit. */
  totalCharges: number;
  profitFactor: number | null;

  averageWin: number;
  averageLoss: number;
  largestWin: number;
  /** Positive magnitude of the worst trade. */
  largestLoss: number;

  /** Rupees per trade, expected. */
  expectancy: number;
  /** Expectancy as a multiple of average risk. Null when no trade recorded a
   *  risk figure — reported as unknown rather than as zero. */
  expectancyR: number | null;

  maxDrawdown: number;
  maxDrawdownPercent: number;
  currentDrawdown: number;

  /** Mean of the risk each position was actually sized to, from its own stop.
   *  Null when nothing in the window recorded one. */
  avgRiskPerTrade: number | null;
  avgRewardRisk: number;

  /** Minutes. */
  averageHoldTime: number;
  shortestTrade: number;
  longestTrade: number;

  bestDay?: { date: string; pnl: number };
  worstDay?: { date: string; pnl: number };

  /** Keyed by strategy name, with 'UNKNOWN' for trades that carry none. */
  byStrategy: IndiaSegmentBreakdown;
  /** Keyed by underlying symbol as the broker reports it. */
  byUnderlying: IndiaSegmentBreakdown;
  byExitReason: IndiaSegmentBreakdown<IndiaTradeExitReason>;
  bySessionPhase: IndiaSegmentBreakdown<IndiaSessionPhase>;
  byDte: IndiaSegmentBreakdown<IndiaDteBucket>;
  /** Both sides are always present; a side with no trades reports zeros, which
   *  is meaningful here because the two are exhaustive. */
  bySide: Record<'BUY' | 'SELL', IndiaSegmentMetrics>;

  /** Null when no phase has enough trades to be worth naming. */
  bestPhase: IndiaSegmentExtreme<IndiaSessionPhase> | null;
  worstPhase: IndiaSegmentExtreme<IndiaSessionPhase> | null;

  last10Trades: IndiaRecentPerformance;
  last20Trades: IndiaRecentPerformance;
}

// ---------------------------------------------------------------------------
// Goal trading (spec §23–§31)
// ---------------------------------------------------------------------------

export interface IndiaGoalConfig {
  goalId: string;
  /** Amount of capital to use in INR. */
  amountInr: number;
  /** Minimum net profit target in INR. */
  minimumProfitInr: number;
  /** Maximum allowed risk per trade in INR. */
  maxRiskInr: number;
  /** Maximum margin (% of amount) per trade. */
  maxMarginPercent: number;
  /** Number of sequential trades requested. */
  numberOfTrades: number;
  executionMode: IndiaExecutionMode;
  sessionPolicy: 'TODAY_ONLY' | 'CONTINUE_NEXT_SESSION';
  createdAt: number;
  /** Optional list of underlyings to trade (e.g., ['NIFTY', 'BANKNIFTY']). If not provided, trades all available. */
  tradeUnderlyings?: string[];
  /**
   * How `minimumProfitInr` completes the goal.
   *  CUMULATIVE — realized net P&L across trades reaches the target (default;
   *              this is what the engine has always done).
   *  PER_TRADE  — each individual trade targets the amount; the run ends when
   *              the requested number of trades has completed.
   * Explicit rather than implied: silently redefining a user's profit target is
   * how trust in an engine dies.
   */
  profitSemantics?: 'CUMULATIVE' | 'PER_TRADE';
  /**
   * Strategy holding barrier in minutes (spec §11). A position held longer than
   * this WITHOUT having reached at least half its expected profit exits as
   * STAGNANT_TRADE, freeing the engine for a fresh opportunity. Not an activity
   * timer: a winning trade is never cut by it.
   */
  maxHoldMinutes?: number;
}

/**
 * A ranked, fully-qualified trade opportunity produced by the Goal Opportunity
 * Engine (spec §7–§8). Everything is INR; probabilities are 0..1; time is an
 * ESTIMATE in minutes, never a guarantee.
 */
export interface IndiaOpportunity {
  instrumentToken: string;
  tradingSymbol: string;
  underlying: string;
  contractType: IndiaContractType;
  optionType?: IndiaOptionType | null;
  side: 'BUY' | 'SELL';
  strategy: StrategyName;
  entry: number;
  stopLoss: number;
  target: number;
  quantity: number;
  lotSize: number;
  /** Net expected profit after configured charges, INR. */
  expectedProfitInr: number;
  riskInr: number;
  rr: number;
  /** Estimated P(reaching target first), 0..1 — model + structure blend. */
  tpProbability: number;
  /** Estimated minutes to target under current velocity — an estimate only. */
  expectedMinutes: number;
  /** Composite ranking score (higher = better candidate). */
  score: number;
  /** Per-component contributions for display/audit. */
  components: Record<string, number>;
  liquidity: 'GOOD' | 'FAIR' | 'POOR' | 'UNKNOWN';
  /** Signal age at scoring time, ms. */
  freshnessMs: number;
  mlStatus: IndiaMlStatus;
}

/**
 * Structured per-scan diagnostic state (spec §34): every stage the Goal engine
 * evaluates, with counts of where candidates died. The point is that "no
 * signals" must never be the only answer — this says WHICH gate starved the
 * engine and on how much evidence.
 */
export interface IndiaGoalDiagnostics {
  /** When the last full scan pass completed; 0 = no pass yet since start. */
  lastScanAt: number;
  /** Wall-clock duration of the last scan pass, ms. */
  lastScanDurationMs: number;
  marketOpen: boolean;
  dataHealthy: boolean;
  mlStatus: IndiaMlStatus | null;
  /** Serving detail string from the ML health probe / predictions. */
  mlDetail?: string | null;
  optionDataReady: boolean;
  /** Instruments evaluated in the last pass (after underlying filter). */
  instrumentsScanned: number;
  /** Of those, how many had enough candle history to analyze at all. */
  instrumentsWithData: number;
  /** Setups where technical entry criteria produced a side. */
  criteriaPassed: number;
  /** Candidates that cleared criteria + ML + gates + sizing (rankable). */
  candidatesPrepared: number;
  /** Candidates additionally eligible after scoring's mandatory checks. */
  validCandidates: number;
  /** Where prepared candidates died, by stage, with one example reason each. */
  rejected: {
    noSetup: number;
    ml: number;
    gates: number;
    sizing: number;
    scoring: number;
    exampleReasons: Partial<Record<'NO_SETUP' | 'GATE' | 'SIZING' | 'COOLDOWN' | 'SCORING', string>>;
  };
  /** The single most important blocking condition right now (§12), or null
   *  when execution is ready / a trade is open. */
  blockReason?: string | null;
}

export interface IndiaGoalProgress {
  goalId: string;
  state: IndiaGoalState;
  requestedTrades: number;
  completedTrades: number;
  remainingTrades: number;
  activeTrade: IndiaPosition | null;
  currentSignal: IndiaSignal | null;
  currentPosition: IndiaPosition | null;
  currentPnlInr: number;
  totalPnlInr: number;
  targetInr: number;
  currentStopLoss: number | null;
  marketOpen: boolean;
  marketStatus: IndiaMarketStatus;
  updatedAt: number;
  /** Realized net INR toward the goal (= totalPnlInr, named for the UI). */
  realizedProfitInr?: number;
  /** Target minus realized, floored at 0. */
  remainingProfitInr?: number;
  /** Best currently-ranked candidate while scanning (not yet traded). */
  currentOpportunity?: IndiaOpportunity | null;
  /** Why the engine is not trading right now (§27): shown verbatim in the UI. */
  waitReason?: string | null;
  /** Last observed ML serving state across the scan universe. */
  mlStatus?: IndiaMlStatus;
  /** Per-stage scan diagnostics (§34). */
  diagnostics?: IndiaGoalDiagnostics | null;
}

export interface IndiaGoal {
  goalId: string;
  config: IndiaGoalConfig;
  state: IndiaGoalState;
  progress: IndiaGoalProgress;
  trades: IndiaTrade[];
  startedAt: number;
  completedAt: number | null;
  status: 'ACTIVE' | 'COMPLETED' | 'STOPPED' | 'FAILED';
}

// ---------------------------------------------------------------------------
// Universal signals (spec §34–§36)
// ---------------------------------------------------------------------------

export interface IndiaUniversalSignal extends IndiaSignal {
  /** When GOAL owns execution, universal signals are SIGNAL ONLY. */
  executionBlocked: boolean;
  owner: 'UNIVERSAL';
}

// ---------------------------------------------------------------------------
// Execution authority (spec §36)
// ---------------------------------------------------------------------------

export interface IndiaExecutionAuthorityState {
  owner: IndiaExecutionOwner;
  updatedAt: number;
  /** Human-readable reason for the last authority change. */
  lastReason: string;
  goal: { executionMode: IndiaExecutionMode };
  universal: { executionMode: IndiaExecutionMode };
}

// ---------------------------------------------------------------------------
// Backtesting (spec §14, §52, §53)
// ---------------------------------------------------------------------------

export interface IndiaBacktestConfig {
  runId: string;
  instruments: string[];
  timeframe: IndiaTimeframe;
  start: number;
  end: number;
  startingCapitalInr: number;
  maxRiskInr: number;
  maxMarginPercent: number;
  minRr: number;
  lotSizing: 'FIXED_LOT' | 'RISK_BASED';
  numberOfTrades: number | null;
  goalTargetInr: number | null;
  slippageTicks: number;
  commissionPerLot: number;
}

export interface IndiaBacktestRun {
  runId: string;
  config: IndiaBacktestConfig;
  createdAt: number;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED';
  error?: string;
  metrics?: IndiaBacktestMetrics;
  trades?: IndiaTrade[];
  equityCurve?: Array<{ time: number; equity: number }>;
  /** Train/validation/out-of-sample split metadata (spec §53). */
  validation?: { trainEnd: number; validationEnd: number; testEnd: number };
}

export interface IndiaBacktestMetrics {
  winRate: number;
  lossRate: number;
  expectancy: number;
  profitFactor: number;
  maxDrawdownPct: number;
  sharpe: number;
  averageWin: number;
  averageLoss: number;
  consecutiveLosses: number;
  tradeCount: number;
  slippageSensitivity: number;
  feeSensitivity: number;
  targetAchievement: number;
  stopLossFrequency: number;
  totalReturnPct: number;
}

// ---------------------------------------------------------------------------
// Paper / live account (spec §25)
// ---------------------------------------------------------------------------

export interface IndiaPaperAccount {
  accountId: string;
  currency: 'INR';
  startingBalance: number;
  balance: number;
  equity: number;
  margin: number;
  freeMargin: number;
  unrealizedPnl: number;
  realizedPnl: number;
  fees: number;
  openPositionCount: number;
  updatedAt: number;
}

/** INR P&L breakdown (spec §25). */
export interface IndiaPnL {
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  lotSize: number;
  grossPnl: number;
  charges: number;
  netPnl: number;
  risk: number;
  target: number;
  margin: number;
  capitalUsed: number;
}

// ---------------------------------------------------------------------------
// Reusable generic shapes for routes / socket / REST payloads
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Option flow (spec §18, option-chain analytics)
// ---------------------------------------------------------------------------

export interface IndiaOptionStrikeFlow {
  strike: number;
  callOI: number;
  putOI: number;
  totalOI: number;
  /** OI change over the lookback window (positive = fresh positions opened). */
  callOIChange: number;
  putOIChange: number;
  totalOIChange: number;
  /** True for the max-pain strike (or the closest candidate when spot is known). */
  maxPainCandidate: boolean;
}

export interface IndiaOptionFlowSnapshot {
  underlying: string;
  expiry: number | null;
  /** Live index/spot price used for max-pain math (null when no quote). */
  spotPrice: number | null;
  totalCallOI: number;
  totalPutOI: number;
  /** Put/Call ratio over total OI (null when no call OI). */
  pcr: number | null;
  /** PCR vs the value `lookback` bars ago (positive = puts building). */
  pcrChange: number;
  /** Strike minimizing total option-writer payout (classic max pain). */
  maxPain: number | null;
  /** Aggregate OI change for calls and puts over the lookback window. */
  callOIChange: number;
  putOIChange: number;
  /** Net OI delta (puts - calls): positive = bearish positioning. */
  netOiDelta: number;
  /** Put/call OI by strike, sorted ascending. */
  strikes: IndiaOptionStrikeFlow[];
  /** Interpretive labels used by the signal engine / UI. */
  posture: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Option chain analytics
//
// These live in `shared` on purpose. The first version of the analytics engine
// declared its own chain shape in the backend while the frontend panel declared
// a third one, and the two were bridged by casts — so the panel rendered
// `undefined` for years' worth of fields nobody noticed were missing. One
// definition, imported by both sides, makes that class of drift a compile error.
// ---------------------------------------------------------------------------

/** Greeks scaled the way a trader reads them, not the way the maths produces
 *  them: vega per volatility *point*, theta per calendar day, rho per rate point. */
export interface IndiaOptionGreeks {
  /** Change in premium per one point of underlying. */
  delta: number;
  /** Change in delta per one point of underlying. */
  gamma: number;
  /** Change in premium per one percentage point of implied volatility. */
  vega: number;
  /** Change in premium per calendar day. Negative for a long option. */
  theta: number;
  /** Change in premium per one percentage point of the risk-free rate. */
  rho: number;
}

export type IndiaOptionSentiment = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

export interface IndiaStrikeSignificance {
  strike: number;
  callOI: number;
  putOI: number;
  /** Absolute contract change since the session baseline, not a fraction. */
  callOIChange: number;
  putOIChange: number;
  significance: 'HIGH' | 'MEDIUM' | 'LOW';
}

/** One side of a strike: the broker's quote plus everything derived from it. */
export interface IndiaOptionLeg {
  instrumentToken: string;
  tradingSymbol: string;
  ltp: number | null;
  oi: number | null;
  oiChange: number | null;
  volume: number | null;
  /** Implied volatility as a DECIMAL (0.145 = 14.5%), or null if unsolvable.
   *  Solved from this leg's own premium — no broker in use supplies it. */
  iv: number | null;
  bid: number | null;
  ask: number | null;
  greeks: IndiaOptionGreeks | null;
  /** Bid-ask spread as a fraction of premium — the real cost of being wrong. */
  spreadPct: number | null;
}

export interface IndiaEnrichedStrike {
  strike: number;
  expiryDate: number;
  call: IndiaOptionLeg;
  put: IndiaOptionLeg;
  /** Absolute OI change in contracts. Null when there is no baseline yet, which
   *  is a real state on the first snapshot of a session — not zero activity. */
  callOIChange: number | null;
  putOIChange: number | null;
  /** Premium change vs the session baseline. Needed to tell fresh buying from
   *  writing: rising OI alone cannot distinguish them. */
  callLtpChange: number | null;
  putLtpChange: number | null;
}

export interface IndiaOptionAnalytics {
  underlying: string;
  spotPrice: number | null;
  expiryDate: number | null;
  timestamp: number;

  pcr: { byOI: number; byVolume: number; byValue: number };
  maxPain: { strike: number; totalPain: number; confidence: number };
  atm: {
    strike: number;
    callOI: number;
    putOI: number;
    callIV: number | null;
    putIV: number | null;
    /** ATM straddle premium — the market's own price for the expected move. */
    straddlePremium: number | null;
  };
  sentiment: { signal: IndiaOptionSentiment; strength: number; reason: string; reasons: string[] };
  ivAnalysis: {
    /** Mean IV across solvable strikes, DECIMAL. */
    averageIV: number;
    atmIV: number | null;
    /** Put IV minus call IV at comparable moneyness. Positive = put skew = fear. */
    ivSkew: number;
    /** Percentile of current ATM IV within the observed history, 0..100. */
    ivPercentile: number;
    /** Same, but only reported once the history is long enough to mean it. */
    ivRank: number | null;
    /** How much history that percentile is actually based on. Be honest. */
    ivWindowDays: number;
  };
  oiActivity: {
    type: 'BUILDUP' | 'UNWINDING' | 'NEUTRAL';
    side: 'CALL' | 'PUT' | 'MIXED';
    strength: number;
    description: string;
  };
  topStrikes: IndiaStrikeSignificance[];
  oiLevels: { support: number[]; resistance: number[] };

  /** One-sigma move implied by ATM IV over the remaining life, in points. */
  expectedMove: number | null;
  daysToExpiry: number | null;
  minutesToExpiry: number | null;
  liquidity: {
    atmSpreadPct: number | null;
    tradableStrikes: number;
    totalStrikes: number;
  };
  /** So a consumer can tell "neutral" from "we have no idea". */
  dataQuality: {
    strikesTotal: number;
    strikesWithOi: number;
    strikesWithIv: number;
    hasBaseline: boolean;
    /**
     * `OI_ONLY` means open interest is real but premium, volume and quotes are
     * absent, so IV, greeks and spreads are unavailable by construction rather
     * than by failure. A consumer must be able to tell those two apart.
     */
    source: 'BROKER_CHAIN' | 'OI_ONLY';
  };
}

/** `GET /api/india/option-chain` — summary and ladder from one chain fetch, so
 *  the Max Pain marker cannot come from a later snapshot than the bars under it. */
export interface IndiaOptionChainView {
  underlying: string;
  analytics: IndiaOptionAnalytics | null;
  strikes: IndiaEnrichedStrike[];
}

export interface IndiaMarketStatusDto {
  status: IndiaMarketStatus;
  marketOpen: boolean;
  isHoliday: boolean;
  ist: string;
  marketOpenAt: number | null;
  marketCloseAt: number | null;
  segments: Partial<Record<IndiaSegment, boolean>>;
}

export interface IndiaHealthDto {
  dataHealth: IndiaDataHealth;
  session: IndiaMarketStatusDto;
  executionAuthority: IndiaExecutionAuthorityState;
  stale: boolean;
}

export type { CandleState, DataMode, MarketRegime, StrategyName, SystemStatus, Timeframe };