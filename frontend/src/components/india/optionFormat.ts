/**
 * Number and unit formatting for the option surfaces.
 *
 * These four functions existed three times over — once in the analytics panel,
 * once in the chain ladder, and about to be copied a third time into the header
 * strip. Each copy had drifted slightly, and the drift was never cosmetic: one
 * printed index levels through the currency formatter, so NIFTY at 24,610 read
 * as ₹24,610. Unit discipline only holds if there is one place to enforce it.
 */

/**
 * An index level or a strike: grouped digits, no currency symbol. A level is a
 * coordinate on a price axis, not an amount of money. Premiums are amounts of
 * money and keep going through `fmtCur`.
 */
export function level(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return n.toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/**
 * Open interest in the units the desk speaks: 1 lakh = 100,000, 1 crore =
 * 10,000,000. Index OI runs to tens of lakhs, where raw digits are unreadable
 * and "2.4L" is what someone would actually say out loud.
 */
export function compactOi(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n === 0) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e7) return `${(n / 1e7).toFixed(2)}Cr`;
  if (abs >= 1e5) return `${(n / 1e5).toFixed(2)}L`;
  if (abs >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(Math.round(n));
}

/** OI *change* — the sign carries the meaning, so it is always shown. */
export function signedOi(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n === 0) return '—';
  return `${n > 0 ? '+' : '−'}${compactOi(Math.abs(n))}`;
}

/** Implied volatility as a percentage. Stored decimal, always displayed as %. */
export function ivPct(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(digits)}%`;
}

/**
 * "3d 4h" / "2h 15m" / "48m". A countdown, because on expiry day the number that
 * matters is hours and the decimal form ("0.3d") hides exactly that.
 *
 * Falls back to days when the minute figure is missing, and reports `expired`
 * rather than a negative duration — a stale chain on a passed expiry is a real
 * state the UI has to be able to show.
 */
export function expiryCountdown(minutesToExpiry: number | null, daysToExpiry: number | null): string {
  if (minutesToExpiry == null) return daysToExpiry == null ? '—' : `${daysToExpiry.toFixed(1)}d`;
  if (minutesToExpiry <= 0) return 'expired';
  if (minutesToExpiry < 60) return `${Math.round(minutesToExpiry)}m`;
  const hours = minutesToExpiry / 60;
  if (hours < 24) return `${Math.floor(hours)}h ${Math.round(minutesToExpiry % 60)}m`;
  return `${Math.floor(hours / 24)}d ${Math.round(hours % 24)}h`;
}
