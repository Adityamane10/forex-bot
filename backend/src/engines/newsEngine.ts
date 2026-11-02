/**
 * News engine. Fetches from the configured provider, deduplicates, caches,
 * persists and emits news.update. Uses the optional LLM only for enrichment
 * (currency classification) — never for decisions. If the provider is down,
 * news features degrade to "unknown" and the configured safe policy applies.
 */
import { NewsItem } from '@fx/shared';
import { FxContext, CHANNELS } from '../core/context';
import { logger } from '../core/logger';

export class NewsEngine {
  private lastFetch = 0;
  private readonly minFetchIntervalMs = 60_000;
  private latest: NewsItem[] = [];

  constructor(private ctx: FxContext) {}

  async refresh(force = false): Promise<NewsItem[]> {
    if (!force && Date.now() - this.lastFetch < this.minFetchIntervalMs && this.latest.length) {
      return this.latest;
    }
    const provider = this.ctx.providers.news;
    try {
      const items = await provider.getLatestNews(30);
      // dedupe against known keys
      const seen = new Set(this.latest.map((n) => n.dedupeKey));
      const fresh = items.filter((n) => !seen.has(n.dedupeKey));
      // optional LLM enrichment (best effort)
      if (this.ctx.providers.llm.available) {
        for (const item of fresh.slice(0, 5)) {
          const classified = await this.ctx.providers.llm.classify(item).catch(() => null);
          if (classified) {
            if (classified.currencies.length) item.currencies = [...new Set([...item.currencies, ...classified.currencies])];
            item.category = classified.category;
          }
        }
      }
      this.latest = [...fresh, ...this.latest].slice(0, 100);
      if (fresh.length) {
        try {
          await this.ctx.store.insertMany('news', fresh);
        } catch (err) {
          logger.warn('news persist failed', { err: String(err) });
        }
        this.ctx.events.emit(CHANNELS.news, fresh);
      }
      this.lastFetch = Date.now();
      return this.latest;
    } catch (err) {
      logger.warn('news refresh failed', { err: String(err) });
      return this.latest;
    }
  }

  getLatest(): NewsItem[] {
    return this.latest;
  }

  async getCurrencyNews(currency: string, limit = 20): Promise<NewsItem[]> {
    const all = this.latest.length ? this.latest : await this.refresh();
    return all.filter((n) => n.currencies.includes(currency)).slice(0, limit);
  }

  async search(query: string, limit = 20): Promise<NewsItem[]> {
    if (this.latest.length === 0) await this.refresh();
    const q = query.toLowerCase();
    return this.latest.filter((n) => n.headline.toLowerCase().includes(q)).slice(0, limit);
  }

  health(): { ok: boolean; detail: string } {
    return {
      ok: this.latest.length > 0,
      detail: this.latest.length ? `${this.latest.length} items cached` : 'no news received (provider down or NONE)',
    };
  }
}
