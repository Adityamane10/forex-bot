/**
 * Core domain constants shared across backend, frontend and workers.
 */

export const TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '4h', '1D'] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

/** Asset classes supported by the platform (FOREX + CRYPTO). */
export const ASSET_CLASSES = ['FOREX', 'CRYPTO'] as const;
export type AssetClass = (typeof ASSET_CLASSES)[number];

export const TIMEFRAME_MS: Record<Timeframe, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1D': 86_400_000,
};

/** Decisions the signal engine is allowed to output. */
export const DECISIONS = [
  'BUY',
  'SELL',
  'WAIT',
  'NO_TRADE',
  'INSUFFICIENT_CONFIDENCE',
] as const;
export type Decision = (typeof DECISIONS)[number];

/** Lifecycle states of a signal. */
export const SIGNAL_STATES = [
  'CANDIDATE',
  'ANALYZING',
  'QUALIFIED',
  'SIGNAL_CREATED',
  'WAITING_FOR_ENTRY',
  'ENTRY_REACHED',
  'POSITION_ACTIVE',
  'TP1_HIT',
  'TP2_HIT',
  'TRAILING',
  'SL_HIT',
  'CLOSED',
  'EXPIRED',
  'INVALIDATED',
  'MISSED',
  'DATA_ERROR',
  'RISK_BLOCKED',
  'MODEL_BLOCKED',
  'NEWS_BLOCKED',
  'INSUFFICIENT_CONFIDENCE',
  'CANCELLED',
  'PERFORMANCE_RECORDED',
] as const;
export type SignalState = (typeof SIGNAL_STATES)[number];

/** Risk classification of a signal. */
export const RISK_LEVELS = ['GREEN', 'YELLOW', 'RED'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/** Market regimes detected by the regime engine (spec §27). */
export const REGIMES = [
  'TRENDING_BULLISH',
  'TRENDING_BEARISH',
  'RANGING',
  'BREAKOUT',
  'BREAKDOWN',
  'REVERSAL',
  'HIGH_VOLATILITY',
  'LOW_VOLATILITY',
  'NEWS_DRIVEN',
  'LIQUIDITY_STRESSED',
  'UNCERTAIN',
] as const;
export type MarketRegime = (typeof REGIMES)[number];

/** Tradable strategies routed by market regime (spec §28). */
export const STRATEGIES = [
  'TREND_FOLLOWING',
  'BREAKOUT',
  'PULLBACK',
  'MOMENTUM',
  'MEAN_REVERSION',
  'RANGE',
  'RISK_CONTROLLED',
] as const;
export type StrategyName = (typeof STRATEGIES)[number];

/** Forex sessions. */
export const SESSIONS = [
  'SYDNEY',
  'TOKYO',
  'LONDON',
  'NEW_YORK',
  'LONDON_NEW_YORK_OVERLAP',
  'OFF_HOURS',
] as const;
export type ForexSession = (typeof SESSIONS)[number];

/** System component statuses. */
export const STATUSES = ['HEALTHY', 'WARNING', 'DOWN', 'UNKNOWN'] as const;
export type SystemStatus = (typeof STATUSES)[number];

/** Market data source modes. */
export const DATA_MODES = ['LIVE', 'DEMO', 'BACKTEST', 'SIMULATED'] as const;
export type DataMode = (typeof DATA_MODES)[number];

/** Candle validation outcomes. */
export const CANDLE_STATES = ['OPEN', 'COMPLETED', 'VALIDATED', 'REJECTED'] as const;
export type CandleState = (typeof CANDLE_STATES)[number];

/** Price action patterns. */
export const PRICE_ACTIONS = [
  'HIGHER_HIGH',
  'HIGHER_LOW',
  'LOWER_HIGH',
  'LOWER_LOW',
  'BREAKOUT',
  'BREAKDOWN',
  'PULLBACK',
  'REVERSAL',
  'CONSOLIDATION',
  'RANGE',
  'VOLATILITY_EXPANSION',
  'VOLATILITY_CONTRACTION',
] as const;
export type PriceAction = (typeof PRICE_ACTIONS)[number];

/** Candlestick patterns. */
export const CANDLE_PATTERNS = [
  'BULLISH_ENGULFING',
  'BEARISH_ENGULFING',
  'PIN_BAR_BULLISH',
  'PIN_BAR_BEARISH',
  'INSIDE_BAR',
  'DOJI',
  'MORNING_STAR',
  'EVENING_STAR',
] as const;
export type CandlePattern = (typeof CANDLE_PATTERNS)[number];

/** Alert types. */
export const ALERT_TYPES = [
  'NEW_SIGNAL',
  'SIGNAL_UPDATED',
  'ENTRY_REACHED',
  'ENTRY_MISSED',
  'SIGNAL_INVALIDATED',
  'SIGNAL_EXPIRED',
  'TP1_HIT',
  'TP2_HIT',
  'SL_HIT',
  'HIGH_IMPACT_NEWS',
  'RISK_BLOCKED',
  'DATA_FAILURE',
  'MODEL_FAILURE',
] as const;
export type AlertType = (typeof ALERT_TYPES)[number];

/** ML algorithms supported by the AI engine. */
export const ML_ALGORITHMS = [
  'LOGISTIC_REGRESSION',
  'RANDOM_FOREST',
  'XGBOOST',
  'LIGHTGBM',
] as const;
export type MlAlgorithm = (typeof ML_ALGORITHMS)[number];

/** Targets for ML models. */
export const ML_TARGETS = ['FUTURE_DIRECTION', 'FUTURE_RETURN', 'TP_BEFORE_SL'] as const;
export type MlTarget = (typeof ML_TARGETS)[number];

/** Event impact levels. */
export const IMPACT_LEVELS = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type ImpactLevel = (typeof IMPACT_LEVELS)[number];

/** Sentiment classes. */
export const SENTIMENT_CLASSES = ['positive', 'negative', 'neutral'] as const;
export type SentimentClass = (typeof SENTIMENT_CLASSES)[number];

/** Circuit breaker limit types. */
export const BREAKER_TYPES = [
  'MAX_DAILY_LOSS',
  'MAX_WEEKLY_LOSS',
  'MAX_DRAWDOWN',
  'MAX_CONSECUTIVE_LOSSES',
  'MAX_OPEN_POSITIONS',
  'MAX_CORRELATED_POSITIONS',
  'MAX_LEVERAGE',
  'MAX_CURRENCY_EXPOSURE',
] as const;
export type BreakerType = (typeof BREAKER_TYPES)[number];

/** Supported providers (abstractions). */
export const PROVIDERS = {
  marketData: ['DEMO', 'TWELVEDATA', 'FINNHUB', 'YAHOO', 'FXCM', 'OANDA', 'DUKASCOPY'] as const,
  cryptoMarketData: ['NONE', 'BINANCE', 'DEMO'] as const,
  news: ['NONE', 'RSS', 'NEWSAPI', 'TWELVEDATA'] as const,
  economicCalendar: ['NONE', 'FOREXFACTORY', 'TWELVEDATA'] as const,
  llm: ['NONE', 'GROQ'] as const,
  execution: ['NONE', 'PAPER', 'SHADOW', 'LIVE'] as const,
} as const;

/** Default instrument universe. */
export const DEFAULT_SYMBOLS = [
  'EUR/USD',
  'GBP/USD',
  'USD/JPY',
  'USD/CHF',
  'AUD/USD',
  'USD/CAD',
  'NZD/USD',
  'EUR/GBP',
  'EUR/JPY',
  'GBP/JPY',
  // Gold (spot via Yahoo GC=F; broker MT5 symbol XAUUSD). Full spec in assets.
  'XAU/USD',
] as const;

/** Crypto instrument universe (Binance spot, USDT-quoted). */
export const CRYPTO_SYMBOLS = [
  'BTC/USDT',
  'ETH/USDT',
  'BNB/USDT',
  'SOL/USDT',
  'XRP/USDT',
  'ADA/USDT',
  'DOGE/USDT',
] as const;

/** Every instrument the platform can trade, forex first. */
export const ALL_SYMBOLS: readonly string[] = [...DEFAULT_SYMBOLS, ...CRYPTO_SYMBOLS];

/**
 * Live USD→INR conversion rate (Yahoo USDINR=X feed). Rate-only: polled by the
 * market data engine so INR-denominated accounts convert sizing/P&L in real
 * time. Deliberately NOT in DEFAULT_SYMBOLS — it is not a tradable pair.
 */
export const INR_RATE_SYMBOL = 'USD/INR' as const;

export const DEFAULT_TIMEFRAMES: Timeframe[] = ['1m', '5m', '15m', '30m', '1h', '4h', '1D'];

export const SLIPPAGE_PIPS = 0.2;
export const DEFAULT_COMMISSION_PER_LOT = 7.0; // USD round turn per standard lot
export const DEFAULT_RISK_PERCENT = 1.0;
export const DEFAULT_MIN_RR = 1.5;
export const DEFAULT_MIN_CONFIDENCE = 0.55;
export const DEFAULT_MAX_DAILY_LOSS_PERCENT = 3.0;
export const DEFAULT_MAX_WEEKLY_LOSS_PERCENT = 6.0;
export const DEFAULT_MAX_DRAWDOWN_PERCENT = 10.0;
export const DEFAULT_MAX_CONSECUTIVE_LOSSES = 5;
export const DEFAULT_MAX_OPEN_POSITIONS = 5;
export const DEFAULT_MAX_CORRELATED_POSITIONS = 3;
export const DEFAULT_MAX_LEVERAGE = 50;
export const DEFAULT_MAX_CURRENCY_EXPOSURE_PERCENT = 30;
export const DEFAULT_MAX_SPREAD_PIPS = 25; // sanity cap per pair, scaled by pair later
