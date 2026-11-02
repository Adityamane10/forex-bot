/**
 * Global emergency stop (spec §90). When triggered it:
 *   - stops NEW signal generation (signal engine returns NO_TRADE)
 *   - stops NEW paper orders / auto-execution
 *   - preserves open positions and monitoring (positions keep tracking SL/TP)
 *
 * Releasing requires an explicit action with a recorded reason. Every trigger
 * and release is logged so the audit trail answers "who stopped trading and
 * why".
 */
import { AuditLogger } from '../core/audit';

export interface EmergencyStopState {
  triggered: boolean;
  reason: string;
  triggeredAt: number | null;
  history: Array<{ action: 'TRIGGER' | 'RELEASE'; reason: string; timestamp: number }>;
}

export class EmergencyStopEngine {
  private triggered = false;
  private reason = '';
  private triggeredAt: number | null = null;
  private history: EmergencyStopState['history'] = [];

  constructor(private audit: AuditLogger | null = null) {}

  isTriggered(): boolean {
    return this.triggered;
  }

  /** Stop new signals and new orders. Preserves positions + monitoring. */
  async trigger(reason: string, userId?: string): Promise<void> {
    this.triggered = true;
    this.reason = reason;
    this.triggeredAt = Date.now();
    const entry = { action: 'TRIGGER' as const, reason, timestamp: Date.now() };
    this.history.push(entry);
    if (this.history.length > 50) this.history.shift();
    await this.audit?.record('emergencyStop.trigger', 'system', undefined, userId ?? undefined, { reason }).catch(() => undefined);
  }

  /** Resume signal generation and orders. Explicit and recorded. */
  async release(reason: string, userId?: string): Promise<void> {
    this.triggered = false;
    this.reason = '';
    this.triggeredAt = null;
    const entry = { action: 'RELEASE' as const, reason, timestamp: Date.now() };
    this.history.push(entry);
    if (this.history.length > 50) this.history.shift();
    await this.audit?.record('emergencyStop.release', 'system', undefined, userId ?? undefined, { reason }).catch(() => undefined);
  }

  status(): EmergencyStopState {
    return {
      triggered: this.triggered,
      reason: this.reason,
      triggeredAt: this.triggeredAt,
      history: this.history.slice(-20),
    };
  }
}
