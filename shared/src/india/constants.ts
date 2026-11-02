/**
 * Indian-market domain constants. Namespaced (INDIA_*) so they never collide
 * with the existing Forex/Crypto constants. The Indian subsystem is architecturally
 * isolated: it only shares market-agnostic infrastructure with Forex/Crypto.
 */

/** Intraday-focused timeframes used by the Indian subsystem. */
export const INDIA_TIMEFRAMES = ['1m', '3m', '5m', '15m', '30m', '1h'] as const;
export type IndiaTimeframe = (typeof INDIA_TIMEFRAMES)[number];

export const INDIA_TIMEFRAME_MS: Record<IndiaTimeframe, number> = {
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
};

/** NSE / BSE exchanges. */
export const INDIA_EXCHANGES = ['NSE', 'BSE'] as const;
export type IndiaExchange = (typeof INDIA_EXCHANGES)[number];

/** Exchange segments supported by Indian F&O. */
export const INDIA_SEGMENTS = [
  'NSE_INDEX',
  'NSE_FUT',
  'NSE_OPT',
  'BSE_INDEX',
  'BSE_FUT',
  'BSE_OPT',
] as const;
export type IndiaSegment = (typeof INDIA_SEGMENTS)[number];

/** Primary index underlyings the Indian subsystem focuses on first. */
export const INDIA_UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY'] as const;
export type IndiaUnderlying = (typeof INDIA_UNDERLYINGS)[number];

/** Contract kinds. */
export const INDIA_CONTRACT_TYPES = ['INDEX', 'FUT', 'OPT'] as const;
export type IndiaContractType = (typeof INDIA_CONTRACT_TYPES)[number];

/** Option types. */
export const INDIA_OPTION_TYPES = ['CE', 'PE'] as const;
export type IndiaOptionType = (typeof INDIA_OPTION_TYPES)[number];

/** Instrument tradability status. */
export const INDIA_INSTRUMENT_STATUS = ['ACTIVE', 'EXPIRED', 'SUSPENDED'] as const;
export type IndiaInstrumentStatus = (typeof INDIA_INSTRUMENT_STATUS)[number];

/** Signal lifecycle for the Indian signal engines. */
export const INDIA_SIGNAL_STATES = [
  'CANDIDATE',
  'VALIDATING',
  'SIGNAL_FOUND',
  'READY',
  'WAITING_FOR_ENTRY',
  'EXECUTING',
  'POSITION_OPEN',
  'MONITORING',
  'EXITING',
  'TRADE_COMPLETED',
  'INVALIDATED',
  'EXPIRED',
  'MISSED',
  'BLOCKED',
] as const;
export type IndiaSignalState = (typeof INDIA_SIGNAL_STATES)[number];

/** Goal Trading state machine (spec §29). */
export const INDIA_GOAL_STATES = [
  'IDLE',
  'SCANNING',
  'SIGNAL_FOUND',
  'VALIDATING',
  'EXECUTING',
  'POSITION_OPEN',
  'MONITORING',
  'EXITING',
  'TRADE_COMPLETED',
  'SCANNING_NEXT',
  'GOAL_COMPLETED',
  'STOPPED',
] as const;
export type IndiaGoalState = (typeof INDIA_GOAL_STATES)[number];

/** Execution authority ownership (spec §36): only one owner at a time. */
export const INDIA_EXECUTION_OWNERS = ['NONE', 'GOAL', 'UNIVERSAL'] as const;
export type IndiaExecutionOwner = (typeof INDIA_EXECUTION_OWNERS)[number];

/** Universal / Goal execution modes. */
export const INDIA_EXECUTION_MODES = ['OFF', 'MANUAL', 'AUTO'] as const;
export type IndiaExecutionMode = (typeof INDIA_EXECUTION_MODES)[number];

/** Data-health states for the Indian market-data health service (spec §8). */
export const INDIA_DATA_HEALTH_STATES = [
  'HEALTHY',
  'STALE',
  'DISCONNECTED',
  'AUTH_FAILED',
  'MARKET_CLOSED',
] as const;
export type IndiaDataHealthState = (typeof INDIA_DATA_HEALTH_STATES)[number];

/** Market session states (spec §9). */
export const INDIA_MARKET_STATUS = [
  'PRE_OPEN',
  'OPEN',
  'CLOSED',
  'HOLIDAY',
  'UNKNOWN',
] as const;
export type IndiaMarketStatus = (typeof INDIA_MARKET_STATUS)[number];

/** Broker order statuses (spec §50 reconciliation). */
export const INDIA_ORDER_STATUSES = [
  'PENDING',
  'OPEN',
  'FILLED',
  'PARTIALLY_FILLED',
  'REJECTED',
  'CANCELLED',
  'DISCONNECTED',
  'UNKNOWN',
] as const;
export type IndiaOrderStatus = (typeof INDIA_ORDER_STATUSES)[number];

/** Position/order exit reasons. */
export const INDIA_TRADE_EXIT_REASONS = [
  'TARGET_REACHED',
  'STOP_LOSS',
  'MANUAL',
  'INVALIDATED',
  'MARKET_CLOSED',
  'DATA_STALE',
  'EXPIRY',
  'ENGINE_EXIT',
  /** Strategy-defined stagnation exit: momentum collapse / max holding barrier
   *  / setup invalidation — never an arbitrary timeout to force activity. */
  'STAGNANT_TRADE',
  /** User's minimum-profit exit (§23): unrealized P&L reached the profit value
   *  the user set in the dashboard — the position's whole ₹ take-profit. */
  'PROFIT_TARGET',
] as const;
export type IndiaTradeExitReason = (typeof INDIA_TRADE_EXIT_REASONS)[number];

/** Exact trade-rejection reasons (spec §57) — stored in the audit trail. */
export const INDIA_REJECTION_REASONS = [
  'SIGNAL_STALE',
  'MARKET_CLOSED',
  'DATA_STALE',
  'EXPIRY',
  'RISK_TOO_HIGH',
  'MARGIN_TOO_HIGH',
  'TARGET_NOT_FEASIBLE',
  'NO_LIQUIDITY',
  'PRICE_MOVED',
  'CONTRACT_NOT_TRADABLE',
  'EXECUTION_BLOCKED',
  'AUTHORITY_BLOCKED',
  'INVALID_QUANTITY',
  'MIN_LOT_VIOLATION',
  'DUPLICATE_ORDER',
  'NO_FUNDS',
  /** Broker-master lot size disagrees with the configured reference for the
   *  underlying — the contract metadata cannot be trusted, fail closed. */
  'LOT_SIZE_MISMATCH',
  /** ML unavailable or meta-filtered: automatic trading must stop (§15). */
  'ML_UNAVAILABLE',
] as const;
export type IndiaRejectionReason = (typeof INDIA_REJECTION_REASONS)[number];

/** NSE trading hours in IST (Asia/Kolkata). */
export const INDIA_SESSION = {
  timezone: 'Asia/Kolkata',
  preOpenStart: { hour: 9, minute: 0 },
  preOpenEnd: { hour: 9, minute: 15 },
  open: { hour: 9, minute: 15 },
  close: { hour: 15, minute: 30 },
  /** No lunch break on NSE; kept for BSE-equivalent calendar modeling. */
  lunchBreak: null,
} as const;

/** Minute of the IST day at which the cash session opens and closes. */
export const INDIA_SESSION_OPEN_MIN = INDIA_SESSION.open.hour * 60 + INDIA_SESSION.open.minute;
export const INDIA_SESSION_CLOSE_MIN = INDIA_SESSION.close.hour * 60 + INDIA_SESSION.close.minute;

/**
 * IST is a fixed +05:30 and India has never observed daylight saving, so the offset
 * can be applied arithmetically rather than via a timezone library. Shared because
 * it was independently redeclared in at least four backend modules, and a constant
 * that means "the timezone the whole market runs in" should not be a local.
 */
export const INDIA_IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Start of the `tf` bucket containing the instant `at`, anchored to the IST session
 * open rather than to the Unix epoch.
 *
 * Every path that builds a candle has to agree on this, and three of them did not.
 * Flooring to an epoch multiple — `Math.floor(at / tfMs) * tfMs` — is correct only
 * when the session open is itself a multiple of the timeframe. 09:15 IST is
 * 13,500,000 ms past UTC midnight, which divides evenly by 1m, 3m, 5m and 15m but
 * not by 30m (7.5) or 1h (3.75). So on the epoch grid the 30-minute boundaries fell
 * at IST :00 and :30, the hourly ones at IST :30, and the first bar of every session
 * was a 15-minute runt wearing a full bar's `closeTime`.
 *
 * Worse, the broker's own historical bars are not on the epoch grid either, so their
 * `openTime` could never equal a locally built one on those two timeframes. Since a
 * candle `id` embeds `openTime`, the two grids produced different ids for the same
 * period, both survived every dedupe-by-id in the codebase, and the chart drew two
 * interleaved half-overlapping series. Note that an epoch-floored 1h bar cannot match
 * a broker bar under *either* convention the broker might plausibly use — at :30 past
 * the hour it agrees with neither 09:15 nor 10:00.
 *
 * Anchoring here is provably a no-op for 1m, 3m, 5m and 15m, because the session open
 * is an exact multiple of each; it changes only the two timeframes that were already
 * wrong.
 *
 * Used by the two paths that build bars from scratch — the live tick engine and the
 * intraday 1-minute resampler. The historical mapper deliberately does not snap the
 * broker's timestamps onto this lattice, because relabelling a real bar is worse than
 * failing to merge one; it checks against this function and warns instead.
 */
export function indiaBucketStart(at: number, tf: IndiaTimeframe): number {
  const tfMs = INDIA_TIMEFRAME_MS[tf];
  // Midnight IST of the calendar day containing `at`, as a UTC instant.
  const istDayStart = Math.floor((at + INDIA_IST_OFFSET_MS) / 86_400_000) * 86_400_000 - INDIA_IST_OFFSET_MS;
  const sessionOpen = istDayStart + INDIA_SESSION_OPEN_MIN * 60_000;
  // `Math.floor` on a negative offset still lands on a grid line, so pre-open and
  // after-hours instants extend the same lattice backwards and forwards instead of
  // collapsing onto the open.
  return sessionOpen + Math.floor((at - sessionOpen) / tfMs) * tfMs;
}

/**
 * When the engine will accept a new intraday entry, in minutes from the session
 * edges. The opening auction leaves spreads wide and the first bar of every
 * indicator unformed; the last quarter-hour leaves no room for a trade to work
 * and an intraday position has to be squared off.
 *
 * This lives in `shared` because two very different consumers need the same
 * numbers: the backend gate that enforces them, and the session arc in the UI
 * that shows the trader when the engine is willing to trade. Duplicating them
 * would let the picture disagree with the rule it is describing.
 */
export const INDIA_ENTRY_WINDOW = {
  /** No entries within this many minutes of the open. */
  openBlockMinutes: 15,
  /** Allowed but flagged, up to this many minutes after the open. */
  openWarnMinutes: 30,
  /** No entries within this many minutes of the close. */
  closeBlockMinutes: 15,
  /** Allowed but flagged, within this many minutes of the close. */
  closeWarnMinutes: 45,
} as const;

/** Default Indian instrument universe (real contracts come from the broker master).
 *  Trading is focused on NIFTY 50, BANK NIFTY and FIN NIFTY only.
 *  MIDCPNIFTY is excluded from goal automation and the index bar. */
export const INDIA_DEFAULT_UNDERLYINGS: readonly IndiaUnderlying[] = ['NIFTY', 'BANKNIFTY', 'FINNIFTY'];

/** Internal event channel names for the Indian subsystem (Redis pub/sub + ctx.events). */
export const INDIA_CHANNELS = {
  tick: 'india:tick',
  candle: 'india:candle',
  marketStatus: 'india:market-status',
  dataHealth: 'india:data-health',
  signal: 'india:signal',
  signalInvalidated: 'india:signal-invalidated',
  /** A setup the engine considered and declined, with its gate trail. */
  signalRejected: 'india:signal-rejected',
  indicatorUpdate: 'india:indicator-update',
  position: 'india:position',
  order: 'india:order',
  pnl: 'india:pnl',
  goal: 'india:goal',
  goalProgress: 'india:goal-progress',
  contract: 'india:contract',
  expiry: 'india:expiry',
  scanner: 'india:scanner',
  executionAuthority: 'india:execution-authority',
  reconciliation: 'india:reconciliation',
  optionFlow: 'india:option-flow',
  optionAnalytics: 'india:option-analytics',
} as const;

/** Redis key namespaces for the Indian subsystem (spec §44) — isolated from Forex/Crypto. */
export const INDIA_REDIS_KEYS = {
  tick: 'india:tick:',
  candle: 'india:candle:',
  market: 'india:market:',
  signal: 'india:signal:',
  position: 'india:position:',
  goal: 'india:goal:',
  contract: 'india:contract:',
  instrument: 'india:instrument:',
  dataHealth: 'india:data-health:',
  indicator: 'india:indicator:',
  optionFlow: 'india:option-flow:',
  optionAnalytics: 'india:option-analytics:',
} as const;

/** MongoDB collection names for the Indian subsystem (spec §45). */
export const INDIA_COLLECTIONS = {
  instruments: 'IndiaInstrument',
  ticks: 'IndiaTickSnapshot',
  candles: 'IndiaCandle',
  signals: 'IndiaSignal',
  positions: 'IndiaPosition',
  orders: 'IndiaOrder',
  goals: 'IndiaGoal',
  trades: 'IndiaTrade',
  analyses: 'IndiaAnalysisSnapshot',
  predictions: 'IndiaModelPrediction',
  backtests: 'IndiaBacktestRun',
  sessions: 'IndiaMarketSession',
  reconciliation: 'IndiaReconciliation',
  optionFlow: 'IndiaOptionFlow',
  /** Chain analytics snapshots. Also the source the IV percentile window is
   *  warmed from on restart — without persistence, IV rank would restart at
   *  zero history every deploy. */
  optionAnalytics: 'IndiaOptionAnalytics',
} as const;

/** Namespaced trading symbols of the primary index underlyings (NSE). */
export const INDIA_INDEX_SYMBOLS = {
  NIFTY: 'NIFTY 50',
  BANKNIFTY: 'NIFTY BANK',
  FINNIFTY: 'NIFTY FIN SERVICE',
  MIDCPNIFTY: 'NIFTY MID SELECT',
} as const;

/**
 * Where in the trading day a trade was entered.
 *
 * The boundaries are `INDIA_ENTRY_WINDOW`, so a performance breakdown that says
 * "the engine loses money in the opening fifteen minutes" is talking about the
 * same fifteen minutes the pre-trade session gate refuses to enter in. Clock-hour
 * buckets fit a 09:15–15:30 session badly — the 09:00 hour holds 45 minutes of it
 * and the 15:00 hour holds 30 — and would not line up with any rule the engine
 * follows.
 */
export const INDIA_SESSION_PHASES = ['OPENING', 'SETTLING', 'MIDDAY', 'PRE_CLOSE', 'OFF_SESSION'] as const;
export type IndiaSessionPhase = (typeof INDIA_SESSION_PHASES)[number];

/**
 * Days-to-expiry buckets for performance segmentation.
 *
 * Split at one day because expiry day is a different instrument rather than a
 * shorter version of the same one: theta is measured in minutes and gamma
 * dominates. `NOT_DATED` is an index or cash trade with no expiry at all;
 * `UNRECORDED` is a trade closed before the expiry was being captured onto the
 * record, and the two must not be conflated.
 */
export const INDIA_DTE_BUCKETS = ['EXPIRY_DAY', '1D', '2-3D', '4-7D', '8D_PLUS', 'NOT_DATED', 'UNRECORDED'] as const;
export type IndiaDteBucket = (typeof INDIA_DTE_BUCKETS)[number];

/** `09:15` from a minute of the IST day. */
function hhmm(minuteOfDay: number): string {
  const m = ((minuteOfDay % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/**
 * Display labels for the session phases, with their clock times computed from
 * the window constants rather than typed out.
 *
 * A hand-written '09:15–09:30' would keep reading 09:15–09:30 after someone
 * widened `openBlockMinutes`, and the label would then be describing a boundary
 * the engine no longer uses. Deriving them means a change to the rule moves the
 * gate, the session arc in the UI, and this label together.
 */
export const INDIA_SESSION_PHASE_LABEL: Record<IndiaSessionPhase, string> = {
  OPENING: `Opening (${hhmm(INDIA_SESSION_OPEN_MIN)}–${hhmm(INDIA_SESSION_OPEN_MIN + INDIA_ENTRY_WINDOW.openBlockMinutes)})`,
  SETTLING: `Settling (${hhmm(INDIA_SESSION_OPEN_MIN + INDIA_ENTRY_WINDOW.openBlockMinutes)}–${hhmm(INDIA_SESSION_OPEN_MIN + INDIA_ENTRY_WINDOW.openWarnMinutes)})`,
  MIDDAY: `Midday (${hhmm(INDIA_SESSION_OPEN_MIN + INDIA_ENTRY_WINDOW.openWarnMinutes)}–${hhmm(INDIA_SESSION_CLOSE_MIN - INDIA_ENTRY_WINDOW.closeWarnMinutes)})`,
  PRE_CLOSE: `Pre-close (${hhmm(INDIA_SESSION_CLOSE_MIN - INDIA_ENTRY_WINDOW.closeWarnMinutes)}–${hhmm(INDIA_SESSION_CLOSE_MIN)})`,
  OFF_SESSION: 'Outside session',
};

export const INDIA_DTE_BUCKET_LABEL: Record<IndiaDteBucket, string> = {
  EXPIRY_DAY: 'Expiry day',
  '1D': '1 day out',
  '2-3D': '2–3 days out',
  '4-7D': '4–7 days out',
  '8D_PLUS': '8+ days out',
  NOT_DATED: 'No expiry',
  UNRECORDED: 'Not recorded',
};