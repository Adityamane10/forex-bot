/**
 * News providers.
 *
 * RSS: aggregates free public forex news RSS feeds. All feeds below were
 * verified reachable from this build (InvestingLive/ForexLive, FXStreet,
 * ActionForex, Investing.com Forex). These feeds are publicly available, free
 * to read, and respect the publisher's terms. We deduplicate and cache; we do
 * not scrape paid content. A feed being down never breaks the news engine.
 *
 * NONE: explicit no-news mode. The system follows the configured safe policy
 * (news blocked strategies stay blocked) and never fabricates news.
 */
import { NewsItem, ImpactLevel } from '@fx/shared';
import { NewsProvider } from './types';
import Parser from 'rss-parser';
import { config } from '../config';

const parser = new Parser();

const FEEDS = [
  'https://www.investinglive.com/feed/news/', // ForexLive (redirect target, direct)
  'https://www.fxstreet.com/rss/news',
  'https://www.actionforex.com/feed',
  'https://www.investing.com/rss/forex.rss',
];

const CURRENCY_ALIASES: Array<{ name: string; code: string }> = [
  { name: 'euro', code: 'EUR' },
  { name: 'dollar', code: 'USD' },
  { name: 'pound', code: 'GBP' },
  { name: 'sterling', code: 'GBP' },
  { name: 'yen', code: 'JPY' },
  { name: 'franc', code: 'CHF' },
  { name: 'aussie', code: 'AUD' },
  { name: 'australian', code: 'AUD' },
  { name: 'kiwi', code: 'NZD' },
  { name: 'canadian', code: 'CAD' },
  { name: 'loonie', code: 'CAD' },
  { name: 'yuan', code: 'CNY' },
];

const PAIR_PATTERN = /\b(EUR|GBP|USD|JPY|CHF|AUD|NZD|CAD)\/(USD|GBP|JPY|CHF|EUR|AUD|NZD|CAD)\b/g;

export function extractCurrencies(text: string): string[] {
  const found = new Set<string>();
  const pairMatches = text.toUpperCase().match(PAIR_PATTERN);
  for (const m of pairMatches ?? []) {
    const [a, b] = m.split('/');
    found.add(a);
    found.add(b);
  }
  const lower = text.toLowerCase();
  for (const { name, code } of CURRENCY_ALIASES) {
    if (lower.includes(name)) found.add(code);
  }
  return [...found];
}

/**
 * Currency → REAL tradable pair from the asset master. Inventing `JPY/USD`
 * style symbols crashed getAsset() consumers — quote currencies map to their
 * actual USD-quoted (or USD-base) pairs.
 */
export function currencyToAsset(code: string): string {
  switch (code) {
    case 'USD': return 'EUR/USD';
    case 'EUR': return 'EUR/USD';
    case 'GBP': return 'GBP/USD';
    case 'JPY': return 'USD/JPY';
    case 'CHF': return 'USD/CHF';
    case 'AUD': return 'AUD/USD';
    case 'NZD': return 'NZD/USD';
    case 'CAD': return 'USD/CAD';
    default: return 'EUR/USD';
  }
}

export function guessImportance(text: string): ImpactLevel {
  const lower = text.toLowerCase();
  const high = ['fed', 'fomc', 'ecb', 'rate decision', 'cpi', 'nfp', 'nonfarm', 'non-farm', 'inflation', 'gdp', 'central bank', 'powell'];
  const med = ['pmi', 'retail sales', 'employment', 'unemployment', 'ppc', 'trade balance', 'housing'];
  if (high.some((k) => lower.includes(k))) return 'HIGH';
  if (med.some((k) => lower.includes(k))) return 'MEDIUM';
  return 'LOW';
}

export class RssNewsProvider implements NewsProvider {
  readonly name = 'RSS';
  readonly description =
    'Free public forex RSS feeds (InvestingLive/ForexLive, FXStreet, ActionForex, Investing.com). No API key. Subject to publisher rate limits; content cached and deduplicated.';
  private connected = false;
  private cache: NewsItem[] = [];
  private cacheTime = 0;
  private readonly cacheTtlMs = 5 * 60 * 1000;

  async connect(): Promise<void> {
    this.connected = true;
  }

  private async fetchAll(): Promise<NewsItem[]> {
    if (this.cache.length && Date.now() - this.cacheTime < this.cacheTtlMs) return this.cache;
    const out: NewsItem[] = [];
    for (const feedUrl of FEEDS) {
      try {
        // Fetch with an explicit timeout: a slow feed must never hang startup
        // or the background refresh loop.
        const res = await fetch(feedUrl, { signal: AbortSignal.timeout(8_000) });
        if (!res.ok) continue;
        const xml = await res.text();
        const feed = await parser.parseString(xml);
        for (const item of feed.items.slice(0, 25)) {
          if (!item.title) continue;
          const ts = item.isoDate ? new Date(item.isoDate).getTime() : Date.now();
          const headline = item.title.replace(/<[^>]+>/g, '').trim();
          const currencies = extractCurrencies(headline);
          out.push({
            id: `${feedUrl}-${item.guid ?? item.link ?? headline}`,
            headline,
            source: feed.title ?? feedUrl,
            timestamp: ts,
            currencies,
            // Map each currency to a REAL tradable pair — `JPY/USD` etc. do
            // not exist in the asset master and crashed getAsset() consumers.
            assets: currencies.map((c) => currencyToAsset(c)),
            category: 'FOREX',
            importance: guessImportance(headline),
            url: item.link,
            body: item.contentSnippet,
            dedupeKey: headline.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(),
          });
        }
      } catch {
        /* a feed being down must not break the news engine */
      }
    }
    const dedup = new Map<string, NewsItem>();
    for (const n of out) {
      if (!dedup.has(n.dedupeKey)) dedup.set(n.dedupeKey, n);
    }
    this.cache = [...dedup.values()].sort((a, b) => b.timestamp - a.timestamp);
    this.cacheTime = Date.now();
    return this.cache;
  }

  async getLatestNews(limit = 25, currencies?: string[]): Promise<NewsItem[]> {
    const all = await this.fetchAll();
    let out = all;
    if (currencies && currencies.length) {
      const wanted = new Set(currencies);
      out = all.filter((n) => n.currencies.some((c) => wanted.has(c)));
    }
    return out.slice(0, limit);
  }

  async searchNews(query: string, limit = 20): Promise<NewsItem[]> {
    const all = await this.fetchAll();
    const q = query.toLowerCase();
    return all.filter((n) => n.headline.toLowerCase().includes(q) || n.body?.toLowerCase().includes(q)).slice(0, limit);
  }

  async getCurrencyNews(currency: string, limit = 20): Promise<NewsItem[]> {
    return this.getLatestNews(limit, [currency]);
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    if (!this.connected) return { ok: false, detail: 'not connected' };
    try {
      const items = await this.fetchAll();
      return { ok: items.length > 0, detail: items.length ? `${items.length} items cached` : 'feeds returned no items' };
    } catch {
      return { ok: false, detail: 'feeds unreachable' };
    }
  }
}

export class NoopNewsProvider implements NewsProvider {
  readonly name = 'NONE';
  readonly description = 'News disabled by configuration. No news data is used or fabricated.';
  async connect(): Promise<void> {
    /* noop */
  }
  async getLatestNews(_limit = 25, _currencies?: string[]): Promise<NewsItem[]> {
    return [];
  }
  async searchNews(_query: string, _limit = 20): Promise<NewsItem[]> {
    return [];
  }
  async getCurrencyNews(_currency: string, _limit = 20): Promise<NewsItem[]> {
    return [];
  }
  async health(): Promise<{ ok: boolean; detail: string }> {
    return { ok: false, detail: 'no news provider configured (NEWS_PROVIDER=NONE)' };
  }
}

export function createNewsProvider(): NewsProvider {
  switch (config.newsProvider) {
    case 'RSS':
      return new RssNewsProvider();
    case 'NEWSAPI':
      throw new Error('NEWSAPI provider not implemented in this build; use RSS');
    default:
      return new NoopNewsProvider();
  }
}
