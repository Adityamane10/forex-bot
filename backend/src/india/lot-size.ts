/**
 * Instrument lot-size reference layer (spec §4).
 *
 * Lot sizes are EXCHANGE-MANDATED and change over time (NIFTY alone has moved
 * 75 → 50 → 25 across mandate cycles). The single source of truth for a live
 * contract is the broker instrument master, loaded into
 * `IndiaInstrument.lotSize` — these numbers must never be scattered through
 * sizing/P&L code.
 *
 * This module is the one place that holds the CURRENTLY EXPECTED per-underlying
 * values. They are used to VALIDATE the master at execution time: a mismatch
 * means the cached master is stale against the exchange's latest mandate, and
 * the trade fails closed (LOT_SIZE_MISMATCH) rather than going out with the
 * wrong quantity — the difference between ₹10 × 65 = ₹650 and ₹10 × 30 = ₹300
 * of P&L per point is exactly the kind of error that must never be discovered
 * after a fill.
 */

/**
 * Expected quantity-per-lot by underlying — SEBI/exchange mandate revision
 * effective for contracts issued from the Aug-2026 cycle (verified against the
 * live Angel One instrument master on 2026-08-26: every NIFTY series — including
 * ones issued before the revision, e.g. NIFTY01SEP26 — reports 65, and FINNIFTY
 * reports 60). The broker master is re-downloaded on every backend boot and is
 * authoritative; these values exist purely as a drift alarm. When they disagree
 * with a fresh master, UPDATE THIS MAP to the master's value (after checking the
 * exchange circular) rather than bypassing the check.
 */
export const INDIA_LOT_SIZE_REFERENCE: Record<string, number> = {
  NIFTY: 65,
  BANKNIFTY: 30,
  FINNIFTY: 60,
  MIDCPNIFTY: 140,
  SENSEX: 20,
} as const;

export interface IndiaLotSizeValidation {
  ok: boolean;
  /** The lot size every downstream calculation must use (broker master). */
  lotSize: number;
  reason?: string;
}

/**
 * Validate a contract's lot size against the configured reference.
 *
 * The broker master remains authoritative for CALCULATION — this exists to
 * catch drift between what the exchange mandates today and what the cached
 * master still claims. When the underlying has no configured reference the
 * check passes with the master's value.
 */
export function validateIndiaLotSize(instrument: {
  underlying: string;
  lotSize: number;
}): IndiaLotSizeValidation {
  const lotSize = Math.max(1, Math.floor(Number(instrument.lotSize) || 0));
  if (!Number.isFinite(lotSize) || lotSize < 1) {
    return { ok: false, lotSize: 0, reason: `instrument master carries invalid lot size ${instrument.lotSize}` };
  }
  const expected = INDIA_LOT_SIZE_REFERENCE[String(instrument.underlying).toUpperCase()];
  if (expected !== undefined && lotSize !== expected) {
    return {
      ok: false,
      lotSize,
      reason: `${instrument.underlying} lot size is ${lotSize}, expected ${expected} — refresh the instrument master before trading`,
    };
  }
  return { ok: true, lotSize };
}
