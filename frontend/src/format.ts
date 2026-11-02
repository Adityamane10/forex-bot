import { getAsset } from '@fx/shared';

export function fmt(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return n.toFixed(digits);
}

/** Currency symbol for account-currency codes (₹ for INR, $ default). */
export function curSymbol(currency?: string | null): string {
  return currency === 'INR' ? '₹' : '$';
}

/** Money in the account currency: ₹1,234.56 / $1,234.56 (— when missing). */
export function fmtCur(n: number | null | undefined, currency?: string | null, digits = 2): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return `${curSymbol(currency)}${n.toFixed(digits)}`;
}

export function fmtPct(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`;
}

export function fmtPrice(n: number | null | undefined, symbol?: string): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  if (symbol) {
    try {
      // Asset metadata knows the right precision for forex AND crypto.
      return n.toFixed(getAsset(symbol).pricePrecision);
    } catch {
      /* fall through to heuristic */
    }
  }
  const digits = symbol === 'XAU/USD' ? 2 : symbol?.includes('JPY') ? 3 : 5;
  return n.toFixed(digits);
}

export function fmtTime(ts: number | undefined): string {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleTimeString('en-GB', { hour12: false });
}

export function fmtDateTime(ts: number | undefined): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('en-GB', { hour12: false });
}

export function timeAgo(ts: number | undefined): string {
  if (!ts) return '—';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5) return 'now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}
