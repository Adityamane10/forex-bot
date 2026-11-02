# SETUP.md

Exact installation and startup instructions for the FX Intel platform.

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | >= 20 (tested on 25) | ships npm |
| Python | 3.13 recommended | 3.10–3.14 generally works; ML wheels matter |
| Docker (optional) | any recent | only needed for `docker compose up` |

Check with: `node --version`, `py -3.13 --version` (Windows) or
`python3.13 --version` (macOS/Linux).

## Option A — Docker (Mongo + Redis included)

```bash
cp .env.example .env      # optional; defaults work for demo
docker compose up --build
```

Services:

| Service | URL |
|---|---|
| Frontend | http://localhost:5173 |
| Backend API | http://localhost:4000/api/health |
| AI engine | http://localhost:8500/health |
| MongoDB | mongodb://localhost:27017 |
| Redis | redis://localhost:6379 |

Stop with `docker compose down` (add `-v` to drop volumes).

## Option B — Local, no Docker, no keys (demo mode)

```bash
npm install
npm run build:shared          # builds the shared npm workspace

# Terminal 1 — Python AI engine
npm run dev:ai

# Terminal 2 — backend (Node 20+)
npm run dev:backend

# Terminal 3 — frontend (Vite dev server)
npm run dev:frontend
```

- Frontend: http://localhost:5173
- Backend: http://localhost:4000
- AI engine: http://localhost:8500

Register an account on the login page (password ≥ 8 chars). The dashboard
opens in DEMO mode with a simulated feed. The System view clearly labels
MongoDB/Redis as IN-MEMORY FALLBACK when no URI is configured.

## Enabling real data (optional)

Copy `.env.example` to `.env` and fill in:

| Variable | Purpose | Free option |
|---|---|---|
| `MARKET_DATA_PROVIDER=TWELVEDATA` + `MARKET_DATA_API_KEY` | real OHLC via REST (800 credits/day free) | yes |
| `NEWS_PROVIDER=RSS` | free public feeds (ForexLive, DailyFX) | yes |
| `ECONOMIC_CALENDAR_PROVIDER=FOREXFACTORY` | free public weekly JSON calendar | yes |
| `GROQ_API_KEY` | optional LLM news summaries/explanations | Groq free tier |
| `MONGODB_URI` | persistence | local MongoDB or free Atlas M0 |
| `REDIS_URL` | real-time layer | local Redis |

The backend must be restarted after changing `.env`.

## Python environment (AI engine)

The AI engine needs Python 3.13 (best wheel support for xgboost/lightgbm):

```bash
py -3.13 -m pip install -r ai-engine/requirements.txt
```

`npm run dev:ai` uses `py -3.13`. On Linux/macOS, run
`python3.13 -m uvicorn app.main:app --port 8500` from `ai-engine/` instead, or
set `PY="python3"` when using `node scripts/setup.mjs`.

## Verify it works

```bash
curl http://localhost:4000/api/health      # {"status":"ok",...}
curl http://localhost:8500/health          # {"status":"ok",...}
curl http://localhost:4000/api/ready       # 200 when signal generation is allowed
curl http://localhost:4000/api/system/status
```

Open the dashboard → **System** to see every component's health.
