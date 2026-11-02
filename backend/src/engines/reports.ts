/**
 * Trading reports — aggregates over the REAL closed-trade journal
 * (paperTrades: the same records the Paper page history renders, each carrying
 * the conversion rate and broker terms it was actually closed under).
 *
 * Nothing here synthesizes data: a day with no closed trades simply has no
 * bucket, and every figure is a plain sum over real records.
 *
 * Calendar days are LOCAL days on the machine running the platform (it runs on
 * the user's PC next to the MT5 terminal), so the browser's calendar and these
 * day buckets always agree.
 */
import { PaperTrade, PaperAccount, getAsset } from '@fx/shared';
import { DataStore } from '../db/store';

export interface DayBucket {
  date: string; trades: number; wins: number; losses: number;
  pnl: number; fees: number; swap: number; margin: number;
}
export interface DailyReport {
  currency: string;
  days: DayBucket[];
  totals: { trades: number; wins: number; losses: number; pnl: number; fees: number; swap: number };
}
export interface DayReport {
  currency: string;
  date: string;
  totals: {
    trades: number; wins: number; losses: number; pnl: number; gross: number;
    fees: number; swap: number; margin: number; durationMsAvg: number;
  };
  trades: PaperTrade[];
}

const DAY_MS = 86_400_000;

export const localDayKey = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export const localDayBounds = (key: string): { start: number; end: number } => {
  const [y, m, d] = key.split('-').map(Number);
  const start = new Date(y, (m || 1) - 1, d || 1).getTime();
  return { start, end: start + DAY_MS };
};

/** Minimal structural view of the paper engine the reports need. */
export interface ReportPaper {
  getAccount(): PaperAccount | null;
  convert(amount: number, from: string, to: string): { amount: number; rate: number; stale: boolean; rateTimestamp: number; source: string } | null;
}

/** Leverage the account reports; broker-specs fill it while bound. */
const accountLeverage = (account: PaperAccount | null): number =>
  account?.leverage && account.leverage > 0 ? account.leverage : 100;

/** Margin actually committed by a closed trade, in ACCOUNT currency:
 *  exposure (lots × contract × entry, in the quote currency) converted at the
 *  LIVE rate, divided by leverage. Margin is fixed when a position opens —
 *  the journal does not store it, so this is the entry-terms value, computed
 *  from the trade's own recorded lots/entry (never invented). */
const tradeMargin = (t: PaperTrade, account: PaperAccount | null): number => {
  try {
    const a = getAsset(t.symbol);
    const quote = a.quoteCurrency || 'USD';
    const acctCcy = (account?.currency ?? 'USD').toUpperCase();
    const exposure = t.lots * (a.contractSize || 100_000) * t.entryPrice;
    if (quote === acctCcy) return exposure / accountLeverage(account);
    const conv = account ? account_convert(account, exposure, quote, acctCcy) : null;
    // convert() is provided by the engine wrapper; fall back to no-margin (0)
    // when no live rate has EVER existed — a missing rate must not fabricate one.
    return conv == null ? 0 : conv / accountLeverage(account);
  } catch {
    return 0;
  }
};

// Small indirection so the margin helper stays dependency-light.
let converter: ((amount: number, from: string, to: string) => number | null) | null = null;
const account_convert = (account: PaperAccount, amount: number, from: string, to: string): number | null =>
  converter ? converter(amount, from, to) : null;

/** Wire the live converter (the paper engine's FX service) once. */
export function setReportConverter(fn: (amount: number, from: string, to: string) => number | null): void {
  converter = fn;
}

const emptyBucket = (date: string): DayBucket =>
  ({ date, trades: 0, wins: 0, losses: 0, pnl: 0, fees: 0, swap: 0, margin: 0 });

const r2 = (n: number): number => Number(n.toFixed(2));

/** Closed trades from the last `days` local days, newest first. */
async function recentClosed(store: DataStore, days: number): Promise<PaperTrade[]> {
  const since = Date.now() - days * DAY_MS;
  return (await store.find<PaperTrade>('paperTrades', {}, { closeTime: -1 }, 10_000))
    .filter((t) => t.closeTime >= since);
}

export async function dailyReport(store: DataStore, account: PaperAccount | null, days = 400): Promise<DailyReport> {
  const capped = Math.min(Math.max(days, 1), 1100);
  const trades = await recentClosed(store, capped);
  const byDay = new Map<string, DayBucket>();
  for (const t of trades) {
    const key = localDayKey(t.closeTime);
    const b = byDay.get(key) ?? emptyBucket(key);
    b.trades += 1;
    if (t.pnl >= 0) b.wins += 1; else b.losses += 1;
    b.pnl += t.pnl;
    b.fees += t.fees ?? 0;
    b.swap += t.swap ?? 0;
    b.margin += tradeMargin(t, account);
    byDay.set(key, b);
  }
  for (const b of byDay.values()) {
    b.pnl = r2(b.pnl); b.fees = r2(b.fees); b.swap = r2(b.swap); b.margin = r2(b.margin);
  }
  return {
    currency: (account?.currency ?? 'USD').toUpperCase(),
    days: [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)),
    totals: {
      trades: trades.length,
      wins: trades.filter((t) => t.pnl >= 0).length,
      losses: trades.filter((t) => t.pnl < 0).length,
      pnl: r2(trades.reduce((s, t) => s + t.pnl, 0)),
      fees: r2(trades.reduce((s, t) => s + (t.fees ?? 0), 0)),
      swap: r2(trades.reduce((s, t) => s + (t.swap ?? 0), 0)),
    },
  };
}

export async function dayReport(store: DataStore, account: PaperAccount | null, date: string): Promise<DayReport | null> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const { start, end } = localDayBounds(date);
  const trades = (await store.find<PaperTrade>('paperTrades', {}, { closeTime: -1 }, 10_000))
    .filter((t) => t.closeTime >= start && t.closeTime < end)
    .sort((a, b) => a.closeTime - b.closeTime);
  return {
    currency: (account?.currency ?? 'USD').toUpperCase(),
    date,
    totals: {
      trades: trades.length,
      wins: trades.filter((t) => t.pnl >= 0).length,
      losses: trades.filter((t) => t.pnl < 0).length,
      pnl: r2(trades.reduce((s, t) => s + t.pnl, 0)),
      gross: r2(trades.reduce((s, t) => s + t.pnl + (t.fees ?? 0) - (t.swap ?? 0), 0)),
      fees: r2(trades.reduce((s, t) => s + (t.fees ?? 0), 0)),
      swap: r2(trades.reduce((s, t) => s + (t.swap ?? 0), 0)),
      margin: r2(trades.reduce((s, t) => s + tradeMargin(t, account), 0)),
      durationMsAvg: trades.length
        ? Math.round(trades.reduce((s, t) => s + (t.durationMs ?? 0), 0) / trades.length)
        : 0,
    },
    trades,
  };
}
