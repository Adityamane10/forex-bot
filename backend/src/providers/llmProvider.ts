/**
 * LLM providers. The LLM is OPTIONAL: the core signal engine never depends on
 * it. Groq free tier (rate-limited) is used only for news summarization,
 * classification and signal explanation. If Groq is down or absent, all LLM
 * features degrade gracefully and trading logic is unaffected.
 */
import { NewsItem } from '@fx/shared';
import { LlmProvider } from './types';
import { config } from '../config';

interface GroqMessage {
  role: 'system' | 'user';
  content: string;
}

export class GroqLlmProvider implements LlmProvider {
  readonly name = 'GROQ';
  private _available = Boolean(config.groqApiKey);
  get available(): boolean {
    return this._available;
  }
  readonly description =
    'Groq free tier (rate limited). Used ONLY for news summarization, classification and explanation. Never for risk controls.';
  private base = 'https://api.groq.com/openai/v1/chat/completions';

  private async chat(messages: GroqMessage[], maxTokens = 300): Promise<string | null> {
    if (!this._available) return null;
    try {
      const res = await fetch(this.base, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.groqApiKey}`,
        },
        body: JSON.stringify({ model: config.groqModel, messages, max_tokens: maxTokens, temperature: 0.2 }),
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      return json.choices?.[0]?.message?.content ?? null;
    } catch {
      return null;
    }
  }

  async summarize(news: NewsItem[]): Promise<string | null> {
    if (!news.length) return null;
    const items = news
      .slice(0, 8)
      .map((n) => `- [${n.importance}] ${n.headline} (${n.source})`)
      .join('\n');
    return this.chat([
      {
        role: 'system',
        content: 'You summarize forex news for a trader. Be concise, factual, neutral. 3-5 sentences max.',
      },
      { role: 'user', content: `Summarize the latest forex news:\n${items}` },
    ]);
  }

  async classify(news: NewsItem): Promise<{ currencies: string[]; category: string; importance: string } | null> {
    const out = await this.chat([
      {
        role: 'system',
        content:
          'Classify this forex news headline. Return strict JSON: {"currencies":["EUR"],"category":"MACRO|CENTRAL_BANK|GEOPOLITICS|COMMODITY|OTHER","importance":"HIGH|MEDIUM|LOW"}',
      },
      { role: 'user', content: news.headline },
    ], 120);
    if (!out) return null;
    try {
      const parsed = JSON.parse(out.replace(/```json|```/g, '').trim());
      return {
        currencies: Array.isArray(parsed.currencies) ? parsed.currencies.map(String) : [],
        category: String(parsed.category ?? 'OTHER'),
        importance: String(parsed.importance ?? 'LOW'),
      };
    } catch {
      return null;
    }
  }

  async explain(context: Record<string, unknown>): Promise<string | null> {
    return this.chat([
      {
        role: 'system',
        content:
          'You explain a forex trading signal from evidence. Be honest about uncertainty and opposing evidence. 4-6 sentences. Never guarantee outcomes.',
      },
      { role: 'user', content: JSON.stringify(context) },
    ]);
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    if (!this._available) return { ok: false, detail: 'GROQ_API_KEY not set' };
    return { ok: true, detail: 'configured (availability verified on first call)' };
  }
}

export class NoopLlmProvider implements LlmProvider {
  readonly name = 'NONE';
  readonly available = false;
  readonly description = 'LLM disabled. Signal explanations are evidence-only.';
  async summarize(_news: NewsItem[]): Promise<string | null> {
    return null;
  }
  async classify(_news: NewsItem): Promise<{ currencies: string[]; category: string; importance: string } | null> {
    return null;
  }
  async explain(_context: Record<string, unknown>): Promise<string | null> {
    return null;
  }
  async health(): Promise<{ ok: boolean; detail: string }> {
    return { ok: false, detail: 'no LLM provider configured' };
  }
}

export function createLlmProvider(): LlmProvider {
  return config.groqApiKey ? new GroqLlmProvider() : new NoopLlmProvider();
}
