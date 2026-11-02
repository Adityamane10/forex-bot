import { ForexSession, SessionSnapshot, assetClassFor } from '@fx/shared';

/** Forex session detection in UTC. */
export function utcHourAt(ts: number): number {
  const d = new Date(ts);
  return d.getUTCHours();
}

/**
 * Sessions active at `ts`, most significant first (overlap before its
 * components). Empty when no named session is live — callers decide what
 * "off hours" means for them. Windows are fixed-UTC approximations of the
 * DST-shifting local sessions (London 07–16 = BST, NY 12–21 = EDT).
 */
export function activeSessions(ts: number): ForexSession[] {
  const h = utcHourAt(ts);
  const out: ForexSession[] = [];
  const inWindow = (start: number, end: number): boolean => (start <= end ? h >= start && h < end : h >= start || h < end);
  if (inWindow(12, 16)) out.push('LONDON_NEW_YORK_OVERLAP');
  if (inWindow(7, 16)) out.push('LONDON');
  if (inWindow(12, 21)) out.push('NEW_YORK');
  if (inWindow(0, 9)) out.push('TOKYO');
  if (inWindow(21, 6)) out.push('SYDNEY');
  return out;
}

/** Primary session label for snapshots/attribution ('OFF_HOURS' when none). */
export function primarySession(ts: number): ForexSession {
  return activeSessions(ts)[0] ?? 'OFF_HOURS';
}

export function sessionSnapshot(ts: number): SessionSnapshot {
  return { session: primarySession(ts), utcHour: utcHourAt(ts), active: true };
}

export function isPreferredSession(ts: number, preferred: ForexSession[]): boolean {
  if (!preferred.length) return true;
  const active = activeSessions(ts);
  return active.some((s) => preferred.includes(s));
}

/** Baseline session liquidity/volatility weighting (descriptive, not normative). */
export function sessionMultiplier(session: ForexSession): number {
  switch (session) {
    case 'LONDON_NEW_YORK_OVERLAP':
      return 1.3;
    case 'LONDON':
    case 'NEW_YORK':
      return 1.1;
    case 'TOKYO':
    case 'SYDNEY':
      return 0.8;
    default:
      return 0.6;
  }
}

/** UTC weekend check (Phase 1): Saturday/Sunday. */
export function isWeekend(ts: number): boolean {
  const d = new Date(ts);
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}

/**
 * The real FX week: the market closes Friday ~22:00 UTC (5pm New York,
 * DST-approximated) and reopens Sunday ~22:00 UTC. Calendar-weekend checks
 * alone wrongly trade a dead Friday night and block the Sunday reopen.
 */
export function isFxMarketClosed(ts: number): boolean {
  const d = new Date(ts);
  const day = d.getUTCDay();
  const hour = d.getUTCHours() + d.getUTCMinutes() / 60;
  if (day === 6) return true; // Saturday
  if (day === 5 && hour >= 22) return true; // Friday night after NY close
  if (day === 0 && hour < 22) return true; // Sunday before the reopen
  return false;
}

/**
 * Weekend-gap risk window (FXBot adoption — flatten before the Friday close):
 * from 20:00 UTC Friday (2h before the ~22:00 UTC FX close) through the Sunday
 * reopen. Holding leveraged positions across the weekly gap pays swap twice,
 * gaps past stops, and opens Monday against you — pro platforms flatten.
 */
export function isWeekendGapRiskWindow(ts: number): boolean {
  const d = new Date(ts);
  const day = d.getUTCDay();
  const hour = d.getUTCHours() + d.getUTCMinutes() / 60;
  if (day === 5 && hour >= 20) return true; // Friday from 20:00 UTC
  if (day === 6) return true; // Saturday
  if (day === 0 && hour < 22) return true; // Sunday before the reopen
  return false;
}

export interface MarketState {
  session: ForexSession;
  /** Forex: weekend closure / outside configured windows. Crypto: 24/7. */
  isTradable: boolean;
  marketOpen: boolean;
  marketClosed: boolean;
  isWeekend: boolean;
  sessionStart: number;
  sessionEnd: number;
}

/**
 * Market-state engine (Phase 1, 3). Forex has defined sessions and follows the
 * real FX week (Fri 22:00 UTC → Sun 22:00 UTC closed, configurable via
 * `weekendTradingEnabled`); crypto trades 24/7 and must never be gated by
 * forex session rules. `preferredSessions` (when non-empty) restricts forex
 * trading to the configured sessions.
 */
export function marketState(
  symbol: string,
  ts: number,
  opts: { weekendTradingEnabled?: boolean; preferredSessions?: ForexSession[] } = {},
): MarketState {
  let isCrypto = false;
  try {
    isCrypto = assetClassFor(symbol) === 'CRYPTO';
  } catch {
    // Unknown symbols default to forex gating (conservative).
  }
  const weekend = isWeekend(ts);
  const active = activeSessions(ts);
  const session = primarySession(ts);

  if (isCrypto) {
    return {
      session,
      isTradable: true,
      marketOpen: true,
      marketClosed: false,
      isWeekend: weekend,
      sessionStart: ts - 3600_000,
      sessionEnd: ts + 3600_000,
    };
  }

  const preferred = opts.preferredSessions ?? [];
  const inPreferred = preferred.length === 0 || active.some((s) => preferred.includes(s));
  const marketClosedWindow = isFxMarketClosed(ts) && !(opts.weekendTradingEnabled ?? false);
  const tradable = inPreferred && !marketClosedWindow;
  return {
    session,
    isTradable: tradable,
    marketOpen: tradable,
    marketClosed: !tradable,
    isWeekend: weekend,
    sessionStart: ts - 3600_000,
    sessionEnd: ts + 3600_000,
  };
}
