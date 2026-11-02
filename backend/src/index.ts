import http from 'http';
import { Container } from './core/container';
import { AuthService } from './auth/auth';
import { createApp } from './app';
import { SocketManager } from './ws/socket';
import { config } from './config';
import { logger } from './core/logger';
import { IndiaModule } from './india';
import { createIndiaApiRouter } from './india/routes';

async function main(): Promise<void> {
  const container = new Container();
  await container.init();

  // Indian-market subsystem: isolated composition root + REST mount. If India
  // init fails the rest of the app keeps running (india never breaks forex).
  const india = new IndiaModule({ store: container.store, cache: container.cache, events: container.ctx.events });

  const app = createApp(container, new AuthService(container.store), [{ path: '/api/india', router: createIndiaApiRouter(india) }]);
  const server = http.createServer(app);
  const sockets = new SocketManager(server, container, new AuthService(container.store));
  sockets.init();

  // Bind early: the provider init below takes ~60s (historical seeding, poll
  // warm-up). Listening first means the port is never refused during boot —
  // requests in that window simply see components come up (health reports the
  // real state; the frontend's defensive fetches handle empty payloads).
  server.listen(config.port, () => {
    logger.info('backend listening', {
      port: config.port,
      marketData: config.marketDataProvider,
      mode: container.ctx.providers.marketData.mode,
      store: container.store.backend,
      cache: container.cache.backend,
    });
  });

  await container.start();

  await india.init().catch((err) => logger.warn('india module init failed — continuing without it', { err: String(err) }));
  india.start();

  // periodic system status broadcast
  setInterval(async () => {
    // Expose the REAL live socket client count to /api/system/status — the
    // old `app.get('wsClients')` was never written, so the health report was
    // always computed under a false "clients connected" premise.
    app.set('wsClients', sockets.clientCount);
    const report = await container.health.check(sockets.clientCount > 0);
    container.ctx.events.emit('system.status', report);
    if (!report.signalGenerationAllowed) {
      container.signals.invalidateAll('critical system component DOWN — signals stopped');
    }
  }, 15_000).unref();

  const shutdown = async (signal: string) => {
    logger.info('shutting down', { signal });
    // Idempotency guard: a second SIGINT/SIGTERM during a slow shutdown used
    // to run the whole teardown concurrently (double flush, double stop).
    if ((globalThis as { __shuttingDown?: boolean }).__shuttingDown) return;
    (globalThis as { __shuttingDown?: boolean }).__shuttingDown = true;
    // Watchdog: a hung Mongo close must not hang SIGTERM forever.
    const forceExit = setTimeout(() => process.exit(1), 10_000);
    forceExit.unref();
    sockets.shutdown();
    india.stop();
    await container.stop().catch((err) => logger.warn('container stop error', { err: String(err) }));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error('fatal startup error', { err: String(err), stack: err.stack });
  process.exit(1);
});
// env reload trigger










