# DEPLOYMENT.md

## Option 1 — Docker Compose (recommended for a single host)

```bash
cp .env.example .env        # set JWT_SECRET, optional API keys
docker compose up -d --build
```

Frontend is served by the Vite dev server in this compose file (development
mode). For a production-style build, swap the frontend service to serve
`frontend/dist` with a static server (nginx) and proxy `/api` +
`/socket.io` to the backend container.

## Option 2 — Local processes

See SETUP.md. Three processes: backend (4000), ai-engine (8500), frontend
(5173).

## Option 3 — Production layout (recommended topology)

```
                        ┌──────────────┐
  browser ──443──► nginx ──/api──────► backend (x2, behind LB)
              (TLS, static dist)      backend (x2) ──► MongoDB (replica)
                        └─/socket.io─► backend ──► Redis
                                      backend ──► ai-engine (8500, x1-2)
```

Notes:

- Run MongoDB Atlas M0 (free) or a managed instance; set `MONGODB_URI`.
- Run Redis (managed or container); set `REDIS_URL`.
- Scale the backend horizontally only with real Mongo/Redis (the in-memory
  fallbacks are single-process).
- Terminate TLS at nginx; set `FRONTEND_URL` to the public origin and keep
  CORS locked to it.
- Set a strong `JWT_SECRET`.
- The AI engine needs a persistent volume for `models/` and `datasets/`
  (docker-compose already mounts `ai-models`).
- Add the following `ALLOW_*` flags are deliberately safe-by-default; keep
  them off in production.

## Health checks

- `GET /api/ready` → 200 only when signal generation is allowed.
- `GET /api/system/status` → per-component status for monitoring/alerting.
- Container healthchecks exist for Mongo and Redis in compose.

## Backups

- Mongo: standard `mongodump`/Atlas backups for `signals`, `signalSnapshots`,
  `paperTrades`, `modelVersions`, `auditLogs`.
- AI engine: back up the models/datasets volume (models are reproducible by
  re-training, but version history matters for auditability).
