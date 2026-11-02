# FX Intel — Real-Time Forex + Crypto Quantitative Trading Platform

AI/ML-assisted **Forex + Crypto analysis, signal generation, backtesting and
paper trading**. Real-time market data (forex: Yahoo/TwelveData/Finnhub/MT5;
crypto: free Binance spot WebSocket) → candles → indicators → multi-timeframe →
price action → support/resistance → historical patterns → news → economic
events → sentiment → features → ML → calibration → uncertainty → expected
value → entry/SL/TP → position sizing → portfolio risk → circuit breakers →
signal → paper trade.

> **Educational tool — NOT financial advice.**
> The system never claims to know the future. Predictions are expressed as
> probabilities, confidence, expected value and risk. It can always say
> **WAIT**, **NO TRADE**, or **INSUFFICIENT CONFIDENCE** — and it does,
> often. No real money is ever traded.

## Stack (free & open-source)

| Layer | Technology |
|---|---|
| Frontend | React 18 · TypeScript · Vite · Tailwind CSS · Redux Toolkit · Socket.IO client · lightweight-charts · recharts |
| Backend | Node.js · TypeScript · Express · Socket.IO · Zod |
| AI/ML | Python · FastAPI · pandas · NumPy · scikit-learn · XGBoost · LightGBM |
| Storage | MongoDB (driver + in-memory fallback) · Redis (client + in-memory fallback) |
| Infra | Docker Compose · Git |

External data providers are **optional** and swappable (see `MARKET_DATA.md`,
`NEWS.md`, `ECONOMIC_EVENTS.md`, `DATA_LICENSES.md`). Without any API key the
platform runs in **DEMO mode** with a clearly-labeled simulated feed. With no
keys it also runs on **real data**: Yahoo (forex, unofficial) and Binance
public API (crypto, real bid/ask).

## Quick start (no Docker, no keys)

```bash
npm install
npm run build:shared

# Terminal 1 — Python AI engine (Python 3.13)
npm run dev:ai

# Terminal 2 — backend
npm run dev:backend

# Terminal 3 — frontend
npm run dev:frontend
```

Open http://localhost:5173, register an account, and explore: Dashboard →
Market (live chart) → Signals → Backtesting → Models (train the ML
challenger) → Risk → System.

### One double-click — ForexBot.exe

No terminal at all: double-click **`scripts\launcher\ForexBot.exe`** (create a
desktop shortcut with `scripts\launcher\create-shortcut.ps1`). It starts the
whole stack — shared, backend, frontend, AI engine, the MetaTrader 5 terminal
with the tick bridge and order worker — opens the dashboard automatically, and
its tray icon stops everything cleanly on Exit. Details and troubleshooting:
[`scripts/launcher/README.md`](scripts/launcher/README.md).

### One command, MT5 included

```bash
npm run dev:all      # shared + backend + AI + frontend + MT5 terminal + bridge + trader
```

On Windows this also brings the **MetaTrader 5 application up with the rest** —
the bridge and trader attach to a running, logged-in terminal, so leaving that
step to the operator is what silently turns "MT5 connected" into "every order
queued". The install is found automatically (`.data/mt5-path.txt` → the
terminal's own `origin.txt` records → program folders → registry → Start-Menu
shortcuts); `node scripts/mt5-locate.mjs` shows what was found and where, and the
workers wait up to `MT5_STARTUP_WAIT_S` (180s) for the terminal to finish loading
instead of failing into a watchdog cooldown.

| Variable | Purpose |
| --- | --- |
| `MT5_PATH` | explicit path to `terminal64.exe` (overrides auto-discovery) |
| `MT5_LAUNCH=0` | don't launch the terminal |
| `MT5_WAIT_MS` | settle time after the terminal process appears (default 5000) |
| `MT5_STARTUP_WAIT_S` | how long the bridge/trader wait for the terminal (default 180) |
| `MT5_BRIDGE=0` / `MT5_TRADER=0` | skip a worker |

Full instructions in [`SETUP.md`](SETUP.md) (including `docker compose up`).

## Repository layout

```
/frontend     React + Vite dashboard (13 sections)
/backend      Node/TS engines, REST API, Socket.IO, broker account binding
              (`broker/`: account profile, MT5 binding, policy watcher)
/ai-engine    Python FastAPI: features, ML, calibration, walk-forward
/shared       Type contract + constants + asset engine (npm workspace)
/docker       Dockerfiles for the compose stack
/docs         full documentation (24 documents)
/scripts      setup helper
```

## Documentation index

| Topic | Doc |
|---|---|
| Setup & Docker | [`SETUP.md`](SETUP.md) · [`DEPLOYMENT.md`](DEPLOYMENT.md) |
| Architecture | [`ARCHITECTURE.md`](ARCHITECTURE.md) |
| REST API | [`API.md`](API.md) |
| WebSocket events | [`WEBSOCKET.md`](WEBSOCKET.md) |
| Database | [`DATABASE.md`](DATABASE.md) |
| Market data & providers | [`MARKET_DATA.md`](MARKET_DATA.md) |
| Indicators | [`INDICATORS.md`](INDICATORS.md) |
| Features | [`FEATURES.md`](FEATURES.md) |
| ML & calibration | [`ML.md`](ML.md) · [`ML_PIPELINE.md`](ML_PIPELINE.md) |
| News & sentiment | [`NEWS.md`](NEWS.md) |
| Economic calendar | [`ECONOMIC_EVENTS.md`](ECONOMIC_EVENTS.md) |
| Trading engine | [`TRADING_ENGINE.md`](TRADING_ENGINE.md) |
| Signal engine | [`SIGNAL_ENGINE.md`](SIGNAL_ENGINE.md) |
| Risk engine | [`RISK.md`](RISK.md) · [`RISK_ENGINE.md`](RISK_ENGINE.md) |
| Portfolio & correlation | [`PORTFOLIO.md`](PORTFOLIO.md) |
| Paper trading | [`PAPER_TRADING.md`](PAPER_TRADING.md) |
| Broker & account binding (XM / MT5) | [`BROKER.md`](BROKER.md) |
| Backtesting & research | [`BACKTESTING.md`](BACKTESTING.md) · [`RESEARCH.md`](RESEARCH.md) |
| Walk-forward | [`WALK_FORWARD.md`](WALK_FORWARD.md) |
| MLOps & champion/challenger | [`MLOPS.md`](MLOPS.md) · [`MODEL_VERSIONING.md`](MODEL_VERSIONING.md) |
| Security | [`SECURITY.md`](SECURITY.md) |
| Testing | [`TESTING.md`](TESTING.md) |
| Troubleshooting | [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) |
| Free services & licenses | [`FREE_SERVICES.md`](FREE_SERVICES.md) · [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md) |
| Project audit | [`PROJECT_AUDIT.md`](PROJECT_AUDIT.md) |

## Non-negotiable rules implemented

1. Never fabricate market data, news, predictions or model accuracy.
2. No lookahead bias anywhere (features and targets are separated in time).
3. LLM (Groq) can never override risk controls.
4. Risk is never raised to satisfy a profit target → `NO TRADE`.
5. Every signal has an immutable snapshot; every model/dataset has a version.
6. The system always outputs `WAIT` / `NO TRADE` / `INSUFFICIENT CONFIDENCE`
   when confidence is insufficient.
7. Unreliable market data or a down ML engine → signal generation stops.
8. Missed entries are marked `MISSED` and never shown as current entries.
9. Broker trading terms are never invented. Contract size, lot geometry,
   spreads, swaps, leverage and margin levels come from the bound broker account
   (`symbol_info`/`account_info`); the commission — which MetaTrader does not
   serve — comes from what the broker publishes for the selected account type,
   acknowledged by you, or from what you confirmed yourself. Each value carries
   its provenance, and per-symbol costs (spread / commission / swap) are priced
   on the broker's own data in the account currency. Unverified terms hold live
   dispatch (orders stay queued, nothing is executed) and are never shown as
   confirmed. Real money needs two independent opt-ins (`ALLOW_REAL_TRADING`,
   `MT5_ALLOW_REAL`); with either off, a real account can be bound and monitored
   but not traded. Every position and trade records the terms it was executed
   under. See [`BROKER.md`](BROKER.md) — and `npm run verify:broker` to check the
   whole chain against a running backend.

## Verification status

See [`TESTING.md`](TESTING.md) and the final report in `docs/FINAL_TEST_REPORT.md`
for what was actually run and what passed. Backend: unit + integration suites via
`npm run test:backend` (a handful of the live-pipeline tests need a real market
feed and a live USD/INR rate, and are the only ones that fail without one).
AI engine: 12 tests (feature correctness, no-lookahead, walk-forward,
calibration, promotion). Frontend: build + typecheck verified; unit tests for
formatting. Live end-to-end workflows verified against running services.

## Agent coordination with Concord MCP

This repo uses **Concord MCP** to coordinate multiple coding agents working in
the same checkout: agents claim a task and its expected files before editing,
then publish progress and completion evidence in a shared, local workspace
(`.concord/`). The full workflow — setup, task lifecycle, and messaging — is in
[`docs/CONCORD_MCP_USAGE.md`](docs/CONCORD_MCP_USAGE.md).

OpenCode sessions need explicit configuration. Copy
[`opencode.example.json`](opencode.example.json) into a local `opencode.json`
and give every session a **unique** `CONCORD_AGENT_ID` (for example
`opencode:session-a` and `opencode:session-b`) before starting it, so agents are
distinct and share the same workspace.

**Limitation:** Concord currently has no native OpenCode adapter, so there are no
lifecycle hooks, idle wake-ups, or automatic live message injection. The MCP
workflow tools still work normally; live peer messaging requires the CLI inbox:

```powershell
concord inbox register --agent "opencode:session-a" --provider opencode
concord inbox drain --agent "opencode:session-a" --provider opencode
```

Use the same agent id as `CONCORD_AGENT_ID`. Without this step, messages are
stored but never delivered to the OpenCode session.
