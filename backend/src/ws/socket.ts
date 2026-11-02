/**
 * WebSocket layer (Socket.IO). Fans out engine events to connected clients and
 * authenticates socket connections with the same JWT as the REST API.
 * Unauthorized sockets cannot join data channels.
 */
import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import { Container } from '../core/container';
import { AuthService } from '../auth/auth';
import { CHANNELS } from '../core/context';
import { INDIA_CHANNELS } from '@fx/shared';
import { config } from '../config';
import { logger } from '../core/logger';

const EVENT_MAP: Record<string, string> = {
  [CHANNELS.tick]: 'market.price',
  [CHANNELS.candle]: 'market.candle',
  [CHANNELS.indicator]: 'indicator.update',
  [CHANNELS.signalCreated]: 'signal.created',
  [CHANNELS.signalUpdated]: 'signal.updated',
  [CHANNELS.signalInvalidated]: 'signal.invalidated',
  [CHANNELS.signalMissed]: 'signal.missed',
  [CHANNELS.signalState]: 'signal.state',
  [CHANNELS.position]: 'paper.position',
  [CHANNELS.trade]: 'paper.trade',
  [CHANNELS.risk]: 'risk.update',
  [CHANNELS.news]: 'news.update',
  [CHANNELS.calendar]: 'calendar.update',
  [CHANNELS.system]: 'system.status',
  [CHANNELS.alert]: 'alert',
  // Broker account binding: which account the platform is trading on, its
  // resolved conditions and whether orders may be dispatched. Pushed on every
  // MT5 heartbeat / selection / confirmation / policy change.
  'broker:profile': 'broker.profile',
  // Broker policy watcher: fetch status and "the published terms changed".
  'broker:policy': 'broker.policy',
  'broker:profile-changed': 'broker.profileChanged',
  'broker:policy-changed': 'broker.policyChanged',
  'scanner.update': 'scanner.update',
  // Goal-mode rankings: the scanner emits this but the map never forwarded it,
  // so the UI's GoalAnalysis list updated once at bootstrap then went stale.
  'goal.update': 'goal.update',
  // Indian subsystem (namespaced, isolated from the Forex/Crypto channels).
  [INDIA_CHANNELS.tick]: 'india.price',
  [INDIA_CHANNELS.candle]: 'india.candle',
  [INDIA_CHANNELS.marketStatus]: 'india.marketStatus',
  [INDIA_CHANNELS.dataHealth]: 'india.dataHealth',
  [INDIA_CHANNELS.signal]: 'india.signal',
  [INDIA_CHANNELS.signalInvalidated]: 'india.signalInvalidated',
  // Setups the engine found and declined, with the gate trail that declined them.
  // Without this the UI can only show what was traded, so "why has nothing
  // happened for two hours" has no answer.
  [INDIA_CHANNELS.signalRejected]: 'india.signalRejected',
  [INDIA_CHANNELS.indicatorUpdate]: 'india.indicator',
  [INDIA_CHANNELS.position]: 'india.position',
  [INDIA_CHANNELS.order]: 'india.order',
  [INDIA_CHANNELS.pnl]: 'india.pnl',
  [INDIA_CHANNELS.goal]: 'india.goal',
  [INDIA_CHANNELS.goalProgress]: 'india.goalProgress',
  [INDIA_CHANNELS.contract]: 'india.contract',
  [INDIA_CHANNELS.expiry]: 'india.expiry',
  [INDIA_CHANNELS.scanner]: 'india.scanner',
  [INDIA_CHANNELS.executionAuthority]: 'india.executionAuthority',
  [INDIA_CHANNELS.reconciliation]: 'india.reconciliation',
  // Option flow and chain analytics. Both engines already emitted these; nothing
  // was listening, so the option panels had to poll on a 30s timer for data the
  // backend was recomputing every 15–20s anyway.
  [INDIA_CHANNELS.optionFlow]: 'india.optionFlow',
  [INDIA_CHANNELS.optionAnalytics]: 'india.optionAnalytics',
};

export class SocketManager {
  private io!: Server;
  private unsubs: Array<() => void> = [];

  constructor(private httpServer: HttpServer, private container: Container, private auth: AuthService) {}

  init(): void {
    this.io = new Server(this.httpServer, {
      // Pin the origin to the configured frontend (wildcard + credentials is
      // an invalid combination and invited cross-origin handshakes).
      cors: { origin: config.frontendUrl, credentials: true },
      maxHttpBufferSize: 1e6,
    });

    this.io.use((socket, next) => {
      const token = socket.handshake.auth?.token as string | undefined;
      if (!token) return next(new Error('authentication required'));
      const user = this.auth.verify(token);
      if (!user) return next(new Error('invalid token'));
      (socket.data as Record<string, unknown>).user = user;
      next();
    });

    this.io.on('connection', (socket: Socket) => {
      logger.info('socket connected', { id: socket.id });
      socket.on('subscribe', (channel: string) => {
        const allowed = ['market', 'signals', 'news', 'risk', 'paper', 'system', 'scanner', 'india', 'broker'];
        if (allowed.includes(channel)) socket.join(channel);
      });
      socket.on('disconnect', () => logger.info('socket disconnected', { id: socket.id }));
    });

    // fan out engine events
    for (const [internal, external] of Object.entries(EVENT_MAP)) {
      const handler = (payload: unknown) => {
        this.io.emit(external, payload);
      };
      this.container.ctx.events.on(internal, handler);
      this.unsubs.push(() => this.container.ctx.events.off(internal, handler));
    }
  }

  get clientCount(): number {
    return this.io?.engine.clientsCount ?? 0;
  }

  shutdown(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    this.io?.close();
  }
}
