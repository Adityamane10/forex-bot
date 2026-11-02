/**
 * ContractLifecycleService (spec §12). Computes expiry date/time, time-to-expiry,
 * active/expired status and tradability from the ACTUAL broker contract master —
 * never hard-coded assumptions like "NIFTY always expires Thursday".
 *
 * Rules:
 *  - A contract expiring today stays tradable only while the exchange says it
 *    is tradable and the market is open; after the day's close it becomes EXPIRED.
 *  - A contract expiring tomorrow stays available during today's valid session
 *    and re-activates on the next valid session until its actual expiry.
 *  - Stale signals for expired contracts are never executed.
 */
import type { IndiaInstrument, IndiaInstrumentStatus } from '@fx/shared';
import { INDIA_CHANNELS, INDIA_COLLECTIONS } from '@fx/shared';
import { DataStore } from '../db/store';
import { EventEmitter } from 'events';
import { IndiaInstrumentService } from './instruments';
import { expiryInstant } from './options-math';
import { istDateKey } from './session';

export interface ContractLifecycle {
  instrument: IndiaInstrument;
  expiryDate: string | null;
  expiryTimeMs: number | null;
  timeToExpiryMs: number | null;
  status: IndiaInstrumentStatus;
  tradable: boolean;
  currentSession: 'OPEN' | 'CLOSED';
  reason: string;
}

export class ContractLifecycleService {
  private cache = new Map<string, ContractLifecycle>();

  constructor(
    private instruments: IndiaInstrumentService,
    private store: DataStore,
    private events: EventEmitter,
  ) {}

  /** Evaluate one contract against the current time + market session. */
  lifecycleFor(token: string, marketOpen: boolean, now = Date.now()): ContractLifecycle | null {
    const instrument = this.instruments.getByToken(token);
    if (!instrument) return null;
    const expiry = instrument.expiry;
    let status: IndiaInstrumentStatus = 'ACTIVE';
    let tradable = true;
    let reason = 'contract tradable';

    if (expiry === null) {
      // Index/cash instruments: no expiry lifecycle.
      tradable = marketOpen;
      reason = marketOpen ? 'index contract tradable' : 'market closed';
      return this.build(instrument, null, null, null, status, tradable, marketOpen ? 'OPEN' : 'CLOSED', reason);
    }

    const expiryDayKey = istDateKey(expiry);
    const todayKey = istDateKey(now);
    // The contract's real end of life is 15:30 IST on the expiry date, NOT the
    // raw bare-date epoch (IST/UTC midnight) — comparing raw made every
    // contract "EXPIRED" before market open on expiry day.
    const expiryAt = expiryInstant(expiry);
    const timeToExpiry = expiryAt - now;

    if (expiryAt <= now) {
      status = 'EXPIRED';
      tradable = false;
      reason = 'contract has expired';
    } else if (expiryDayKey === todayKey) {
      // Expires today: tradable only while the market is open.
      if (!marketOpen) {
        status = 'EXPIRED';
        tradable = false;
        reason = 'expires today and market is closed — lifecycle complete';
      } else {
        status = 'ACTIVE';
        tradable = true;
        reason = 'expires today; tradable while the market is open';
      }
    } else {
      status = 'ACTIVE';
      tradable = marketOpen;
      reason = marketOpen ? 'contract tradable this session' : 'market closed — resumes next session';
    }

    const lifecycle = this.build(instrument, expiry, expiry, timeToExpiry, status, tradable, marketOpen ? 'OPEN' : 'CLOSED', reason);
    const prev = this.cache.get(token);
    if (!prev || prev.status !== lifecycle.status || prev.tradable !== lifecycle.tradable) {
      this.cache.set(token, lifecycle);
      this.events.emit(INDIA_CHANNELS.expiry, lifecycle);
      void this.store
        .insertOne(INDIA_COLLECTIONS.sessions, { kind: 'contract', ...lifecycle, timestamp: Date.now() })
        .catch(() => undefined);
    } else {
      this.cache.set(token, lifecycle);
    }
    return lifecycle;
  }

  private build(
    instrument: IndiaInstrument,
    expiryDateRaw: number | null,
    expiryTimeMs: number | null,
    timeToExpiryMs: number | null,
    status: IndiaInstrumentStatus,
    tradable: boolean,
    currentSession: 'OPEN' | 'CLOSED',
    reason: string,
  ): ContractLifecycle {
    return {
      instrument,
      expiryDate: expiryDateRaw ? istDateKey(expiryDateRaw) : null,
      expiryTimeMs,
      timeToExpiryMs,
      status,
      tradable,
      currentSession,
      reason,
    };
  }

  /** Bulk evaluation for every subscribed instrument. */
  evaluateAll(marketOpen: boolean, now = Date.now()): ContractLifecycle[] {
    const out: ContractLifecycle[] = [];
    for (const instrument of this.instruments.executionInstruments()) {
      const lc = this.lifecycleFor(instrument.instrumentToken, marketOpen, now);
      if (lc) out.push(lc);
    }
    return out;
  }

  /** All currently-tradable contracts (for execution gating). */
  tradableTokens(marketOpen: boolean, now = Date.now()): Set<string> {
    const out = new Set<string>();
    for (const instrument of this.instruments.executionInstruments()) {
      const lc = this.lifecycleFor(instrument.instrumentToken, marketOpen, now);
      if (lc && lc.tradable) out.add(instrument.instrumentToken);
    }
    return out;
  }
}