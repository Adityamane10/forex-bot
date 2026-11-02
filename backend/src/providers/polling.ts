/**
 * Adaptive polling scheduler. Assigns each symbol a poll interval so the
 * aggregate request rate never exceeds a provider's free-tier budget, while
 * hot symbols (active signals / strong candidates) are polled as fast as the
 * provider allows. Pure function — unit tested.
 */

export interface PollBudget {
  /** Total requests allowed per minute across all symbols. */
  budgetPerMinute: number;
  /** Fastest interval for high-priority symbols (ms). */
  activeIntervalMs: number;
  /** Slowest interval for idle symbols (ms). */
  idleIntervalMs: number;
}

/**
 * @param symbols all symbols to poll
 * @param weights symbol -> priority (0 = idle, higher = hotter). Missing = 0.
 * @returns symbol -> poll interval ms
 */
export function scheduleIntervals(
  symbols: string[],
  weights: Record<string, number>,
  budget: PollBudget,
): Record<string, number> {
  if (symbols.length === 0) return {};
  const { budgetPerMinute, activeIntervalMs, idleIntervalMs } = budget;
  const activeMs = Math.max(1_000, activeIntervalMs);
  const idleMs = Math.max(activeMs, idleIntervalMs);

  const costPerMinute = (intervalMs: number) => 60_000 / Math.max(1, intervalMs);
  const totalIdleCost = symbols.length * costPerMinute(idleMs);

  // Start everyone at the idle interval. If even that exceeds the budget, slow
  // idle down (honest: fewer refreshes per minute beats breaking the limit).
  let idle = idleMs;
  while (totalIdleCost > budgetPerMinute && idle < 3_600_000) {
    idle = Math.round(idle * 1.5);
    if (costPerMinute(idle) * symbols.length <= budgetPerMinute) break;
  }

  const out: Record<string, number> = {};
  let budgetLeft = budgetPerMinute - symbols.length * costPerMinute(idle);
  for (const s of symbols) out[s] = idle;

  // Upgrade hottest symbols to the active interval while budget remains.
  const ordered = [...symbols].sort((a, b) => (weights[b] ?? 0) - (weights[a] ?? 0));
  for (const s of ordered) {
    if ((weights[s] ?? 0) <= 0) continue;
    // Upgrading to the fast interval costs more per minute (negative saving);
    // it is allowed only while the aggregate budget has room.
    const saving = costPerMinute(idle) - costPerMinute(activeMs);
    if (budgetLeft + saving >= 0) {
      out[s] = activeMs;
      budgetLeft += saving;
    }
  }
  return out;
}
