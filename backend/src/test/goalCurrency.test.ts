/**
 * Goal currency (USD-readiness guarantee): the GOAL — minimum profit, sizing,
 * margin figures — is denominated in the LIVE WALLET currency. The user's
 * account-currency setting drives it until an MT5 account binds; the wallet
 * then ADOPTS the account's currency (XM pattern) and the goal must follow,
 * otherwise a position sized for a ₹ goal is measured against a $ target
 * (≈90× error) or the reverse.
 *
 * These tests pin `SignalEngine.goalCurrencyFor` — the single choke point
 * every goal-path consumer (analyzeForGoal, tryOpenForSignal, openManual)
 * resolves its currency through.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Container } from '../core/container';
import { INR_RATE_SYMBOL } from '@fx/shared';

describe('goal is denominated in the wallet currency, not a stale setting', () => {
  let container: Container;

  beforeAll(async () => {
    process.env.SCANNER_INTERVAL_MS = '60000'; // keep the scanner quiet
    container = new Container();
    await container.init();
    await container.start();
  }, 90_000);

  afterAll(async () => {
    await container.stop();
  });

  /** Live USD/INR tick so the adoption rescale has a real conversion path. */
  async function pushInrTick(rate: number): Promise<void> {
    const now = Date.now();
    await container.marketData.handleTick({
      symbol: INR_RATE_SYMBOL,
      timestamp: now,
      receivedAt: now,
      bid: rate - 0.005, ask: rate + 0.005, mid: rate,
      spread: 0.01, source: 'test', mode: 'DEMO',
    } as never);
  }

  /** Persist settings the way the PUT route does, then refresh caches. */
  async function setSettings(patch: Record<string, unknown>): Promise<void> {
    await container.store.updateOne('userSettings', {}, { $set: patch as never }, true);
    container.noteAccountCurrency((patch.accountCurrency as string) ?? 'USD');
    await container.paper.init(await container.signals.loadSettings());
  }

  it('paper-only wallet: the goal follows the account-currency setting', async () => {
    await setSettings({ accountCurrency: 'USD', paperStartingCapital: 5000, availableCapital: 5000 });
    await container.paper.reinitAccount();
    let settings = await container.signals.loadSettings();
    expect(container.paper.getAccount()!.currency).toBe('USD');
    expect(container.signals.goalCurrencyFor(settings)).toBe('USD');

    await setSettings({ accountCurrency: 'INR' });
    await container.paper.reinitAccount();
    settings = await container.signals.loadSettings();
    expect(container.paper.getAccount()!.currency).toBe('INR');
    expect(container.signals.goalCurrencyFor(settings)).toBe('INR');
  });

  it('bound USD account: the wallet flips to USD, settings follow, and the goal rescales over the live rate', async () => {
    // Legacy stored state: INR-era settings and wallet.
    await setSettings({ accountCurrency: 'INR', paperStartingCapital: 5000, availableCapital: 5000, minimumProfit: 100 });
    await container.paper.reinitAccount();
    expect(container.paper.getAccount()!.currency).toBe('INR');

    // The bound XM-style account heartbeats in ITS OWN money (USD) — exactly
    // what the trader worker sends. The wallet adopts USD; the stored setting
    // follows it and the ₹ goal/capital rescale over the live USD/INR rate.
    await pushInrTick(83);
    await container.paper.syncFromMt5({
      balance: 5000, equity: 5000, margin: 0, freeMargin: 5000,
      currency: 'USD', login: 12345678, server: 'DemoBroker-MT5',
    });
    expect(container.paper.getAccount()!.currency).toBe('USD');
    // Stored settings FOLLOW the account: currency persists as USD, the ₹
    // goal rescales over the live rate (a ₹ goal must not silently become a
    // $ goal), and capital adopts the bound account's balance — the sizer
    // must work from the account's own money, not a converted stale figure.
    const settings = await container.signals.loadSettings();
    expect(settings.accountCurrency).toBe('USD');
    expect(settings.minimumProfit).toBeCloseTo(100 / 83, 1); // ₹100 → ~$1.20
    expect(settings.availableCapital).toBe(5000); // account balance, not 5000/83
    expect(settings.paperStartingCapital).toBe(5000);
    expect(container.signals.goalCurrencyFor(settings)).toBe('USD');
  });

  it('the goal scan runs against the live wallet currency without crashing (smoke)', async () => {
    // Wallet is USD here (bound above). The goal hunt prices sizing/margin in
    // USD for a USD wallet — no INR conversion rate may be required.
    const analysis = await container.signals.analyzeForGoal('XAU/USD');
    expect(analysis.goalProfit).toBeCloseTo(100 / 83, 1); // rescaled ₹100 goal
    expect(Number.isFinite(analysis.updatedAt)).toBe(true);
  });
});
