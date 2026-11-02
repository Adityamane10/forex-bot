/**
 * IndiaCandleWarmer (spec §5, §7, §11).
 *
 * The Goal engine can only trade what it can analyze, and analysis needs candle
 * history. The instrument master carries thousands of option contracts but the
 * boot feed seeds only the indices — every strike sits at NO_DATA until someone
 * happens to open its chart, which is why Goal scans kept reporting nothing to
 * trade: the tradable universe was empty of evidence, not of setups.
 *
 * This service closes that gap honestly: it selects near-ATM CE/PE strikes of
 * the NEAREST expiry per configured underlying (the contracts a short-horizon
 * goal would actually trade), fetches today's intraday candles from the broker,
 * merges them into the live buffer, and puts each token on the REST poll so the
 * bars keep forming. It fabricates nothing — an empty broker response is
 * recorded as such and retried on the next round.
 *
 * Bounded by design: a per-round cap and a slow cadence keep the whole thing
 * inside the broker's rate budget next to the LTP/OHLC polls.
 */
import type { IndiaCandle, IndiaInstrument } from '@fx/shared';
import { INDIA_TIMEFRAME_MS } from '@fx/shared';
import { logger } from '../core/logger';
import { indiaConfig } from './config';
import { expiryInstant } from './options-math';
import type { IndiaInstrumentService } from './instruments';
import type { IndiaCandleEngine } from './candle-engine';
import type { IndiaBrokerAdapter } from './brokers/types';

export interface IndiaCandleWarmerOptions {
  instruments: IndiaInstrumentService;
  candles: IndiaCandleEngine;
  adapter: IndiaBrokerAdapter;
  /** Live quote source for spot fallback when chain analytics has none yet. */
  lastTick?(instrumentToken: string): { ltp: number } | null;
}

/** Contracts fetched in one round. 24 requests / 15 min is negligible next to
 *  the LTP poll (~20/min) yet covers ±4 strikes × CE+PE for one underlying per
 *  round; rounds rotate through underlyings so all three stay warm. */
const MAX_CONTRACTS_PER_ROUND = indiaConfig.warmContractsPerRound;
/** Strikes either side of spot considered "near ATM". */
const STRIKES_EITHER_SIDE = Number(process.env.INDIA_WARM_STRIKES_EITHER_SIDE ?? '4');
/** Minimum bars before a buffer counts as warm (analysis refuses < 30). */
const MIN_WARM_BARS = 60;
/**
 * How far back one warm fetch reaches. Today-only intraday cannot warm a
 * buffer in the morning: at 09:45 IST the whole session is ~7 bars of 5m,
 * analysis still reads NO_DATA, and the goal engine spent the best hours of
 * the day rejecting every contract it scanned. Several sessions of history
 * cross the 30-bar gate immediately, whatever the clock says.
 */
const WARM_LOOKBACK_DAYS = Number(process.env.INDIA_WARM_LOOKBACK_DAYS ?? '7');

export class IndiaCandleWarmer {
  private round = 0;
  private running = false;
  /** Tokens whose last fetch came back empty — probed less often than healthy
   *  ones, because a far OTM strike does not start trading because we asked again. */
  private emptyUntil = new Map<string, number>();

  constructor(private opts: IndiaCandleWarmerOptions) {}

  /**
   * One warm-up pass. Rotates through the underlyings so a single round stays
   * small; returns how many buffers were (re)warmed.
   */
  async warmOnce(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let warmed = 0;
    try {
      const underlyings = indiaConfig.underlyings;
      if (underlyings.length === 0) return 0;
      const target = underlyings[this.round % underlyings.length];
      this.round += 1;

      const indexToken = this.opts.instruments.primaryIndexInstruments()
        .find((i) => i.underlying.toUpperCase() === target)?.instrumentToken;

      // Nearest common expiry among this underlying's options — compared via
      // expiryInstant(): raw bare-date epochs are already past at open on
      // expiry day, which excluded exactly the contracts theta matters most.
      const now = Date.now();
      const expiries = this.opts.instruments.all()
        .filter((i) => i.contractType === 'OPT' && i.underlying.toUpperCase() === target && i.expiry != null && expiryInstant(i.expiry as number) > now)
        .map((i) => i.expiry as number);
      if (expiries.length === 0) return 0;
      const nearest = Math.min(...expiries);

      const spot = this.spotFor(indexToken ?? null);
      if (!spot || !Number.isFinite(spot) || spot <= 0) {
        logger.debug('india: warmer skipped — no spot yet', { underlying: target });
        return 0;
      }

      const universe = this.opts.instruments.all()
        .filter((i) => i.contractType === 'OPT' && i.underlying.toUpperCase() === target && i.expiry === nearest);
      const strikes = [...new Set(universe.map((i) => i.strike as number))]
        .sort((a, b) => Math.abs(a - spot) - Math.abs(b - spot))
        .slice(0, STRIKES_EITHER_SIDE * 2 + 1);
      const wanted = new Set(strikes);
      const contracts = universe
        .filter((i) => i.tradable && i.status === 'ACTIVE' && wanted.has(i.strike as number))
        .sort((a, b) => (a.optionType === b.optionType ? (a.strike as number) - (b.strike as number) : a.optionType === 'CE' ? -1 : 1));

      const budget = MAX_CONTRACTS_PER_ROUND;
      let used = 0;
      for (const contract of contracts) {
        if (used >= budget) break;
        if ((this.emptyUntil.get(contract.instrumentToken) ?? 0) > Date.now()) continue;
        used += 1;
        try {
          warmed += await this.warmContract(contract) ? 1 : 0;
        } catch (err) {
          logger.warn('india: warmer contract failed', { token: contract.instrumentToken, err: String(err) });
        }
      }
      if (used > 0) {
        logger.info('india: candle warmer pass', { underlying: target, expiry: new Date(nearest).toISOString(), attempted: used, warmed });
      }
      return warmed;
    } finally {
      this.running = false;
    }
  }

  /** Fetch + merge bars for one contract; report whether it helped. */
  private async warmContract(instrument: IndiaInstrument): Promise<boolean> {
    const tf = indiaConfig.primaryTimeframe as keyof typeof INDIA_TIMEFRAME_MS;
    const existing = this.opts.candles.getCandles(instrument.instrumentToken, tf, MIN_WARM_BARS);
    const newestBar = existing.length > 0 ? existing[existing.length - 1] : null;
    // Staleness threshold derived from the ACTUAL timeframe — the hardcoded
    // 2×5-minute check flagged healthy 15m/30m buffers as perpetually behind,
    // triggering a redundant 7-day refetch per contract per round.
    const tfMs = INDIA_TIMEFRAME_MS[tf];
    const behind = !!newestBar && newestBar.openTime < Date.now() - 2 * tfMs;
    if (existing.length >= MIN_WARM_BARS && !behind) return false;

    // Multi-day window: enough sessions to clear analysis's 30-bar floor even
    // minutes after the open, weekends included.
    const to = Date.now();
    const from = to - WARM_LOOKBACK_DAYS * 86_400_000;
    const history = await this.opts.adapter.getHistoricalCandles(instrument.instrumentToken, tf, from, to);
    if (history.length === 0) {
      // Ten-minute cool-off instead of hammering a contract that never traded.
      this.emptyUntil.set(instrument.instrumentToken, Date.now() + 600_000);
      return false;
    }
    this.emptyUntil.delete(instrument.instrumentToken);
    const merged = [...new Map(
      [...history, ...existing].map((c: IndiaCandle) => [c.id, c]),
    ).values()].sort((a, b) => a.openTime - b.openTime);
    await this.opts.candles.seed(instrument.instrumentToken, tf, merged);
    return true;
  }

  /** The index LTP is the spot for these underlyings — never a guess. */
  private spotFor(indexToken: string | null): number | null {
    const tick = indexToken ? this.opts.lastTick?.(indexToken) ?? null : null;
    return tick && Number.isFinite(tick.ltp) && tick.ltp > 0 ? tick.ltp : null;
  }
}
