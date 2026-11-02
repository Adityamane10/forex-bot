import { AuditEntry } from '@fx/shared';
import { DataStore } from '../db/store';
import { logger } from './logger';

/** Immutable audit trail. Decision history is never deleted. */
export class AuditLogger {
  constructor(private store: DataStore, private enabled = true) {}

  async record(action: string, entity: string, entityId?: string, userId?: string, meta: Record<string, unknown> = {}): Promise<void> {
    const entry: AuditEntry = {
      id: crypto.randomUUID(),
      action,
      entity,
      entityId,
      userId,
      meta,
      timestamp: Date.now(),
    };
    if (this.enabled) {
      try {
        await this.store.insertOne('auditLogs', entry);
      } catch (err) {
        logger.warn('audit write failed', { action, err: String(err) });
      }
    }
    return;
  }

  async list(filter?: { entity?: string; entityId?: string; limit?: number }): Promise<AuditEntry[]> {
    try {
      const q: Record<string, unknown> = {};
      if (filter?.entity) q.entity = filter.entity;
      if (filter?.entityId) q.entityId = filter.entityId;
      return await this.store.find<AuditEntry>(
        'auditLogs',
        Object.keys(q).length ? (q as never) : undefined,
        { timestamp: -1 },
        filter?.limit ?? 100,
      );
    } catch {
      return [];
    }
  }
}
