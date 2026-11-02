/**
 * Why a symbol's cost could not be completed — the detail of the first
 * component that has no value, so the dashboard explains the gap instead of
 * only naming it.
 */
function costGapReason(view: BrokerSymbolCostView): string {
  for (const c of [view.spreadPerLot, view.commissionPerLot, view.contractSize]) {
    if (c.value === null) return c.detail;
  }
  return 'unknown';
}

/**
 * AccountProfileService — which broker account is this platform bound to, what
 * are its real trading conditions, and may we dispatch orders to it?
 *
 * Layering (weakest → strongest), resolved per condition:
 *
 *   1. the catalog entry (known values are dropped; broker terms start unknown)
 *   2. what the bound MT5 account reports about itself — live, broker-issued
 *      (`account_info` / `symbol_info`), i.e. realtime "as per the broker"
 *   3. what the operator confirmed from the broker's own pages
 *
 * The resolved conditions then drive the platform: contract size / lot
 * geometry / stop level override the built-in specs (so a Micro-style account
 * sizes differently from a Standard one), commission and spread feed the cost
 * model, and the gate below decides whether an order may leave for MT5.
 *
 * Fail-closed rules that matter:
 *   - an UNKNOWN condition is never treated as 0, 1 or "fine";
 *   - REAL-money dispatch requires live-grade evidence for the sizing fields
 *     (`REQUIRED_FOR_LIVE`) plus an explicit operator opt-in;
 *   - a DEMO account may run on platform defaults, but every consumer is told
 *     which terms are unverified so nothing looks confirmed that isn't;
 *   - an account that has not reported recently, or whose trade mode is
 *     unknown/contest, cannot receive orders at all.
 */
import { EventEmitter } from 'events';
import {
  AccountProfileDefinition,
  BrokerGateView,
  BrokerId,
  BrokerReadinessItem,
  BrokerReadinessView,
  BrokerStatusView,
  BrokerSymbolCostView,
  BROKER_BRAND_LABELS,
  CONDITION_FIELDS,
  CompatibilityIssue,
  ConditionField,
  ConditionKey,
  EvidenceKind,
  JOURNAL_TERM_KEYS,
  Mt5AccountSnapshot,
  Mt5SymbolSpec,
  REQUIRED_FOR_LIVE,
  SPREAD_MODELS,
  SpreadModel,
  TermsProvenance,
  checkAccountCompatibility,
  describeConditionValue,
  defaultProfile,
  findProfile,
  isLiveGrade,
  isLiveGradeGiven,
  profileId,
} from '@fx/shared';
import { logger } from '../core/logger';
import { DataStore } from '../db/store';
import type { BrokerPolicySource } from './policy-source';
import {
  BrokerCostObservation,
  brokerCostSymbols,
  setBrokerAccountCosts,
  symbolCostView,
} from './cost-registry';

export interface BrokerInputSpec {
  symbol: string;
  platformSymbol: string;
  contractSize: number;
  volumeMin: number;
  volumeMax: number;
  volumeStep: number;
  stopsLevelPoints: number;
}

export interface AccountProfileDeps {
  /** Live quote→account conversion rate, straight from the market-data engine. */
  getFx: () => { pair: string; rate: number; source: string; at: number } | null;
  /** Platform's built-in spec for a symbol, used to detect broker divergence. */
  platformSpec: (symbol: string) => { contractSize: number; minLot: number; maxLot: number; lotStep: number; pipSize: number } | null;
  /** Adopt the bound account's leverage (account_info) for all margin math. */
  setAccountLeverage?: (leverage: number) => void;
  /** Push broker-reported specs into the sizing engine (live overrides). */
  applyBrokerSpecs: (specs: BrokerInputSpec[]) => void;
  /** Real-money execution opt-in (env-controlled, default off). */
  allowReal: () => boolean;
  /** Currency the wallet ledger is denominated in (user setting). */
  accountCurrency: () => string;
  /** Live bid/ask spread (price units) of the tick being traded, when fed. */
  liveSpread?: (symbol: string) => number | null;
  /** QUOTE-currency → account-currency conversion over live rates. */
  convertQuoteToAccount?: (symbol: string, amount: number) => { amount: number; source: string; at: number } | null;
  /** USD → account-currency conversion over live rates (commissions). */
  convertUsdToAccount?: (usd: number) => { amount: number; source: string; at: number } | null;
  maxAccountAgeMs?: number;
  /** Minimum gap between WebSocket pushes of the full status. */
  emitThrottleMs?: number;
}

interface StoredConfirmation {
  value: unknown;
  at: number;
  note?: string;
}

interface BrokerProfileDoc {
  docId: string;
  broker: BrokerId;
  accountType: string;
  confirmations: Partial<Record<ConditionKey, StoredConfirmation>>;
  updatedAt: number;
}

export interface SpecMismatch {
  symbol: string;
  field: string;
  platform: string;
  broker: string;
  severity: 'BLOCK' | 'WARN';
}

const DOC_ID = 'active';
const FX_MAX_AGE_MS = 300_000;

/** Broker-issued facts carry this provenance; everything else is human/platform. */
function mt5Field<T>(value: T, note?: string): ConditionField<T> {
  return { value, evidence: { kind: 'MT5_ACCOUNT', source: 'MT5 account_info', at: Date.now(), note } };
}

export class AccountProfileService {
  private doc: BrokerProfileDoc = {
    docId: DOC_ID,
    broker: 'XM',
    accountType: defaultProfile().accountType,
    confirmations: {},
    updatedAt: 0,
  };
  private account: Mt5AccountSnapshot | null = null;
  private accountAt: number | null = null;
  private mismatches: SpecMismatch[] = [];
  private lastEmit = 0;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private store: DataStore,
    private events: EventEmitter,
    private policy: BrokerPolicySource,
    private deps: AccountProfileDeps,
  ) {}

  /**
   * Load the persisted selection. `initial` (from env) seeds the FIRST run
   * only: once a selection is stored, the dashboard's choice wins — re-applying
   * env on every boot would wipe the operator's confirmed conditions.
   */
  async init(initial?: { broker: BrokerId; accountType: string }): Promise<void> {
    let loaded = false;
    try {
      const stored = await this.store.findOne<BrokerProfileDoc>('brokerProfile', { docId: DOC_ID });
      if (stored && findProfile(profileId(stored.broker, stored.accountType))) {
        this.doc = { ...this.doc, ...stored };
        loaded = true;
      }
    } catch {
      /* collection may not exist yet — catalog default applies */
    }
    if (!loaded && initial) {
      const profile = findProfile(profileId(initial.broker, initial.accountType));
      if (profile) {
        this.doc.broker = profile.broker;
        this.doc.accountType = profile.accountType;
        this.doc.updatedAt = Date.now();
        await this.persist();
      }
    }
    this.publishCosts();
    logger.info('broker profile loaded', {
      profile: this.profile().id,
      confirmed: Object.keys(this.doc.confirmations).length,
    });
  }

  // ---- selection --------------------------------------------------------

  selection(): { broker: BrokerId; accountType: string } {
    return { broker: this.doc.broker, accountType: this.doc.accountType };
  }

  async setAccountType(broker: BrokerId, accountType: string): Promise<BrokerStatusView> {
    const profile = findProfile(profileId(broker, accountType));
    if (!profile) throw new Error(`unknown broker account type ${broker}:${accountType}`);
    this.doc.broker = broker;
    this.doc.accountType = accountType;
    // Conditions are account-specific: switching account type invalidates every
    // confirmation, because the confirmed numbers belong to the old account.
    // The acknowledgement of the broker's published terms lapses with it: it
    // was an acknowledgement of the PREVIOUS account type's terms.
    this.doc.confirmations = {};
    this.doc.updatedAt = Date.now();
    await this.policy.unacknowledge().catch(() => undefined);
    await this.persist();
    this.applySpecsToEngines();
    // The selected account type IS the cost model: republish it immediately so
    // signals, sizing and the dashboard follow the switch without waiting for
    // the next heartbeat.
    this.publishCosts();
    logger.info('broker account type selected', { profile: profile.id, confirmationsCleared: true });
    this.events.emit('broker:profile-changed', { profileId: profile.id, reason: 'ACCOUNT_TYPE_CHANGED' });
    return await this.emitNow();
  }

  async confirmConditions(values: Partial<Record<ConditionKey, unknown>>, note?: string): Promise<BrokerStatusView> {
    const clean = this.validateConfirmations(values);
    const at = Date.now();
    for (const [key, value] of Object.entries(clean) as Array<[ConditionKey, unknown]>) {
      this.doc.confirmations[key] = { value, at, note };
    }
    this.doc.updatedAt = at;
    await this.persist();
    this.publishCosts();
    // Confirming conditions after reading the broker's document is exactly the
    // acknowledgement the policy watcher waits for.
    await this.policy.acknowledge().catch(() => undefined);
    logger.info('broker conditions confirmed', { keys: Object.keys(clean) });
    this.events.emit('broker:profile-changed', { profileId: this.profile().id, reason: 'CONDITIONS_CONFIRMED' });
    return await this.emitNow();
  }

  async clearConfirmations(): Promise<BrokerStatusView> {
    this.doc.confirmations = {};
    this.doc.updatedAt = Date.now();
    await this.persist();
    this.publishCosts();
    this.events.emit('broker:profile-changed', { profileId: this.profile().id, reason: 'CONFIRMATIONS_CLEARED' });
    return await this.emitNow();
  }

  private validateConfirmations(values: Partial<Record<ConditionKey, unknown>>): Partial<Record<ConditionKey, unknown>> {
    const out: Partial<Record<ConditionKey, unknown>> = {};
    for (const [rawKey, rawValue] of Object.entries(values ?? {})) {
      const meta = CONDITION_FIELDS.find((f) => f.key === rawKey);
      if (!meta) throw new Error(`unknown condition '${rawKey}'`);
      const key = meta.key;
      // null/'' clears a confirmation back to unknown.
      if (rawValue === null || rawValue === '' || (Array.isArray(rawValue) && rawValue.length === 0)) continue;
      switch (meta.kind) {
        case 'number': {
          const n = Number(rawValue);
          if (!Number.isFinite(n) || n < 0) throw new Error(`${meta.label} must be a number ≥ 0`);
          if (['contractSize', 'minLot', 'lotStep'].includes(key) && n <= 0) throw new Error(`${meta.label} must be greater than 0`);
          out[key] = n;
          break;
        }
        case 'numberList': {
          const list = (Array.isArray(rawValue) ? rawValue : String(rawValue).split(','))
            .map((v) => Number(String(v).trim()))
            .filter((v) => Number.isFinite(v) && v > 0);
          if (!list.length) throw new Error(`${meta.label} needs at least one positive number`);
          out[key] = list;
          break;
        }
        case 'stringList': {
          const list = (Array.isArray(rawValue) ? rawValue : String(rawValue).split(','))
            .map((v) => String(v).trim().toUpperCase())
            .filter(Boolean);
          if (!list.length) throw new Error(`${meta.label} needs at least one value`);
          out[key] = list;
          break;
        }
        case 'boolean': {
          if (typeof rawValue !== 'boolean') throw new Error(`${meta.label} must be true or false`);
          out[key] = rawValue;
          break;
        }
        case 'enum': {
          const v = String(rawValue).toUpperCase() as SpreadModel;
          if (!SPREAD_MODELS.includes(v)) throw new Error(`${meta.label} must be one of ${SPREAD_MODELS.join(', ')}`);
          out[key] = v;
          break;
        }
      }
    }
    const minLot = (out.minLot ?? this.doc.confirmations.minLot?.value) as number | undefined;
    const maxLot = (out.maxLot ?? this.doc.confirmations.maxLot?.value) as number | undefined;
    if (typeof minLot === 'number' && typeof maxLot === 'number' && maxLot < minLot) {
      throw new Error('Maximum lot must be ≥ minimum lot');
    }
    return out;
  }

  private async persist(): Promise<void> {
    try {
      await this.store.updateOne('brokerProfile', { docId: DOC_ID }, { $set: { ...this.doc } } as never, true);
    } catch (err) {
      logger.warn('broker profile persist failed', { err: String(err) });
    }
  }

  // ---- bound MT5 account ------------------------------------------------

  /** Called on every trader heartbeat. This is the realtime broker feed. */
  async noteMt5Account(account: Mt5AccountSnapshot | null): Promise<void> {
    const previousMode = this.account?.tradeMode ?? null;
    const previousLogin = this.account?.login ?? null;
    this.account = account;
    this.accountAt = account ? Date.now() : null;
    if (!account) this.deps.setAccountLeverage?.(0); // unbound → catalog fallback returns
    if (account) {
      this.computeMismatches(account.symbolSpecs ?? []);
      this.applySpecsToEngines();
      // The account's own leverage is the margin law for every sizing/margin
      // path (XM/MT5 pattern): account_info.leverage, straight from the feed.
      if (account.leverage && account.leverage > 0) this.deps.setAccountLeverage?.(account.leverage);
      this.publishCosts();
      if (previousLogin !== account.login || previousMode !== account.tradeMode) {
        logger.info('MT5 account bound', {
          login: account.login,
          server: account.server,
          company: account.company ?? null,
          currency: account.currency,
          leverage: account.leverage ?? null,
          tradeMode: account.tradeMode,
        });
      }
    }
    this.emit();
  }

  private computeMismatches(specs: Mt5SymbolSpec[]): void {
    const out: SpecMismatch[] = [];
    for (const s of specs) {
      const built = this.deps.platformSpec(s.platformSymbol);
      if (!built) continue;
      if (Math.abs(built.contractSize - s.contractSize) > 1e-9) {
        out.push({
          symbol: s.platformSymbol,
          field: 'contract size',
          platform: String(built.contractSize),
          broker: String(s.contractSize),
          severity: 'BLOCK',
        });
      }
      if (Math.abs(built.minLot - s.volumeMin) > 1e-9) {
        out.push({ symbol: s.platformSymbol, field: 'minimum lot', platform: String(built.minLot), broker: String(s.volumeMin), severity: 'WARN' });
      }
      if (Math.abs(built.lotStep - s.volumeStep) > 1e-9) {
        out.push({ symbol: s.platformSymbol, field: 'lot step', platform: String(built.lotStep), broker: String(s.volumeStep), severity: 'WARN' });
      }
      if (Math.abs(built.maxLot - s.volumeMax) > 1e-9) {
        out.push({ symbol: s.platformSymbol, field: 'maximum lot', platform: String(built.maxLot), broker: String(s.volumeMax), severity: 'WARN' });
      }
    }
    this.mismatches = out.slice(0, 40);
    if (out.some((m) => m.severity === 'BLOCK')) {
      logger.warn('broker contract specs diverge from platform defaults — sizing now follows the broker', {
        count: out.length,
        sample: out.slice(0, 5),
      });
    }
  }

  /** Give the sizing engine the broker's own lot geometry. */
  private applySpecsToEngines(): void {
    const specs = this.account?.symbolSpecs ?? [];
    if (!specs.length) return;
    this.deps.applyBrokerSpecs(
      specs.map((s) => ({
        symbol: s.platformSymbol,
        platformSymbol: s.platformSymbol,
        contractSize: s.contractSize,
        volumeMin: s.volumeMin,
        volumeMax: s.volumeMax,
        volumeStep: s.volumeStep,
        stopsLevelPoints: s.stopsLevelPoints,
      })),
    );
  }

  /**
   * Publish the account's cost model for the engines (signals, sizing, paper
   * fills, dispatch). Called on selection, confirmation and every heartbeat, so
   * changing account type on the dashboard changes what a trade COSTS on the
   * next tick — not at the next restart.
   */
  private publishCosts(): void {
    const profile = this.profile();
    const c = profile.conditions;
    const specs: BrokerCostObservation[] = (this.account?.symbolSpecs ?? []).map((s) => ({
      platformSymbol: s.platformSymbol,
      brokerSymbol: s.symbol,
      contractSize: s.contractSize,
      volumeMin: s.volumeMin,
      volumeMax: s.volumeMax,
      volumeStep: s.volumeStep,
      stopsLevelPoints: s.stopsLevelPoints,
      spreadPoints: s.spreadPoints,
      point: s.point,
      digits: s.digits,
      swapLong: s.swapLong,
      swapShort: s.swapShort,
      swapMode: s.swapMode ?? null,
      observedAt: this.accountAt ?? Date.now(),
    }));
    setBrokerAccountCosts(
      {
        active: this.costBasisActive(),
        profileId: profile.id,
        broker: profile.broker,
        accountType: profile.accountType,
        label: profile.label,
        accountCurrency: this.accountCurrency(),
        commissionPerLotUsdRoundTurn: c.commissionPerLotUsdRoundTurn as ConditionField<number>,
        spreadModel: c.spreadModel as ConditionField<SpreadModel>,
        swapFree: c.swapFree as ConditionField<boolean>,
        leverage: this.account?.leverage ?? null,
        stopLevelPoints: (c.stopLevelPoints.value as number | null) ?? null,
        updatedAt: Date.now(),
      },
      specs,
      Date.now(),
    );
  }

  /** Currency money is priced in: the bound account's, else the wallet's. */
  private accountCurrency(): string {
    return (this.account?.currency ?? this.deps.accountCurrency()).toUpperCase();
  }

  /** Public mirror of the currency above, for API consumers. */
  displayCurrency(): string {
    return this.accountCurrency();
  }

  /**
   * True when the account's OWN cost figures may be used for money: an MT5
   * account is bound and fresh, or the operator acknowledged the broker's
   * published terms for this account type. Until then the wallet keeps the
   * platform defaults, labelled as such.
   */
  costBasisActive(): boolean {
    const bound = this.account !== null
      && this.accountAgeMs() !== null
      && (this.accountAgeMs() as number) <= (this.deps.maxAccountAgeMs ?? 45_000);
    return bound || this.publishedAcknowledged();
  }

  /** Live conversion helpers — null means "no rate", never an invented one. */
  private convertQuote(symbol: string, amount: number): { amount: number; source: string; at: number } | null {
    const ccy = this.accountCurrency();
    const quote = symbol.toUpperCase().split('/')[1] ?? '';
    if (quote === ccy) return { amount, source: 'identity (same currency)', at: Date.now() };
    return this.deps.convertQuoteToAccount?.(symbol, amount) ?? null;
  }

  private convertUsd(usd: number): { amount: number; source: string; at: number } | null {
    const ccy = this.accountCurrency();
    if (ccy === 'USD') return { amount: usd, source: 'identity (USD account)', at: Date.now() };
    return this.deps.convertUsdToAccount?.(usd) ?? null;
  }

  /** Per-symbol account costs, priced on the bound account's live data. */
  costFor(symbol: string): BrokerSymbolCostView {
    const spec = this.deps.platformSpec(symbol);
    return symbolCostView(symbol, {
      accountCurrency: this.accountCurrency(),
      liveSpreadPrice: this.deps.liveSpread?.(symbol) ?? null,
      pipSize: spec?.pipSize ?? null,
      toAccountQuote: (amount) => this.convertQuote(symbol, amount),
      toAccountUsd: (usd) => this.convertUsd(usd),
    });
  }

  /**
   * Costs for a symbol set. Defaults to every symbol the bound terminal priced,
   * so the dashboard shows exactly the instruments this account can trade.
   */
  costsFor(symbols?: string[]): BrokerSymbolCostView[] {
    const list = symbols && symbols.length
      ? symbols
      : (this.account?.symbolSpecs ?? []).map((s) => s.platformSymbol).filter(Boolean);
    const unique = [...new Set(list.length ? list : brokerCostSymbols())];
    return unique.map((s) => this.costFor(s));
  }

  accountAgeMs(): number | null {
    return this.accountAt === null ? null : Date.now() - this.accountAt;
  }

  // ---- resolved profile -------------------------------------------------

  /** Catalog + MT5-derived + operator-confirmed, resolved per condition. */
  profile(): AccountProfileDefinition {
    const base = findProfile(profileId(this.doc.broker, this.doc.accountType)) ?? defaultProfile();
    const derived = this.mt5Derived();
    const conditions = { ...base.conditions } as Record<ConditionKey, ConditionField<unknown>>;
    for (const meta of CONDITION_FIELDS) {
      const confirmed = this.doc.confirmations[meta.key];
      if (confirmed && confirmed.value !== null && confirmed.value !== undefined) {
        conditions[meta.key] = {
          value: confirmed.value,
          evidence: { kind: 'OPERATOR_CONFIRMED', source: 'operator confirmation', at: confirmed.at, note: confirmed.note },
        };
        continue;
      }
      const fromBroker = derived[meta.key];
      if (fromBroker && fromBroker.value !== null && fromBroker.value !== undefined) {
        conditions[meta.key] = fromBroker;
      }
    }
    return { ...base, conditions };
  }

  /** Facts the bound MT5 account reports about itself (live, broker-issued). */
  private mt5Derived(): Partial<Record<ConditionKey, ConditionField<unknown>>> {
    const a = this.account;
    if (!a) return {};
    const out: Partial<Record<ConditionKey, ConditionField<unknown>>> = {};
    if (a.currency) out.baseCurrencies = mt5Field([a.currency.toUpperCase()], 'base currency of the bound account');
    if (a.leverage && a.leverage > 0) out.leverageOptions = mt5Field([a.leverage], 'leverage granted to the bound account');
    if (typeof a.marginCallLevelPct === 'number' && a.marginCallLevelPct > 0) out.marginCallLevelPct = mt5Field(a.marginCallLevelPct);
    if (typeof a.stopOutLevelPct === 'number' && a.stopOutLevelPct > 0) out.stopOutLevelPct = mt5Field(a.stopOutLevelPct);

    const specs = a.symbolSpecs ?? [];
    if (specs.length) {
      const modal = (pick: (s: Mt5SymbolSpec) => number): number | null => {
        const counts = new Map<number, number>();
        for (const s of specs) {
          const v = pick(s);
          if (!Number.isFinite(v) || v <= 0) continue;
          counts.set(v, (counts.get(v) ?? 0) + 1);
        }
        let best: number | null = null;
        let bestN = 0;
        for (const [v, n] of counts) if (n > bestN) { best = v; bestN = n; }
        return best;
      };
      const cs = modal((s) => s.contractSize);
      if (cs !== null) out.contractSize = mt5Field(cs, `most common contract size across ${specs.length} broker symbols`);
      const min = modal((s) => s.volumeMin);
      if (min !== null) out.minLot = mt5Field(min, 'typical minimum volume reported by the broker');
      const step = modal((s) => s.volumeStep);
      if (step !== null) out.lotStep = mt5Field(step, 'typical volume step reported by the broker');
      const max = modal((s) => s.volumeMax);
      if (max !== null) out.maxLot = mt5Field(max, 'typical maximum volume reported by the broker');
      const stops = modal((s) => s.stopsLevelPoints);
      if (stops !== null) out.stopLevelPoints = mt5Field(stops, 'typical minimum stop distance (points)');

      // Live spread: convert each symbol's point spread into pips using the
      // platform's own pip geometry for that symbol.
      const pips: number[] = [];
      for (const s of specs) {
        const built = this.deps.platformSpec(s.platformSymbol);
        if (!built || !built.pipSize || !s.point || !s.spreadPoints) continue;
        const pipsValue = (s.spreadPoints * s.point) / built.pipSize;
        if (Number.isFinite(pipsValue) && pipsValue > 0) pips.push(pipsValue);
      }
      if (pips.length) {
        pips.sort((x, y) => x - y);
        const median = pips[Math.floor(pips.length / 2)];
        out.typicalSpreadPips = mt5Field(Number(median.toFixed(2)), `median live spread over ${pips.length} broker symbols`);
      }
    }
    return out;
  }

  /**
   * True once the operator has acknowledged the broker's published terms for
   * the selected account type — and false again the moment the broker's page
   * changes (the acknowledgement is of content, not of a checkbox).
   */
  publishedAcknowledged(): boolean {
    const snap = this.policy.snapshot();
    return snap.acknowledgedAt !== null && !snap.reviewRequired;
  }

  /** Operator states: "I have read the terms the broker publishes for this account type". */
  async acknowledgePublishedTerms(): Promise<BrokerStatusView> {
    await this.policy.acknowledge();
    logger.info('broker published terms acknowledged', { profile: this.profile().id });
    this.events.emit('broker:profile-changed', { profileId: this.profile().id, reason: 'PUBLISHED_TERMS_ACKNOWLEDGED' });
    return await this.emitNow();
  }

  missingLiveConditions(): string[] {
    const conditions = this.profile().conditions;
    const ctx = { publishedAcknowledged: this.publishedAcknowledged() };
    return REQUIRED_FOR_LIVE
      .filter((k) => !isLiveGradeGiven(conditions[k], ctx))
      .map((k) => CONDITION_FIELDS.find((f) => f.key === k)?.label ?? String(k));
  }

  /** Conditions that would be satisfied by acknowledging the broker's published terms. */
  private pendingPublishedTerms(): string[] {
    if (this.publishedAcknowledged()) return [];
    const conditions = this.profile().conditions;
    return REQUIRED_FOR_LIVE
      .filter((k) => conditions[k].evidence.kind === 'POLICY_SNAPSHOT' && !isLiveGrade(conditions[k]))
      .map((k) => CONDITION_FIELDS.find((f) => f.key === k)?.label ?? String(k));
  }

  // ---- gates ------------------------------------------------------------

  private issues(): CompatibilityIssue[] {
    return checkAccountCompatibility(this.profile(), this.account, {
      allowReal: this.deps.allowReal(),
      ageMs: this.accountAgeMs(),
      maxAgeMs: this.deps.maxAccountAgeMs ?? 45_000,
      missingLiveConditions: this.missingLiveConditions(),
    });
  }

  /** May an order be dispatched to the bound MT5 account right now? */
  liveGate(): BrokerGateView {
    const issues = this.issues();
    const blocks = issues.filter((i) => i.severity === 'BLOCK').map((i) => i.message);
    const warns = issues.filter((i) => i.severity === 'WARN').map((i) => i.message);
    // A contract-size disagreement means the platform's own lot math is wrong
    // for this account: never dispatch until the broker's number is in use.
    const specBlocks = this.mismatches.filter((m) => m.severity === 'BLOCK');
    if (specBlocks.length && !this.account?.symbolSpecs?.length) {
      blocks.push('Broker contract specs are unknown for this account — sizing would use platform defaults.');
    }
    return { allowed: blocks.length === 0, reasons: blocks, warnings: warns };
  }

  /**
   * Live-money readiness — the consolidated checklist behind "may real money
   * move through this account right now?". Every item is independently
   * checkable, so the operator sees WHICH fact is missing rather than a single
   * boolean they cannot act on.
   */
  readiness(symbol?: string): BrokerReadinessView {
    const profile = this.profile();
    const account = this.account;
    const ageMs = this.accountAgeMs();
    const maxAge = this.deps.maxAccountAgeMs ?? 45_000;
    const missing = this.missingLiveConditions();
    const items: BrokerReadinessItem[] = [];
    const add = (key: string, label: string, ok: boolean, severity: 'BLOCK' | 'WARN', detail: string) =>
      items.push({ key, label, ok, severity, detail });

    add(
      'broker_profile',
      'Broker account type selected',
      profile.broker !== 'GENERIC',
      'BLOCK',
      profile.broker === 'GENERIC'
        ? 'No broker profile is selected: the platform would trade its own built-in assumptions. Pick your XM account type.'
        : `${profile.label} (${profile.id})`,
    );
    add(
      'worker_online',
      'MT5 terminal reporting',
      account !== null && ageMs !== null && ageMs <= maxAge,
      'BLOCK',
      account === null
        ? 'No MT5 account has ever reported in this process.'
        : `last heartbeat ${ageMs === null ? 'never' : `${Math.round((ageMs ?? 0) / 1000)}s ago`} (limit ${Math.round(maxAge / 1000)}s), account ${account.login} on ${account.server || 'unknown server'}`,
    );
    add(
      'trade_mode',
      'Trade mode known (DEMO/REAL)',
      account !== null && account.tradeMode !== 'UNKNOWN' && account.tradeMode !== 'CONTEST',
      'BLOCK',
      account === null
        ? 'unknown — no account reporting'
        : `the terminal reports ${account.tradeMode}${account.tradeMode === 'CONTEST' ? ' (contest accounts are not tradeable here)' : ''}`,
    );
    add(
      'specs_reported',
      'Broker contract specs received',
      (account?.symbolSpecs?.length ?? 0) > 0,
      'BLOCK',
      `${account?.symbolSpecs?.length ?? 0} symbol spec(s) from symbol_info — lot geometry, spread, swaps and stop levels come from these`,
    );
    add(
      'terms_complete',
      'Sizing terms live-grade',
      missing.length === 0,
      'BLOCK',
      missing.length === 0
        ? 'every sizing term is broker-reported, published-and-acknowledged, or confirmed by you'
        : `missing: ${missing.join(', ')}`,
    );
    const pendingPublished = this.pendingPublishedTerms();
    add(
      'published_terms',
      'Broker-published terms acknowledged',
      pendingPublished.length === 0,
      'BLOCK',
      pendingPublished.length === 0
        ? 'the values taken from the broker\'s own pages have been acknowledged for this account type'
        : `${pendingPublished.join(', ')} currently rest on the broker's published terms — read them on the broker's page and acknowledge them`,
    );
    add(
      'spec_agreement',
      'Broker specs agree with the selected account type',
      !this.mismatches.some((m) => m.severity === 'BLOCK'),
      'BLOCK',
      this.mismatches.some((m) => m.severity === 'BLOCK')
        ? `contract size differs from the platform assumption for: ${[...new Set(this.mismatches.filter((m) => m.severity === 'BLOCK').map((m) => m.symbol))].slice(0, 6).join(', ')} (the broker\'s value is the one in use)`
        : 'no blocking divergence',
    );
    if (account?.tradeMode === 'REAL') {
      add(
        'real_optin',
        'Live-money execution enabled on the backend',
        this.deps.allowReal(),
        'BLOCK',
        this.deps.allowReal()
          ? 'ALLOW_REAL_TRADING is set — live orders may leave this platform'
          : 'ALLOW_REAL_TRADING is not set: a real account can be bound and monitored, but no order will leave. The MT5 host also needs MT5_ALLOW_REAL=1.',
      );
    }
    const policySnap = this.policy.snapshot();
    const policyReadable = policySnap.fetchedAt !== null && policySnap.status !== 'STALE';
    add(
      'policy_current',
      'Broker page being watched',
      !policySnap.reviewRequired && policyReadable,
      'WARN',
      policySnap.reviewRequired
        ? 'the broker\'s published terms changed since they were acknowledged — re-read them and acknowledge again'
        : policyReadable
          ? `the published terms match what was last acknowledged (checked ${Math.round((Date.now() - (policySnap.fetchedAt ?? 0)) / 1000)}s ago)`
          : `the broker\'s page could not be read (${policySnap.status}${policySnap.lastError ? `: ${policySnap.lastError}` : ''}) — the terms in use are the ones you acknowledged, re-checked as soon as the page is reachable`,
    );
    const brokerHints = profile.brokerHints;
    const identity = `${account?.company ?? ''} ${account?.server ?? ''}`.toUpperCase();
    const identityOk = !brokerHints.length || !account || brokerHints.some((h) => identity.includes(h));
    add(
      'broker_identity',
      'Terminal identifies as the selected broker',
      identityOk,
      'WARN',
      account
        ? `terminal reports company "${account.company || 'unknown'}" on "${account.server || 'unknown'}"`
        : 'no account reporting',
    );

    const targets = symbol ? [symbol] : (account?.symbolSpecs ?? []).map((s) => s.platformSymbol);
    if (targets.length) {
      const views = this.costsFor(targets);
      const incomplete = views.filter((v) => !v.complete);
      add(
        'symbol_costs',
        symbol ? `Costs known for ${symbol}` : 'Costs known for every priced symbol',
        incomplete.length === 0,
        'BLOCK',
        incomplete.length === 0
          ? `${views.length} symbol(s) priced from the bound account's own data`
          : `incomplete for ${incomplete.map((v) => `${v.symbol} (${v.missing.join('/')}: ${costGapReason(v)})`).slice(0, 4).join('; ')}`,
      );
    }
    // Cross-currency money must have a live rate, not a stored one.
    const ccy = this.accountCurrency();
    const needsFx = symbol ? (symbol.toUpperCase().split('/')[1] ?? '') !== ccy : ccy !== 'USD';
    if (needsFx) {
      const fx = this.deps.getFx();
      const fresh = fx !== null && Date.now() - fx.at <= FX_MAX_AGE_MS;
      add(
        'fx_live',
        `Live ${ccy} conversion`,
        fresh,
        'BLOCK',
        fx === null
          ? `no live rate into ${ccy} yet — cross-currency money would have no honest value`
          : `${fx.pair} ${fx.rate} from ${fx.source}, ${Math.round((Date.now() - fx.at) / 1000)}s old`,
      );
    }

    const blocking = items.filter((i) => !i.ok && i.severity === 'BLOCK').map((i) => i.detail);
    return { ready: blocking.length === 0, checkedAt: Date.now(), symbol: symbol ?? null, items, blocking };
  }

  /**
   * Live dispatch gate FOR A SYMBOL: the account-wide gate plus the per-symbol
   * costs that order would be priced on. An unpriced symbol is held, not traded
   * on an assumption.
   */
  liveGateFor(symbol?: string): BrokerGateView {
    const base = this.liveGate();
    const view = this.readiness(symbol);
    return {
      allowed: base.allowed && view.ready,
      reasons: [...base.reasons, ...view.blocking.filter((b) => !base.reasons.includes(b))],
      warnings: [...base.warnings, ...view.items.filter((i) => !i.ok && i.severity === 'WARN').map((i) => i.detail)],
    };
  }

  /**
   * Freeze the trading terms a decision was made under.
   *
   * Written onto positions and trades so the journal shows the account type,
   * every number that sized the trade, where each number came from, the costs
   * used and whether live execution was open at that moment — none of which can
   * be re-derived later from settings that may since have changed.
   */
  termsProvenance(symbol?: string): TermsProvenance {
    const profile = this.profile();
    const conditions = profile.conditions;
    const fx = this.deps.getFx();
    return {
      profileId: profile.id,
      broker: profile.broker,
      accountType: profile.accountType,
      label: profile.label,
      fields: JOURNAL_TERM_KEYS.map((key) => {
        const f = conditions[key];
        return {
          key,
          label: CONDITION_FIELDS.find((m) => m.key === key)?.label ?? String(key),
          value: describeConditionValue(f.value),
          evidence: f.evidence.kind as EvidenceKind,
          source: f.evidence.source,
          at: f.evidence.at,
        };
      }),
      costs: symbol ? this.costFor(symbol) : null,
      fx: fx ? { pair: fx.pair, rate: fx.rate, source: fx.source, at: fx.at } : null,
      binding: {
        login: this.account?.login ?? null,
        server: this.account?.server ?? null,
        currency: this.account?.currency ?? null,
        tradeMode: this.account?.tradeMode ?? null,
        ageMs: this.accountAgeMs(),
      },
      liveGate: this.liveGateFor(symbol),
      liveReady: this.readiness(symbol).ready,
      at: Date.now(),
    };
  }

  /** Simulated entries: never blocked by unverified broker terms, always labelled. */
  paperGate(): BrokerGateView {
    const issues = this.issues().filter((i) => i.code !== 'REAL_NOT_ALLOWED');
    const warnings = issues.map((i) => `${i.code}: ${i.message}`);
    if (this.account?.tradeMode === 'REAL') {
      warnings.unshift('A REAL-money account is bound: simulated results are being mirrored nowhere, but the platform is configured for live-capable execution.');
    }
    return { allowed: true, reasons: [], warnings };
  }

  // ---- status / realtime ------------------------------------------------

  conditionsTable(): BrokerStatusView['conditions'] {
    const conditions = this.profile().conditions;
    const ctx = { publishedAcknowledged: this.publishedAcknowledged() };
    return CONDITION_FIELDS.map((meta) => {
      const f = conditions[meta.key];
      return {
        key: meta.key,
        label: meta.label,
        unit: meta.unit,
        display: describeConditionValue(f.value),
        raw: f.value,
        evidence: f.evidence.kind as EvidenceKind,
        source: f.evidence.source,
        at: f.evidence.at,
        liveGrade: isLiveGradeGiven(f, ctx),
        requiredForLive: REQUIRED_FOR_LIVE.includes(meta.key),
      };
    });
  }

  async status(): Promise<BrokerStatusView> {
    const profile = this.profile();
    const policy = this.policy.snapshot();
    const ageMs = this.accountAgeMs();
    const fx = this.deps.getFx();
    const fxAge = fx ? Date.now() - fx.at : null;
    return {
      broker: profile.broker,
      brokerLabel: BROKER_BRAND_LABELS[profile.broker],
      accountType: profile.accountType,
      profileId: profile.id,
      label: profile.label,
      marketUrl: profile.marketUrl,
      note: profile.note,
      conditions: this.conditionsTable(),
      missingLiveConditions: this.missingLiveConditions(),
      confirmedAt: Object.values(this.doc.confirmations).reduce<number | null>(
        (max, c) => (max === null ? c.at : Math.max(max, c.at)),
        null,
      ),
      publishedAcknowledged: this.publishedAcknowledged(),
      publishedAcknowledgedAt: this.policy.snapshot().acknowledgedAt,
      binding: {
        bound: ageMs !== null && ageMs <= (this.deps.maxAccountAgeMs ?? 45_000) && this.account?.tradeMode !== 'UNKNOWN',
        account: this.account,
        ageMs,
        issues: this.issues(),
        specsReported: this.account?.symbolSpecs?.length ?? 0,
      },
      specMismatches: this.mismatches,
      policy,
      costs: this.costsFor(),
      readiness: this.readiness(),
      costBasisActive: this.costBasisActive(),
      published: profile.published,
      fx: fx
        ? { pair: fx.pair, rate: fx.rate, source: fx.source, at: fx.at, ageMs: fxAge ?? 0, stale: (fxAge ?? 0) > FX_MAX_AGE_MS }
        : null,
      accountCurrency: this.deps.accountCurrency(),
      displayCurrency: this.accountCurrency(),
      realExecutionEnabled: this.deps.allowReal(),
      liveGate: this.liveGate(),
      paperGate: this.paperGate(),
      updatedAt: Date.now(),
    };
  }

  private emit(): void {
    const throttle = this.deps.emitThrottleMs ?? 4_000;
    const since = Date.now() - this.lastEmit;
    if (since >= throttle) {
      void this.emitNow().catch(() => undefined);
      return;
    }
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      void this.emitNow().catch(() => undefined);
    }, throttle - since);
  }

  private async emitNow(): Promise<BrokerStatusView> {
    this.lastEmit = Date.now();
    const snap = await this.status();
    this.events.emit('broker:profile', snap);
    return snap;
  }
}
