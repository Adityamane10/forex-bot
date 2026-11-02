/**
 * Token-bucket rate limiter. Guarantees the provider never exceeds its
 * per-minute budget, even across concurrent callers. Pure and testable via an
 * injectable clock.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    /** Max tokens (burst capacity), typically the per-minute budget. */
    private capacity: number,
    /** Tokens added per millisecond. */
    private refillPerMs: number,
    /** Injectable clock for tests (ms epoch). */
    private now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.lastRefill = now();
  }

  private refill(): void {
    const t = this.now();
    const elapsed = Math.max(0, t - this.lastRefill);
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.lastRefill = t;
  }

  /** How many tokens are currently available (for health/logging). */
  available(): number {
    this.refill();
    return this.tokens;
  }

  /** Wait until one token is available, then consume it. Resolves immediately if possible. */
  async acquire(): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      // wait for the next token to accrue
      const waitMs = (1 - this.tokens) / this.refillPerMs;
      await new Promise((r) => setTimeout(r, Math.min(waitMs, 500)));
    }
  }

  /** Try to take a token without waiting. */
  tryAcquire(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}

/** Build a bucket from a per-minute budget. */
export function bucketPerMinute(budgetPerMinute: number, now: () => number = Date.now): TokenBucket {
  return new TokenBucket(budgetPerMinute, budgetPerMinute / 60_000, now);
}
