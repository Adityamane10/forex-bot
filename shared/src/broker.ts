/**
 * Broker & trading-account domain (shared by backend, frontend, workers).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The platform can be bound to a real broker account (XM) through a local
 * MetaTrader 5 terminal. The moment real money can move, every number the
 * engine uses to size a trade has to come from somewhere the operator can
 * point at — never from a constant somebody typed once.
 *
 * So this file models *provenance* as a first-class field. Every trading
 * condition (contract size, lot bounds, commission, stop level, leverage,
 * margin call/stop-out …) is a `ConditionField` carrying the value AND where
 * that value came from:
 *
 *   PLATFORM_DEFAULT  the platform's own built-in assumption (assets.ts).
 *                     Usable for simulation, NEVER sufficient for live money.
 *   UNVERIFIED        declared by the catalog but not confirmed for THIS
 *                     account. Never sufficient for live money.
 *   MT5_ACCOUNT       reported by the bound MT5 terminal itself
 *                     (symbol_info / account_info). This is the strongest
 *                     source: it IS the broker's live answer for the account.
 *   OPERATOR_CONFIRMED the user read it on the broker's site and confirmed it.
 *   POLICY_SNAPSHOT   taken from a fetched broker-policy document.
 *
 * Nothing here fabricates broker terms. The XM catalog ships the account types
 * the platform models with UNVERIFIED (or absent) conditions; they become
 * usable as the operator confirms them or as the bound MT5 account reports
 * them. `executionPolicy` in the backend turns that into a gate.
 */

/** Brokers the platform can model. GENERIC = no broker assertions at all. */
export const BROKER_IDS = ['XM', 'GENERIC'] as const;
export type BrokerId = (typeof BROKER_IDS)[number];

/**
 * Account types modelled for XM. `ULTRA_LOW_STANDARD` is the platform default
 * (the account this workspace is configured for).
 *
 * The NAMES are the catalog's own identifiers, not a claim about what the
 * broker currently sells — every condition below starts unverified, and the
 * dashboard shows that state explicitly.
 */
export const XM_ACCOUNT_TYPES = [
  'ULTRA_LOW_STANDARD',
  'STANDARD',
  'MICRO',
  'XM_ZERO',
] as const;
export type XmAccountType = (typeof XM_ACCOUNT_TYPES)[number];

/** Where a condition's value came from. Ordered weakest → strongest. */
export const EVIDENCE_KINDS = [
  'PLATFORM_DEFAULT',
  'UNVERIFIED',
  'POLICY_SNAPSHOT',
  'OPERATOR_CONFIRMED',
  'MT5_ACCOUNT',
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/** Evidence strong enough to size a REAL-money order. */
export const LIVE_GRADE_EVIDENCE: readonly EvidenceKind[] = ['OPERATOR_CONFIRMED', 'MT5_ACCOUNT'];

export interface Evidence {
  kind: EvidenceKind;
  /** Human-readable origin: a URL, 'MT5 symbol_info', 'assets.ts', an operator note. */
  source: string;
  /** Epoch ms when this value was established. */
  at: number;
  note?: string;
}

export interface ConditionField<T> {
  /** null = unknown. Never rendered as a number; treated as missing. */
  value: T | null;
  evidence: Evidence;
}

export function isLiveGrade(f: ConditionField<unknown>): boolean {
  return f.value !== null && LIVE_GRADE_EVIDENCE.includes(f.evidence.kind);
}

/**
 * What the platform knows about the broker's published terms for the account
 * type currently selected. `publishedAcknowledged` is true only once the
 * operator has explicitly read and accepted those published terms — and it
 * lapses when the broker republishes the page.
 */
export interface LiveGradeContext {
  publishedAcknowledged: boolean;
}

/**
 * Live-grade test with the operator's acknowledgement in the picture.
 *
 * A broker-PUBLISHED value (POLICY_SNAPSHOT evidence, e.g. "XM Ultra Low
 * Standard is priced on its spread, no per-lot commission") is usable for real
 * money ONLY after the operator has acknowledged that publication for the
 * selected account type. MT5-reported and operator-typed values never need it,
 * because they already are the account's own answer.
 */
export function isLiveGradeGiven(f: ConditionField<unknown>, ctx: LiveGradeContext): boolean {
  if (f.value === null || f.value === undefined) return false;
  if (LIVE_GRADE_EVIDENCE.includes(f.evidence.kind)) return true;
  return ctx.publishedAcknowledged && f.evidence.kind === 'POLICY_SNAPSHOT';
}

/** A spread accounting model — how the account charges for a fill. */
export const SPREAD_MODELS = ['VARIABLE', 'VARIABLE_ZERO', 'FIXED'] as const;
export type SpreadModel = (typeof SPREAD_MODELS)[number];

/**
 * Every trading condition the engine cares about. All nullable so "unknown"
 * is representable — an unknown commission must never silently become 0.
 */
export interface AccountConditions {
  /** Account base currencies the broker offers for this account type. */
  baseCurrencies: string[] | null;
  /** Leverage ratios offered (e.g. [100, 200, 500] = 1:100 …). */
  leverageOptions: number[] | null;
  /** Units of base currency per 1.00 lot. */
  contractSize: number | null;
  minLot: number | null;
  maxLot: number | null;
  lotStep: number | null;
  /** Round-turn commission in USD per standard lot (0 for spread-only accounts). */
  commissionPerLotUsdRoundTurn: number | null;
  /** Typical spread in pips on the majors. */
  typicalSpreadPips: number | null;
  spreadModel: SpreadModel | null;
  /** Minimum distance (in points) the broker accepts for SL/TP. */
  stopLevelPoints: number | null;
  /** Margin call / stop-out thresholds as % of margin. */
  marginCallLevelPct: number | null;
  stopOutLevelPct: number | null;
  swapFree: boolean | null;
  /** Overnight swap in pips per lot per night (negative = cost). */
  swapLongPipsPerLot: number | null;
  swapShortPipsPerLot: number | null;
  /** Instrument whitelist for the account, when the broker publishes one. */
  instruments: string[] | null;
}

export type ConditionKey = keyof AccountConditions;

/** Field metadata drives the dashboard table and the confirmation form. */
export interface ConditionMeta {
  key: ConditionKey;
  label: string;
  unit?: string;
  kind: 'number' | 'stringList' | 'numberList' | 'boolean' | 'enum';
}

export const CONDITION_FIELDS: readonly ConditionMeta[] = [
  { key: 'baseCurrencies', label: 'Base currencies', kind: 'stringList' },
  { key: 'leverageOptions', label: 'Leverage options', kind: 'numberList' },
  { key: 'contractSize', label: 'Contract size', unit: 'units / lot', kind: 'number' },
  { key: 'minLot', label: 'Minimum lot', unit: 'lots', kind: 'number' },
  { key: 'maxLot', label: 'Maximum lot', unit: 'lots', kind: 'number' },
  { key: 'lotStep', label: 'Lot step', unit: 'lots', kind: 'number' },
  { key: 'commissionPerLotUsdRoundTurn', label: 'Commission', unit: 'USD / lot round turn', kind: 'number' },
  { key: 'typicalSpreadPips', label: 'Typical spread', unit: 'pips (majors)', kind: 'number' },
  { key: 'spreadModel', label: 'Spread model', kind: 'enum' },
  { key: 'stopLevelPoints', label: 'Stop level', unit: 'points', kind: 'number' },
  { key: 'marginCallLevelPct', label: 'Margin call', unit: '% of margin', kind: 'number' },
  { key: 'stopOutLevelPct', label: 'Stop out', unit: '% of margin', kind: 'number' },
  { key: 'swapFree', label: 'Swap-free option', kind: 'boolean' },
  { key: 'swapLongPipsPerLot', label: 'Swap long', unit: 'pips / lot / night', kind: 'number' },
  { key: 'swapShortPipsPerLot', label: 'Swap short', unit: 'pips / lot / night', kind: 'number' },
  { key: 'instruments', label: 'Instruments', kind: 'stringList' },
] as const;

/**
 * Conditions that MUST be live-grade before a REAL-money order is dispatched.
 * Lot geometry, sizing economics and the account's own currency/leverage.
 */
export const REQUIRED_FOR_LIVE: readonly ConditionKey[] = [
  'baseCurrencies',
  'leverageOptions',
  'contractSize',
  'minLot',
  'maxLot',
  'lotStep',
  'commissionPerLotUsdRoundTurn',
  'typicalSpreadPips',
  'stopOutLevelPct',
] as const;

export interface AccountProfileDefinition {
  id: string;
  broker: BrokerId;
  /** Stable catalog key; for XM this is an XmAccountType. */
  accountType: string;
  label: string;
  /** Where the operator can read the account's real conditions. */
  marketUrl: string;
  /** Broker-identity hints used to sanity-check the bound MT5 account. */
  brokerHints: readonly string[];
  conditions: Record<ConditionKey, ConditionField<unknown>>;
  /** Honest description of what is and is not known about this profile. */
  note: string;
  /** What the broker itself publishes about this account type, with citations. */
  published: PublishedAccountTerms | null;
}

/**
 * What the broker's OWN pages say about an account type.
 *
 * `quotes` are verbatim, `sourceUrl`/`retrievedAt` say when they were read, and
 * numbers are only ever recorded when the broker published a number the page
 * actually contained. This is deliberately weaker evidence than the bound MT5
 * account: it tells the operator what the broker claims, and the platform
 * cross-checks those claims against the live terminal instead of trusting them.
 */
export interface PublishedAccountTerms {
  accountType: string;
  label: string;
  sourceUrl: string;
  retrievedAt: number;
  /** Verbatim broker copy (never paraphrased into numbers). */
  quotes: string[];
  minDepositUsd: number | null;
  /** Rows the broker's own comparison table publishes for this account type. */
  publishedRows: string[];
  /** Tradeable instrument families the broker lists for this account. */
  markets: string | null;
  /** How the cost figures in this profile were derived from the quotes above. */
  costBasis: string;
}

export function profileId(broker: BrokerId, accountType: string): string {
  return `${broker}:${accountType}`;
}

const PLATFORM_SOURCE = 'platform built-in assumptions (shared/src/assets.ts)';

/**
 * The platform's own defaults, used for GENERIC — deliberately attributed to
 * the PLATFORM, never to a broker. These are the values the engines have
 * always assumed; naming them makes simulation honest and live execution
 * distinguishable.
 */
export const PLATFORM_DEFAULT_CONDITIONS: AccountConditions = {
  baseCurrencies: null,
  leverageOptions: null,
  contractSize: 100_000,
  minLot: 0.01,
  maxLot: 100,
  lotStep: 0.01,
  commissionPerLotUsdRoundTurn: 7,
  typicalSpreadPips: null,
  spreadModel: 'VARIABLE',
  stopLevelPoints: 0,
  marginCallLevelPct: null,
  stopOutLevelPct: null,
  swapFree: null,
  swapLongPipsPerLot: null,
  swapShortPipsPerLot: null,
  instruments: null,
};

function field<T>(value: T | null, kind: EvidenceKind, source: string, note?: string): ConditionField<T> {
  return { value, evidence: { kind, source, at: 0, note } };
}

/**
 * Citation for every XM fact this catalog carries.
 *
 * The values below were read from the broker's own account-types page. XM
 * publishes its account TERMS there but not the numeric table cells (those are
 * loaded by the page's own client-side script), so a number is recorded ONLY
 * where the published copy states it — everything else stays `null` and is
 * settled by the bound MT5 account or by the operator.
 */
export const XM_TERMS_URL = 'https://www.xm.com/account-types';
export const XM_TERMS_RETRIEVED_AT = Date.UTC(2026, 8, 17);
const XM_TERMS_SOURCE = `xm.com account-types page (read ${new Date(XM_TERMS_RETRIEVED_AT).toISOString().slice(0, 10)})`;

const XM_QUOTE_ALL_ACCOUNTS =
  'All accounts offer negative balance protection, hedging and Islamic option as standard.';
const XM_QUOTE_STANDARD =
  'Open our most popular account to get bonuses that boost your trading power and reduce the risk to your capital. Minimum Deposit $5.';
const XM_QUOTE_ULTRA_LOW =
  'The ideal choice for trading high volumes. Reduce your costs with low spreads and even lower swap fees and commissions. Minimum Deposit $5.';
const XM_QUOTE_ZERO =
  'Stay in full control of your trading costs with a Zero Account. Trade with fixed commissions and spreads as low as zero.';
const XM_QUOTE_SHARES = 'Looking to buy shares in a company? Open a Shares Account. Minimum Deposit $10,000.';

export const XM_PUBLISHED_ROWS = [
  'Spreads As Low As',
  'Commission',
  'Maximum Leverage',
  'Stop Out Level',
  'Markets',
  'Swap Free',
  'Bonus Eligibility',
  'Micro Account Option',
] as const;

export const XM_MARKETS =
  'Forex, Precious Metals, Equity Indices, Cryptocurrencies, Thematic Indices, Turbo Stocks, Commodities, Energies';

const SPREAD_BASED_BASIS =
  "XM's account-types comparison prices this account on its spreads (a separate Commission row exists, and the " +
  'account XM describes as having fixed commissions is the Zero account). Modelled as spread-only: commission 0, ' +
  'to be confirmed against your own account page before real money moves.';

function publishedTerms(
  accountType: string,
  label: string,
  quotes: string[],
  minDepositUsd: number | null,
  costBasis: string,
): PublishedAccountTerms {
  return {
    accountType,
    label,
    sourceUrl: XM_TERMS_URL,
    retrievedAt: XM_TERMS_RETRIEVED_AT,
    quotes,
    minDepositUsd,
    publishedRows: [...XM_PUBLISHED_ROWS],
    markets: XM_MARKETS,
    costBasis,
  };
}

/** A blank (all-unknown) condition set for a broker-specific account type. */
function unknownConditions(note: string): Record<ConditionKey, ConditionField<unknown>> {
  const out = {} as Record<ConditionKey, ConditionField<unknown>>;
  for (const meta of CONDITION_FIELDS) {
    out[meta.key] = field(null, 'UNVERIFIED', 'broker catalog', note);
  }
  return out;
}

function platformConditions(): Record<ConditionKey, ConditionField<unknown>> {
  const out = {} as Record<ConditionKey, ConditionField<unknown>>;
  for (const meta of CONDITION_FIELDS) {
    out[meta.key] = field(PLATFORM_DEFAULT_CONDITIONS[meta.key], 'PLATFORM_DEFAULT', PLATFORM_SOURCE);
  }
  return out;
}

const XM_URL = XM_TERMS_URL;
const XM_HINTS = ['XM', 'TRADING POINT'] as const;

/**
 * A catalog profile for an XM account type: every condition starts unknown
 * except the ones the broker's own published copy actually states, which are
 * recorded with POLICY_SNAPSHOT evidence and the citation beside them.
 */
function xmProfile(
  accountType: XmAccountType,
  label: string,
  note: string,
  published: PublishedAccountTerms,
  cost: { spreadModel: SpreadModel; commissionUsd: number | null },
): AccountProfileDefinition {
  const conditions = unknownConditions(note);
  conditions.spreadModel = field(cost.spreadModel, 'POLICY_SNAPSHOT', XM_TERMS_SOURCE, published.costBasis);
  conditions.commissionPerLotUsdRoundTurn = field(
    cost.commissionUsd,
    'POLICY_SNAPSHOT',
    XM_TERMS_SOURCE,
    cost.commissionUsd === null ? 'XM publishes a fixed commission for this account but not the amount on the page that was read — confirm the per-lot figure from your account terms.' : published.costBasis,
  );
  // "All accounts offer negative balance protection, hedging and Islamic
  // option as standard" — a swap-free (Islamic) arrangement is available on
  // every XM account type, as published.
  conditions.swapFree = field(true, 'POLICY_SNAPSHOT', XM_TERMS_SOURCE, XM_QUOTE_ALL_ACCOUNTS);
  return {
    id: profileId('XM', accountType),
    broker: 'XM',
    accountType,
    label,
    marketUrl: XM_URL,
    brokerHints: XM_HINTS,
    conditions,
    note,
    published,
  };
}

const UNVERIFIED_NOTE =
  'Conditions not yet confirmed for this account. They are filled in from the bound MT5 account ' +
  '(symbol_info/account_info) or confirmed by you from the broker, never assumed.';

/**
 * The catalog. XM entries carry NO invented numbers: each condition is
 * "unknown until the bound account reports it or the operator confirms it",
 * which is exactly what a real trading platform must do.
 */
export const BROKER_ACCOUNT_CATALOG: readonly AccountProfileDefinition[] = [
  xmProfile(
    'ULTRA_LOW_STANDARD',
    'XM Ultra Low Standard',
    `Ultra Low Standard (platform default). ${UNVERIFIED_NOTE}`,
    publishedTerms(
      'ULTRA_LOW_STANDARD',
      'XM Ultra Low Standard',
      [XM_QUOTE_ULTRA_LOW, XM_QUOTE_ALL_ACCOUNTS],
      5,
      SPREAD_BASED_BASIS,
    ),
    { spreadModel: 'VARIABLE', commissionUsd: 0 },
  ),
  xmProfile(
    'STANDARD',
    'XM Standard',
    `Standard. ${UNVERIFIED_NOTE}`,
    publishedTerms('STANDARD', 'XM Standard', [XM_QUOTE_STANDARD, XM_QUOTE_ALL_ACCOUNTS], 5, SPREAD_BASED_BASIS),
    { spreadModel: 'VARIABLE', commissionUsd: 0 },
  ),
  xmProfile(
    'MICRO',
    'XM Micro',
    `Micro (XM publishes this as the "Micro Account Option" on its account types). ${UNVERIFIED_NOTE}`,
    publishedTerms(
      'MICRO',
      'XM Micro',
      ['Micro Account Option (row on the account-types comparison).', XM_QUOTE_ALL_ACCOUNTS],
      5,
      SPREAD_BASED_BASIS,
    ),
    { spreadModel: 'VARIABLE', commissionUsd: 0 },
  ),
  xmProfile(
    'XM_ZERO',
    'XM Zero',
    `Zero (spread + commission pricing). ${UNVERIFIED_NOTE}`,
    publishedTerms(
      'XM_ZERO',
      'XM Zero',
      [XM_QUOTE_ZERO, XM_QUOTE_ALL_ACCOUNTS],
      null,
      'XM describes Zero as the account with fixed commissions and spreads as low as zero; the per-lot commission amount is not published on the page that was read, so it is left unknown.',
    ),
    { spreadModel: 'VARIABLE_ZERO', commissionUsd: null },
  ),
  {
    id: profileId('GENERIC', 'GENERIC'),
    broker: 'GENERIC',
    accountType: 'GENERIC',
    label: 'Unspecified account (platform defaults)',
    marketUrl: '',
    brokerHints: [],
    conditions: platformConditions(),
    note: 'No broker profile selected: the platform uses its own built-in contract/commission assumptions. Simulation only.',
    published: null,
  },
] as const;

export const DEFAULT_BROKER: BrokerId = 'XM';
export const DEFAULT_ACCOUNT_TYPE: XmAccountType = 'ULTRA_LOW_STANDARD';

export function findProfile(id: string): AccountProfileDefinition | undefined {
  return BROKER_ACCOUNT_CATALOG.find((p) => p.id === id);
}

export function defaultProfile(): AccountProfileDefinition {
  return findProfile(profileId(DEFAULT_BROKER, DEFAULT_ACCOUNT_TYPE)) ?? BROKER_ACCOUNT_CATALOG[BROKER_ACCOUNT_CATALOG.length - 1];
}

// ---------------------------------------------------------------------------
// MT5 account snapshot
// ---------------------------------------------------------------------------

/** MT5 account trade mode, as the terminal reports it. */
export const MT5_TRADE_MODES = ['DEMO', 'CONTEST', 'REAL', 'UNKNOWN'] as const;
export type Mt5TradeMode = (typeof MT5_TRADE_MODES)[number];

/** Per-symbol specs the broker reports for THIS account. */
export interface Mt5SymbolSpec {
  /** Broker symbol name (e.g. EURUSD, XAUUSD.a). */
  symbol: string;
  /** Platform symbol resolved by the trader (e.g. EUR/USD). */
  platformSymbol: string;
  contractSize: number;
  volumeMin: number;
  volumeMax: number;
  volumeStep: number;
  digits: number;
  point: number;
  stopsLevelPoints: number;
  /** Current spread in points as the terminal sees it. */
  spreadPoints: number;
  swapLong: number;
  swapShort: number;
  /**
   * MT5 `symbol_info.swap_mode`: 0 = swap charged in POINTS, anything else
   * charges in a currency/interest scheme this platform does not model. Only
   * mode 0 is interpreted; every other mode stays "unknown" rather than being
   * silently read as points and mispricing the overnight cost.
   */
  swapMode?: number | null;
  /** MT5 `symbol_info.filling_mode` bitmask (execution capability of the symbol). */
  fillingMode?: number | null;
  path?: string;
  description?: string;
}

export interface Mt5AccountSnapshot {
  login: number;
  server: string;
  /** Broker company string as the terminal reports it. */
  company?: string;
  currency: string;
  balance: number;
  equity?: number;
  profit?: number;
  margin?: number;
  freeMargin?: number;
  /** Account leverage ratio (100 = 1:100). */
  leverage?: number;
  tradeMode: Mt5TradeMode;
  marginCallLevelPct?: number;
  stopOutLevelPct?: number;
  /** Specs for the symbols the worker is trading, straight from symbol_info. */
  symbolSpecs?: Mt5SymbolSpec[];
  /** Epoch ms the worker observed this snapshot. */
  observedAt?: number;
}

export interface CompatibilityIssue {
  code: string;
  severity: 'BLOCK' | 'WARN';
  message: string;
}

export interface CompatibilityContext {
  /** Whether real-money execution has been explicitly enabled by the operator. */
  allowReal: boolean;
  /** How long ago the snapshot was observed; null = never. */
  ageMs: number | null;
  /** Max age for a snapshot to count as a live binding. */
  maxAgeMs: number;
  /** Keys that lack live-grade evidence (from summarizeConditions). */
  missingLiveConditions: readonly string[];
}

/**
 * Pure broker/account consistency check. Every rule is fail-closed: an unknown
 * is never treated as OK when money could move.
 */
export function checkAccountCompatibility(
  profile: AccountProfileDefinition,
  account: Mt5AccountSnapshot | null,
  ctx: CompatibilityContext,
): CompatibilityIssue[] {
  const issues: CompatibilityIssue[] = [];
  const add = (code: string, severity: 'BLOCK' | 'WARN', message: string) => issues.push({ code, severity, message });

  if (!account) {
    add('NO_ACCOUNT', 'BLOCK', 'No MT5 account is bound yet — start the MT5 trader worker and log in to the broker account.');
    return issues;
  }

  if (ctx.ageMs === null || ctx.ageMs > ctx.maxAgeMs) {
    add(
      'ACCOUNT_STALE',
      'BLOCK',
      ctx.ageMs === null
        ? 'The MT5 account has never reported in.'
        : `The MT5 account last reported ${Math.round(ctx.ageMs / 1000)}s ago (limit ${Math.round(ctx.maxAgeMs / 1000)}s) — binding not live.`,
    );
  }

  if (account.tradeMode === 'UNKNOWN') {
    add('TRADE_MODE_UNKNOWN', 'BLOCK', 'The MT5 account did not report whether it is DEMO or REAL — refusing to assume.');
  }
  if (account.tradeMode === 'CONTEST') {
    add('TRADE_MODE_CONTEST', 'BLOCK', 'Contest accounts are not tradeable by this platform.');
  }
  if (account.tradeMode === 'REAL' && !ctx.allowReal) {
    add('REAL_NOT_ALLOWED', 'BLOCK', 'A REAL-money account is bound but real execution is disabled. Enable it deliberately to trade live money.');
  }

  const currencies = profile.conditions.baseCurrencies.value as string[] | null;
  if (currencies && currencies.length && !currencies.includes(account.currency.toUpperCase())) {
    add('CURRENCY_MISMATCH', 'BLOCK', `Account is denominated in ${account.currency}, which is not a listed base currency for ${profile.label}.`);
  }

  const leverages = profile.conditions.leverageOptions.value as number[] | null;
  if (leverages && leverages.length && account.leverage && !leverages.includes(account.leverage)) {
    add('LEVERAGE_MISMATCH', 'WARN', `Account leverage 1:${account.leverage} is not in the declared set for ${profile.label} (1:${leverages.join(', 1:')}).`);
  }

  if (profile.brokerHints.length) {
    const identity = `${account.company ?? ''} ${account.server ?? ''}`.toUpperCase();
    if (!profile.brokerHints.some((h) => identity.includes(h))) {
      add('BROKER_UNVERIFIED', 'WARN', `The MT5 account identifies as "${account.company ?? 'unknown'}" on "${account.server || 'unknown server'}" — that does not match the selected profile (${profile.label}).`);
    }
  }

  if (ctx.missingLiveConditions.length) {
    add(
      'CONDITIONS_UNVERIFIED',
      'BLOCK',
      `Live execution needs broker-confirmed conditions; missing: ${ctx.missingLiveConditions.join(', ')}.`,
    );
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Realtime status contract (REST + WebSocket payloads)
// ---------------------------------------------------------------------------

/** State of the broker-policy watcher (the "is XM still saying the same thing" check). */
export const POLICY_STATUSES = ['FRESH', 'STALE', 'UNAVAILABLE', 'NEVER_CHECKED'] as const;
export type PolicyStatus = (typeof POLICY_STATUSES)[number];

export interface BrokerPolicySnapshot {
  id: string;
  status: PolicyStatus;
  sourceUrl: string;
  /** Epoch ms of the last SUCCESSFUL fetch. */
  fetchedAt: number | null;
  /** Epoch ms of the last attempt, success or failure. */
  lastAttemptAt: number | null;
  lastError: string | null;
  /** sha256 of the normalized document, null when never fetched. */
  contentHash: string | null;
  contentBytes: number | null;
  /** Epoch ms the content last CHANGED (broker re-published something). */
  changedAt: number | null;
  /** Epoch ms the operator last acknowledged the current content. */
  acknowledgedAt: number | null;
  refreshIntervalMs: number;
  consecutiveFailures: number;
  /** True when fresh content differs from what was acknowledged → re-confirm conditions. */
  reviewRequired: boolean;
}

/** Live currency conversion backing every money figure shown for the account. */
export interface BrokerFxView {
  pair: string;
  rate: number;
  source: string;
  at: number;
  ageMs: number;
  stale: boolean;
}

// ---------------------------------------------------------------------------
// Per-symbol account costs
// ---------------------------------------------------------------------------

/**
 * Where a cost component came from. Ordered strongest → weakest:
 *
 *   LIVE_FEED        the tick the platform is trading on right now (bid/ask),
 *                    i.e. the broker's live spread as the price stream sees it.
 *   MT5_SYMBOL_INFO  the bound terminal's own `symbol_info` (spread, swaps,
 *                    stop distance) for THIS account.
 *   ACCOUNT_TERMS    the account type's commission/spread model.
 *   PLATFORM_DEFAULT the platform's built-in assumption — simulation only.
 *   UNKNOWN          not available; never silently treated as zero.
 */
export const COST_SOURCES = ['LIVE_FEED', 'MT5_SYMBOL_INFO', 'ACCOUNT_TERMS', 'PLATFORM_DEFAULT', 'UNKNOWN'] as const;
export type CostSource = (typeof COST_SOURCES)[number];

export interface CostComponent {
  /** Amount in the ACCOUNT currency. null = unknown (never assumed 0). */
  value: number | null;
  source: CostSource;
  /** Human origin, e.g. 'MT5 symbol_info EURUSD.spread' or 'account terms'. */
  detail: string;
  /** Epoch ms the value was observed; null when it is not a live observation. */
  at: number | null;
}

/** What one symbol costs to trade on the bound account, component by component. */
export interface BrokerSymbolCostView {
  symbol: string;
  brokerSymbol: string | null;
  /** Spread cost for one lot, round turn, account currency. */
  spreadPerLot: CostComponent;
  /** Commission for one lot, round turn, account currency. */
  commissionPerLot: CostComponent;
  /** Overnight swap per lot, account currency (negative = cost). */
  swapLongPerLotNight: CostComponent;
  swapShortPerLotNight: CostComponent;
  /** Spread + commission for a round turn; null when either part is unknown. */
  roundTurnPerLot: CostComponent;
  /** The same spread expressed in pips (reviewability, not money). */
  spreadPips: CostComponent;
  /** Minimum SL/TP distance the broker accepts, in points. */
  stopLevelPoints: CostComponent;
  /** Contract size the platform is actually sizing with for this symbol. */
  contractSize: CostComponent;
  /** True when every component a live order needs is known. */
  complete: boolean;
  /** Names of the components that are still unknown. */
  missing: string[];
}

// ---------------------------------------------------------------------------
// Live-money readiness
// ---------------------------------------------------------------------------

export interface BrokerReadinessItem {
  key: string;
  label: string;
  ok: boolean;
  severity: 'BLOCK' | 'WARN';
  detail: string;
}

/**
 * The consolidated "may real money move through this account right now"
 * checklist. Each item is a separate, independently checkable fact so the
 * dashboard can show exactly which one is holding the platform back.
 */
export interface BrokerReadinessView {
  ready: boolean;
  checkedAt: number;
  /** Symbol the per-symbol items were evaluated for, when one was given. */
  symbol: string | null;
  items: BrokerReadinessItem[];
  /** Details of the failed BLOCK items. */
  blocking: string[];
}

// ---------------------------------------------------------------------------
// Terms provenance (trade journal)
// ---------------------------------------------------------------------------

/** One condition as it was actually used, with the evidence behind it. */
export interface TermsFieldRecord {
  key: string;
  label: string;
  value: string;
  evidence: EvidenceKind;
  source: string;
  at: number;
}

/**
 * The trading terms a decision was made under, frozen at decision time.
 *
 * Written onto positions and trades (and available over the API) so a trade's
 * journal entry always shows which account type it belonged to, which numbers
 * sized it, where each number came from and whether live execution was open —
 * none of which may be re-derived later from today's settings.
 */
export interface TermsProvenance {
  profileId: string;
  broker: BrokerId;
  accountType: string;
  label: string;
  /** Conditions that actually drive sizing/costs, with provenance. */
  fields: TermsFieldRecord[];
  /** Cost view for the traded symbol at decision time. */
  costs: BrokerSymbolCostView | null;
  fx: { pair: string; rate: number; source: string; at: number } | null;
  binding: {
    login: number | null;
    server: string | null;
    currency: string | null;
    tradeMode: Mt5TradeMode | null;
    ageMs: number | null;
  };
  liveGate: BrokerGateView;
  /** Readiness at decision time (false = the order could not have been live). */
  liveReady: boolean;
  at: number;
}

/** Condition keys recorded in the journal as "what this trade was priced on". */
export const JOURNAL_TERM_KEYS: readonly ConditionKey[] = [
  'contractSize',
  'minLot',
  'maxLot',
  'lotStep',
  'commissionPerLotUsdRoundTurn',
  'typicalSpreadPips',
  'spreadModel',
  'stopLevelPoints',
  'leverageOptions',
  'stopOutLevelPct',
  'marginCallLevelPct',
  'baseCurrencies',
] as const;

export interface BrokerConditionView {
  key: string;
  label: string;
  unit?: string;
  /** Rendered value ('unknown' when absent). */
  display: string;
  raw: unknown;
  evidence: EvidenceKind;
  source: string;
  at: number;
  liveGrade: boolean;
  requiredForLive: boolean;
}

export interface BrokerGateView {
  allowed: boolean;
  reasons: string[];
  warnings: string[];
}

export interface BrokerSymbolSpecIssue {
  symbol: string;
  field: string;
  platform: string;
  broker: string;
  severity: 'BLOCK' | 'WARN';
}

export interface BrokerStatusView {
  broker: BrokerId;
  brokerLabel: string;
  accountType: string;
  profileId: string;
  label: string;
  marketUrl: string;
  note: string;
  conditions: BrokerConditionView[];
  missingLiveConditions: string[];
  confirmedAt: number | null;
  /** True once the operator has acknowledged the broker's published terms. */
  publishedAcknowledged: boolean;
  publishedAcknowledgedAt: number | null;
  binding: {
    bound: boolean;
    account: Mt5AccountSnapshot | null;
    ageMs: number | null;
    issues: CompatibilityIssue[];
    specsReported: number;
  };
  specMismatches: BrokerSymbolSpecIssue[];
  policy: BrokerPolicySnapshot;
  fx: BrokerFxView | null;
  /** Per-symbol account costs, priced on the bound account's live data. */
  costs: BrokerSymbolCostView[];
  /**
   * True when those costs are in force for MONEY (an account is bound, or the
   * operator acknowledged the broker's published terms). While false they are
   * the selected account type's PLANNING basis and the wallet keeps the
   * platform defaults.
   */
  costBasisActive: boolean;
  /** Consolidated live-money readiness checklist. */
  readiness: BrokerReadinessView;
  /** What the broker publishes about the selected account type, with citations. */
  published: PublishedAccountTerms | null;
  /** Currency the paper/wallet ledger is denominated in. */
  accountCurrency: string;
  /** Currency the dashboard renders money in (follows the bound MT5 account). */
  displayCurrency: string;
  realExecutionEnabled: boolean;
  /** Gate for dispatching orders to the bound MT5 account. */
  liveGate: BrokerGateView;
  /** Gate for simulated (paper) entries — advisory, never blocks on unverified terms. */
  paperGate: BrokerGateView;
  updatedAt: number;
}

export const BROKER_BRAND_LABELS: Record<BrokerId, string> = {
  XM: 'XM (xm.com)',
  GENERIC: 'No broker',
};

/** Human summary of a field's value, for UI/logs. */
export function describeConditionValue(value: unknown): string {
  if (value === null || value === undefined) return 'unknown';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (Array.isArray(value)) return value.length ? value.join(', ') : 'unknown';
  return String(value);
}
