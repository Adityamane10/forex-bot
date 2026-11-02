/**
 * Mt5MirrorService — mirrors the signal engine's PAPER trades onto the local
 * MetaTrader 5 account bound to this platform (spec: "place in MT5 and on the
 * dashboard, auto close at both places").
 *
 * Dispatch is gated by the broker account binding: the `executionGate` dep is
 * consulted on every poll, and a refusal holds the queue instead of executing
 * on an account the platform cannot verify (see backend/src/broker).
 *
 * Flow:
 *   paper open/close  → this service queues a command (Mongo, durable)
 *   trader.py worker  → long-polls /internal/mt5/commands, executes on MT5
 *   trader.py worker  → POSTs results to /internal/mt5/results → stored/emitted
 *
 * The dashboard remains the source of truth: a failed MT5 fill never blocks or
 * rolls back the paper position — it is surfaced as `mt5Error` on the mirror
 * record and shown in the UI.
 */
import { EventEmitter } from 'events';
import { Mt5AccountSnapshot } from '@fx/shared';
import { logger } from '../core/logger';
import { DataStore } from '../db/store';
import { METRICS } from '../ops/metrics';

export interface Mt5MirrorRecord {
  commandId: string;
  /** Paper position that owns this mirror. */
  positionId: string;
  signalId: string | null;
  symbol: string;
  direction: 'BUY' | 'SELL';
  lots: number;
  action: 'OPEN' | 'CLOSE';
  status: 'PENDING' | 'DISPATCHED' | 'EXECUTED' | 'FAILED' | 'UNKNOWN_TICKET';
  /** Times this command was handed to the trader worker (dispatch attempts). */
  dispatchCount?: number;
  dispatchAt?: number;
  mt5Ticket?: number;
  price?: number;
  error?: string;
  createdAt: number;
  executedAt?: number;
}

export interface Mt5TraderStatus {
  workerId: string | null;
  lastSeenAt: number | null;
  online: boolean;
  accountInfo?: Mt5AccountSnapshot | null;
  pendingCommands: number;
  enabled: boolean;
  /**
   * Set while the broker-account gate is refusing to dispatch. Commands stay
   * PENDING (nothing is lost or executed) and the dashboard shows exactly why
   * no order is leaving — e.g. an unverified account type or a stale binding.
   */
  dispatchBlocked?: { at: number; reasons: string[] } | null;
}

const STALE_OFFLINE_MS = 30_000;
/** A dispatched command not acked within this window is assumed lost. */
const DISPATCH_ACK_TIMEOUT_MS = 45_000;
/** Max times any single command may be handed to the worker. */
const MAX_DISPATCH_ATTEMPTS = 3;

export class Mt5MirrorService {
  private lastWorkerSeenAt: number | null = null;
  private lastWorkerId: string | null = null;
  /** Last gate refusal, surfaced to keep the dashboard honest about idleness. */
  private gateBlock: { at: number; reasons: string[] } | null = null;
  /** Set on every settings save; keeps the dispatch gate in realtime. */
  private symbolLock: string | null = null;

  /** Realtime lock update from the settings path (before the next poll). */
  setSymbolLock(lock: string | null): void {
    this.symbolLock = (lock ?? '').toUpperCase() || null;
  }

  /**
   * Boot-time recovery: with the queue persisted, a backend restart must not
   * leave commands wedged in DISPATCHED (their result died with the old
   * process) — return them to PENDING so the worker re-serves them. PENDING
   * commands survive as-is and dispatch on the first poll. Called once after
   * the store connects.
   */
  async recoverAfterRestart(): Promise<void> {
    try {
      const dispatched = await this.store.find<Mt5MirrorRecord>('Mt5MirrorCommands', { status: 'DISPATCHED' }, { dispatchAt: 1 }, 100);
      for (const d of dispatched) {
        await this.store.updateOne('Mt5MirrorCommands', { commandId: d.commandId } as never, { $set: { status: 'PENDING' } });
      }
      if (dispatched.length) {
        logger.warn('mt5 mirror: boot recovery requeued DISPATCHED commands', { count: dispatched.length });
      }
    } catch { /* collection may not exist on first boot */ }
  }

  constructor(
    private store: DataStore,
    private events: EventEmitter,
    private deps: {
      isEnabled: () => boolean;
      /**
       * Broker-account gate. Orders are only handed to the trader worker when
       * the bound account is known, live and (for real money) explicitly
       * permitted — see AccountProfileService. Absent = no gate.
       */
      executionGate?: () => { allowed: boolean; reasons: string[] };
      /**
       * Symbol lock (XM/MT5 pattern): when the user locks the platform to one
       * symbol, OPEN commands for any other symbol are held PENDING — nothing
       * outside the lock is ever dispatched to the MT5/XM account (demo or
       * real). Absent/null = no lock.
       */
      symbolLock?: () => string | null;
      getOpenPaperPositions: () => Array<{
        id: string; signalId: string; symbol: string;
        direction: 'BUY' | 'SELL'; lots: number;
        stopLoss?: number | null; takeProfit1?: number | null; takeProfit2?: number | null;
      }>;
      /** Repair hook: a paper position whose MT5 mirror OPEN permanently
       *  failed was NEVER placed on the broker — the paper position is an
       *  orphan and must be closed out (reason 'MT5_MIRROR_FAILED') instead
       *  of floating forever with no broker counterpart. */
      onOpenFailed?: (positionId: string, error: string) => Promise<void>;
    },
  ) {}

  /** Manual enable/disable from the dashboard. Persisted via settings collection.
   *  NOTE: MT5 execution is now ALWAYS ON when INTERNAL_API_TOKEN is set and the
   *  trader worker is online. This toggle is kept only for backward compat and
   *  always reports enabled=true so existing clients don't break. Trades are
   *  ALWAYS queued to MT5 demo regardless of this flag. */
  async setEnabled(v: boolean): Promise<void> {
    await this.store.updateOne('userSettings', { key: 'mt5Mirror' }, { $set: { key: 'mt5Mirror', enabled: true } }, true);
    logger.info('mt5 mirror (always-enabled)', { requested: v, effective: true });
    this.events.emit('mt5:mirror-status', await this.status());
  }

  async isEnabledStored(): Promise<boolean> {
    // Always true — MT5 demo execution is mandatory per product spec.
    return true;
  }

  /**
   * Queue an OPEN mirror for a freshly opened paper position. SL/TP ride along:
   * MT5 enforces them server-side too, so the demo account closes even if this
   * backend is down at exit time.
   *
   * ALWAYS queues when INTERNAL_API_TOKEN is configured — the dashboard toggle
   * is deprecated. Every paper trade executes on the MT5 demo balance and
   * appears in both places.
   */
  async queueOpen(pos: {
    id: string; signalId: string; symbol: string; direction: 'BUY' | 'SELL'; lots: number;
    stopLoss?: number | null; takeProfit1?: number | null; takeProfit2?: number | null;
  }): Promise<void> {
    if (!this.deps.isEnabled()) return;
    // Idempotent: one OPEN per paper position even across restarts.
    const existing = await this.store.findOne<Mt5MirrorRecord>('Mt5MirrorCommands', { positionId: pos.id, action: 'OPEN' });
    if (existing) return;
    const rec: Mt5MirrorRecord = {
      commandId: `mopen-${pos.id}`,
      positionId: pos.id,
      signalId: pos.signalId ?? null,
      symbol: pos.symbol,
      direction: pos.direction,
      lots: pos.lots,
      action: 'OPEN',
      status: 'PENDING',
      dispatchCount: 0,
      createdAt: Date.now(),
    };
    // Duplicate-safe upsert on commandId: a raced double-queue is a no-op
    // instead of two docs sharing one id (the stray PENDING copy is then
    // re-served forever — duplicate MT5 orders observed live). bulkUpsert is
    // idempotent on BOTH backends — the JSON store has no unique index here.
    await this.store.bulkUpsert('Mt5MirrorCommands', [rec], ['commandId']);
    logger.info('mt5 mirror: queued OPEN', { symbol: pos.symbol, direction: pos.direction, lots: pos.lots });
  }

  /**
   * Queue a kill-switch FLATTEN. The worker closes every position the platform
   * owns in the terminal (and everything else when includeForeign). Executed
   * ahead of queued OPENs because the operator pressing this button wants a
   * clean slate NOW — the command is pushed to the front of the queue.
   */
  async queueFlatten(includeForeign: boolean): Promise<{ ok: boolean; closed: number; failed: number; errors?: Array<{ ticket: number; error: string }> }> {
    const rec: Mt5MirrorRecord & { includeForeign?: boolean } = {
      commandId: `mflatten-${Date.now()}`,
      positionId: `flatten-${Date.now()}`,
      signalId: null,
      symbol: '*ALL*',
      direction: 'SELL',
      lots: 0,
      action: 'OPEN', // stored as OPEN shape; pollCommands special-cases the sentinel symbol
      status: 'PENDING',
      createdAt: Date.now(),
    };
    await this.store.insertOne('Mt5MirrorCommands', rec as never);
    if (includeForeign) {
      await this.store.updateOne('Mt5MirrorCommands', { commandId: rec.commandId } as never, { $set: { includeForeign: true } });
    }
    logger.warn('mt5 mirror: FLATTEN queued', { includeForeign });
    return { ok: true, closed: 0, failed: 0 }; // worker reports the real result via heartbeat positions
  }

  /** Queue a CLOSE for a paper position's mirrored MT5 ticket. Always active. */
  async queueClose(positionId: string): Promise<void> {
    if (!this.deps.isEnabled()) return;
    const open = await this.store.find<Mt5MirrorRecord>(
      'Mt5MirrorCommands', { positionId, action: 'OPEN', status: 'EXECUTED' }, { createdAt: -1 }, 1,
    );
    const openRec = open[0];
    if (!openRec?.mt5Ticket) return; // nothing mirrored — e.g. mirror was off at open time
    // Idempotent close (DISPATCHED counts as in-flight — never queue twice).
    const existing = await this.store.findOne<Mt5MirrorRecord>('Mt5MirrorCommands', { positionId, action: 'CLOSE', status: { $in: ['PENDING', 'DISPATCHED', 'EXECUTED'] } } as never);
    if (existing) return;
    const rec: Mt5MirrorRecord = {
      commandId: `mclose-${positionId}-${Date.now()}`,
      positionId,
      signalId: openRec.signalId,
      symbol: openRec.symbol,
      direction: openRec.direction === 'BUY' ? 'SELL' : 'BUY',
      lots: openRec.lots,
      action: 'CLOSE',
      status: 'PENDING',
      mt5Ticket: openRec.mt5Ticket,
      createdAt: Date.now(),
    };
    await this.store.bulkUpsert('Mt5MirrorCommands', [rec], ['commandId']);
    logger.info('mt5 mirror: queued CLOSE', { positionId, ticket: openRec.mt5Ticket });
  }

  /** Long-poll payload for the trader worker (oldest pending first). Always serves when token is set. */
  async pollCommands(workerId: string): Promise<Array<{ id: string; action: 'OPEN' | 'CLOSE' | 'FLATTEN'; symbol?: string; direction?: string; lots?: number; sl?: number | null; tp?: number | null; ticket?: number; includeForeign?: boolean; comment: string }>> {
    this.lastWorkerSeenAt = Date.now();
    this.lastWorkerId = workerId;
    if (!this.deps.isEnabled()) return [];
    // Broker-account gate: nothing NEW-risk is dispatched to a terminal whose
    // account the platform cannot verify (unknown currency/leverage geometry,
    // stale binding, real money without opt-in). OPEN commands remain PENDING
    // so the moment the gate opens they execute. FLATTEN and CLOSE always
    // pass — reducing risk on a degraded connection must never be blocked by
    // a data-completeness condition, or a stuck gate would strand open MT5
    // positions with no way out (observed live as an un-sweepable book).
    const pendingAll = await this.store.find<Mt5MirrorRecord & { includeForeign?: boolean }>('Mt5MirrorCommands', { status: 'PENDING' }, { createdAt: 1 }, 20);
    const flatten = pendingAll.filter((p) => p.symbol === '*ALL*');
    const pending = pendingAll.filter((p) => p.symbol !== '*ALL*' && p.action !== 'CLOSE').concat(pendingAll.filter((p) => p.action === 'CLOSE'));
    let gateOpen = true;
    if (this.deps.executionGate) {
      const gate = this.deps.executionGate();
      if (!gate.allowed) {
        if (!this.gateBlock || this.gateBlock.reasons.join('|') !== gate.reasons.join('|')) {
          logger.warn('mt5 dispatch held by broker account gate (OPEN commands only)', { reasons: gate.reasons });
        }
        this.gateBlock = { at: Date.now(), reasons: gate.reasons };
        gateOpen = false;
      } else {
        this.gateBlock = null;
      }
    }
    // Ack-lost recovery: a command handed to the worker whose result never
    // arrived (backend restart, worker crash mid-execution, network drop) is
    // returned to PENDING so it is retried — but only a bounded number of
    // times. A poison command can never re-execute forever (observed live as
    // a duplicate 0.1-lot position opened every poll cycle).
    try {
      const dispatched = await this.store.find<Mt5MirrorRecord & { dispatchCount?: number }>('Mt5MirrorCommands', { status: 'DISPATCHED' } as never, { dispatchAt: 1 }, 50);
      for (const d of dispatched) {
        if (Date.now() - (d.dispatchAt ?? 0) < DISPATCH_ACK_TIMEOUT_MS) continue;
        if ((d.dispatchCount ?? 0) >= MAX_DISPATCH_ATTEMPTS) {
          await this.store.updateOne('Mt5MirrorCommands', { commandId: d.commandId } as never, { $set: { status: 'FAILED', error: 'no ack from trader worker after retries', executedAt: Date.now() } });
          logger.error('mt5 mirror: command abandoned after retry cap', { id: d.commandId, attempts: d.dispatchCount ?? 0 });
          // Orphan repair: the paper position this OPEN belonged to was never
          // mirrored to the broker. Close it on paper so the two books stay
          // reconciled (the alternative is a paper-only position that can
          // never be closed on MT5).
          if (d.action === 'OPEN' && d.positionId && this.deps.onOpenFailed) {
            await this.deps.onOpenFailed(d.positionId, d.error ?? 'no ack from trader worker').catch(() => undefined);
          }
          continue;
        }
        await this.store.updateOne('Mt5MirrorCommands', { commandId: d.commandId } as never, { $set: { status: 'PENDING' } });
        logger.warn('mt5 mirror: dispatch ack timeout — requeueing', { id: d.commandId, attempts: d.dispatchCount ?? 0 });
      }
    } catch { /* best-effort */ }
    // Symbol lock: OPEN commands outside the locked symbol are HELD (not
    // dropped), so the demo/real account can never receive an order the user
    // has locked out. CLOSE commands always pass — exiting a position must
    // never be blocked.
    const lock = this.deps.symbolLock?.() ?? this.symbolLock;
    type CommandPayload = { id: string; action: 'OPEN' | 'CLOSE' | 'FLATTEN'; symbol?: string; direction?: string; lots?: number; sl?: number | null; tp?: number | null; ticket?: number; includeForeign?: boolean; comment: string };
    const out: CommandPayload[] = [];
    for (const f of flatten) {
      out.push({ id: f.commandId, action: 'FLATTEN', includeForeign: (f as { includeForeign?: boolean }).includeForeign ?? false, comment: 'kill switch' });
      await this.store.updateOne('Mt5MirrorCommands', { commandId: f.commandId } as never, { $set: { status: 'EXECUTED', executedAt: Date.now() } });
    }
    const rest = (gateOpen ? pending : pending.filter((p) => p.action !== 'OPEN')).filter((p) => p.symbol !== '*ALL*');
    const openBook = new Map(this.deps.getOpenPaperPositions().map((p) => [p.id, p]));
    for (const p of rest) {
      if (p.action === 'OPEN') {
        if (lock && p.symbol.toUpperCase() !== lock) continue;
        const bookPos = openBook.get(p.positionId);
        // Mark DISPATCHED atomically at hand-off (also caps re-serves). If a
        // reaper returns stale DISPATCHED docs to PENDING, a second attempt
        // for one position is allowed so one lost ack can't orphan a fill.
        await this.store.updateOne('Mt5MirrorCommands', { commandId: p.commandId } as never, { $set: { status: 'DISPATCHED', dispatchAt: Date.now(), dispatchCount: (p.dispatchCount ?? 0) + 1 } });
        out.push({
          id: p.commandId, action: 'OPEN', symbol: p.symbol, direction: p.direction,
          lots: p.lots,
          // SL/TP ride with the order so the demo account is protected even if
          // this backend dies before the paper engine's own exit fires.
          sl: bookPos?.stopLoss ?? null,
          tp: bookPos?.takeProfit2 ?? bookPos?.takeProfit1 ?? null,
          comment: 'fx-bot auto',
        });
      } else {
        await this.store.updateOne('Mt5MirrorCommands', { commandId: p.commandId } as never, { $set: { status: 'DISPATCHED', dispatchAt: Date.now(), dispatchCount: (p.dispatchCount ?? 0) + 1 } });
        out.push({
          id: p.commandId, action: 'CLOSE', ticket: p.mt5Ticket,
          lots: p.lots, comment: 'fx-bot close',
        });
      }
    }
    return out;
  }

  /** Result callback from trader.py. */
  async applyResult(r: { id: string; ok: boolean; ticket?: number; price?: number; error?: string; already_closed?: boolean }): Promise<void> {
    this.lastWorkerSeenAt = Date.now();
    const rec = await this.store.findOne<Mt5MirrorRecord & { _id?: unknown }>('Mt5MirrorCommands', { commandId: r.id });
    if (!rec) {
      logger.warn('mt5 mirror: result for unknown command', { id: r.id });
      return;
    }
    const patch: Partial<Mt5MirrorRecord> = {
      status: r.ok ? 'EXECUTED' : 'FAILED',
      executedAt: Date.now(),
      error: r.ok ? undefined : r.error,
    };
    if (r.ok && r.ticket) patch.mt5Ticket = r.ticket;
    if (r.ok && typeof r.price === 'number') patch.price = r.price;
    if (!r.ok && rec.action === 'CLOSE' && /no\s*positions|not found/i.test(r.error ?? '')) {
      // Ticket vanished between dispatch and execution — broker closed it
      // server-side (SL/TP). Treat as done rather than retrying forever.
      patch.status = 'UNKNOWN_TICKET';
    }
    // Latest-first: with the unique index there is exactly one doc per id, but
    // keep deterministic behavior if legacy duplicate docs still exist.
    await this.store.updateOne('Mt5MirrorCommands', { commandId: r.id } as never, { $set: patch });
    if (!r.ok && rec.action === 'OPEN' && rec.positionId && this.deps.onOpenFailed) {
      // Worker-reported failure of an OPEN: same orphan repair as the
      // ack-timeout path — the paper position has no broker counterpart.
      await this.deps.onOpenFailed(rec.positionId, r.error ?? 'mt5 open failed').catch(() => undefined);
    }
    // § realtime measurement: dispatch→confirmation latency and the outcome
    // of every order, straight into the metrics surface.
    METRICS.orderResults().inc({ status: r.ok ? 'ok' : 'failed', action: rec.action });
    if (rec.createdAt > 0) {
      METRICS.orderLatency().observe({ action: rec.action }, Date.now() - rec.createdAt);
    }
    logger.info('mt5 mirror: result', { id: r.id, ok: r.ok, ticket: r.ticket ?? null, error: r.error ?? null });
    this.events.emit('mt5:mirror-status', await this.status());
  }

  /** Register/refresh the worker heartbeat (account info from trader.py). */
  noteHeartbeat(workerId: string, info?: Mt5TraderStatus['accountInfo']): void {
    this.lastWorkerSeenAt = Date.now();
    this.lastWorkerId = workerId;
    if (info) this.accountInfo = info;
    // Auto-retry FAILED opens caused by "AutoTrading disabled" once the trader
    // is online again (user enabled Algo Trading in MT5). Without this, a
    // temporary terminal setting would permanently orphan paper positions.
    if (info) {
      void (async () => {
        try {
          const failed = await this.store.find<Mt5MirrorRecord>('Mt5MirrorCommands', { status: 'FAILED' } as never, undefined, 100);
          let retried = 0;
          for (const rec of failed) {
            if (!/10027|AutoTrading disabled/i.test(rec.error ?? '')) continue;
            await this.store.updateOne('Mt5MirrorCommands', { commandId: rec.commandId } as never, { $set: { status: 'PENDING', error: undefined, executedAt: undefined } as never });
            retried++;
          }
          if (retried) logger.info('mt5 mirror: auto-retrying FAILED (AutoTrading disabled) commands', { retried });
        } catch { /* best-effort */ }
      })();
    }
    // Emit so container can sync paper wallet from MT5 balance (INR conversion).
    void this.status().then((s) => this.events.emit('mt5:mirror-status', s)).catch(() => undefined);
  }

  private accountInfo: Mt5TraderStatus['accountInfo'] = null;

  async status(): Promise<Mt5TraderStatus> {
    const online = this.lastWorkerSeenAt !== null && Date.now() - this.lastWorkerSeenAt < STALE_OFFLINE_MS;
    let pendingCommands = 0;
    try {
      const pending = await this.store.find<Mt5MirrorRecord>('Mt5MirrorCommands', { status: 'PENDING' }, undefined, 1000);
      pendingCommands = pending.length;
    } catch { /* collection may not exist yet */ }
    return {
      workerId: online ? this.lastWorkerId : null,
      lastSeenAt: this.lastWorkerSeenAt,
      online,
      accountInfo: online ? this.accountInfo ?? null : null,
      pendingCommands,
      enabled: await this.isEnabledStored(),
      dispatchBlocked: this.gateBlock,
    };
  }
}
