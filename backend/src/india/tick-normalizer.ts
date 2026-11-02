/**
 * Tick normalization and validation (spec §7, §8). Normalizes broker ticks into
 * the common IndiaTick structure and enforces data-integrity invariants:
 *  - marketTimestamp is NEVER overwritten with the server receive time
 *  - both exchange timestamp AND local receive timestamp are preserved
 *  - invalid/duplicate/out-of-order ticks are rejected
 */
import type { IndiaTick } from '@fx/shared';

export interface TickValidation {
  ok: boolean;
  reason?: string;
}

/** Structural + sanity validation of a raw normalized tick. */
export function validateIndiaTick(tick: IndiaTick): TickValidation {
  if (!tick.instrumentToken || !Number(tick.instrumentToken)) {
    return { ok: false, reason: 'missing instrument token' };
  }
  if (!Number.isFinite(tick.ltp) || tick.ltp <= 0) {
    return { ok: false, reason: 'invalid ltp' };
  }
  if (tick.bid !== null && (!Number.isFinite(tick.bid) || tick.bid <= 0)) {
    return { ok: false, reason: 'invalid bid' };
  }
  if (tick.ask !== null && (!Number.isFinite(tick.ask) || tick.ask <= 0)) {
    return { ok: false, reason: 'invalid ask' };
  }
  if (tick.bid !== null && tick.ask !== null && tick.bid > tick.ask) {
    return { ok: false, reason: 'bid above ask' };
  }
  if (!Number.isFinite(tick.marketTimestamp) || tick.marketTimestamp <= 0) {
    return { ok: false, reason: 'invalid market timestamp' };
  }
  return { ok: true };
}

/**
 * Complete a partially-populated broker tick (tradingSymbol/underlying/segment
 * filled from the instrument master) and stamp the receive time.
 */
export function normalizeIndiaTick(
  raw: Omit<IndiaTick, 'receivedAt' | 'timestamp'> & Partial<Pick<IndiaTick, 'receivedAt' | 'timestamp'>>,
): IndiaTick {
  const receivedAt = raw.receivedAt ?? Date.now();
  return {
    ...raw,
    marketTimestamp: raw.marketTimestamp,
    receivedAt,
    timestamp: raw.marketTimestamp, // exchange time; receive time stays in receivedAt
  } as IndiaTick;
}

/**
 * Per-instrument duplicate/ordering guard. Returns true when the tick is new
 * (different market timestamp or newer) and records it.
 */
export class TickSequencer {
  private lastMarketTs = new Map<string, number>();
  private lastReceivedTs = new Map<string, number>();
  /** Total dropped count, surfaced to the data-health service. */
  dropped = 0;

  accept(tick: IndiaTick): boolean {
    const key = tick.instrumentToken;
    const last = this.lastMarketTs.get(key);
    // Duplicate market timestamp = the broker re-sent the same tick: drop.
    if (last !== undefined && tick.marketTimestamp === last) {
      this.dropped += 1;
      return false;
    }
    // Out-of-order tick (older than the last received): drop.
    if (last !== undefined && tick.marketTimestamp < last) {
      this.dropped += 1;
      return false;
    }
    this.lastMarketTs.set(key, tick.marketTimestamp);
    this.lastReceivedTs.set(key, tick.receivedAt);
    return true;
  }

  reset(): void {
    this.lastMarketTs.clear();
    this.lastReceivedTs.clear();
    this.dropped = 0;
  }
}