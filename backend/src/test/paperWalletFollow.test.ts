/**
 * XM-follow wallet: while an MT5 account is bound, the ledger ADOPTS the
 * account's currency and mirrors its figures in realtime — the same way the
 * XM platform itself displays the bound account's money (never a converted
 * version of it). This pins the exact behavior the dashboard depends on:
 *   - an INR-era wallet flips to the account's currency on the first report
 *   - subsequent heartbeats mirror balance/equity 1:1 (realtime)
 *   - the mirrored state is persisted, not just in-memory
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Container } from '../core/container';

describe('paper wallet follows the bound account (XM pattern)', () => {
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

  it('adopts the bound account currency and mirrors balance/equity in realtime', async () => {
    // Start from the pre-XM state: an INR-era wallet (the legacy stored setting).
    await container.store.updateOne(
      'userSettings', {},
      { $set: { accountCurrency: 'INR', paperStartingCapital: 5000, availableCapital: 5000 } as never },
      true,
    );
    await container.paper.init(await container.signals.loadSettings());
    await container.paper.reinitAccount();
    const before = container.paper.getAccount()!;
    expect(before.currency).toBe('INR');
    expect(before.balance).toBe(5000);

    // The bound XM-style account reports itself in ITS OWN money (USD), the
    // way the trader worker heartbeats it — note lowercase to prove
    // normalization.
    await container.paper.syncFromMt5({
      balance: 7432.55, equity: 7480.1, margin: 120.5, freeMargin: 7359.6,
      currency: 'usd', login: 12345678, server: 'DemoBroker-MT5',
    });

    const after = container.paper.getAccount()!;
    expect(after.currency).toBe('USD');
    // Mirrored 1:1 — NOT converted (a conversion would fabricate ~713k INR).
    expect(after.balance).toBe(7432.55);
    expect(after.equity).toBe(7480.1);
    // Re-baselined so drawdown stats stay meaningful in the new currency.
    expect(after.startingBalance).toBe(7432.55);

    // Realtime: the next heartbeat's new figures are mirrored directly.
    await container.paper.syncFromMt5({
      balance: 7501.25, equity: 7510, margin: 100, freeMargin: 7401.25,
      currency: 'USD', login: 12345678, server: 'DemoBroker-MT5',
    });
    const latest = container.paper.getAccount()!;
    expect(latest.currency).toBe('USD');
    expect(latest.balance).toBe(7501.25);
    expect(latest.equity).toBe(7510);

    // The mirrored state is what the API serves — verify it was persisted.
    const stored = await container.store.findOne<{ currency: string; balance: number }>('paperAccounts', {});
    expect(stored).not.toBeNull();
    expect(stored!.currency).toBe('USD');
    expect(stored!.balance).toBe(7501.25);
  });
});
