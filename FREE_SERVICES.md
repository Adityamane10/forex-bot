# FREE_SERVICES.md

Free / free-tier services used by the platform, with honest limits. The core
system runs with **zero paid services**. Every provider is optional and
swappable; nothing here requires a credit card.

## Market data

| Service | Type | Free? | Limits | Notes |
|---|---|---|---|---|
| Yahoo Finance chart API | Forex REST (polled) | ✅ no key | unofficial; app caps at 30 req/min | Bid/ask **modeled** (`spreadModeled`); near-real-time (p50 ~1.5 s, slow pairs ~60 s). **Unofficial** — may throttle/change; dev/personal use. |
| Binance public API | Crypto REST + WebSocket | ✅ no key | bookTicker weight 2, klines weight 2, 6000 weight/min IP | **Real bid/ask** via bookTicker WebSocket; real klines history. No funding for spot. |
| Twelve Data | Forex REST | ✅ free tier | 8 req/min, 800/day | Requires key (`MARKET_DATA_API_KEY`); bid/ask modeled. |
| Finnhub | Forex REST | ✅ free tier | 60 calls/min (app uses ≤55) | Requires key (`FINNHUB_API_KEY`); real-time mid, no free bid/ask (modeled). |
| MT5 bridge | Forex tick stream | ✅ free demo account | none (push) | `workers/mt5-bridge`; needs a local MT5 terminal + free demo account; zero-polling real ticks. |

## News & calendar

| Service | Type | Free? | Limits | Notes |
|---|---|---|---|---|
| RSS feeds (InvestingLive/ForexLive, FXStreet, ActionForex, Investing.com Forex) | News | ✅ no key | cached 5 min, deduped | Default on; only feeds whose terms permit use. |
| ForexFactory weekly JSON | Economic calendar | ✅ no key | may 429 like any public feed | Merged with official central-bank pages. |
| Official central-bank pages (Fed FOMC / BoE MPC / BoJ MPM / ECB) | Economic calendar | ✅ | fetch throttling | Each source fails independently; rate decisions 4-6 weeks out included. |

## AI / ML

| Service | Type | Free? | Notes |
|---|---|---|---|
| scikit-learn / XGBoost / LightGBM | Local ML | ✅ open source | Runs locally; no API. |
| FinBERT (Hugging Face) | Sentiment | ✅ open weights (Apache-2.0) | One-time ~420 MB download, then offline; falls back to lexicon (`RULE_BASED`). |
| Groq | LLM (optional) | ✅ free tier | News summarization / explanations ONLY — never risk controls or signal decisions. |
| CCXT | Crypto exchange library | ✅ open source | Public Binance data via `CryptoExchangeAdapter`; no key needed for public reads. |
| On-chain (whales/flows/liquidations) | Crypto on-chain | ❌ none free/keyless | `OnChainProvider` interface exists but reports **UNAVAILABLE** — crypto analysis runs without on-chain features rather than fabricating them. Plug a legitimate source here when available. |

## Infrastructure

MongoDB Community, Redis, Node.js, React, Vite, Tailwind, Socket.IO, Docker —
all free/open source. Local in-memory fallbacks mean the stack runs with no
databases at all (state is then not durable — surfaced in System Health).

## What can cost money (honest)

- **Production-grade licensed live forex data** (e.g. paid Finnhub/TwelveData
  tiers, OANDA/FXCM feeds) — the free tiers above are rate-limited.
- **Cloud hosting** for a deployed multi-instance stack.
- **Real exchange execution fees** — live trading is disabled by default and
  no real order can be placed in this build.
