/**
 * Pure paper-execution math (spec §40-41, §34). No dependencies — fully
 * unit-testable. Paper fills are never perfect: BUY fills above the ask,
 * SELL fills below the bid, and daily/weekly loss windows roll on UTC
 * boundaries so the risk circuit breakers see real account state.
 */

export const DAY_MS = 86400_000;
export const WEEK_MS = 7 * DAY_MS;

/**
 * Apply slippage to a fill price. BUY pays more (worse than the ask),
 * SELL receives less (worse than the bid). bps = basis points (1/100 of 1%).
 */
export function applySlippage(direction: 'BUY' | 'SELL', price: number, slippageBps: number): number {
  const bps = Math.max(0, slippageBps) / 10000;
  return direction === 'BUY' ? price * (1 + bps) : price * (1 - bps);
}

/** UTC day window key — a new key means the daily counter must roll. */
export function dayWindowKey(t: number): number {
  return Math.floor(t / DAY_MS);
}

/** UTC Monday-based week window key — a new key means the weekly counter rolls. */
export function weekWindowKey(t: number): number {
  const d = new Date(t);
  const dayOfWeek = (d.getUTCDay() + 6) % 7; // 0 = Monday
  const startOfDay = t - (d.getUTCHours() * 3600_000 + d.getUTCMinutes() * 60_000 + d.getUTCSeconds() * 1000 + d.getUTCMilliseconds());
  return Math.floor((startOfDay - dayOfWeek * DAY_MS) / WEEK_MS);
}

/**
 * Roll a windowed P&L counter across a UTC boundary.
 * Returns the counter value that applies at `now` plus the reset timestamp.
 */
export function rollWindow(
  counter: number,
  lastResetAt: number,
  now: number,
  windowKey: (t: number) => number,
): { value: number; resetAt: number } {
  if (lastResetAt <= 0 || windowKey(now) !== windowKey(lastResetAt)) {
    return { value: 0, resetAt: now };
  }
  return { value: counter, resetAt: lastResetAt };
}

/**
 * Goal progress for the paper wallet (INR-native when the account is INR).
 *
 * Semantics match the India Goal engine: the goal is measured against
 * CUMULATIVE NET P&L (realized + floating), never gross, and reaching it
 * pauses NEW automatic entries. Manual execution always stays available —
 * pausing is a data-derived state, not a flag someone flips, so raising the
 * target (or a losing open position) re-enables auto trading on its own.
 */
export interface GoalProgressInput {
  /** Profit target in the ACCOUNT currency (USD on an XM forex account). */
  target: number;
  realized: number;
  unrealized: number;
  /** Session cap on CLOSED trades (null/undefined = unlimited). */
  maxTrades?: number | null;
  /** Closed trades counted since the goal session's baseline. */
  tradesDone?: number;
}

export interface GoalProgress {
  target: number;
  realized: number;
  unrealized: number;
  total: number;
  remaining: number;
  achieved: boolean;
  /** True when the goal is set (>0) and reached: auto entries must pause. */
  autoPaused: boolean;
  percent: number;
  /** Session trade-cap accounting (§ goal). */
  maxTrades?: number | null;
  tradesDone?: number;
  tradesExhausted?: boolean;
}

export function computeGoalProgress(input: GoalProgressInput): GoalProgress {
  const target = Math.max(0, input.target);
  const total = input.realized + input.unrealized;
  const remaining = Math.max(0, target - total);
  const achieved = target > 0 && total >= target;

  const maxTrades = input.maxTrades ?? null;
  const tradesDone = input.tradesDone ?? 0;
  // Exhausted only counts when a real cap exists AND there is something to
  // count — a brand-new baseline starts everyone at zero attempts.
  const tradesExhausted = maxTrades != null && maxTrades > 0 && input.tradesDone != null
    ? tradesDone >= maxTrades
    : false;

  return {
    target,
    realized: input.realized,
    unrealized: input.unrealized,
    total,
    remaining,
    achieved,
    autoPaused: achieved || tradesExhausted,
    percent: target > 0 ? Math.max(0, Math.min(100, (total / target) * 100)) : 0,
    maxTrades,
    tradesDone,
    tradesExhausted,
  };
}
