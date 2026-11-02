import express, { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { Container } from './core/container';
import { AuthService } from './auth/auth';
import { createApiRouter } from './api/routes';
import { config } from './config';
import { logger } from './core/logger';

export interface AppExtraRouter {
  path: string;
  router: express.Router;
}

export function createApp(container: Container, auth: AuthService, extra: AppExtraRouter[] = []): express.Express {
  const app = express();
  app.disable('x-powered-by');
  // Behind a reverse proxy (nginx/TLS terminator), req.ip is the proxy unless
  // the hop count is trusted — every client then shared ONE rate-limit bucket.
  if (config.trustProxyHops > 0) app.set('trust proxy', config.trustProxyHops);
  app.use(helmet({
    contentSecurityPolicy: config.nodeEnv === 'production' ? undefined : false,
  }));
  app.use(cors({ origin: config.frontendUrl, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  const isDev = config.nodeEnv !== 'production';
  app.use(rateLimit({
    windowMs: 60_000,
    limit: isDev ? 10_000 : 300,
    standardHeaders: true,
    legacyHeaders: false,
    // The internal feed (MT5 bridge) is token-authenticated and pushes up to
    // 5 batches/sec — exempt it from the anonymous client limiter.
    skip: (req) => req.path.startsWith('/api/internal'),
  }));

  // Dedicated credential-stuffing limiter: the global bucket allowed
  // ~5 password guesses/sec/IP with no lockout.
  const authLimiter = rateLimit({
    windowMs: 60_000,
    limit: isDev ? 10_000 : 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'too many authentication attempts — try again in a minute' },
  });

  // request logging + audit
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.on('finish', () => {
      if (req.path.startsWith('/api/auth')) return; // don't log credentials
      logger.debug('http', { method: req.method, path: req.path, status: res.statusCode });
    });
    next();
  });

  app.use('/api', createApiRouter(container, auth, extra, authLimiter));

  // Root liveness (§36): cheap, unauthenticated, no engine work — deep state
  // lives under /api/india/* and /api/*.
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', uptimeMs: Math.round(process.uptime() * 1000), timestamp: Date.now() });
  });

  // Extra routers (e.g. the Indian subsystem) are mounted INSIDE
  // createApiRouter's authenticated gate — mounting them here bypassed auth.
  void extra;

  app.use('/api', (_req, res) => res.status(404).json({ error: 'not found' }));

  // central error handler
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error('unhandled error', { err: String(err), stack: err.stack });
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}
