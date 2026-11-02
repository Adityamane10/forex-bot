/**
 * IndiaMarketDataHealthService (spec §8). Tracks WebSocket/auth/subscription
 * health, tick age, reconnects and dropped messages. When the market is
 * supposed to be open but ticks go stale → DATA_STALE, which:
 *  - stops new signals and automatic trades
 *  - shows a warning in the UI
 *  - attempts reconnect
 *  - requires healthy data before execution resumes
 * It NEVER silently switches to fake data or an old cached tick.
 */
import type { IndiaDataHealth, IndiaDataHealthState } from '@fx/shared';
import { INDIA_CHANNELS, INDIA_COLLECTIONS, INDIA_REDIS_KEYS } from '@fx/shared';
import { DataStore } from '../db/store';
import { Cache } from '../db/cache';
import { EventEmitter } from 'events';
import { indiaConfig } from './config';

export class IndiaMarketDataHealthService {
  private health: IndiaDataHealth = {
    state: 'DISCONNECTED',
    wsConnected: false,
    authenticated: false,
    subscribed: false,
    lastTickAt: null,
    lastHeartbeatAt: null,
    tickAgeMs: null,
    reconnectCount: 0,
    droppedMessages: 0,
    stale: true,
    instruments: {},
    detail: 'initialising…',
    updatedAt: Date.now(),
  };
  /** True when the session is read-only (analytics token) — WS stream won't
   *  connect but historical data is available, so MARKET_CLOSED is the right
   *  idle state rather than DISCONNECTED. */
  private readOnly = false;

  constructor(
    private store: DataStore,
    private cache: Cache,
    private events: EventEmitter,
  ) {}

  get snapshot(): IndiaDataHealth {
    return this.health;
  }

  /** True only when data is flowing AND fresh enough for trading. */
  get healthy(): boolean {
    return !this.health.stale && this.health.state === 'HEALTHY';
  }

  setWsConnected(v: boolean): void {
    this.health.wsConnected = v;
    this.update();
  }

  setAuthenticated(v: boolean): void {
    this.health.authenticated = v;
    this.update();
  }

  /** Mark this session as read-only (analytics token). Affects health evaluation:
   *  when authenticated but WS unavailable, show MARKET_CLOSED not DISCONNECTED. */
  setReadOnly(v: boolean): void {
    this.readOnly = v;
  }

  setSubscribed(instruments: string[], v: boolean): void {
    this.health.subscribed = v;
    for (const t of instruments) {
      this.health.instruments[t] = { subscribed: v, lastTickAt: this.health.instruments[t]?.lastTickAt ?? null, tickAgeMs: null };
    }
    this.update();
  }

  onTick(instrumentToken: string): void {
    this.health.lastTickAt = Date.now();
    const entry = this.health.instruments[instrumentToken];
    if (entry) entry.lastTickAt = Date.now();
    else this.health.instruments[instrumentToken] = { subscribed: true, lastTickAt: Date.now(), tickAgeMs: 0 };
    this.update();
  }

  onHeartbeat(): void {
    this.health.lastHeartbeatAt = Date.now();
    this.update();
  }

  onReconnect(): void {
    this.health.reconnectCount += 1;
    this.health.wsConnected = true;
    this.update();
  }

  onDroppedMessages(n: number): void {
    this.health.droppedMessages += n;
    this.update();
  }

  /** Periodic evaluation — called on a timer; market-open check passed in. */
  async evaluate(marketOpen: boolean): Promise<void> {
    const now = Date.now();
    const lastTick = this.health.lastTickAt;
    const age = lastTick ? now - lastTick : null;
    this.health.tickAgeMs = age;
    for (const [token, entry] of Object.entries(this.health.instruments)) {
      entry.tickAgeMs = entry.lastTickAt ? now - entry.lastTickAt : null;
      void token;
    }

    if (!this.health.authenticated) {
      this.setHealthState('AUTH_FAILED', 'broker authentication missing or failed');
      return;
    }
    if (!marketOpen) {
      // Authenticated (including read-only analytics token) + market closed →
      // show MARKET_CLOSED. Historical candles are available; charts load fine.
      this.setHealthState('MARKET_CLOSED', 'Indian market is closed (09:15–15:30 IST)');
      return;
    }
    if (!this.health.wsConnected) {
      // Transport down but DATA FLOWING (REST-poll credentials like the Upstox
      // analytics token / Angel One): judge by evidence, not by transport. A
      // fresh tick is worth more than a socket flag.
      const restAge = this.health.lastTickAt ? now - this.health.lastTickAt : null;
      if (restAge !== null && restAge <= indiaConfig.tickStaleMs) {
        this.setHealthState('HEALTHY', 'real-time data via REST poll');
        return;
      }
      if (this.readOnly) {
        // Analytics token: can't stream, but REST data is valid
        this.setHealthState('MARKET_CLOSED', 'read-only token — REST data active, live stream unavailable');
      } else {
        this.setHealthState('DISCONNECTED', 'market data websocket disconnected');
      }
      return;
    }
    if (age === null) {
      this.setHealthState('STALE', 'no ticks received since startup');
      return;
    }
    if (age > indiaConfig.tickStaleMs) {
      this.setHealthState('STALE', `last tick ${age}ms ago (threshold ${indiaConfig.tickStaleMs}ms)`);
      return;
    }
    this.setHealthState('HEALTHY', 'real-time feed healthy');
  }

  private setHealthState(state: IndiaDataHealthState, detail: string): void {
    const prev = this.health.state;
    this.health.state = state;
    this.health.stale = state !== 'HEALTHY';
    this.health.detail = detail;
    this.health.updatedAt = Date.now();
    this.emit();
    if (prev !== state) {
      this.store
        .insertOne(INDIA_COLLECTIONS.sessions, { state, detail, updatedAt: Date.now() })
        .catch(() => undefined);
    }
  }

  private update(): void {
    this.health.updatedAt = Date.now();
    this.emit();
  }

  private emit(): void {
    const snapshot = { ...this.health };
    this.events.emit(INDIA_CHANNELS.dataHealth, snapshot);
    this.cache
      .set(INDIA_REDIS_KEYS.dataHealth + 'current', JSON.stringify(snapshot), 60_000)
      .catch(() => undefined);
  }
}