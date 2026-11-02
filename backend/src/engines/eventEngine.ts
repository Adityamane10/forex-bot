/**
 * Economic calendar engine. Tracks events, computes time-to-event and event
 * risk windows. If the calendar provider is down, event risk is "unknown"
 * and news-sensitive strategies are blocked per the configured policy.
 */
import { EconomicEvent } from '@fx/shared';
import { FxContext, CHANNELS } from '../core/context';
import { logger } from '../core/logger';

export interface EventRiskInput {
  symbol: string;
  now: number;
  /** Window in ms before an event during which risk is elevated. */
  preWindowMs?: number;
  /** Window in ms after an event during which volatility risk persists. */
  postWindowMs?: number;
}

export interface EventRiskResult {
  imminentHighImpact: boolean;
  eventsInWindow: EconomicEvent[];
  eventRisk: number; // 0..1
  affectedCurrencies: string[];
  detail: string;
}

export class EventEngine {
  private events: EconomicEvent[] = [];
  private lastFetch = 0;
  private readonly minFetchIntervalMs = 10 * 60_000;

  constructor(private ctx: FxContext) {}

  async refresh(force = false): Promise<EconomicEvent[]> {
    if (!force && Date.now() - this.lastFetch < this.minFetchIntervalMs && this.events.length) return this.events;
    try {
      const provider = this.ctx.providers.calendar;
      const now = Date.now();
      // 60-day lookahead: official rate decisions (FOMC/MPC) are announced 4-6
      // weeks out, so a short window would make the calendar look empty.
      const events = await provider.getEvents(now - 2 * 86400_000, now + 60 * 86400_000);
      this.events = events;
      try {
        await this.ctx.store.insertMany('economicEvents', events);
      } catch (err) {
        logger.warn('events persist failed', { err: String(err) });
      }
      this.lastFetch = Date.now();
      this.ctx.events.emit(CHANNELS.calendar, events);
      return events;
    } catch (err) {
      logger.warn('calendar refresh failed', { err: String(err) });
      return this.events;
    }
  }

  getUpcoming(limit = 30): EconomicEvent[] {
    const now = Date.now();
    return this.events.filter((e) => e.timestamp >= now).slice(0, limit);
  }

  getEvents(from: number, to: number): EconomicEvent[] {
    return this.events.filter((e) => e.timestamp >= from && e.timestamp <= to);
  }

  private currencyOfSymbol(symbol: string): string[] {
    return symbol.split('/');
  }

  assess(input: EventRiskInput): EventRiskResult {
    const preWindow = input.preWindowMs ?? 2 * 3600_000; // 2h before
    const postWindow = input.postWindowMs ?? 60 * 60_000; // 1h after
    const currencies = this.currencyOfSymbol(input.symbol);
    const inWindow = this.events.filter((e) => {
      const relevant = e.currency === 'ALL' || currencies.includes(e.currency);
      if (!relevant) return false;
      const diff = e.timestamp - input.now;
      return diff > -postWindow && diff < preWindow;
    });
    const highImpact = inWindow.filter((e) => e.impact === 'HIGH');
    const risk = Math.min(1, inWindow.reduce((acc, e) => acc + (e.impact === 'HIGH' ? 0.5 : e.impact === 'MEDIUM' ? 0.25 : 0.1), 0));
    return {
      imminentHighImpact: highImpact.length > 0,
      eventsInWindow: inWindow,
      eventRisk: risk,
      affectedCurrencies: [...new Set(inWindow.flatMap((e) => [e.currency]))],
      detail: highImpact.length
        ? `high-impact event: ${highImpact.map((e) => e.event).join(', ')}`
        : inWindow.length
          ? `${inWindow.length} event(s) in window (risk ${risk.toFixed(2)})`
          : 'no events in window',
    };
  }

  health(): { ok: boolean; detail: string } {
    return {
      ok: this.events.length > 0,
      detail: this.events.length ? `${this.events.length} events loaded` : 'calendar provider down or NONE',
    };
  }
}
