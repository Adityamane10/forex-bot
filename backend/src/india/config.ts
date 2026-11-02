/**
 * Indian-subystem configuration. Read from .env with INDIA_* variables (spec §56).
 * Kept fully separate from the existing Forex/Crypto config.
 */
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });
dotenv.config({ path: path.resolve(process.cwd(), '../.env') });

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

export type IndiaBrokerName = 'NONE' | 'ZERODHA' | 'UPSTOX' | 'ANGELONE';

export const indiaConfig = {
  broker: env('INDIA_BROKER', 'NONE').toUpperCase() as IndiaBrokerName,
  apiKey: env('INDIA_API_KEY', ''),
  apiSecret: env('INDIA_API_SECRET', ''),
  accessToken: env('INDIA_ACCESS_TOKEN', ''),
  requestToken: env('INDIA_REQUEST_TOKEN', ''),
  redirectUri: env('INDIA_REDIRECT_URI', ''),
  /** Upstox API Analytics Token — free, read-only, up to ~1 year, cannot place
   *  orders. Ideal for the real-market-data + paper-trading stage (spec §49). */
  upstoxAnalyticsToken: env('INDIA_UPSTOX_ANALYTICS_TOKEN', ''),
  /** Angel One SmartAPI — free market data with NO static-IP requirement.
   *  Create at smartapi.angelone.in → enable TOTP → copy the four values. */
  angelApiKey: env('INDIA_ANGEL_API_KEY', ''),
  angelClientCode: env('INDIA_ANGEL_CLIENT_CODE', ''),
  angelPin: env('INDIA_ANGEL_PIN', ''),
  angelTotpSecret: env('INDIA_ANGEL_TOTP_SECRET', ''),
  /** Upstox WebSocket feed mode: 'ltp' = tick-by-tick (TBT) LTP; 'full' = full
   *  market depth. TBT is free on Upstox and is the default. */
  upstoxFeedMode: (env('INDIA_UPSTOX_FEED_MODE', 'ltp') === 'full' ? 'full' : 'ltp') as 'ltp' | 'full',
  /** Live execution is always OFF unless explicitly enabled (spec §49). */
  liveExecution: env('INDIA_LIVE_EXECUTION', 'false') === 'true',
  /** Underlyings to subscribe to (spec §2). Comma separated. */
  underlyings: env('INDIA_UNDERLYINGS', 'NIFTY,BANKNIFTY,FINNIFTY')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean),
  /** Include index future contracts of the selected underlyings. */
  includeFutures: env('INDIA_INCLUDE_FUTURES', 'true') === 'true',
  /** Include index options (nearest monthly + weekly where the broker offers). */
  includeOptions: env('INDIA_INCLUDE_OPTIONS', 'true') === 'true',
  /** Option strikes around at-the-money to include when options are enabled. */
  optionStrikes: Number(env('INDIA_OPTION_STRIKES', '5')),
  /** Timeframe used as the primary intraday execution timeframe. */
  primaryTimeframe: env('INDIA_PRIMARY_TIMEFRAME', '5m'),
  /** Tick staleness threshold (ms) before DATA_STALE is declared (spec §8).
   *  Must sit ABOVE the achievable poll cadence (see ltpPollMs): a threshold
   *  equal to the interval itself makes the badge flap STALE on ordinary
   *  network jitter even while data flows. */
  tickStaleMs: Number(env('INDIA_TICK_STALE_MS', '15000')),
  /** How far ahead (days) to keep derivative contracts (spec §7). */
  expiryLookaheadDays: Number(env('INDIA_EXPIRY_LOOKAHEAD_DAYS', '60')),
  /** Redis TTL for latest-tick caching (ms). */
  tickCacheTtlMs: Number(env('INDIA_TICK_CACHE_TTL_MS', '15000')),
  /** Redis TTL for candle-buffer caching (ms). */
  candleCacheTtlMs: Number(env('INDIA_CANDLE_CACHE_TTL_MS', '3600000')),
  /** Default goal parameters shown in the UI (spec §23). The risk/margin
   *  defaults size UNIVERSAL-engine signals too, and were set so tight that
   *  nearly every candidate died at sizing — one NIFTY option lot alone risks
   *  ₹700–1500 (SL distance × lot 75), so a ₹100 cap rejected everything and
   *  both signal feeds sat empty. ₹2000 within ₹100k paper capital ≈ 2%/trade. */
  defaultGoal: {
    amountInr: Number(env('INDIA_DEFAULT_AMOUNT_INR', '10000')),
    minimumProfitInr: Number(env('INDIA_DEFAULT_MIN_PROFIT_INR', '200')),
    maxRiskInr: Number(env('INDIA_DEFAULT_MAX_RISK_INR', '2000')),
    maxMarginPercent: Number(env('INDIA_DEFAULT_MAX_MARGIN_PCT', '50')),
    numberOfTrades: Number(env('INDIA_DEFAULT_TRADES', '4')),
  },
  /** Per-lot execution costs in INR (brokerage + exchange + STT estimate). */
  commissionPerLotInr: Number(env('INDIA_COMMISSION_PER_LOT_INR', '20')),
  /** Slippage model in ticks for paper fills (spec §48). */
  slippageTicks: Number(env('INDIA_SLIPPAGE_TICKS', '1')),
  /** Historic NSE holidays override file (optional, JSON array of yyyy-mm-dd). */
  holidayFile: env('INDIA_HOLIDAY_FILE', ''),
  scannerIntervalMs: Number(env('INDIA_SCANNER_INTERVAL_MS', '10000')),
  goalScanIntervalMs: Number(env('INDIA_GOAL_SCAN_INTERVAL_MS', '5000')),
  /** Near-ATM candle warm-up: contracts fetched per round / round cadence (ms).
   *  Without it only indices have candle history and the goal universe is
   *  effectively empty (spec §5/§11). Set contracts to 0 to disable. */
  warmContractsPerRound: Number(env('INDIA_WARM_MAX_PER_ROUND', '24')),
  warmIntervalMs: Number(env('INDIA_WARM_INTERVAL_MS', '900000')),
  /**
   * Ceiling on how many instruments the boot websocket subscription may carry.
   *
   * `executionInstruments()` returns every tradable unexpired contract in the master —
   * with a 60-day expiry lookahead that is thousands of option strikes, all pushed
   * into a single subscribe frame. Brokers cap instruments per connection, so the
   * whole frame gets rejected and the feed goes dark rather than carrying slightly
   * less than asked for. The bounded set is ordered indices first, then nearest
   * expiry, so what survives the cap is what the platform actually charts; anything
   * else the user opens is added on demand by `ensureSubscribed`.
   */
  wsSubscribeMax: Number(env('INDIA_WS_SUBSCRIBE_MAX', '150')),
  /**
   * How often the REST last-traded-price fallback runs while the market is open.
   *
   * This poll is the only price source when the credential cannot open the
   * streaming websocket. Cadence is a rate-budget decision per broker:
   *  - UPSTOX: throttles with 200-EMPTY responses once its rolling quota bites,
   *    so 10s keeps it sustainable all session.
   *  - ANGELONE: SmartAPI tolerates 3s batched quotes comfortably — that is
   *    near-realtime on charts without any streaming entitlement.
   */
  ltpPollMs: Number(env('INDIA_LTP_POLL_MS', env('INDIA_BROKER', 'NONE').toUpperCase() === 'ANGELONE' ? '3000' : '10000')),
  /**
   * The same poll's interval outside market hours.
   *
   * Not zero: the last traded price is what a closed-market chart is captioned with, and
   * it has to arrive at least once after a restart. But nothing moves, and the tick
   * sequencer drops the repeats anyway, so asking every three seconds would be paying
   * the rate limit to be told the same number.
   */
  ltpPollClosedMs: Number(env('INDIA_LTP_POLL_CLOSED_MS', '300000')),
  /** Ceiling on instruments per LTP poll request, so a long browsing session cannot
   *  grow one batched call without bound. Indices are always inside it. */
  ltpPollMax: Number(env('INDIA_LTP_POLL_MAX', '40')),
  /**
   * Cadence for the day-OHLC enrichment request (open/high/low/OI fields the LTP
   * endpoint does not carry). One batched call per tick; at 30s that is 2
   * requests/minute on top of the LTP poll's ~20 — well inside the broker budget.
   */
  ohlcPollMs: Number(env('INDIA_OHLC_POLL_MS', '120000')),
  /**
   * Maximum adverse drift between a signal's entry and the live price at fill
   * time, as a percent of entry. A signal whose market has walked further away
   * than this is refused (PRICE_MOVED) instead of filled at a price the engine
   * never analysed (spec §21).
   */
  maxEntryDriftPct: Number(env('INDIA_MAX_ENTRY_DRIFT_PCT', '2')),
  /**
   * ML gate tuning (spec §15). Availability is ALWAYS mandatory. The current v2
   * shadow bundles emit a constant meta probability (no shadow history), so
   * strict-meta vetoing would deadlock the engine on zero information; by
   * default conviction is enforced through the side-aligned probability floor
   * instead, and a meta-filtered prediction merely loses confidence weight.
   */
  mlMetaStrict: env('INDIA_ML_META_STRICT', 'false') === 'true',
  mlMinProbability: Number(env('INDIA_ML_MIN_PROBABILITY', '0.55')),
  /**
   * Portfolio-level concurrent exposure caps for the UNIVERSAL auto-trading
   * book (spec §46). Per-trade sizing caps do not bound how many trades stack
   * up over a session: every fresh signal re-entered on cooldown expiry and
   * total margin/risk grew far past what the user configured. The GOAL engine
   * is sequential by design (one trade at a time) and enforces its own
   * single-position cap.
   */
  universalMaxOpenPositions: Number(env('INDIA_UNIVERSAL_MAX_OPEN_POSITIONS', '3')),
  universalMaxConcurrentMarginInr: Number(env('INDIA_UNIVERSAL_MAX_MARGIN_INR', '30000')),
} as const;

/**
 * Whether the India subsystem has enough credentials to talk to a broker.
 *
 * The analytics token counts. It is read-only and cannot place orders, but it is a
 * real credential for real market data, and for paper trading that is the whole job.
 * This used to test `apiKey` alone, which reported NOT configured for the very setup
 * the token exists to serve — while `market-feed.start()` applied a different, wider
 * test a few lines away and proceeded. Two answers to one question.
 */
export const indiaIsConfigured =
  indiaConfig.broker !== 'NONE'
  && (
    Boolean(indiaConfig.apiKey)
    || Boolean(indiaConfig.upstoxAnalyticsToken)
    || Boolean(indiaConfig.accessToken)
    || Boolean(
      indiaConfig.broker === 'ANGELONE'
      && indiaConfig.angelApiKey && indiaConfig.angelClientCode
      && indiaConfig.angelPin && indiaConfig.angelTotpSecret,
    )
  );