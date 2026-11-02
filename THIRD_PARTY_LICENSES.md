# THIRD_PARTY_LICENSES.md

Every external dependency used by the platform, with license and role. All are
free/open-source. Verify current license/version before upgrading.

## Node.js / TypeScript (backend + frontend)

| Package | Purpose | License |
|---|---|---|
| express | REST API framework | MIT |
| socket.io | WebSocket real-time layer | MIT |
| ws | WebSocket client (Binance stream) | MIT |
| mongodb | Mongo driver | Apache-2.0 |
| ioredis | Redis client | MIT |
| jsonwebtoken | JWT auth | MIT |
| bcryptjs | Password hashing | MIT |
| zod | Input validation | MIT |
| rss-parser | RSS news ingestion | MIT |
| cheerio | HTML parsing (central-bank calendars) | MIT |
| cors / helmet / express-rate-limit | Security middleware | MIT |
| ccxt | Crypto exchange connectivity (CryptoExchangeAdapter) | MIT |
| react / react-dom | UI | MIT |
| redux-toolkit / react-redux | State management | MIT |
| lightweight-charts | Real-time charts | Apache-2.0 |
| recharts | Backtest equity curves | MIT |
| socket.io-client | WS client | MIT |
| vite / vitest / typescript / tailwindcss / tsx | Build, test, tooling | MIT |

## Python (ai-engine)

| Package | Purpose | License |
|---|---|---|
| fastapi / uvicorn | API server | MIT / BSD-3-Clause |
| numpy / pandas / scipy | Numerics | BSD-3-Clause |
| scikit-learn | ML baseline + calibration | BSD-3-Clause |
| xgboost | Gradient boosting | Apache-2.0 |
| lightgbm | Gradient boosting | MIT |
| joblib | Model serialization | BSD-3-Clause |
| pytest | Tests | MIT |
| transformers + torch (optional FinBERT) | Local sentiment model | Apache-2.0 |

## Data / models

| Asset | Role | License / terms |
|---|---|---|
| FinBERT (ProsusAI) | Financial sentiment model | Apache-2.0 (open weights) |
| Binance public API | Crypto market data | Binance terms; public market data free for development/personal use |
| Yahoo Finance public chart API | Forex quotes | **Unofficial endpoint** — personal/dev use, may change; see MARKET_DATA.md |
| RSS feeds used | News | Only feeds whose terms permit use; attribution preserved via source/url fields |
| ForexFactory weekly JSON | Economic calendar | Free public JSON; may rate-limit |

## Third-party framework concepts (evaluated, not vendored)

Backtrader, VectorBT, Lumibot, Freqtrade, NautilusTrader, Hummingbot, FinRL —
evaluated for concepts (event-driven architecture, risk controls, backtesting
patterns) per the master spec §10-16. **None are runtime dependencies.** Their
licenses (GPL-3.0 for Backtrader/VectorBT, MIT/Apache for others) are a reason
they are not vendored into this codebase — the platform uses its own engines
and only borrows architecture ideas.
