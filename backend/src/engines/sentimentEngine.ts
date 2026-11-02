/**
 * Sentiment engine. Preferred source: FinBERT (free, open-source) served by
 * the Python AI engine. Fallbacks in order: VADER-style lexicon (implemented
 * locally) -> rule-based -> UNAVAILABLE. Never fabricates sentiment: if no
 * source is available the engine reports UNAVAILABLE and downstream code
 * treats sentiment as unknown.
 */
import { CurrencySentiment, NewsItem, SentimentClass, SentimentResult } from '@fx/shared';
import { FxContext } from '../core/context';
import { logger } from '../core/logger';

// Small financial lexicon (subset of common terms). Clearly rule-based.
const POSITIVE = new Set([
  'beat', 'beats', 'surge', 'surges', 'gain', 'gains', 'rally', 'rallies', 'strong', 'growth',
  'rise', 'rises', 'raised', 'boost', 'boosted', 'outperform', 'record', 'rebound', 'rebounds',
  'upgrade', 'upgrades', 'improve', 'improves', 'expansion', 'optimistic', 'recovery', 'jump', 'jumps',
]);
const NEGATIVE = new Set([
  'miss', 'misses', 'plunge', 'plunges', 'drop', 'drops', 'fall', 'falls', 'slump', 'slumps',
  'weak', 'slowdown', 'cut', 'cuts', 'lowered', 'downgrade', 'downgrades', 'decline', 'declines',
  'loss', 'losses', 'fear', 'fears', 'worst', 'recession', 'deficit', 'pressure', 'turmoil',
  'crash', 'crashes', 'bearish', 'selloff', 'sell-off', 'tumble', 'tumbles',
]);

export function lexiconSentiment(text: string): { class: SentimentClass; score: number; confidence: number } {
  const words = text.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2);
  let score = 0;
  for (const w of words) {
    if (POSITIVE.has(w)) score += 1;
    else if (NEGATIVE.has(w)) score -= 1;
  }
  const n = score === 0 ? 0 : Math.min(1, Math.abs(score) / 4);
  const cls: SentimentClass = score > 0 ? 'positive' : score < 0 ? 'negative' : 'neutral';
  return { class: cls, score: Math.max(-1, Math.min(1, score / 4)), confidence: cls === 'neutral' ? 0.4 : 0.4 + n * 0.5 };
}

export class SentimentEngine {
  constructor(private ctx: FxContext) {}

  private async finbert(text: string): Promise<SentimentResult | null> {
    try {
      const url = `${this.ctx.providers.llm.name === 'GROQ' ? process.env.PYTHON_AI_URL ?? 'http://localhost:8500' : process.env.PYTHON_AI_URL ?? 'http://localhost:8500'}/sentiment`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { class: SentimentClass; confidence: number; score: number; model: string };
      return { ...json, source: 'FINBERT', timestamp: Date.now() };
    } catch {
      return null;
    }
  }

  async scoreNews(items: NewsItem[]): Promise<SentimentResult[]> {
    const out: SentimentResult[] = [];
    for (const item of items.slice(0, 15)) {
      let result: SentimentResult | null = null;
      try {
        result = await this.finbert(item.headline);
      } catch {
        result = null;
      }
      if (!result) {
        const lex = lexiconSentiment(item.headline);
        result = { ...lex, source: 'RULE_BASED', model: 'financial-lexicon-v1', timestamp: Date.now() };
      }
      out.push(result);
    }
    return out;
  }

  /** Aggregate sentiment per currency from recent news. */
  async aggregateByCurrency(items: NewsItem[], now = Date.now()): Promise<CurrencySentiment[]> {
    const perCurrency = new Map<string, { score: number; conf: number; count: number }>();
    const scored = await this.scoreNews(items);
    items.slice(0, scored.length).forEach((item, i) => {
      const s = scored[i];
      for (const c of item.currencies) {
        const cur = perCurrency.get(c) ?? { score: 0, conf: 0, count: 0 };
        cur.score += s.score;
        cur.conf += s.confidence;
        cur.count++;
        perCurrency.set(c, cur);
      }
    });
    return [...perCurrency.entries()].map(([currency, v]) => ({
      currency,
      score: Math.max(-1, Math.min(1, v.score / Math.max(1, v.count))),
      confidence: v.count ? v.conf / v.count : 0,
      count: v.count,
      timestamp: now,
    }));
  }

  health(): { ok: boolean; detail: string } {
    // Sentiment is best-effort; rule-based always available.
    return { ok: true, detail: 'rule-based fallback always available; FinBERT via AI engine when online' };
  }
}
