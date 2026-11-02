/**
 * Per-symbol account costs, live-money readiness and journal provenance.
 *
 * The invariants that protect real money once an XM account is bound:
 *   - a cost component that cannot be sourced is UNKNOWN, never 0;
 *   - changing the account type changes what a trade COSTS (a spread-only
 *     Ultra Low Standard account charges no per-lot commission, a Zero-style
 *     account charges its published one);
 *   - swap is only interpreted when the terminal says it is charged in points;
 *   - the readiness checklist names the exact fact that is holding dispatch;
 *   - the terms record written into the journal keeps the provenance of every
 *     number, so history cannot be re-priced by a later settings change.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { Mt5AccountSnapshot, TermsProvenance, findProfile, profileId } from '@fx/shared';
import { AccountProfileService } from '../broker/account-profile-service';
import { BrokerPolicySource } from '../broker/policy-source';
import {
  brokerAccountCosts,
  brokerSpreadPerLot,
  brokerSwapQuotePerLotNight,
  clearBrokerAccountCosts,
  effectiveCommissionUsdPerLot,
  plannedCommissionUsdPerLot,
} from '../broker/cost-registry';
import { clearBrokerSpecOverrides } from '../forex/symbol-spec';
import type { DataStore } from '../db/store';

function makeStore(): DataStore {
  const docs = new Map<string, Record<string, unknown>>();
  const key = (c: string, q: Record<string, unknown>) => `${c}|${JSON.stringify(q)}`;
  return {
    findOne: async (c: string, q: Record<string, unknown>) => docs.get(key(c, q)) ?? null,
    find: async () => [],
    updateOne: async (c: string, q: Record<string, unknown>, u: { $set?: Record<string, unknown> }) => {
      docs.set(key(c, q), { ...(u.$set ?? {}) });
      return { modified: 1 };
    },
    insertOne: async () => ({}),
    deleteMany: async () => ({ deleted: 0 }),
  } as unknown as DataStore;
}

/** An account whose terminal reports everything except the commission. */
const ACCOUNT: Mt5AccountSnapshot = {
  login: 99887766,
  server: 'XMGlobal-MT5',
  company: 'XM Global Limited',
  currency: 'USD',
  balance: 5_000,
  equity: 5_000,
  leverage: 1000,
  tradeMode: 'DEMO',
  marginCallLevelPct: 50,
  stopOutLevelPct: 20,
  symbolSpecs: [
    {
      symbol: 'EURUSD', platformSymbol: 'EUR/USD', contractSize: 100_000,
      volumeMin: 0.01, volumeMax: 50, volumeStep: 0.01, digits: 5, point: 0.00001,
      stopsLevelPoints: 0, spreadPoints: 8, swapLong: -5.2, swapShort: 1.1, swapMode: 0,
    },
    {
      symbol: 'USDJPY', platformSymbol: 'USD/JPY', contractSize: 100_000,
      volumeMin: 0.01, volumeMax: 50, volumeStep: 0.01, digits: 3, point: 0.001,
      stopsLevelPoints: 0, spreadPoints: 12, swapLong: -18.4, swapShort: 4.2, swapMode: 0,
    },
  ],
};

function buildService(opts: { allowReal?: boolean; liveSpread?: number | null } = {}) {
  const events = new EventEmitter();
  const policy = new BrokerPolicySource(makeStore(), events, {
    id: 'test-policy',
    url: 'https://example.test/terms',
    refreshIntervalMs: 60_000,
    fetcher: async () => new Response('<html>spreads</html>', { status: 200 }),
  });
  const service = new AccountProfileService(makeStore(), events, policy, {
    getFx: () => ({ pair: 'USD/INR', rate: 87.42, source: 'YAHOO', at: Date.now() }),
    platformSpec: () => ({ contractSize: 100_000, minLot: 0.01, maxLot: 50, lotStep: 0.01, pipSize: 0.0001 }),
    applyBrokerSpecs: () => undefined,
    allowReal: () => opts.allowReal ?? false,
    accountCurrency: () => 'USD',
    liveSpread: () => (opts.liveSpread === undefined ? null : opts.liveSpread),
    convertQuoteToAccount: () => null,
    convertUsdToAccount: () => null,
  });
  return { service, events };
}

describe('broker cost registry', () => {
  beforeEach(() => {
    clearBrokerAccountCosts();
    clearBrokerSpecOverrides();
  });
  afterEach(() => {
    clearBrokerAccountCosts();
    clearBrokerSpecOverrides();
  });

  it('prices a symbol from the broker’s own spec when no live quote is fed', async () => {
    const { service } = buildService();
    await service.init();
    await service.noteMt5Account({ ...ACCOUNT });

    // 8 points × 0.00001 × 100000 = 0.008 USD? No — that is the pip value;
    // the SPREAD cost is 8 points of price on a 100k contract = 8 USD per lot.
    const spread = brokerSpreadPerLot('EUR/USD', null);
    expect(spread.source).toBe('MT5_SYMBOL_INFO');
    expect(spread.value).toBeCloseTo(8, 6);
  });

  it('prefers the live bid/ask over the terminal’s last known spread', async () => {
    const { service } = buildService({ liveSpread: 0.00003 });
    await service.init();
    await service.noteMt5Account({ ...ACCOUNT });
    const spread = brokerSpreadPerLot('EUR/USD', 0.00003);
    expect(spread.source).toBe('LIVE_FEED');
    expect(spread.value).toBeCloseTo(3, 6);
  });

  it('charges no per-lot commission on a spread-only XM account type', async () => {
    const { service } = buildService();
    await service.init();
    await service.noteMt5Account({ ...ACCOUNT });

    const snap = await service.status();
    expect(snap.profileId).toBe('XM:ULTRA_LOW_STANDARD');
    const commission = effectiveCommissionUsdPerLot();
    expect(commission?.usdPerLotRoundTurn).toBe(0);
    expect(brokerAccountCosts()?.spreadModel.value).toBe('VARIABLE');

    const cost = snap.costs.find((c) => c.symbol === 'EUR/USD');
    expect(cost?.commissionPerLot.value).toBe(0);
    expect(cost?.roundTurnPerLot.value).toBeCloseTo(8, 6);
    expect(cost?.complete).toBe(true);
  });

  it('follows the account type: switching to Zero drops the “no commission” assumption', async () => {
    const { service } = buildService();
    await service.init();
    await service.noteMt5Account({ ...ACCOUNT });
    expect(effectiveCommissionUsdPerLot()?.usdPerLotRoundTurn).toBe(0);

    await service.setAccountType('XM', 'XM_ZERO');
    // Zero is priced on spreads PLUS a fixed commission XM does not publish on
    // the page we read — so the platform reports unknown rather than guessing.
    const zero = effectiveCommissionUsdPerLot();
    expect(zero?.usdPerLotRoundTurn).toBeNull();
    const snap = await service.status();
    const cost = snap.costs.find((c) => c.symbol === 'EUR/USD');
    expect(cost?.commissionPerLot.value).toBeNull();
    expect(cost?.complete).toBe(false);
    expect(cost?.missing).toContain('commission');

    await service.setAccountType('XM', 'ULTRA_LOW_STANDARD');
    expect(effectiveCommissionUsdPerLot()?.usdPerLotRoundTurn).toBe(0);
    const back = await service.status();
    expect(back.costs.find((c) => c.symbol === 'EUR/USD')?.complete).toBe(true);
  });

  it('quotes swap in the pair’s quote currency, and refuses unmodelled swap modes', async () => {
    const { service } = buildService();
    await service.init();
    await service.noteMt5Account({ ...ACCOUNT });
    // Long EUR/USD pays 5.2 points × 0.00001 × 100000 = 5.2 quote units per lot.
    const long = brokerSwapQuotePerLotNight('EUR/USD', 'BUY');
    expect(long.value).toBeCloseTo(5.2, 6);
    expect(brokerSwapQuotePerLotNight('EUR/USD', 'SELL').value).toBeCloseTo(-1.1, 6);

    // A terminal charging swaps in a currency/interest scheme must not be read
    // as points: the value stays unknown with the reason.
    await service.noteMt5Account({
      ...ACCOUNT,
      symbolSpecs: ACCOUNT.symbolSpecs!.map((s) => ({ ...s, swapMode: 2 })),
    });
    const unmodelled = brokerSwapQuotePerLotNight('EUR/USD', 'BUY');
    expect(unmodelled.value).toBeNull();
    expect(unmodelled.detail).toContain('mode 2');
  });

  it('leaves the wallet on platform defaults until a basis is in force', async () => {
    // Signals still plan on the selected account type, but no unacknowledged
    // published figure may price the ledger: with nothing bound and nothing
    // acknowledged, the money path must see "no broker basis" and keep its
    // own default.
    const { service } = buildService();
    await service.init();
    expect(service.costBasisActive()).toBe(false);
    expect(effectiveCommissionUsdPerLot()).toBeNull();
    // Planning still knows what the selected account type implies.
    expect(plannedCommissionUsdPerLot()?.usdPerLotRoundTurn).toBe(0);
  });

  it('keeps an unpriced symbol unknown instead of inventing a cost', async () => {
    const { service } = buildService();
    await service.init();
    await service.noteMt5Account({ ...ACCOUNT });
    const cost = service.costFor('GBP/USD'); // never reported by the terminal
    expect(cost.complete).toBe(false);
    expect(cost.spreadPerLot.value).toBeNull();
    expect(cost.spreadPerLot.source).toBe('UNKNOWN');
    expect(cost.brokerSymbol).toBeNull();
  });
});

describe('live-money readiness gate', () => {
  beforeEach(() => {
    clearBrokerAccountCosts();
    clearBrokerSpecOverrides();
  });
  afterEach(() => {
    clearBrokerAccountCosts();
    clearBrokerSpecOverrides();
  });

  it('is not ready with nothing bound, and names what is missing', async () => {
    const { service } = buildService();
    await service.init();
    const readiness = service.readiness('EUR/USD');
    expect(readiness.ready).toBe(false);
    const keys = readiness.items.filter((i) => !i.ok).map((i) => i.key);
    expect(keys).toContain('worker_online');
    expect(keys).toContain('specs_reported');
    expect(readiness.blocking.join(' ')).toContain('No MT5 account');
  });

  it('holds the gate until the broker-published terms are acknowledged, then opens it', async () => {
    const { service } = buildService();
    await service.init();
    await service.noteMt5Account({ ...ACCOUNT });

    // The commission rests on XM's published (spread-only) terms, so it is NOT
    // live-grade until the operator acknowledges them for this account type.
    const held = service.readiness('EUR/USD');
    expect(held.ready).toBe(false);
    expect(held.items.find((i) => i.key === 'published_terms')?.ok).toBe(false);
    expect(service.missingLiveConditions()).toContain('Commission');

    await service.acknowledgePublishedTerms();
    const ready = service.readiness('EUR/USD');
    expect(ready.ready).toBe(true);
    expect(ready.blocking).toEqual([]);
    expect(service.missingLiveConditions()).toEqual([]);
    expect(service.liveGateFor('EUR/USD').allowed).toBe(true);
  });

  it('lapses the acknowledgement when the account type changes', async () => {
    const { service } = buildService();
    await service.init();
    await service.noteMt5Account({ ...ACCOUNT });
    await service.acknowledgePublishedTerms();
    expect(service.publishedAcknowledged()).toBe(true);

    await service.setAccountType('XM', 'STANDARD');
    expect(service.publishedAcknowledged()).toBe(false);
    expect(service.readiness('EUR/USD').ready).toBe(false);
  });

  it('holds a REAL account until live execution is explicitly enabled', async () => {
    const held = buildService({ allowReal: false });
    await held.service.init();
    await held.service.noteMt5Account({ ...ACCOUNT, tradeMode: 'REAL' });
    await held.service.acknowledgePublishedTerms();
    const readiness = held.service.readiness('EUR/USD');
    expect(readiness.ready).toBe(false);
    expect(readiness.items.find((i) => i.key === 'real_optin')?.ok).toBe(false);

    const allowed = buildService({ allowReal: true });
    await allowed.service.init();
    await allowed.service.noteMt5Account({ ...ACCOUNT, tradeMode: 'REAL' });
    await allowed.service.acknowledgePublishedTerms();
    expect(allowed.service.readiness('EUR/USD').ready).toBe(true);
  });

  it('closes the gate for a symbol the broker has no priceable spec for', async () => {
    const { service } = buildService();
    await service.init();
    await service.noteMt5Account({ ...ACCOUNT });
    const gate = service.liveGateFor('GBP/USD');
    expect(gate.allowed).toBe(false);
    expect(gate.reasons.join(' ')).toContain('GBP/USD');
  });

  it('flags a stale binding instead of trading on an old snapshot', async () => {
    const { service } = buildService();
    await service.init();
    await service.noteMt5Account({ ...ACCOUNT });
    await service.noteMt5Account(null);
    const readiness = service.readiness();
    expect(readiness.ready).toBe(false);
    expect(readiness.items.find((i) => i.key === 'worker_online')?.ok).toBe(false);
  });
});

describe('terms provenance (journal)', () => {
  beforeEach(() => {
    clearBrokerAccountCosts();
    clearBrokerSpecOverrides();
  });
  afterEach(() => {
    clearBrokerAccountCosts();
    clearBrokerSpecOverrides();
  });

  it('records the account type, every sizing number and its evidence', async () => {
    const { service } = buildService();
    await service.init();
    await service.noteMt5Account({ ...ACCOUNT });
    await service.acknowledgePublishedTerms();
    const terms: TermsProvenance = service.termsProvenance('EUR/USD');

    expect(terms.profileId).toBe('XM:ULTRA_LOW_STANDARD');
    expect(terms.accountType).toBe('ULTRA_LOW_STANDARD');
    expect(terms.binding.login).toBe(99887766);
    expect(terms.binding.tradeMode).toBe('DEMO');

    const contract = terms.fields.find((f) => f.key === 'contractSize');
    expect(contract?.value).toBe('100000');
    expect(contract?.evidence).toBe('MT5_ACCOUNT');

    const commission = terms.fields.find((f) => f.key === 'commissionPerLotUsdRoundTurn');
    expect(commission?.evidence).toBe('POLICY_SNAPSHOT');
    expect(commission?.value).toBe('0');

    expect(terms.costs?.symbol).toBe('EUR/USD');
    expect(terms.costs?.commissionPerLot.value).toBe(0);
    expect(terms.fx?.pair).toBe('USD/INR');
    expect(terms.liveReady).toBe(true);
  });

  it('is frozen per account type: the journal keeps the old terms after a switch', async () => {
    const { service } = buildService();
    await service.init();
    await service.noteMt5Account({ ...ACCOUNT });
    const before = service.termsProvenance('EUR/USD');

    await service.setAccountType('XM', 'XM_ZERO');
    const after = service.termsProvenance('EUR/USD');

    expect(before.profileId).toBe('XM:ULTRA_LOW_STANDARD');
    expect(after.profileId).toBe('XM:XM_ZERO');
    expect(before.fields.find((f) => f.key === 'commissionPerLotUsdRoundTurn')?.value).toBe('0');
    expect(after.fields.find((f) => f.key === 'commissionPerLotUsdRoundTurn')?.value).toBe('unknown');
  });

  it('carries the broker’s published terms with a citation, never invented numbers', () => {
    const profile = findProfile(profileId('XM', 'ULTRA_LOW_STANDARD'))!;
    expect(profile.published?.sourceUrl).toContain('xm.com');
    expect(profile.published?.quotes.length).toBeGreaterThan(0);
    expect(profile.published?.minDepositUsd).toBe(5);
    // The page publishes the Spreads/Commission/Stop-Out rows but not their
    // numeric cells: the platform must not fabricate them.
    expect(profile.conditions.typicalSpreadPips.value).toBeNull();
    expect(profile.conditions.stopOutLevelPct.value).toBeNull();
    expect(profile.conditions.swapFree.value).toBe(true);
  });
});
