/**
 * IndiaExecutionAuthorityManager (spec §36). Exactly ONE owner (GOAL or
 * UNIVERSAL) holds execution authority at a time. When GOAL owns execution,
 * universal signals are signal-only; when UNIVERSAL owns it, goal trading is
 * paused. Authority changes are audited and broadcast, and no other engine
 * (Forex/Crypto) is affected.
 */
import type { IndiaExecutionAuthorityState, IndiaExecutionMode, IndiaExecutionOwner } from '@fx/shared';
import { INDIA_CHANNELS, INDIA_REDIS_KEYS } from '@fx/shared';
import { DataStore } from '../db/store';
import { Cache } from '../db/cache';
import { EventEmitter } from 'events';

export interface IndiaExecutionAuthorityOptions {
  store: DataStore;
  cache: Cache;
  events: EventEmitter;
}

export class IndiaExecutionAuthorityManager {
  private state: IndiaExecutionAuthorityState = {
    owner: 'NONE',
    updatedAt: Date.now(),
    lastReason: 'initialized — no execution authority granted',
    goal: { executionMode: 'OFF' },
    universal: { executionMode: 'OFF' },
  };

  constructor(private opts: IndiaExecutionAuthorityOptions) {}

  async init(): Promise<void> {
    try {
      // Broadcasts append one document per state change; "latest" must be
      // decided by timestamp. Natural order is not insertion order in MongoDB,
      // and trusting it loaded a YESTERDAY's snapshot after a restart — the
      // UI showed an owner that no longer existed and engines resumed against
      // stale authority.
      const stored = await this.opts.store.find<IndiaExecutionAuthorityState & { _id?: unknown }>(
        INDIA_CHANNELS.executionAuthority, {}, { updatedAt: -1 }, 1,
      );
      const latest = stored[0] as unknown as Record<string, unknown> | undefined;
      if (latest) {
        const { _id, ...rest } = latest;
        this.state = rest as unknown as IndiaExecutionAuthorityState;
      }
    } catch {
      /* collection may not exist */
    }
  }

  snapshot(): IndiaExecutionAuthorityState {
    return { ...this.state, goal: { ...this.state.goal }, universal: { ...this.state.universal } };
  }

  setGoalMode(mode: IndiaExecutionMode, reason: string): void {
    this.state.goal.executionMode = mode;
    if (mode === 'OFF' && this.state.owner === 'GOAL') {
      this.release('GOAL', reason);
    }
    this.broadcast(reason);
  }

  setUniversalMode(mode: IndiaExecutionMode, reason: string): void {
    this.state.universal.executionMode = mode;
    if (mode === 'OFF' && this.state.owner === 'UNIVERSAL') {
      this.release('UNIVERSAL', reason);
    }
    this.broadcast(reason);
  }

  /** Request authority for an owner. Returns false if another owner holds it
   *  or the owner's executionMode is OFF/MANUAL (a user-disabled goal must not
   *  auto-trade on restart or on a stray acquire() call). */
  acquire(owner: 'GOAL' | 'UNIVERSAL', reason: string): boolean {
    if (this.state.owner !== 'NONE' && this.state.owner !== owner) {
      this.opts.events.emit(INDIA_CHANNELS.executionAuthority, {
        ...this.state,
        lastReason: `acquisition denied: ${owner} blocked by ${this.state.owner}`,
      });
      return false;
    }
    const mode = owner === 'GOAL' ? this.state.goal.executionMode : this.state.universal.executionMode;
    if (mode === 'OFF') return false;
    this.state.owner = owner;
    this.broadcast(reason);
    return true;
  }

  /** Release authority (owner done / stopped). */
  release(owner: 'GOAL' | 'UNIVERSAL', reason: string): void {
    if (this.state.owner === owner) {
      this.state.owner = 'NONE';
      if (owner === 'GOAL') this.state.goal.executionMode = 'OFF';
      if (owner === 'UNIVERSAL') this.state.universal.executionMode = 'OFF';
      this.broadcast(reason);
    }
  }

  canExecute(owner: 'GOAL' | 'UNIVERSAL'): { allowed: boolean; reason: string } {
    if (this.state.owner !== owner) {
      return { allowed: false, reason: `${this.state.owner} owns execution authority` };
    }
    const mode = owner === 'GOAL' ? this.state.goal.executionMode : this.state.universal.executionMode;
    if (mode !== 'AUTO') return { allowed: false, reason: `${owner} execution mode is ${mode}` };
    return { allowed: true, reason: 'ok' };
  }

  private broadcast(reason: string): void {
    this.state.updatedAt = Date.now();
    this.state.lastReason = reason;
    const snap = this.snapshot();
    this.opts.events.emit(INDIA_CHANNELS.executionAuthority, snap);
    this.opts.cache
      .set(INDIA_REDIS_KEYS.market + 'execution-authority', JSON.stringify(snap), 86_400_000)
      .catch(() => undefined);
    this.opts.store
      .insertOne(INDIA_CHANNELS.executionAuthority, snap)
      .catch(() => undefined);
  }
}