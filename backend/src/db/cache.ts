import Redis from 'ioredis';
import { EventEmitter } from 'events';
import { config, hasRedis } from '../config';

export interface Cache {
  backend: 'redis' | 'in-memory';
  status: 'HEALTHY' | 'DOWN';
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs?: number): Promise<void>;
  del(key: string): Promise<void>;
  /** Pub/sub: subscribe to a channel. Returns an unsubscribe function. */
  subscribe(channel: string, handler: (message: string) => void): Promise<() => void>;
  publish(channel: string, message: string): Promise<void>;
}

class InMemoryCache implements Cache {
  backend = 'in-memory' as const;
  status: 'HEALTHY' | 'DOWN' = 'HEALTHY';
  private map = new Map<string, { value: string; expiresAt: number | null }>();
  private emitter = new EventEmitter();

  async connect(): Promise<void> {
    this.status = 'HEALTHY';
  }
  async disconnect(): Promise<void> {
    this.map.clear();
    this.status = 'DOWN';
  }
  private sweep(): void {
    const now = Date.now();
    for (const [k, v] of this.map) {
      if (v.expiresAt !== null && v.expiresAt <= now) this.map.delete(k);
    }
  }
  async get(key: string): Promise<string | null> {
    this.sweep();
    const v = this.map.get(key);
    return v ? v.value : null;
  }
  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    this.map.set(key, { value, expiresAt: ttlMs ? Date.now() + ttlMs : null });
  }
  async del(key: string): Promise<void> {
    this.map.delete(key);
  }
  async subscribe(channel: string, handler: (m: string) => void): Promise<() => void> {
    this.emitter.on(channel, handler);
    return () => this.emitter.off(channel, handler);
  }
  async publish(channel: string, message: string): Promise<void> {
    this.emitter.emit(channel, message);
  }
}

class RedisCache implements Cache {
  backend = 'redis' as const;
  status: 'HEALTHY' | 'DOWN' = 'DOWN';
  private client: Redis | null = null;

  async connect(): Promise<void> {
    try {
      this.client = new Redis(config.redisUrl, {
        maxRetriesPerRequest: 1,
        connectTimeout: 4000,
        lazyConnect: false,
      });
      await new Promise<void>((resolve, reject) => {
        const onReady = () => {
          cleanup();
          resolve();
        };
        const onError = (err: Error) => {
          cleanup();
          reject(err);
        };
        const cleanup = () => {
          this.client?.off('ready', onReady);
          this.client?.off('error', onError);
        };
        this.client?.once('ready', onReady);
        this.client?.once('error', onError);
      });
      this.status = 'HEALTHY';
    } catch (err) {
      this.status = 'DOWN';
      await this.client?.quit().catch(() => undefined);
      this.client = null;
      throw err;
    }
  }
  async disconnect(): Promise<void> {
    await this.client?.quit().catch(() => undefined);
    this.client = null;
    this.status = 'DOWN';
  }
  private requireClient(): Redis {
    if (!this.client) throw new Error('Redis not connected');
    return this.client;
  }
  async get(key: string): Promise<string | null> {
    return this.requireClient().get(key);
  }
  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    if (ttlMs) await this.requireClient().set(key, value, 'PX', ttlMs);
    else await this.requireClient().set(key, value);
  }
  async del(key: string): Promise<void> {
    await this.requireClient().del(key);
  }
  async subscribe(channel: string, handler: (m: string) => void): Promise<() => void> {
    const sub = this.requireClient().duplicate();
    await sub.subscribe(channel);
    sub.on('message', (_ch, message) => handler(message));
    return async () => {
      await sub.unsubscribe(channel);
      sub.disconnect();
    };
  }
  async publish(channel: string, message: string): Promise<void> {
    await this.requireClient().publish(channel, message);
  }
}

export async function createCache(): Promise<Cache> {
  if (hasRedis) {
    const cache: Cache = new RedisCache();
    try {
      await cache.connect();
      return cache;
    } catch (err) {
      console.warn(`[cache] Redis connect failed (${String(err)}) — falling back to in-memory cache`);
      const memory: Cache = new InMemoryCache();
      await memory.connect();
      return memory;
    }
  }
  const cache: Cache = new InMemoryCache();
  await cache.connect();
  return cache;
}
