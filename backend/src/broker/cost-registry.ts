/**
 * BrokerCostRegistry — what does ONE LOT of a symbol actually cost on the
 * account this platform is bound to, and where did each number come from?
 *
 * WHY A MODULE-LEVEL REGISTRY
 * ---------------------------
 * The cost model sits on the money path of three engines (signals, paper
 * fills, MT5 dispatch) and is fed by a fourth (the account binding). Threading
 * it through every constructor would touch every call site for no benefit, and
 * the platform already keeps its broker lot-geometry the same way
 * (forex/symbol-spec.ts `setBrokerSpecOverrides`). So the account binding
 * PUSHES here on every MT5 heartbeat, engines PULL here synchronously, and a
 * version counter lets caches invalidate when the account actually changes.
 *
 * Fail-closed contract, matching the rest of the broker layer:
 *   - with no broker profile active everything returns `null` and the caller
 *     keeps its platform-default behaviour (simulation);
 *   - a component that cannot be sourced from the bound account or from the
 *     account's own terms is `unknown` — never 0, never a platform guess;
 *   - `swap_mode != 0` (points) is NOT interpreted: MT5 can charge swaps in
 *     currency/interest schemes this platform does not model, and reading
 *     those as points would misprice the hold cost by orders of magnitude.
 *
 * Units: every monetary helper returns a value in the pair's QUOTE currency
 * per lot for one round turn (same convention as pipValueQuote), because
 * that is what the EV/sizing math already works in. The account-currency view
 * is assembled in AccountProfileService, which owns the FX conversion.
 */
import {
  BrokerId,
  ConditionField,
  CostComponent,
  CostSource,
  EvidenceKind,
  SpreadModel,
} from '@fx/shared';

export interface BrokerCostObservation {
  /** Platform symbol the observation is keyed by (e.g. EUR/USD). */
  platformSymbol: string;
  /** Broker's own symbol name (e.g. EURUSD.a). */
  brokerSymbol: string;
  contractSize: number;
  volumeMin: number;
  volumeMax: number;
  volumeStep: number;
  stopsLevelPoints: number;
  /** Current spread in points as the terminal reports it. */
  spreadPoints: number;
  /** Smallest price increment (`symbol_info.point`). */
  point: number;
  digits: number;
  swapLong: number;
  swapShort: number;
  swapMode: number | null;
  observedAt: number;
}

/** The account-level cost policy: commission and spread model, with evidence. */
export interface BrokerAccountCostPolicy {
  /**
   * True when these figures may be used for MONEY, not just planning: either an
   * MT5 account is actually bound (the broker's own costs are then in force) or
   * the operator has acknowledged the broker's published terms for the selected
   * account type. While false the wallet keeps its platform-default costs — an
   * unacknowledged published number must never quietly price a ledger.
   */
  active: boolean;
  profileId: string;
  broker: BrokerId;
  accountType: string;
  label: string;
  /** Currency the bound account settles in, as the terminal reports it. */
  accountCurrency: string;
  /** Round-turn commission in USD per standard lot. */
  commissionPerLotUsdRoundTurn: ConditionField<number>;
  spreadModel: ConditionField<SpreadModel>;
  swapFree: ConditionField<boolean>;
  /** Leverage the broker granted this account (100 = 1:100), null = unknown. */
  leverage: number | null;
  /** Minimum stop distance the account applies globally (points), if known. */
  stopLevelPoints: number | null;
  updatedAt: number;
}

export interface CostQuote {
  value: number | null;
  source: CostSource;
  detail: string;
  at: number | null;
}

const UNKNOWN = (detail: string): CostQuote => ({ value: null, source: 'UNKNOWN', detail, at: null });

let policy: BrokerAccountCostPolicy | null = null;
let observations = new Map<string, BrokerCostObservation>();
let versionCounter = 0;

/** Bumped on every policy/observation change so caches can invalidate. */
export function brokerCostVersion(): number {
  return versionCounter;
}

/**
 * Install/refresh the account's cost policy and per-symbol observations.
 * This is called on every MT5 heartbeat, so it replaces (never merges) the
 * observation set — a symbol that disappears from the terminal must stop
 * being priced from a stale spec.
 */
export function setBrokerAccountCosts(
  next: BrokerAccountCostPolicy | null,
  specs: BrokerCostObservation[] = [],
  observedAt = Date.now(),
): void {
  policy = next ? { ...next, updatedAt: observedAt } : null;
  observations = new Map();
  for (const s of specs) {
    if (!s?.platformSymbol) continue;
    // Malformed geometry is dropped rather than priced: a bad contract size
    // or point would corrupt every cost and every lot size derived from it.
    if (!(s.contractSize > 0) || !(s.point > 0)) continue;
    observations.set(s.platformSymbol, { ...s, observedAt });
  }
  versionCounter += 1;
}

/** Test/teardown hook: forget the bound account entirely. */
export function clearBrokerAccountCosts(): void {
  policy = null;
  observations = new Map();
  versionCounter += 1;
}

/** The active cost policy, or null when no broker profile is bound. */
export function brokerAccountCosts(): BrokerAccountCostPolicy | null {
  return policy;
}

export function brokerCostObservation(symbol: string): BrokerCostObservation | null {
  return observations.get(symbol) ?? null;
}

export function brokerCostSymbols(): string[] {
  return [...observations.keys()];
}

function component(q: CostQuote): CostComponent {
  return { value: q.value, source: q.source, detail: q.detail, at: q.at };
}

/**
 * Spread cost for one lot in QUOTE currency.
 *
 * The live bid/ask of the tick the platform is trading on always wins: it is
 * the broker's current spread as the price stream sees it, which is what a
 * real platform charges. The terminal's `symbol_info.spread` is the fallback
 * (its own last known value), and an unknown symbol stays unknown.
 */
export function brokerSpreadPerLot(symbol: string, liveSpreadPrice: number | null): CostQuote {
  const obs = observations.get(symbol);
  if (liveSpreadPrice !== null && Number.isFinite(liveSpreadPrice) && liveSpreadPrice > 0 && obs) {
    const value = liveSpreadPrice * obs.contractSize;
    return {
      value,
      source: 'LIVE_FEED',
      detail: `live bid/ask on ${symbol} × contract ${obs.contractSize}`,
      at: obs.observedAt,
    };
  }
  if (!obs) return UNKNOWN(`no broker contract spec for ${symbol} yet`);
  if (!(obs.spreadPoints > 0)) return UNKNOWN(`${obs.brokerSymbol} reported no spread yet`);
  return {
    value: obs.spreadPoints * obs.point * obs.contractSize,
    source: 'MT5_SYMBOL_INFO',
    detail: `MT5 ${obs.brokerSymbol}.spread ${obs.spreadPoints} points × point ${obs.point} × contract ${obs.contractSize}`,
    at: obs.observedAt,
  };
}

/** Spread expressed in pips, for reviewability (not money). */
export function brokerSpreadPips(symbol: string, liveSpreadPrice: number | null, pipSize: number): CostQuote {
  if (!(pipSize > 0)) return UNKNOWN('pip geometry unknown');
  if (liveSpreadPrice !== null && Number.isFinite(liveSpreadPrice) && liveSpreadPrice > 0) {
    return {
      value: liveSpreadPrice / pipSize,
      source: 'LIVE_FEED',
      detail: `live ${symbol} bid/ask ÷ pip ${pipSize}`,
      at: Date.now(),
    };
  }
  const obs = observations.get(symbol);
  if (!obs) return UNKNOWN(`no broker contract spec for ${symbol} yet`);
  if (!(obs.spreadPoints > 0)) return UNKNOWN(`${obs.brokerSymbol} reported no spread yet`);
  return {
    value: (obs.spreadPoints * obs.point) / pipSize,
    source: 'MT5_SYMBOL_INFO',
    detail: `MT5 ${obs.brokerSymbol}.spread ${obs.spreadPoints} points ÷ pip ${pipSize}`,
    at: obs.observedAt,
  };
}

/**
 * Commission for one lot round turn, in USD, with the evidence behind it.
 * Null when no broker profile is bound (the caller then uses its own default).
 */
export function brokerCommissionUsdPerLot(): ConditionField<number> | null {
  if (!policy) return null;
  return policy.commissionPerLotUsdRoundTurn;
}

/** The account's spread model (spread-only vs spread+commission). */
export function brokerSpreadModel(): ConditionField<SpreadModel> | null {
  return policy?.spreadModel ?? null;
}

export interface EffectiveCommission {
  /** USD per lot round turn; null = the account terms do not say. */
  usdPerLotRoundTurn: number | null;
  source: string;
  detail: string;
  /** False when the caller fell back to its own platform default. */
  fromBrokerAccount: boolean;
}

/**
 * The commission the account type actually applies, in USD per lot round turn.
 *
 * Two distinct cases are kept apart on purpose:
 *   - the account publishes a per-lot commission (XM Zero) → that number;
 *   - the account is priced on its spread (XM Standard / Ultra Low) → 0, because
 *     the broker charges inside the spread rather than a separate line item.
 * Anything else is UNKNOWN and the caller must decide — never silently zero.
 *
 * Returns null when no broker account is bound at all, which tells the caller
 * to keep its own platform-default behaviour.
 */
/**
 * Commission for MONEY (paper ledger, fills). Returns null while the account's
 * own cost basis is not in force, telling the caller to keep its default.
 */
export function effectiveCommissionUsdPerLot(): EffectiveCommission | null {
  if (!policy || !policy.active) return null;
  return plannedCommissionUsdPerLot();
}

/**
 * Commission for PLANNING (signal expected value): what the SELECTED account
 * type implies right now, including a broker-published basis that the operator
 * has not acknowledged yet — the point of the selection is that signals and
 * predictions price the account the user chose, and the provenance recorded on
 * the signal says exactly which basis was used.
 */
export function plannedCommissionUsdPerLot(): EffectiveCommission | null {
  if (!policy) return null;
  const f = policy.commissionPerLotUsdRoundTurn;
  if (f.value !== null && f.value !== undefined) {
    return {
      usdPerLotRoundTurn: f.value,
      source: `${f.evidence.source} [${f.evidence.kind}]`,
      detail: f.evidence.note ?? '',
      fromBrokerAccount: true,
    };
  }
  const model = policy.spreadModel.value;
  if (model === 'VARIABLE' || model === 'FIXED') {
    return {
      usdPerLotRoundTurn: 0,
      source: `${policy.spreadModel.evidence.source} [spread-only ${model} account type]`,
      detail: policy.spreadModel.evidence.note ?? '',
      fromBrokerAccount: true,
    };
  }
  return {
    usdPerLotRoundTurn: null,
    source: `${f.evidence.source} [${f.evidence.kind}]`,
    detail: 'the broker does not publish a per-lot commission for this account type — confirm it before live money',
    fromBrokerAccount: true,
  };
}

/**
 * Overnight swap for one lot in QUOTE currency per night.
 * `direction` is the position side; a positive return value is a COST.
 */
export function brokerSwapQuotePerLotNight(symbol: string, direction: 'BUY' | 'SELL'): CostQuote {
  const obs = observations.get(symbol);
  if (!obs) return UNKNOWN(`no broker contract spec for ${symbol} yet`);
  if (obs.swapMode !== null && obs.swapMode !== 0) {
    return UNKNOWN(
      `${obs.brokerSymbol} charges swaps in mode ${obs.swapMode} (not points) — the platform will not reinterpret it`,
    );
  }
  const raw = direction === 'BUY' ? obs.swapLong : obs.swapShort;
  if (!Number.isFinite(raw) || raw === 0) return UNKNOWN(`${obs.brokerSymbol} reported no ${direction} swap`);
  // MT5 points mode: swap = points × point × contract size, in QUOTE currency.
  return {
    value: -raw * obs.point * obs.contractSize,
    source: 'MT5_SYMBOL_INFO',
    detail: `MT5 ${obs.brokerSymbol}.swap_${direction === 'BUY' ? 'long' : 'short'} ${raw} points × point ${obs.point} × contract ${obs.contractSize}`,
    at: obs.observedAt,
  };
}

/** Minimum stop distance the broker accepts for a symbol, in points. */
export function brokerStopLevelPoints(symbol: string): CostQuote {
  const obs = observations.get(symbol);
  if (obs) {
    return {
      value: obs.stopsLevelPoints,
      source: 'MT5_SYMBOL_INFO',
      detail: `MT5 ${obs.brokerSymbol}.trade_stops_level`,
      at: obs.observedAt,
    };
  }
  if (policy && policy.stopLevelPoints !== null) {
    return {
      value: policy.stopLevelPoints,
      source: 'ACCOUNT_TERMS',
      detail: 'account terms',
      at: policy.updatedAt,
    };
  }
  return UNKNOWN(`no broker stop level for ${symbol} yet`);
}

/** Contract size actually in use for a symbol (broker first, else unknown). */
export function brokerContractSize(symbol: string): CostQuote {
  const obs = observations.get(symbol);
  if (!obs) return UNKNOWN(`no broker contract spec for ${symbol} yet`);
  return {
    value: obs.contractSize,
    source: 'MT5_SYMBOL_INFO',
    detail: `MT5 ${obs.brokerSymbol}.trade_contract_size`,
    at: obs.observedAt,
  };
}

export interface CostViewOptions {
  accountCurrency: string;
  /** Live bid/ask of the tick being traded (price units), when available. */
  liveSpreadPrice: number | null;
  pipSize: number | null;
  /** QUOTE-currency amount → account currency, over live rates. */
  toAccountQuote: (quoteAmount: number) => { amount: number; source: string; at: number } | null;
  /** USD amount → account currency, over live rates. Optional. */
  toAccountUsd?: (usdAmount: number) => { amount: number; source: string; at: number } | null;
}

/**
 * Assemble the per-symbol cost view in ACCOUNT currency.
 *
 * Conversion is over LIVE rates: when a converter returns null the platform
 * has no rate, so the component degrades to unknown (with the reason) rather
 * than being reported in a currency the account does not settle in.
 */
export function symbolCostView(symbol: string, opts: CostViewOptions) {
  return buildView(symbol, opts);
}

/** True when a pair's quote leg is USD, so a USD amount is already "quote". */
function quoteIsUsd(symbol: string): boolean {
  const s = symbol.toUpperCase();
  return s.endsWith('/USD') || s === 'XAU/USD';
}

function convert(q: CostQuote, target: string, opts: CostViewOptions): CostQuote {
  if (q.value === null) return q;
  const conv = opts.toAccountQuote(q.value);
  if (!conv) {
    return {
      value: null,
      source: 'UNKNOWN',
      detail: `${q.detail} — no live conversion into ${target}`,
      at: q.at,
    };
  }
  return { value: conv.amount, source: q.source, detail: q.detail, at: conv.at || q.at };
}

function buildView(
  symbol: string,
  opts: CostViewOptions,
) {
  const obs = observations.get(symbol) ?? null;
  const ccy = opts.accountCurrency.toUpperCase();
  // The converter is an identity when the account already settles in the
  // pair's quote currency, so this is safe to call unconditionally.
  const spread = convert(brokerSpreadPerLot(symbol, opts.liveSpreadPrice), ccy, opts);
  const spreadPips = opts.pipSize
    ? brokerSpreadPips(symbol, opts.liveSpreadPrice, opts.pipSize)
    : UNKNOWN('pip geometry unknown');

  // Commission is published/confirmed in USD per lot; convert USD → account.
  const commissionField = policy?.commissionPerLotUsdRoundTurn ?? null;
  let commission: CostQuote;
  if (!commissionField || commissionField.value === null) {
    commission = commissionField
      ? {
          value: null,
          source: commissionField.evidence.kind === 'UNVERIFIED' ? 'UNKNOWN' : 'ACCOUNT_TERMS',
          detail: `${commissionField.evidence.source}: no per-lot commission published for this account`,
          at: commissionField.evidence.at,
        }
      : UNKNOWN('no broker account bound');
  } else if (ccy === 'USD') {
    commission = {
      value: commissionField.value,
      source: evidenceToCostSource(commissionField.evidence.kind),
      detail: `${commissionField.evidence.source} (USD/lot round turn)`,
      at: commissionField.evidence.at,
    };
  } else {
    // USD → account currency: the explicit USD converter when the caller has
    // one, otherwise reuse the quote converter only for USD-quoted pairs.
    const conv = opts.toAccountUsd
      ? opts.toAccountUsd(commissionField.value)
      : quoteIsUsd(symbol)
        ? opts.toAccountQuote(commissionField.value)
        : null;
    commission = conv
      ? {
          value: conv.amount,
          source: evidenceToCostSource(commissionField.evidence.kind),
          detail: `${commissionField.evidence.source} (USD/lot round turn, converted live)`,
          at: conv.at,
        }
      : {
          value: null,
          source: 'UNKNOWN',
          detail: `${commissionField.evidence.source} — no live USD→${ccy} conversion available`,
          at: commissionField.evidence.at,
        };
  }

  const swapLong = convert(brokerSwapQuotePerLotNight(symbol, 'BUY'), ccy, opts);
  const swapShort = convert(brokerSwapQuotePerLotNight(symbol, 'SELL'), ccy, opts);
  const stopLevel = brokerStopLevelPoints(symbol);
  const contract = brokerContractSize(symbol);

  const missing: string[] = [];
  if (spread.value === null) missing.push('spread');
  if (commission.value === null) missing.push('commission');
  if (contract.value === null) missing.push('contract spec');
  const roundTurn: CostQuote = spread.value === null || commission.value === null
    ? { value: null, source: 'UNKNOWN', detail: 'spread and/or commission unknown', at: null }
    : {
        value: spread.value + commission.value,
        source: spread.source,
        detail: `${spread.detail} + ${commission.detail}`,
        at: Math.max(spread.at ?? 0, commission.at ?? 0),
      };

  return {
    symbol,
    brokerSymbol: obs?.brokerSymbol ?? null,
    spreadPerLot: component(spread),
    commissionPerLot: component(commission),
    swapLongPerLotNight: component(swapLong),
    swapShortPerLotNight: component(swapShort),
    roundTurnPerLot: component(roundTurn),
    spreadPips: component(spreadPips),
    stopLevelPoints: component(stopLevel),
    contractSize: component(contract),
    complete: missing.length === 0 && contract.value !== null,
    missing,
  };
}

function evidenceToCostSource(kind: EvidenceKind): CostSource {
  switch (kind) {
    case 'MT5_ACCOUNT':
      return 'MT5_SYMBOL_INFO';
    case 'OPERATOR_CONFIRMED':
    case 'POLICY_SNAPSHOT':
      return 'ACCOUNT_TERMS';
    case 'PLATFORM_DEFAULT':
      return 'PLATFORM_DEFAULT';
    default:
      return 'UNKNOWN';
  }
}
