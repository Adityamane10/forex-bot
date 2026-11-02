/**
 * System health engine. Monitors market data, Mongo, Redis, backend, Python
 * AI, news, calendar, WebSocket and models. If critical data/AI infrastructure
 * fails, signal generation STOPS.
 */
import { ComponentStatus, SystemStatusReport } from '@fx/shared';
import { FxContext } from '../core/context';
import { AiClient } from '../ai/aiClient';
import { MarketDataEngine } from './marketDataEngine';
import { NewsEngine } from './newsEngine';
import { EventEngine } from './eventEngine';
import { DataStore } from '../db/store';
import { Cache } from '../db/cache';
import { ModelRegistry } from './modelRegistry';
import { config } from '../config';
import { logger } from '../core/logger';

export class SystemHealthEngine {
  private lastReport: SystemStatusReport | null = null;

  constructor(
    private ctx: FxContext,
    private marketData: MarketDataEngine,
    private news: NewsEngine,
    private events: EventEngine,
    private ai: AiClient,
    private store: DataStore,
    private cache: Cache,
    private models: ModelRegistry,
  ) {}

  async check(wsConnected: boolean): Promise<SystemStatusReport> {
    const components: ComponentStatus[] = [];
    const now = Date.now();

    const mdHealth = this.marketData.health();
    components.push({
      name: 'Market Data',
      status: mdHealth.ok ? 'HEALTHY' : 'DOWN',
      detail: mdHealth.detail,
      lastChecked: now,
      // Spec §1: pipeline latency (provider timestamp → engine receive).
      latencyMs: mdHealth.medianLatencyMs,
    });

    components.push({
      name: 'MongoDB',
      status: this.store.status,
      detail: this.store.backend === 'in-memory'
        ? 'IN-MEMORY FALLBACK (not durable) — set MONGODB_URI for persistence'
        : this.store.status === 'HEALTHY' ? 'connected' : 'down',
      lastChecked: now,
    });

    components.push({
      name: 'Redis',
      status: this.cache.status,
      detail: this.cache.backend === 'in-memory'
        ? 'IN-MEMORY FALLBACK (single process) — set REDIS_URL for real-time layer'
        : this.cache.status === 'HEALTHY' ? 'connected' : 'down',
      lastChecked: now,
    });

    components.push({ name: 'Backend', status: 'HEALTHY', detail: `running on :${config.port}`, lastChecked: now });

    const aiHealth = await this.ai.health();
    components.push({
      name: 'Python AI',
      status: aiHealth.ok ? 'HEALTHY' : 'DOWN',
      detail: aiHealth.detail,
      lastChecked: now,
      latencyMs: aiHealth.latencyMs,
    });

    const newsHealth = this.news.health();
    components.push({
      name: 'News',
      status: newsHealth.ok ? 'HEALTHY' : 'WARNING',
      detail: newsHealth.detail,
      lastChecked: now,
    });

    const calHealth = this.events.health();
    components.push({
      name: 'Economic Calendar',
      status: calHealth.ok ? 'HEALTHY' : 'WARNING',
      detail: calHealth.detail,
      lastChecked: now,
    });

    components.push({
      name: 'WebSocket',
      status: wsConnected ? 'HEALTHY' : 'WARNING',
      detail: wsConnected ? 'connected' : 'no clients connected',
      lastChecked: now,
    });

    const execHealth = await this.ctx.providers.execution.health();
    components.push({
      name: 'Live Execution',
      status: execHealth.ok ? 'HEALTHY' : 'WARNING',
      detail: execHealth.detail,
      lastChecked: now,
    });

    const cxHealth = await this.ctx.providers.cryptoExchange.health();
    components.push({
      name: 'Crypto Exchange (CCXT)',
      status: cxHealth.ok ? 'HEALTHY' : 'WARNING',
      detail: cxHealth.detail,
      lastChecked: now,
    });

    // On-chain data (spec §17-18): honest UNAVAILABLE when no source is
    // configured. Crypto analysis continues without on-chain features.
    const ocHealth = await this.ctx.providers.onChain.health();
    components.push({
      name: 'On-Chain',
      status: ocHealth.ok ? 'HEALTHY' : 'WARNING',
      detail: ocHealth.detail,
      lastChecked: now,
    });

    const [champion, remoteModels] = await Promise.all([
      this.models.champion().catch(() => null),
      this.ai.listModels().catch(() => [] as unknown[]),
    ]);
    const remoteAny = (remoteModels as Array<{ champion?: string | null; challenger?: string | null; local?: unknown[] }>)[0] ?? {};
    const remoteChampion = remoteAny.champion ?? null;
    components.push({
      name: 'Models',
      status: champion || remoteChampion ? 'HEALTHY' : 'WARNING',
      detail: champion
        ? `champion ${champion.modelVersion} (${champion.algorithm})`
        : remoteChampion
          ? `champion ${remoteChampion} (python registry)`
          : 'no trained champion model',
      lastChecked: now,
    });

    const critical = components.filter((c) => c.name === 'Market Data' || c.name === 'Python AI' || c.name === 'MongoDB');
    const criticalDown = critical.filter((c) => c.status === 'DOWN');
    const overall: SystemStatusReport['overall'] = criticalDown.length
      ? 'DOWN'
      : components.some((c) => c.status === 'WARNING' || c.status === 'DOWN')
        ? 'WARNING'
        : 'HEALTHY';

    const report: SystemStatusReport = {
      generatedAt: now,
      components,
      overall,
      signalGenerationAllowed: criticalDown.length === 0,
    };
    this.lastReport = report;
    return report;
  }

  getLastReport(): SystemStatusReport | null {
    return this.lastReport;
  }
}
