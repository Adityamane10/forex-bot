/**
 * Alert delivery — takes the AlertEngine's alerts beyond the UI.
 *
 * Channels: Telegram bot API + generic webhook (Slack/Discord-compatible
 * JSON). Both are fire-and-forget with a short timeout: a broken channel can
 * never block trading logic (the alert is still persisted + emitted to the
 * UI regardless of delivery outcome).
 *
 * Configuration (backend/.env):
 *   ALERT_TELEGRAM_BOT_TOKEN   bot token from @BotFather
 *   ALERT_TELEGRAM_CHAT_ID     chat/channel id to post into
 *   ALERT_WEBHOOK_URL          generic JSON POST endpoint
 *   ALERT_MIN_SEVERITY         INFO | WARNING | CRITICAL (default WARNING)
 *   ALERT_RATE_LIMIT_PER_MIN   max deliveries per minute (default 20)
 */
import { config } from '../config';
import { logger } from '../core/logger';
import type { Alert } from '@fx/shared';

const SEVERITY_ORDER: Record<string, number> = { INFO: 0, WARNING: 1, CRITICAL: 2 };
const ICONS: Record<string, string> = { INFO: 'ℹ️', WARNING: '⚠️', CRITICAL: '🚨' };

interface DeliveryConfig {
  telegramToken: string;
  telegramChatId: string;
  webhookUrl: string;
  minSeverity: string;
  ratePerMin: number;
}

function loadConfig(): DeliveryConfig {
  return {
    telegramToken: process.env.ALERT_TELEGRAM_BOT_TOKEN ?? '',
    telegramChatId: process.env.ALERT_TELEGRAM_CHAT_ID ?? '',
    webhookUrl: process.env.ALERT_WEBHOOK_URL ?? '',
    minSeverity: (process.env.ALERT_MIN_SEVERITY ?? 'WARNING').toUpperCase(),
    ratePerMin: Number(process.env.ALERT_RATE_LIMIT_PER_MIN ?? 20) || 20,
  };
}

class AlertDelivery {
  private cfg: DeliveryConfig = loadConfig();
  private windowStart = 0;
  private sentThisWindow = 0;

  configured(): { telegram: boolean; webhook: boolean } {
    return { telegram: Boolean(this.cfg.telegramToken && this.cfg.telegramChatId), webhook: Boolean(this.cfg.webhookUrl) };
  }

  private rateLimited(): boolean {
    const now = Date.now();
    if (now - this.windowStart > 60_000) { this.windowStart = now; this.sentThisWindow = 0; }
    return this.sentThisWindow >= this.cfg.ratePerMin;
  }

  private passesFilter(severity: string): boolean {
    return (SEVERITY_ORDER[severity] ?? 0) >= (SEVERITY_ORDER[this.cfg.minSeverity] ?? 1);
  }

  async deliver(alert: Alert): Promise<void> {
    const channels = this.configured();
    if (!channels.telegram && !channels.webhook) return;
    if (!this.passesFilter(alert.severity ?? 'INFO')) return;
    if (this.rateLimited()) return;
    this.sentThisWindow++;
    await Promise.allSettled([this.sendTelegram(alert), this.sendWebhook(alert)]);
  }

  private async sendTelegram(alert: Alert): Promise<void> {
    if (!this.cfg.telegramToken || !this.cfg.telegramChatId) return;
    const icon = ICONS[alert.severity ?? 'INFO'] ?? '•';
    const symbolPart = alert.symbol ? ` — ${alert.symbol}` : '';
    const text = `${icon} *${alert.severity ?? 'INFO'}*${symbolPart}\n${alert.message}\n\n_fx-intel · ${new Date(alert.timestamp).toISOString()}_`;
    try {
      const res = await fetch(`https://api.telegram.org/bot${this.cfg.telegramToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: this.cfg.telegramChatId, text, parse_mode: 'Markdown', disable_web_page_preview: true }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) logger.warn('alert telegram delivery failed', { status: res.status });
    } catch (err) {
      logger.warn('alert telegram delivery error', { err: String(err) });
    }
  }

  private async sendWebhook(alert: Alert): Promise<void> {
    if (!this.cfg.webhookUrl) return;
    try {
      const res = await fetch(this.cfg.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: `${ICONS[alert.severity ?? 'INFO'] ?? '•'} [${alert.severity ?? 'INFO'}]${alert.symbol ? ` ${alert.symbol}:` : ''} ${alert.message}`,
          alert,
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) logger.warn('alert webhook delivery failed', { status: res.status });
    } catch (err) {
      logger.warn('alert webhook delivery error', { err: String(err) });
    }
  }

  /** Re-read env (tests / hot config changes). */
  reload(): void { this.cfg = loadConfig(); }
}

export const alertDelivery = new AlertDelivery();
void config;
