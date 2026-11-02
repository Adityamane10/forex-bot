# SECURITY.md

## Implemented controls

| Area | Implementation |
|---|---|
| Authentication | bcrypt (12 rounds) password hashing; JWT sessions (HS256, expiry); `register`/`login` endpoints |
| Authorization | `requireAuth` middleware on protected routes; role field on users |
| WebSocket auth | Socket.IO middleware verifies the JWT before any channel subscription; unauthorized sockets rejected |
| Rate limiting | express-rate-limit (300 req/min per IP) |
| Headers | helmet (CSP off in development for the Vite dev server) |
| CORS | restricted to `FRONTEND_URL` with credentials |
| Input validation | zod schemas on every mutating endpoint (register, login, settings, backtests, train, scanner refresh) |
| Injection | Mongo driver parameterization + a restricted query DSL (no raw query strings from the client); the REST API never accepts arbitrary Mongo queries |
| XSS | React escaping by default; CSP in production |
| CSRF | JWT-in-header auth (no cookies), so CSRF is not applicable to state-changing calls |
| Secrets | API keys live only in backend env (`config.ts`); never sent to the frontend; `.env` git-ignored |
| Audit | immutable `auditLogs` trail: user.registered, signal lifecycle, risk blocks, paper actions |

## Known limitations (honest)

- JWT_SECRET default is a dev value — **must be changed** in production
  (`openssl rand -hex 32`).
- Passwords are hashed but there is no account lockout / email verification /
  MFA yet (documented future work).
- Rate limiting is per-process; scale-out needs a shared limiter (Redis).
- HTTPS termination is delegated to the reverse proxy (see DEPLOYMENT.md).
- In-memory fallbacks bypass Mongo auth by design (local demo only).

## Threat notes

- NoSQL injection: mitigated via the typed query DSL and zod-validated
  inputs; no endpoint accepts `filter` objects from clients.
- Secret exposure: the frontend build contains no backend env values.
- WebSocket replay: tokens expire; disconnect handlers clean subscriptions.
