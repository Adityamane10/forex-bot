import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });
dotenv.config({ path: path.resolve(process.cwd(), '../.env') });

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

/** Integer env with clamping — `SCANNER_INTERVAL_MS=abc` used to become NaN,
 *  and setInterval(fn, NaN) behaves as 1ms (a hot loop hammering providers). */
function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  // `0` is a common way for a shell, IDE or supervisor to say "not set". For an
  // option whose valid range excludes it (min >= 1) clamping to `min` silently
  // picks a value nobody asked for — `PORT=0` used to bind port 1, leaving the
  // API unreachable at the port the dashboard and the MT5 workers dial. Fall
  // back to the documented default instead. Options that legitimately accept 0
  // (min === 0, e.g. TRUST_PROXY_HOPS) are unaffected.
  if (n === 0 && min > 0) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function boolEnv(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return v === 'true' || v === '1';
}

export const config = {
  nodeEnv: env('NODE_ENV', 'development'),
  port: intEnv('PORT', 4000, 1, 65535),
  frontendUrl: env('FRONTEND_URL', 'http://localhost:5173'),
  /** Hop count of trusted reverse proxies in front of this API (rate limiting
   *  keys on the client IP — without this, every proxied client shares one
   *  bucket and one attacker can DoS the platform). */
  trustProxyHops: intEnv('TRUST_PROXY_HOPS', 0, 0, 5),
  mongodbUri: env('MONGODB_URI', ''),
  redisUrl: env('REDIS_URL', ''),
  jwtSecret: env('JWT_SECRET', 'dev-only-secret-change-me'),
  jwtExpiresIn: env('JWT_EXPIRES_IN', '7d'),

  // Default: YAHOO — REAL market data, no API key, sub-minute freshness.
  // DEMO is an explicit opt-in for development only.
  marketDataProvider: env('MARKET_DATA_PROVIDER', 'YAHOO'),
  marketDataApiKey: env('MARKET_DATA_API_KEY', ''),
  finnhubApiKey: env('FINNHUB_API_KEY', ''),

  // Crypto market data. BINANCE = free public spot REST + WebSocket (no key).
  // DEMO = clearly-labeled simulated feed (development only).
  cryptoMarketDataProvider: env('CRYPTO_MARKET_DATA_PROVIDER', 'BINANCE'),
  cryptoSymbols: env('CRYPTO_SYMBOLS', '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  binanceRestUrl: env('BINANCE_REST_URL', 'https://api.binance.com'),
  binanceWsUrl: env('BINANCE_WS_URL', 'wss://stream.binance.com:9443'),
  /** Shared secret for internal feed ingestion (MT5 bridge). Empty disables the endpoint. */
  internalApiToken: env('INTERNAL_API_TOKEN', ''),

  // Default RSS: free public forex feeds (verified reachable). NONE is explicit opt-out.
  newsProvider: env('NEWS_PROVIDER', 'RSS'),
  newsApiKey: env('NEWS_API_KEY', ''),

  // Default CENTRALBANK: official Fed/BoE/BoJ/ECB calendars + free ForexFactory JSON.
  economicCalendarProvider: env('ECONOMIC_CALENDAR_PROVIDER', 'CENTRALBANK'),
  economicCalendarApiKey: env('ECONOMIC_CALENDAR_API_KEY', ''),

  groqApiKey: env('GROQ_API_KEY', ''),
  groqModel: env('GROQ_MODEL', 'llama-3.3-70b-versatile'),

  pythonAiUrl: env('PYTHON_AI_URL', 'http://localhost:8500'),

  /** If true, signals are allowed when the ML engine is unavailable (unsafe; default off). */
  allowSignalsWithoutMl: boolEnv('ALLOW_SIGNALS_WITHOUT_ML', false),
  /** If true, the DEMO (simulated) market-data feed may drive signal
   *  generation. Default OFF: fabricated prices must never produce "real"
   *  signals — this is an explicit development opt-in. */
  allowDemoSignals: boolEnv('ALLOW_DEMO_SIGNALS', false),
  /** Live execution is OFF by default and must be explicitly enabled (spec §1, §55). */
  enableLiveTrading: boolEnv('ENABLE_LIVE_TRADING', false),

  // ---- broker account binding (the platform's trading account) -------------
  /** Broker whose account terms the platform follows. */
  brokerId: env('BROKER_ID', 'XM'),
  /** Account type selected at boot; empty = the catalog default (XM Ultra Low Standard). */
  brokerAccountType: env('BROKER_ACCOUNT_TYPE', ''),
  /**
   * Document the broker publishes its account terms on. Polled for CHANGES
   * only — the platform never edits its own trading conditions from a fetch.
   * A local path (or file: URL) is accepted for an operator-saved copy.
   */
  brokerPolicyUrl: env('BROKER_POLICY_URL', 'https://www.xm.com/account-types'),
  brokerPolicyRefreshMs: intEnv('BROKER_POLICY_REFRESH_MS', 6 * 3600_000, 60_000, 7 * 24 * 3600_000),
  /** Max age of an MT5 account heartbeat before the binding counts as stale. */
  brokerAccountMaxAgeMs: intEnv('BROKER_ACCOUNT_MAX_AGE_MS', 45_000, 5_000, 600_000),
  /**
   * REAL-money execution opt-in. Separate from ENABLE_LIVE_TRADING (paper/live
   * engine switch) on purpose: with this false, a real account may be bound and
   * watched but no order can ever be dispatched to it.
   */
  allowRealTrading: boolEnv('ALLOW_REAL_TRADING', false),
  /** How often the scanner re-evaluates all assets (ms). */
  scannerIntervalMs: intEnv('SCANNER_INTERVAL_MS', 15_000, 1_000, 3_600_000),
  /** Staleness threshold: if no tick for this long, data is stale (ms). */
  staleTickMs: intEnv('STALE_TICK_MS', 10_000, 1_000, 3_600_000),
  /** Max candles kept in memory per symbol/timeframe. */
  maxCandlesInMemory: intEnv('MAX_CANDLES_IN_MEMORY', 2000, 100, 100_000),
  /** Retention policy for ticks persisted to Mongo (ms). */
  tickRetentionMs: intEnv('TICK_RETENTION_MS', 7 * 24 * 3600 * 1000, 60_000, 365 * 24 * 3600 * 1000),
  logLevel: env('LOG_LEVEL', 'info'),
};

export const isProd = config.nodeEnv === 'production';
export const hasMongo = Boolean(config.mongodbUri);
export const hasRedis = Boolean(config.redisUrl);

// Fail fast on an insecure JWT secret in production: a source-visible default
// lets anyone forge admin tokens.
if (isProd && (!config.jwtSecret || config.jwtSecret.includes('change') || config.jwtSecret === 'dev-only-secret-change-me')) {
  throw new Error('JWT_SECRET must be set to a strong random value in production (>= 32 chars, not a known default)');
}
