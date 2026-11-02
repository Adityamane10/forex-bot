# RESOURCE AUDIT — Providers & Free-First Compliance (Phases 4 & 92)

Every external provider is behind an interface with a safe fallback. The **core
system runs with zero paid services**. Providers below are documented with their
free-tier reality; limits are never bypassed.

## 1. Market data

| | Yahoo Finance (default, REST) | Twelve Data (REST) | Finnhub (REST) | MT5 bridge (streaming) | Demo feed |
|---|---|---|---|---|---|
| Implementation | `yahooFinanceMarketData.ts` | `twelvedataMarketData.ts` | `finnhubMarketData.ts` | `workers/mt5-bridge/bridge.py` | `demoMarketData.ts` |
| Free availability | Yes — no key, works today | Yes — free tier | Yes — free tier | Yes — free broker demo account + terminal | Yes (local, generated) |
| Rate limits | unofficial; app caps at 30/min | 8 req/min, 800/day | 60 req/min (app uses ≤55) | none (tick push) | none |
| Real-time | near-real-time: p50 ~1.5s, slow pairs ~60s | REST poll (adaptive: hot 15s, idle 60s) | REST poll (adaptive: hot 5s, idle 30s) | true tick stream (~200ms batches) | simulated stream |
| Bid/ask | **modeled (labeled `spreadModeled`)** | modeled (labeled) | **modeled (labeled `spreadModeled`)** | real bid/ask from MT5 | modeled (labeled DEMO) |
| Historical data | up to 1440 bars/call, deep ranges | years of daily; intraday limited by credits | up to 5000 bars/call | full M1→D1 via terminal | synthetic, clearly labeled |
| Official/licensed | **unofficial endpoint** — personal/dev use, may break | Paid plan required for commercial | Paid plan required for commercial | personal use typical | n/a |
| API key | none | `MARKET_DATA_API_KEY` | `FINNHUB_API_KEY` | `INTERNAL_API_TOKEN` (backend side) | none |
| Fallback if missing | reports DOWN; signals stop (never silent demo) | reports DOWN → labeled DEMO fallback | same | exits with clear error, never fakes ticks | default |

Switching: `MARKET_DATA_PROVIDER=YAHOO|TWELVEDATA|FINNHUB` in `.env`. Ticks
from polled providers carry `spreadModeled` so modeled spreads are never
mistaken for quotes. The demo feed never claims to be live — the UI labels it
`DEMO DATA`, and it is only used when explicitly configured or as a labeled
fallback for keyed providers.

### Crypto market data

| | Binance (default, streaming WS + REST) | Demo crypto feed |
|---|---|---|
| Implementation | `binanceCryptoMarketData.ts` | `demoMarketData.ts` |
| Free availability | Yes — public unauthenticated API | Yes (local, generated) |
| Rate limits | bookTicker weight 2, klines weight 2; 6000 weight/min IP limit — app stays far below (7 symbols, ≤ 2 REST calls/symbol/minute) | none |
| Real-time | **true bid/ask streaming** via bookTicker WebSocket (~ms); REST fallback | simulated stream |
| Bid/ask | **real exchange quotes** (never modeled) | modeled (labeled DEMO) |
| Historical data | real klines per interval (1000 bars/call) | synthetic, labeled |
| API key | none | none |
| Fallback if missing | reports DOWN → labeled DEMO fallback | default |

Switching: `CRYPTO_MARKET_DATA_PROVIDER=BINANCE|DEMO`. Both feeds run
concurrently behind `RoutingMarketDataProvider`; per-tick `mode`/`venue` are
always truthful.

## 2. News

| | RSS news (default: `NEWS_PROVIDER=RSS`) | Noop |
|---|---|---|
| Implementation | `newsProvider.ts` (RssNewsProvider) | same file |
| Sources | InvestingLive/ForexLive, FXStreet, ActionForex, Investing.com Forex — free public RSS feeds | n/a |
| Free availability | Yes — no key, verified reachable from this build | n/a |
| Rate limits | Respect feed polling etiquette (cached 5 min, 8 s per-feed timeout, deduplicated) | n/a |
| Terms | Use only feeds whose terms permit it | n/a |
| API key | none | none |
| Fallback | news engine continues with reduced/no news; sentiment safely degrades | |

`NEWSAPI` is documented but **not implemented** in this build — selecting it throws
a clear error rather than silently fabricating news.

## 3. Economic calendar

| | CentralBank (default: `ECONOMIC_CALENDAR_PROVIDER=CENTRALBANK`) | ForexFactory only | Noop |
|---|---|---|---|
| Implementation | `centralBankCalendar.ts` (Fed/BoE/BoJ/ECB official pages + ForexFactory JSON) | `calendarProvider.ts` | same files |
| Free availability | Yes — official public government pages + free JSON feed | Yes — public JSON | n/a |
| Rate limits | Feed throttling; each source fails independently (cached 15 min) | may rate-limit (429) like any public feed | n/a |
| API key | none | none | none |
| Fallback | remaining official sources keep working; event risk raises uncertainty when all are down | | |

## 4. LLM (optional)

| | Groq | Noop |
|---|---|---|
| Implementation | `llmProvider.ts` (GroqLlmProvider) | same file |
| Free availability | Free tier (rate-limited) | n/a |
| Usage | News summarization, classification, explanations **only** | n/a |
| Never used for | Predictions, risk controls, signal decisions | n/a |
| Fallback | Signal explanations simplify; trading logic unaffected | |

Core signal engine is **fully functional with no LLM**.

## 5. Sentiment NLP

| | Lexicon fallback | FinBERT (installed by default in this build) |
|---|---|---|
| Implementation | `sentiment.py` | same file |
| Free availability | Yes (local) | Yes — Hugging Face open weights (Apache-2.0) |
| Install | none | `pip install -r ai-engine/requirements-finbert.txt` (CPU torch + transformers) |
| Model download | none | one-time ~420 MB download, then fully offline |
| Fallback | lexicons always available | degrades to lexicon (labeled `RULE_BASED`) |

## 6. ML stack — fully local & open source

sklearn, XGBoost, LightGBM, NumPy, pandas, SciPy, statsmodels. No ML API required.

## 7. Infrastructure — free-first

MongoDB (Community), Redis, Docker, Node, React, Vite, Tailwind, Socket.IO — all
open source. Local in-memory fallbacks mean the stack runs with zero databases too.

## 8. What happens when each service fails (Phase 93)

| Failure | Behavior |
|---|---|
| Market data | Signal generation **stops**; system health reports degraded |
| ML | Outputs `WAIT` / `INSUFFICIENT_CONFIDENCE` |
| News | Safe fallback: news features neutralized |
| Calendar | Uncertainty raised; news-sensitive strategies blocked |
| Groq | Continues without LLM explanations |
| Redis | Real-time layer disabled safely (memory fallback) |
| Mongo | Persistence workflows paused; live pipeline keeps running |

## 9. Compliance statements

- No paid service in the core architecture.
- No provider rate limit is bypassed.
- No data is scraped against terms; RSS/API feeds only.
- The system never fabricates data: missing providers degrade honestly and are
  surfaced in the System Health UI.
