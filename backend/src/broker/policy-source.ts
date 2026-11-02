/**
 * BrokerPolicySource — "is the broker still saying the same thing?" watchdog.
 *
 * The platform must follow the broker's published account terms in realtime,
 * but xm.com publishes them as a web page (no API), and money math may never
 * be derived from a page the platform only *thinks* it read. So this service
 * does the honest half of the job:
 *
 *   - fetches the configured policy document on an interval (and on demand),
 *   - hashes a normalized text form of it, so a re-worded page is detected,
 *   - keeps the content hash + timestamps as an auditable trail,
 *   - raises `reviewRequired` when the content CHANGED since the operator last
 *     acknowledged it — it never edits trading conditions by itself,
 *   - records failures verbatim and degrades to STALE/UNAVAILABLE instead of
 *     pretending the last snapshot is current.
 *
 * Recognizing a change is automatable. Interpreting it into a contract size is
 * not, so that step stays with the operator (or with the bound MT5 account,
 * which reports the broker's live specs). Nothing here ever invents a value.
 */
import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import { EventEmitter } from 'events';
import type { BrokerPolicySnapshot, PolicyStatus } from '@fx/shared';
import { logger } from '../core/logger';
import { DataStore } from '../db/store';

export interface PolicySourceOptions {
  id: string;
  /** http(s) URL, or a local path / file: URL for an operator-saved copy. */
  url: string;
  refreshIntervalMs: number;
  timeoutMs?: number;
  /** Injectable for tests. */
  fetcher?: typeof fetch;
}

interface PolicyDoc {
  docId: string;
  contentHash: string | null;
  acknowledgedHash: string | null;
  fetchedAt: number | null;
  lastAttemptAt: number | null;
  lastError: string | null;
  contentBytes: number | null;
  changedAt: number | null;
  acknowledgedAt: number | null;
  consecutiveFailures: number;
}

const DOC_ID = 'policy';

/**
 * Reduce a document to the words that carry meaning, so cosmetic markup churn
 * (whitespace, attribute order, generated ids) does not look like a policy
 * change while a real change always does.
 */
export function normalizePolicyText(raw: string): string {
  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function hashPolicyText(raw: string): { hash: string; bytes: number } {
  const text = normalizePolicyText(raw);
  return { hash: createHash('sha256').update(text).digest('hex'), bytes: Buffer.byteLength(text) };
}

export class BrokerPolicySource {
  private doc: PolicyDoc = {
    docId: DOC_ID,
    contentHash: null,
    acknowledgedHash: null,
    fetchedAt: null,
    lastAttemptAt: null,
    lastError: null,
    contentBytes: null,
    changedAt: null,
    acknowledgedAt: null,
    consecutiveFailures: 0,
  };
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<BrokerPolicySnapshot> | null = null;

  constructor(
    private store: DataStore,
    private events: EventEmitter,
    private opts: PolicySourceOptions,
  ) {}

  async init(): Promise<void> {
    try {
      const stored = await this.store.findOne<PolicyDoc>('brokerPolicy', { docId: DOC_ID });
      if (stored) this.doc = { ...this.doc, ...stored };
    } catch {
      /* collection may not exist yet */
    }
  }

  start(): void {
    this.stop();
    if (!this.opts.url) return;
    this.timer = setInterval(() => {
      void this.refresh().catch(() => undefined);
    }, this.opts.refreshIntervalMs);
    this.timer.unref?.();
    // Never block startup on a network call.
    void this.refresh().catch(() => undefined);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private isLocal(url: string): boolean {
    return /^file:/i.test(url) || !/^https?:\/\//i.test(url);
  }

  private async fetchDocument(): Promise<string> {
    const url = this.opts.url;
    if (this.isLocal(url)) {
      const path = url.replace(/^file:\/\//i, '');
      return await readFile(path, 'utf8');
    }
    const fetcher = this.opts.fetcher ?? fetch;
    const res = await fetcher(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000),
      headers: {
        // Some broker fronts reject obviously-scripted clients outright; we do
        // not try to defeat that (no forged browser fingerprint), so a refusal
        // surfaces as UNAVAILABLE with the reason and the operator confirms by
        // hand instead.
        'User-Agent': 'FXIntel/1.0 (+broker policy watcher)',
        Accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
    return await res.text();
  }

  /** One refresh attempt. Never throws — failures are recorded as state. */
  async refresh(): Promise<BrokerPolicySnapshot> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.run().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async run(): Promise<BrokerPolicySnapshot> {
    const now = Date.now();
    this.doc.lastAttemptAt = now;
    try {
      const raw = await this.fetchDocument();
      const { hash, bytes } = hashPolicyText(raw);
      const previous = this.doc.contentHash;
      this.doc.contentHash = hash;
      this.doc.contentBytes = bytes;
      this.doc.fetchedAt = now;
      this.doc.lastError = null;
      this.doc.consecutiveFailures = 0;
      if (previous === null) {
        // First successful read: there is nothing to have "changed" from, but the
        // operator still has to acknowledge that these are the current terms.
        this.doc.changedAt = now;
        logger.info('broker policy: first snapshot captured', { id: this.opts.id, bytes });
      } else if (previous !== hash) {
        this.doc.changedAt = now;
        logger.warn('broker policy: PUBLISHED CONTENT CHANGED — conditions need re-confirmation', {
          id: this.opts.id,
          url: this.opts.url,
        });
        this.events.emit('broker:policy-changed', { id: this.opts.id, changedAt: now, hash });
      }
    } catch (err) {
      this.doc.consecutiveFailures += 1;
      this.doc.lastError = err instanceof Error ? err.message : String(err);
      logger.warn('broker policy: fetch failed', {
        id: this.opts.id,
        url: this.opts.url,
        error: this.doc.lastError,
        consecutiveFailures: this.doc.consecutiveFailures,
      });
    }
    try {
      await this.store.updateOne('brokerPolicy', { docId: DOC_ID }, { $set: { ...this.doc } } as never, true);
    } catch {
      /* in-memory state stays authoritative for this process */
    }
    const snap = this.snapshot();
    this.events.emit('broker:policy', snap);
    return snap;
  }

  /**
   * Drop the acknowledgement. Used when the account type changes: the operator
   * acknowledged the published terms of the PREVIOUS account, which says
   * nothing about the one now selected.
   */
  async unacknowledge(): Promise<BrokerPolicySnapshot> {
    this.doc.acknowledgedHash = null;
    this.doc.acknowledgedAt = null;
    try {
      await this.store.updateOne('brokerPolicy', { docId: DOC_ID }, { $set: { ...this.doc } } as never, true);
    } catch {
      /* ignore */
    }
    const snap = this.snapshot();
    this.events.emit('broker:policy', snap);
    return snap;
  }

  /** Operator states: "I have read the current document and re-confirmed the conditions". */
  async acknowledge(): Promise<BrokerPolicySnapshot> {
    this.doc.acknowledgedHash = this.doc.contentHash;
    this.doc.acknowledgedAt = Date.now();
    try {
      await this.store.updateOne('brokerPolicy', { docId: DOC_ID }, { $set: { ...this.doc } } as never, true);
    } catch {
      /* ignore */
    }
    const snap = this.snapshot();
    this.events.emit('broker:policy', snap);
    return snap;
  }

  private status(): PolicyStatus {
    if (this.doc.fetchedAt === null) return this.doc.lastAttemptAt === null ? 'NEVER_CHECKED' : 'UNAVAILABLE';
    const maxAge = Math.max(this.opts.refreshIntervalMs * 2, 3_600_000);
    if (Date.now() - this.doc.fetchedAt <= maxAge) return 'FRESH';
    return 'STALE';
  }

  snapshot(): BrokerPolicySnapshot {
    return {
      id: this.opts.id,
      status: this.status(),
      sourceUrl: this.opts.url,
      fetchedAt: this.doc.fetchedAt,
      lastAttemptAt: this.doc.lastAttemptAt,
      lastError: this.doc.lastError,
      contentHash: this.doc.contentHash,
      contentBytes: this.doc.contentBytes,
      changedAt: this.doc.changedAt,
      acknowledgedAt: this.doc.acknowledgedAt,
      refreshIntervalMs: this.opts.refreshIntervalMs,
      consecutiveFailures: this.doc.consecutiveFailures,
      reviewRequired: this.doc.contentHash !== null && this.doc.acknowledgedHash !== this.doc.contentHash,
    };
  }
}
