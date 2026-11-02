# ARCHITECTURE.md

## System overview

```
MARKET DATA ── RoutingMarketDataProvider ── (forex: YAHOO | TWELVEDATA | FINNHUB | MT5 bridge)
        │                                   └─ (crypto: BINANCE bookTicker WS + REST klines)
        │  ticks
        ▼
MARKET DATA ENGINE ── validate (dup, stale, future, abnormal, bid>ask) ──► Redis/cache latest price
        │
        ▼
CANDLE ENGINE ── 1m 5m 15m 30m 1h 4h 1D ──► open candle in cache, completed candle → Mongo
        │
        ▼
INDICATOR ENGINE ── full indicator set (see INDICATORS.md) ──► indicator.update
        │
        ▼
MULTI-TIMEFRAME  ─► PRICE ACTION ─► SUPPORT/RESISTANCE ─► SESSION ─► HISTORICAL PATTERNS
        │
        ▼
NEWS ENGINE ─► SENTIMENT ─► EVENT ENGINE (economic calendar)
        │
        ▼
FEATURE ENGINE (versioned vector, timestamp-safe)
        │
        ▼
AI ENGINE (Python) ── ML models ── probability calibration ── champion/challenger
        │
        ▼
SIGNAL ENGINE ── regime ─► EV ─► entry/SL/TP/R:R ─► sizing ─► portfolio ─► correlation
             ─► circuit breakers ─► uncertainty ─► DECISION (BUY/SELL/WAIT/NO_TRADE/INSUFFICIENT_CONFIDENCE)
        │
        ├──► state machine + immutable snapshots ─► REST / Socket.IO ─► FRONTEND
        └──► PAPER TRADING (real prices, virtual account)
        └──► BACKTESTING + WALK-FORWARD + METRICS
```

## Components

### `shared` (npm workspace `@fx/shared`)
The contract layer: domain types, constants (timeframes, sessions, states,
regimes, decisions), the Forex asset engine (pip size, contract size, lot
step, leverage, margin, swap, sessions per pair). Both backend and frontend
consume it; the backend consumes the built `dist`, the frontend aliases the
TypeScript source.

### `backend` (Node + TypeScript)
- **Providers** (`src/providers/`) — swappable `MarketDataProvider`,
  `NewsProvider`, `EconomicCalendarProvider`, `LlmProvider`, `ExecutionProvider`
  (live trading OFF by default). `RoutingMarketDataProvider` routes forex
  (DEMO/TwelveData/Finnhub/Yahoo) and crypto (Binance WS+REST) symbols.
  RSS news, ForexFactory calendar, Groq LLM (optional).
- **Engines** (`src/engines/`) — one class per concern: market data, candles,
  indicators, multi-timeframe, price action, support/resistance, sessions,
  patterns, news, events, sentiment, features, regime, expected value,
  entry/SL/TP, sizing, portfolio risk, correlation, circuit breakers, risk
  classification, uncertainty, signals (state machine + snapshots), scanner,
  paper trading, backtesting, metrics, model registry, drift, health, alerts.
- **Math** (`src/math/`) — pure, unit-tested indicator and forex math.
- **Persistence** (`src/db/`) — a `DataStore` facade (Mongo or in-memory)
  and a `Cache` facade (Redis or in-memory) with a small query DSL shared by
  both backends.
- **API / WS** (`src/api/`, `src/ws/`) — Express REST API and authenticated
  Socket.IO fan-out.
- **AI client** (`src/ai/`) — HTTP client for the Python engine with graceful
  degradation.

### `ai-engine` (Python + FastAPI)
Feature computation (single-pass series, no lookahead), dataset building,
walk-forward training (Logistic Regression, Random Forest, XGBoost,
LightGBM), probability calibration (isotonic via `CalibratedClassifierCV`),
dataset/model versioning on disk, champion/challenger registry, drift
assessment, optional FinBERT sentiment with lexicon fallback.

### `frontend` (React + Vite)
Twelve views driven by a Redux store, fed by REST + Socket.IO. Live charts
with lightweight-charts; backtest equity curves with recharts.

## Data flow guarantees

- **No lookahead**: features at bar *i* use bars ≤ *i*; the ML target uses
  bars > *i*; the pattern engine only counts horizons that already completed.
- **Timestamp-safe everything**: every prediction, signal and trade records
  its feature/model/dataset versions and timestamps.
- **Failure safety** (see `RISK.md`): market data down → STOP; ML down →
  WAIT; news/calendar down → configured safe fallback; Groq down → continue
  without LLM; Redis down → real-time layer marked DOWN (not pretended
  healthy); Mongo down → persistence-dependent workflows stop.

## Configuration

All environment variables are documented in `.env.example`. Secrets never
reach the frontend; the REST API is the only source of configuration.

## Scaling notes

The in-memory store/cache fallbacks are single-process. For multiple backend
instances set `MONGODB_URI` and `REDIS_URL` (docker-compose provides them);
Redis pub/sub is then used for cross-instance fan-out.
