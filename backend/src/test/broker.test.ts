/**
 * Broker account binding (XM account types).
 *
 * The invariants under test are the ones that protect real money once an XM
 * account is bound to MetaTrader:
 *   - unknown terms are never treated as known;
 *   - orders cannot be dispatched while the account is unbound, stale, in an
 *     unknown/contest mode, or with conditions that were never confirmed;
 *   - a REAL account cannot be traded unless it is explicitly permitted;
 *   - the bound account's OWN contract specs drive lot sizing, so an Ultra Low
 *     Standard / Micro style contract sizes differently from a platform default;
 *   - the policy watcher notices a changed broker document but never rewrites
 *     the platform's trading conditions by itself.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import {
  Mt5AccountSnapshot,
  checkAccountCompatibility,
  defaultProfile,
  findProfile,
  profileId,
} from '@fx/shared';
import { AccountProfileService } from '../broker/account-profile-service';
import { BrokerPolicySource, hashPolicyText, normalizePolicyText } from '../broker/policy-source';
import { clearBrokerSpecOverrides, forexBasedSpec, setBrokerSpecOverrides } from '../forex/symbol-spec';
import { specFor } from '../forex/pip-margin';
import { getAsset } from '@fx/shared';
import type { DataStore } from '../db/store';

/** Minimal single-document store: exactly what these services use. */
function makeStore(): { store: DataStore; docs: Map<string, Record<string, unknown>> } {
  const docs = new Map<string, Record<string, unknown>>();
  const key = (collection: string, query: Record<string, unknown>) => `${collection}|${JSON.stringify(query)}`;
  const store = {
    findOne: async (collection: string, query: Record<string, unknown>) => docs.get(key(collection, query)) ?? null,
    find: async (collection: string, query: Record<string, unknown>) => {
      const out: Record<string, unknown>[] = [];
      for (const [k, v] of docs) if (k.startsWith(`${collection}|`) && (Object.keys(query).length === 0 || k === key(collection, query))) out.push(v);
      return out;
    },
    updateOne: async (collection: string, query: Record<string, unknown>, update: { $set?: Record<string, unknown> }) => {
      docs.set(key(collection, query), { ...(update.$set ?? {}) });
      return { modified: 1 };
    },
    insertOne: async (collection: string, doc: Record<string, unknown>) => {
      docs.set(key(collection, { docId: doc.docId ?? doc.id ?? String(docs.size) }), doc);
      return doc;
    },
  } as unknown as DataStore;
  return { store, docs };
}

const DEMO_ACCOUNT: Mt5AccountSnapshot = {
  login: 12345678,
  server: 'XMGlobal-Demo',
  company: 'XM Global Limited',
  currency: 'USD',
  balance: 10_000,
  equity: 10_050,
  leverage: 500,
  tradeMode: 'DEMO',
  marginCallLevelPct: 50,
  stopOutLevelPct: 20,
  symbolSpecs: [
    {
      symbol: 'EURUSD', platformSymbol: 'EUR/USD', contractSize: 100_000,
      volumeMin: 0.01, volumeMax: 50, volumeStep: 0.01, digits: 5, point: 0.00001,
      stopsLevelPoints: 0, spreadPoints: 6, swapLong: -5.2, swapShort: 1.1,
    },
    {
      symbol: 'GBPUSD', platformSymbol: 'GBP/USD', contractSize: 100_000,
      volumeMin: 0.01, volumeMax: 50, volumeStep: 0.01, digits: 5, point: 0.00001,
      stopsLevelPoints: 0, spreadPoints: 10, swapLong: -6.1, swapShort: 0.4,
    },
  ],
};

function buildService(overrides: { allowReal?: boolean; account?: Mt5AccountSnapshot | null } = {}) {
  const events = new EventEmitter();
  const { store } = makeStore();
  const policy = new BrokerPolicySource(store, events, {
    id: 'test-policy',
    url: 'https://example.test/terms',
    refreshIntervalMs: 60_000,
    fetcher: async () => new Response('<html><body>spreads from 0.6</body></html>', { status: 200 }),
  });
  const service = new AccountProfileService(store, events, policy, {
    getFx: () => ({ pair: 'USD/INR', rate: 87.42, source: 'YAHOO', at: Date.now() }),
    platformSpec: (symbol) => {
      const a = getAsset(symbol);
      return { contractSize: a.contractSize, minLot: a.minimumLot, maxLot: a.maximumLot, lotStep: a.lotStep, pipSize: a.pipSize };
    },
    applyBrokerSpecs: (specs) => {
      setBrokerSpecOverrides(specs.map((s) => ({
        symbol: s.platformSymbol, contractSize: s.contractSize,
        volumeMin: s.volumeMin, volumeMax: s.volumeMax, volumeStep: s.volumeStep,
      })));
    },
    allowReal: () => overrides.allowReal ?? false,
    accountCurrency: () => 'USD',
  });
  return { service, policy, events };
}

describe('broker account compatibility rules', () => {
  const profile = findProfile(profileId('XM', 'ULTRA_LOW_STANDARD'))!;
  const base = { allowReal: false, ageMs: 1_000, maxAgeMs: 45_000, missingLiveConditions: [] as string[] };

  it('refuses to trade with no bound account', () => {
    const issues = checkAccountCompatibility(profile, null, base);
    expect(issues.some((i) => i.code === 'NO_ACCOUNT' && i.severity === 'BLOCK')).toBe(true);
  });

  it('blocks a stale binding instead of assuming the account is still there', () => {
    const issues = checkAccountCompatibility(profile, { ...DEMO_ACCOUNT }, { ...base, ageMs: 90_000 });
    expect(issues.some((i) => i.code === 'ACCOUNT_STALE' && i.severity === 'BLOCK')).toBe(true);
  });

  it('blocks an account whose demo/real mode is unknown', () => {
    const issues = checkAccountCompatibility(profile, { ...DEMO_ACCOUNT, tradeMode: 'UNKNOWN' }, base);
    expect(issues.some((i) => i.code === 'TRADE_MODE_UNKNOWN')).toBe(true);
  });

  it('block real money unless it is explicitly enabled, and allow it when it is', () => {
    const real = { ...DEMO_ACCOUNT, tradeMode: 'REAL' as const };
    expect(checkAccountCompatibility(profile, real, base).some((i) => i.code === 'REAL_NOT_ALLOWED')).toBe(true);
    expect(checkAccountCompatibility(profile, real, { ...base, allowReal: true }).some((i) => i.code === 'REAL_NOT_ALLOWED')).toBe(false);
  });

  it('blocks live dispatch while required conditions lack live-grade evidence', () => {
    const issues = checkAccountCompatibility(profile, { ...DEMO_ACCOUNT }, { ...base, missingLiveConditions: ['Commission'] });
    const issue = issues.find((i) => i.code === 'CONDITIONS_UNVERIFIED');
    expect(issue?.severity).toBe('BLOCK');
    expect(issue?.message).toContain('Commission');
  });

  it('warns when the bound account does not identify as the selected broker', () => {
    const issues = checkAccountCompatibility(
      profile,
      { ...DEMO_ACCOUNT, company: 'Some Other Broker Ltd', server: 'OtherBroker-Demo' },
      base,
    );
    expect(issues.some((i) => i.code === 'BROKER_UNVERIFIED' && i.severity === 'WARN')).toBe(true);
  });

  it('blocks an account currency the profile does not list', () => {
    const confirmed = {
      ...profile,
      conditions: { ...profile.conditions, baseCurrencies: { value: ['USD', 'EUR'], evidence: { kind: 'OPERATOR_CONFIRMED' as const, source: 'test', at: Date.now() } } },
    };
    const issues = checkAccountCompatibility(confirmed, { ...DEMO_ACCOUNT, currency: 'INR' }, base);
    expect(issues.some((i) => i.code === 'CURRENCY_MISMATCH' && i.severity === 'BLOCK')).toBe(true);
  });
});

describe('broker policy watcher', () => {
  it('fingerprints content, ignoring markup-only churn', () => {
    const a = hashPolicyText('<div class="x">Spreads from 0.6 pips</div>');
    const b = hashPolicyText('<section id="y"><span>Spreads from 0.6   pips</span></section>');
    expect(a.hash).toBe(b.hash);
    expect(normalizePolicyText('<p>a</p><script>evil()</script>')).toBe('a');
  });

  it('records a policy change and asks for review, without touching conditions', async () => {
    let body = '<html><body>spreads from 0.6</body></html>';
    const events = new EventEmitter();
    const { store } = makeStore();
    const changes: unknown[] = [];
    events.on('broker:policy-changed', (p) => changes.push(p));
    const source = new BrokerPolicySource(store, events, {
      id: 'p', url: 'https://example.test/terms', refreshIntervalMs: 60_000,
      fetcher: async () => new Response(body, { status: 200 }),
    });
    const first = await source.refresh();
    expect(first.status).toBe('FRESH');
    expect(first.reviewRequired).toBe(true); // never acknowledged yet
    await source.acknowledge();
    expect(source.snapshot().reviewRequired).toBe(false);

    body = '<html><body>spreads from 0.9</body></html>';
    const second = await source.refresh();
    expect(second.changedAt).not.toBeNull();
    expect(second.reviewRequired).toBe(true);
    expect(changes.length).toBe(1);
    // The watcher detects; it never rewrites conditions itself.
    expect(second.contentHash).not.toBe(first.contentHash);
  });

  it('degrades to UNAVAILABLE with the reason when the broker blocks the request', async () => {
    const events = new EventEmitter();
    const { store } = makeStore();
    const source = new BrokerPolicySource(store, events, {
      id: 'p', url: 'https://example.test/terms', refreshIntervalMs: 60_000,
      fetcher: async () => new Response('forbidden', { status: 403, statusText: 'Forbidden' }),
    });
    const snap = await source.refresh();
    expect(snap.status).toBe('UNAVAILABLE');
    expect(snap.lastError).toContain('403');
    expect(snap.fetchedAt).toBeNull();
  });
});

describe('account profile service', () => {
  beforeEach(() => clearBrokerSpecOverrides());
  afterEach(() => clearBrokerSpecOverrides());

  it('defaults to the XM Ultra Low Standard profile and holds live orders until the terms are known', async () => {
    const { service } = buildService();
    await service.init();
    const snap = await service.status();
    expect(snap.profileId).toBe('XM:ULTRA_LOW_STANDARD');
    expect(snap.label).toContain('Ultra Low Standard');
    // No account bound yet → nothing may be dispatched.
    expect(snap.liveGate.allowed).toBe(false);
    expect(snap.liveGate.reasons.join(' ')).toContain('No MT5 account is bound');
    // Simulation still runs, but is labelled with what is unverified.
    expect(snap.paperGate.allowed).toBe(true);
    expect(snap.paperGate.warnings.length).toBeGreaterThan(0);
    // Nothing may be presented as broker-confirmed when nothing was confirmed.
    expect(snap.conditions.find((c) => c.key === 'contractSize')?.liveGrade).toBe(false);
  });

  it('resolves the account terms from the bound MT5 account, in realtime', async () => {
    const { service } = buildService();
    await service.init();
    await service.noteMt5Account({ ...DEMO_ACCOUNT });

    const snap = await service.status();
    const byKey = Object.fromEntries(snap.conditions.map((c) => [c.key, c]));
    expect(byKey.leverageOptions.evidence).toBe('MT5_ACCOUNT');
    expect(byKey.leverageOptions.display).toBe('500');
    expect(byKey.baseCurrencies.display).toBe('USD');
    expect(byKey.contractSize.display).toBe('100000');
    expect(snap.binding.bound).toBe(true);
    expect(snap.displayCurrency).toBe('USD');
    // The live spread the terminal reports is used as the cost assumption.
    expect(byKey.typicalSpreadPips.evidence).toBe('MT5_ACCOUNT');
    expect(Number(byKey.typicalSpreadPips.raw)).toBeGreaterThan(0);
  });

  it('applies the broker contract specs to lot sizing (account type drives trades)', async () => {
    const { service } = buildService();
    await service.init();
    // A micro-style contract: 1,000 units per lot instead of the platform's 100,000.
    await service.noteMt5Account({
      ...DEMO_ACCOUNT,
      company: 'Some Broker',
      symbolSpecs: [{ ...DEMO_ACCOUNT.symbolSpecs![0], contractSize: 1_000 }],
    });
    // Both the spec cache and the sizing path must see the broker's geometry.
    expect(specFor('EUR/USD').contractSize).toBe(1_000);
    expect(forexBasedSpec('GBP/USD').contractSize).toBe(100_000); // untouched symbol keeps defaults

    // The divergence is surfaced rather than hidden.
    const snap = await service.status();
    const mismatch = snap.specMismatches.find((m) => m.symbol === 'EUR/USD' && m.field === 'contract size');
    expect(mismatch?.severity).toBe('BLOCK');
    expect(mismatch?.broker).toBe('1000');
    expect(mismatch?.platform).toBe('100000');
  });

  it('holds live orders until every sizing term is broker-confirmed, then releases them', async () => {
    const { service } = buildService();
    await service.init();
    await service.noteMt5Account({ ...DEMO_ACCOUNT });
    // Commission is not exposed by the terminal, so it stays unverified.
    expect((await service.status()).liveGate.allowed).toBe(false);
    expect(service.missingLiveConditions()).toContain('Commission');

    await service.confirmConditions({ commissionPerLotUsdRoundTurn: 0 }, 'xm.com account page');
    const after = await service.status();
    expect(service.missingLiveConditions()).toEqual([]);
    expect(after.liveGate.allowed).toBe(true);
    const commission = after.conditions.find((c) => c.key === 'commissionPerLotUsdRoundTurn');
    expect(commission?.evidence).toBe('OPERATOR_CONFIRMED');
    expect(commission?.display).toBe('0');
  });

  it('separates simulation from real money: a REAL account is bound but never traded without opt-in', async () => {
    const { service } = buildService({ allowReal: false });
    await service.init();
    await service.noteMt5Account({ ...DEMO_ACCOUNT, tradeMode: 'REAL' });
    const held = await service.status();
    expect(held.binding.account?.tradeMode).toBe('REAL');
    expect(held.liveGate.allowed).toBe(false);
    expect(held.liveGate.reasons.join(' ')).toContain('REAL-money');
    expect(held.realExecutionEnabled).toBe(false);

    const allowed = buildService({ allowReal: true });
    await allowed.service.init();
    await allowed.service.noteMt5Account({ ...DEMO_ACCOUNT, tradeMode: 'REAL' });
    await allowed.service.confirmConditions({ commissionPerLotUsdRoundTurn: 0 });
    expect((await allowed.service.status()).liveGate.allowed).toBe(true);
  });

  it('drops orders when the trader worker goes away (binding no longer live)', async () => {
    const { service } = buildService();
    await service.init();
    await service.noteMt5Account({ ...DEMO_ACCOUNT });
    await service.confirmConditions({ commissionPerLotUsdRoundTurn: 0 });
    expect((await service.status()).liveGate.allowed).toBe(true);

    await service.noteMt5Account(null);
    const offline = await service.status();
    expect(offline.liveGate.allowed).toBe(false);
    expect(offline.binding.bound).toBe(false);
  });

  it('clears account-specific confirmations when the account type changes', async () => {
    const { service } = buildService();
    await service.init();
    await service.noteMt5Account({ ...DEMO_ACCOUNT });
    await service.confirmConditions({ commissionPerLotUsdRoundTurn: 2.5 });
    expect((await service.status()).confirmedAt).not.toBeNull();

    const switched = await service.setAccountType('XM', 'STANDARD');
    expect(switched.profileId).toBe('XM:STANDARD');
    expect(switched.confirmedAt).toBeNull();
    expect(service.missingLiveConditions()).toContain('Commission');
  });

  it('reports the live conversion rate rather than a fixed one', async () => {
    const { service } = buildService();
    await service.init();
    const snap = await service.status();
    expect(snap.fx?.pair).toBe('USD/INR');
    expect(snap.fx?.rate).toBeCloseTo(87.42, 2);
    expect(snap.fx?.stale).toBe(false);
    expect(defaultProfile().id).toBe('XM:ULTRA_LOW_STANDARD');
  });
});
