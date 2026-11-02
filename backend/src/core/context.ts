import { EventEmitter } from 'events';
import { DataStore } from '../db/store';
import { Cache } from '../db/cache';
import { ProviderRegistry } from '../providers/types';
import { AuditLogger } from './audit';

/**
 * Shared context passed to every engine. Keeps engines decoupled: they
 * communicate through the store, cache, provider registry and event bus.
 */
export interface FxContext {
  store: DataStore;
  cache: Cache;
  providers: ProviderRegistry;
  events: EventEmitter;
  audit: AuditLogger;
  /** In-memory live state (latest tick / candle buffers) keyed per engine. */
  live: Map<string, unknown>;
}

export const CHANNELS = {
  tick: 'market.price',
  candle: 'market.candle',
  indicator: 'indicator.update',
  signalCreated: 'signal.created',
  signalUpdated: 'signal.updated',
  signalInvalidated: 'signal.invalidated',
  signalMissed: 'signal.missed',
  signalState: 'signal.state',
  position: 'paper.position',
  trade: 'paper.trade',
  risk: 'risk.update',
  news: 'news.update',
  calendar: 'calendar.update',
  system: 'system.status',
  alert: 'alert',
  /** Broker account binding + resolved trading conditions (realtime). */
  broker: 'broker.profile',
} as const;
