import { MongoClient, Collection, Db, Document } from 'mongodb';
import * as fs from 'fs';
import * as path from 'path';
import { config, hasMongo } from '../config';
import { QueryFilter, SortSpec, UpdateDoc, matchesFilter, applySort, applyUpdate } from './query';

export interface DataStore {
  backend: 'mongodb' | 'in-memory';
  status: 'HEALTHY' | 'DOWN';
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  insertOne<T>(collection: string, doc: T): Promise<void>;
  insertMany<T>(collection: string, docs: T[]): Promise<void>;
  /** Bulk idempotent upsert keyed by the given fields (deep candle history
   *  ingest). Returns the number of rows written. */
  bulkUpsert<T>(collection: string, docs: T[], keyFields: string[]): Promise<number>;
  find<T>(collection: string, filter?: QueryFilter, sort?: SortSpec, limit?: number): Promise<T[]>;
  findOne<T>(collection: string, filter?: QueryFilter): Promise<T | null>;
  updateOne<T>(collection: string, filter: QueryFilter, update: UpdateDoc, upsert?: boolean): Promise<void>;
  deleteMany(collection: string, filter?: QueryFilter): Promise<number>;
  count(collection: string, filter?: QueryFilter): Promise<number>;
  distinct(collection: string, field: string, filter?: QueryFilter): Promise<unknown[]>;
}

// ---------------------------------------------------------------------------
// In-memory backend (development / no-Mongo environments). Account-critical
// collections (settings, wallet, positions, trades, signals) are persisted to
// a JSON file so backend restarts do NOT wipe the wallet; bulk/streaming data
// (candles, snapshots) stays ephemeral.
// ---------------------------------------------------------------------------

/** Collections written to the store file (small, stateful, restart-critical).
 *  `users` is included so daily restarts never log anyone out or orphan
 *  accounts — the frontend auto-signs-in with its stored token, and a wiped
 *  user table would 401 every request after every restart. */
const PERSIST_COLLECTIONS = new Set(['users', 'userSettings', 'paperAccounts', 'paperPositions', 'paperTrades', 'signals', 'signalEvents', 'Mt5MirrorCommands']);
/** Per-collection caps applied at flush time — signals/paperTrades used to
 *  grow unbounded in the JSON store until every save rewrote megabytes. */
const PERSIST_CAPS: Record<string, number> = {
  paperTrades: 20_000,
  signals: 20_000,
  signalEvents: 50_000,
  // Accounts and their users are tiny and must never be trimmed.
  users: Infinity,
  paperAccounts: Infinity,
  paperPositions: Infinity,
  userSettings: Infinity,
  // Mirror-command audit trail: newest 500 is plenty for reconciliation.
  Mt5MirrorCommands: 500,
};

/**
 * Persistence is OPT-IN via STORE_FILE (tests and ephemeral runs stay purely
 * in-memory). Read lazily in createStore() so a vitest setup file can disable
 * it before the container is constructed.
 */
function storeFilePath(): string | null {
  const v = process.env.STORE_FILE;
  if (!v || v.trim() === '') return null;
  return path.resolve(v);
}

class MemoryStore implements DataStore {
  backend = 'in-memory' as const;
  status: 'HEALTHY' | 'DOWN' = 'HEALTHY';
  private maps = new Map<string, Array<Record<string, unknown>>>();
  private seq = 0;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Flush machinery: an in-flight async write must not overlap itself. */
  private flushing = false;
  private flushAgain = false;

async connect(): Promise<void> {
    this.status = 'HEALTHY';
    // Restore the wallet/state collections from the store file if present.
    const file = storeFilePath();
    if (!file) return;
    if (this.flushing) { this.flushAgain = true; return; }
    this.flushing = true;
    console.log(`[store] file persistence active: ${file}`);
    try {
      if (fs.existsSync(file)) {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as {
          seq: number;
          collections: Record<string, Array<Record<string, unknown>>>;
        };
        this.seq = raw.seq ?? 0;
        for (const [name, docs] of Object.entries(raw.collections ?? {})) {
          if (PERSIST_COLLECTIONS.has(name) && Array.isArray(docs)) this.maps.set(name, docs);
        }
      }
    } catch (err) {
      /* corrupt store file: start fresh rather than crash the backend */
    }
  }
  async disconnect(): Promise<void> {
    await this.flush();
  }
  private coll<T>(name: string): Array<Record<string, unknown>> {
    let c = this.maps.get(name);
    if (!c) {
      c = [];
      this.maps.set(name, c);
    }
    return c;
  }
  /** Debounced write of the stateful collections to the store file. */
  private dirty(collection: string): void {
    if (!PERSIST_COLLECTIONS.has(collection)) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = // 2s debounce: goal signals re-mark far more often than persistence needs
    // to be that fresh, and every flush serializes the whole stateful store.
    setTimeout(() => void this.flush(), 2000);
  }

  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
const file = storeFilePath();
    if (!file) return;
    try {
      const collections: Record<string, Array<Record<string, unknown>>> = {};
      for (const name of PERSIST_COLLECTIONS) {
        const arr = this.maps.get(name);
        if (arr && arr.length) {
          let docs = arr;
          const cap = PERSIST_CAPS[name];
          if (cap && arr.length > cap) docs = docs.slice(docs.length - cap);
          // Goal signals append a state event per tick re-mark; docs created
          // before that array was bounded must not re-inflate the file.
          if (name === 'signals') {
            docs = docs.map((d) => {
              const ev = (d as { events?: unknown[] }).events;
              return Array.isArray(ev) && ev.length > 50
                ? { ...d, events: ev.slice(-50) }
                : d;
            });
          }
          collections[name] = docs;
        }
      }
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      // ASYNC write: a synchronous write of a multi-hundred-MB payload froze
      // the event loop for seconds - live MT5 tick pushes timed out and the
      // dashboard went stale mid-stream. Also guarded against overlapping runs.
      await fs.promises.writeFile(tmp, JSON.stringify({ seq: this.seq, collections }));
      await fs.promises.rename(tmp, file);
} catch (err) {
      console.error('[store] flush failed', String(err));
      /* persistence is best-effort; never crash the trading loop */
    } finally {
      this.flushing = false;
      if (this.flushAgain) {
        this.flushAgain = false;
        this.saveTimer = setTimeout(() => void this.flush(), 2000);
      }
    }
  }

  async insertOne<T>(collection: string, doc: T): Promise<void> {
    this.coll(collection).push({ ...(doc as Record<string, unknown>), __id: ++this.seq });
    this.dirty(collection);
  }
  async bulkUpsert<T>(collection: string, docs: T[], keyFields: string[]): Promise<number> {
    const arr = this.coll(collection);
    const index = new Map<string, number>();
    arr.forEach((d, i) => {
      const k = keyFields.map((f) => String((d as Record<string, unknown>)[f])).join('|');
      index.set(k, i);
    });
    for (const doc of docs) {
      const k = keyFields.map((f) => String((doc as Record<string, unknown>)[f])).join('|');
      const idx = index.get(k);
      if (idx !== undefined) arr[idx] = { ...(doc as Record<string, unknown>), __id: arr[idx].__id };
      else {
        arr.push({ ...(doc as Record<string, unknown>), __id: ++this.seq });
        index.set(k, arr.length - 1);
      }
    }
    this.dirty(collection);
    return docs.length;
  }
  async insertMany<T>(collection: string, docs: T[]): Promise<void> {
    for (const d of docs) await this.insertOne(collection, d);
  }
  async find<T>(collection: string, filter?: QueryFilter, sort?: SortSpec, limit?: number): Promise<T[]> {
    let out = this.coll(collection).filter((d) => (filter ? matchesFilter(d, filter) : true));
    out = applySort(out, sort);
    // Hard cap: a NaN/absent limit must never serialize an entire collection.
    const lim = limit && limit > 0 && Number.isFinite(limit) ? Math.min(limit, 10_000) : Math.min(10_000, out.length);
    if (out.length > lim) out = out.slice(0, lim);
    return out as T[];
  }
  async findOne<T>(collection: string, filter?: QueryFilter): Promise<T | null> {
    const r = await this.find<T>(collection, filter);
    return r.length ? r[0] : null;
  }
  async updateOne<T>(collection: string, filter: QueryFilter, update: UpdateDoc, upsert = false): Promise<void> {
    const arr = this.coll(collection);
    const idx = arr.findIndex((d) => matchesFilter(d, filter));
    if (idx >= 0) {
      arr[idx] = applyUpdate(arr[idx], update);
    } else if (upsert) {
      const base: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(filter)) base[k] = v;
      arr.push(applyUpdate(base, update));
    }
    this.dirty(collection);
  }
  async deleteMany(collection: string, filter?: QueryFilter): Promise<number> {
    const arr = this.coll(collection);
    const before = arr.length;
    const kept = arr.filter((d) => (filter ? !matchesFilter(d, filter) : false));
    this.maps.set(collection, kept);
    if (kept.length !== before) this.dirty(collection);
    return before - kept.length;
  }
  async count(collection: string, filter?: QueryFilter): Promise<number> {
    return this.coll(collection).filter((d) => (filter ? matchesFilter(d, filter) : true)).length;
  }
  async distinct(collection: string, field: string, filter?: QueryFilter): Promise<unknown[]> {
    const seen = new Set<unknown>();
    for (const d of this.coll(collection)) {
      if (filter && !matchesFilter(d, filter)) continue;
      seen.add((d as Record<string, unknown>)[field]);
    }
    return [...seen];
  }
}

// ---------------------------------------------------------------------------
// MongoDB backend
// ---------------------------------------------------------------------------

class MongoStore implements DataStore {
  backend = 'mongodb' as const;
  status: 'HEALTHY' | 'DOWN' = 'DOWN';
  private client: MongoClient | null = null;
  private db: Db | null = null;
  private collections = new Map<string, Collection<Document>>();

  async connect(): Promise<void> {
    try {
      this.client = new MongoClient(config.mongodbUri, { serverSelectionTimeoutMS: 4000 });
      // Track runtime health — the status used to stay HEALTHY forever even
      // after a mid-session outage, so /ready lied while every op threw.
      this.client.on('serverHeartbeatSucceeded', () => { this.status = 'HEALTHY'; });
      this.client.on('serverHeartbeatFailed', () => { this.status = 'DOWN'; });
      await this.client.connect();
      this.db = this.client.db();
      await this.db.command({ ping: 1 });
      this.status = 'HEALTHY';
      await this.ensureIndexes();
    } catch (err) {
      this.status = 'DOWN';
      throw err;
    }
  }
  async disconnect(): Promise<void> {
    await this.client?.close();
    this.client = null;
    this.status = 'DOWN';
  }
  private coll(name: string): Collection<Document> {
    if (!this.db) throw new Error('Mongo not connected');
    let c = this.collections.get(name);
    if (!c) {
      c = this.db.collection(name);
      this.collections.set(name, c);
    }
    return c;
  }
  private async ensureIndexes(): Promise<void> {
    if (!this.db) return;
    // [collection, spec, unique?] — users.email MUST be unique: the
    // check-then-insert register flow raced into duplicate accounts.
    const defs: Array<[string, Record<string, 1 | -1>, boolean?]> = [
      ['candles', { symbol: 1, timeframe: 1, openTime: -1 }],
      ['marketSnapshots', { symbol: 1, timestamp: -1 }],
      ['signals', { timestamp: -1 }],
      ['signals', { symbol: 1, state: 1 }],
      ['signalEvents', { signalId: 1, timestamp: -1 }],
      ['signalSnapshots', { signalId: 1 }],
      ['news', { timestamp: -1 }],
      ['news', { dedupeKey: 1 }],
      ['economicEvents', { timestamp: 1 }],
      ['paperTrades', { closeTime: -1 }],
      ['paperTrades', { symbol: 1, closeTime: -1 }],
      // One mirror command per id: the check-then-insert in queueOpen raced
      // into duplicate docs sharing a commandId, and the stray PENDING copy
      // was re-executed by the worker forever (duplicate MT5 orders).
      ['Mt5MirrorCommands', { commandId: 1 }, true],
      ['modelVersions', { createdAt: -1 }],
      ['datasets', { createdAt: -1 }],
      ['auditLogs', { timestamp: -1 }],
      ['userSettings', { userId: 1 }],
      ['users', { email: 1 }, true],
      ['features', { symbol: 1, timeframe: 1, timestamp: -1 }],
      // India hot paths are queried sorted by creation/close time.
      ['IndiaSignal', { createdAt: -1 }],
      ['IndiaSignal', { signalId: 1 }],
      ['IndiaTrade', { closedAt: -1 }],
      ['IndiaPosition', { status: 1, openedAt: -1 }],
      ['IndiaOrder', { signalId: 1 }],
      ['IndiaBacktestRun', { createdAt: -1 }],
      ['IndiaCandle', { instrumentToken: 1, timeframe: 1, openTime: -1 }],
    ];
    for (const [coll, spec, unique] of defs) {
      try {
        await this.db.collection(coll).createIndex(spec, unique ? { unique: true } : undefined).catch(() => undefined);
      } catch {
        /* index failures are non-fatal */
      }
    }
  }
  async insertOne<T>(collection: string, doc: T): Promise<void> {
    await this.coll(collection).insertOne(doc as Document);
  }
  async insertMany<T>(collection: string, docs: T[]): Promise<void> {
    if (docs.length) await this.coll(collection).insertMany(docs as Document[]);
  }
  async bulkUpsert<T>(collection: string, docs: T[], keyFields: string[]): Promise<number> {
    if (!docs.length) return 0;
    const coll = this.coll(collection);
    const ops = docs.map((doc) => ({
      replaceOne: {
        filter: Object.fromEntries(keyFields.map((f) => [f, (doc as Record<string, unknown>)[f]])) as Document,
        replacement: doc as Document,
        upsert: true,
      },
    }));
    // Batched: a 20k-bar export is 20 bulk round-trips, not 20k inserts.
    let written = 0;
    for (let i = 0; i < ops.length; i += 1000) {
      const res = await coll.bulkWrite(ops.slice(i, i + 1000), { ordered: false });
      written += res.upsertedCount + res.modifiedCount;
    }
    return written;
  }
  async find<T>(collection: string, filter?: QueryFilter, sort?: SortSpec, limit?: number): Promise<T[]> {
    const cursor = this.coll(collection).find((filter as Document) || {});
    if (sort) cursor.sort(sort as Document);
    // Hard cap: an undefined/NaN limit must never scan the whole collection.
    const lim = limit && limit > 0 && Number.isFinite(limit) ? Math.min(limit, 10_000) : 10_000;
    cursor.limit(lim);
    const docs = await cursor.toArray();
    return docs as T[];
  }
  async findOne<T>(collection: string, filter?: QueryFilter): Promise<T | null> {
    const doc = await this.coll(collection).findOne((filter as Document) || {});
    return (doc as T) ?? null;
  }
  async updateOne<T>(collection: string, filter: QueryFilter, update: UpdateDoc, upsert = false): Promise<void> {
    await this.coll(collection).updateOne(filter as Document, update as Document, { upsert });
  }
  async deleteMany(collection: string, filter?: QueryFilter): Promise<number> {
    const r = await this.coll(collection).deleteMany((filter as Document) || {});
    return r.deletedCount ?? 0;
  }
  async count(collection: string, filter?: QueryFilter): Promise<number> {
    return this.coll(collection).countDocuments((filter as Document) || {});
  }
  async distinct(collection: string, field: string, filter?: QueryFilter): Promise<unknown[]> {
    return this.coll(collection).distinct(field, (filter as Document) || {});
  }
}

export async function createStore(): Promise<DataStore> {
  if (hasMongo) {
    const store: DataStore = new MongoStore();
    try {
      await store.connect();
      return store;
    } catch (err) {
      console.warn(`[store] MongoDB connect failed (${String(err)}) — falling back to in-memory store`);
      const memory: DataStore = new MemoryStore();
      await memory.connect();
      return memory;
    }
  }
  const store: DataStore = new MemoryStore();
  await store.connect();
  return store;
}
// touch
