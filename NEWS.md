# NEWS.md

## Providers

| Provider | Source | Free? | Key? | Notes |
|---|---|---|---|---|
| `RSS` | InvestingLive/ForexLive, FXStreet, ActionForex, Investing.com Forex — free public RSS feeds (default) | yes | no | feeds cached 5 min, deduplicated; each feed fails independently |
| `NONE` | disabled | — | — | system never fabricates news |

`NEWSAPI` is documented as a future provider (paid key, higher rate limits).

## Pipeline

1. Fetch (with an 8 s per-feed timeout — a slow feed never blocks startup or
   the background refresh) → 2. dedupe by `dedupeKey` → 3. cache →
4. persist (`news`) → 5. optional LLM enrichment (Groq: currency extraction +
   category; best effort) → 6. emit `news.update`.

News is refreshed every 5 minutes in the background and immediately after
startup; fresh news for a currency triggers instant re-analysis of the
affected pairs (event-driven signal engine).

## Sentiment

Preferred: **FinBERT** (`ProsusAI/finbert`, free/open-source) served by the
AI engine at `POST /sentiment`. Install the optional dependency once
(`pip install -r ai-engine/requirements-finbert.txt`); the model downloads
once from Hugging Face (~420 MB) and then runs fully local/offline. If
transformers is not installed or the model fails, the engine falls back to a
**financial lexicon** and reports `source: "RULE_BASED"` — it never silently
claims FinBERT output. If nothing is available the sentiment is `UNAVAILABLE`
and downstream treats it as unknown.

Output per item: `{class: positive|negative|neutral, confidence, score,
model, source}`. Aggregated per currency for the feature vector.

## Safety rules

- News feeds are cached and rate-limit-friendly; the app never bypasses
  publisher terms or scrapes paid content.
- If the news provider is down: `newsAvailable=false` lowers the data-quality
  score and the configured safe policy applies (news-sensitive strategies
  stay blocked when `highImpactNewsRestriction` is on).
- Groq is used only for summarization/classification/explanation — never for
  risk controls and never for the core signal math. When Groq is down, the
  signal explanation degrades to evidence-only and trading logic is
  unaffected.
