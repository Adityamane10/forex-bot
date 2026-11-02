/**
 * Alert engine. Emits alert events; alerts may be surfaced via WebSocket
 * and/or stored. Notifications are optional and never block core logic.
 * Out-of-band delivery (Telegram/webhook) rides along fire-and-forget.
 */
import { Alert, AlertType } from '@fx/shared';
import { FxContext, CHANNELS } from '../core/context';
import { logger } from '../core/logger';
import { alertDelivery } from '../ops/alertDelivery';
import { METRICS } from '../ops/metrics';

export class AlertEngine {
  constructor(private ctx: FxContext) {}

  async emit(type: AlertType, message: string, symbol?: string, severity: Alert['severity'] = 'INFO'): Promise<void> {
    const alert: Alert = {
      id: crypto.randomUUID(),
      type,
      symbol,
      message,
      severity,
      timestamp: Date.now(),
      read: false,
    };
    this.ctx.events.emit(CHANNELS.alert, alert);
    try {
      await this.ctx.store.insertOne('alerts', alert);
    } catch (err) {
      logger.warn('alert persist failed', { err: String(err) });
    }
    // Out-of-band delivery (Telegram/webhook). Fire-and-forget: a broken
    // channel must never slow the trading path, and failures are logged
    // inside the delivery module.
    void alertDelivery.deliver(alert).then(() => METRICS.alertsSent().inc({ channel: 'external', status: 'ok' })).catch(() => METRICS.alertsSent().inc({ channel: 'external', status: 'error' }));
  }

  async recent(limit = 50): Promise<Alert[]> {
    try {
      return await this.ctx.store.find<Alert>('alerts', {}, { timestamp: -1 }, limit);
    } catch {
      return [];
    }
  }
}
