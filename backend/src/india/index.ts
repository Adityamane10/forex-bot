/**
 * IndiaModule — composition root for the INDIAN MARKET subsystem (spec §2).
 * Fully separate from the Forex/Crypto Container: it reuses only market-agnostic
 * infra (store, cache, event bus) and bootstraps the Indian engines without
 * touching existing Forex/Crypto engines. If India init fails, the rest of the
 * app keeps running (india never breaks forex/crypto).
 */
import { EventEmitter } from 'events';
import { INDIA_DEFAULT_UNDERLYINGS } from '@fx/shared';
import { DataStore } from '../db/store';
import { Cache } from '../db/cache';
import { logger } from '../core/logger';
import { indiaConfig } from './config';
import { createIndiaBrokerAdapter } from './brokers/broker-adapter';
import type { IndiaBrokerAdapter } from './brokers/types';
import { IndiaInstrumentService } from './instruments';
import { IndiaMarketDataHealthService } from './data-health';
import { IndiaMarketSessionService } from './session';
import { ContractLifecycleService } from './contract-lifecycle';
import { IndiaCandleEngine } from './candle-engine';
import { IndiaIndicatorEngine } from './indicator-engine';
import { IndiaPredictionClient } from './ml';
import { IndiaAnalysisEngine } from './analysis';
import { IndiaSignalEngine } from './signal-engine';
import { IndiaOptionFlowEngine } from './option-flow';
import { IndiaPaperExecutionEngine } from './paper-execution';
import { IndiaExecutionAuthorityManager } from './execution-authority';
import { IndiaGoalEngine } from './goal-engine';
import { IndiaMarketFeedService } from './market-feed';
import { IndiaCandleWarmer } from './candle-warmer';
import { IndiaHistoricalService } from './historical';
import { IndiaBacktestEngine } from './backtest';
import { OptionAnalyticsEngine } from './option-analytics';
import { MultiTimeframeEngine } from './multi-timeframe';
import { PerformanceAnalyticsEngine } from './performance-analytics';
import { IndiaUserSettingsService } from './user-settings';

export interface IndiaModuleOptions {
  store: DataStore;
  cache: Cache;
  events: EventEmitter;
}

export class IndiaModule {
  readonly instruments: IndiaInstrumentService;
  readonly health: IndiaMarketDataHealthService;
  readonly session: IndiaMarketSessionService;
  readonly lifecycle: ContractLifecycleService;
  readonly candles: IndiaCandleEngine;
  readonly indicators: IndiaIndicatorEngine;
  readonly prediction: IndiaPredictionClient;
  readonly analysis: IndiaAnalysisEngine;
  readonly signals: IndiaSignalEngine;
  readonly optionFlow: IndiaOptionFlowEngine;
  readonly paper: IndiaPaperExecutionEngine;
  readonly authority: IndiaExecutionAuthorityManager;
  readonly goals: IndiaGoalEngine;
  readonly feed: IndiaMarketFeedService;
  readonly warmer: IndiaCandleWarmer;
  readonly historical: IndiaHistoricalService;
  readonly backtest: IndiaBacktestEngine;
  readonly optionAnalytics: OptionAnalyticsEngine;
  readonly multiTimeframe: MultiTimeframeEngine;
  readonly performanceAnalytics: PerformanceAnalyticsEngine;
  readonly userSettings: IndiaUserSettingsService;

  private timers: Array<NodeJS.Timeout> = [];
  private started = false;
  /** Last observed ML serving state — surfaced on /status and the goal panel. */
  mlHealth: { status: 'ONLINE' | 'SHADOW' | 'OFFLINE'; detail: string; checkedAt: number } = {
    status: 'OFFLINE', detail: 'not checked yet', checkedAt: 0,
  };

  /** Active broker adapter (exposes readOnly/feedMode capabilities). */
  readonly adapter: IndiaBrokerAdapter;

  /** Public handle to the underlying store (REST layer reads India collections). */
  readonly store: DataStore;

  constructor(private opts: IndiaModuleOptions) {
    const { store, cache, events } = opts;
    this.store = store;
    this.adapter = createIndiaBrokerAdapter();
    this.userSettings = new IndiaUserSettingsService(store, cache);

    this.instruments = new IndiaInstrumentService(store, cache, this.adapter);
    this.health = new IndiaMarketDataHealthService(store, cache, events);
    this.session = new IndiaMarketSessionService(store, events);
    this.lifecycle = new ContractLifecycleService(this.instruments, store, events);
    this.candles = new IndiaCandleEngine(store, cache, events, this.instruments, this.session);
    this.indicators = new IndiaIndicatorEngine(cache, events);
    this.prediction = new IndiaPredictionClient();
    this.analysis = new IndiaAnalysisEngine({
      instrumentService: this.instruments,
      candleEngine: this.candles,
      indicatorEngine: this.indicators,
      predictionClient: this.prediction,
      primaryTimeframe: indiaConfig.primaryTimeframe as '5m',
    });
    this.optionFlow = new IndiaOptionFlowEngine({
      store, cache, events,
      instruments: this.instruments,
      candles: this.candles,
      primaryTimeframe: indiaConfig.primaryTimeframe as '5m',
    });
    // Built before the signal engine, which reads its tick book synchronously in
    // the depth gate. Its own dependencies — adapter, instruments, health, candles,
    // cache, events — all exist by this point, so the earlier position costs
    // nothing; leaving it below the signal engine would just mean the gate always
    // saw an undefined reader.
    this.feed = new IndiaMarketFeedService(this.adapter, this.instruments, this.health, this.candles, cache, events, this.session);
    // Built before the signal engine because the pre-trade gates read its cache
    // synchronously — a scan runs inside a tick handler and cannot await a REST
    // call. It depends only on the adapter, store, cache, events and option flow,
    // all of which exist by this point.
    this.optionAnalytics = new OptionAnalyticsEngine(this.adapter, store, {
      events,
      cache,
      // OI-only fallback: keeps PCR, max pain and OI levels alive when the
      // broker chain endpoint is unavailable (Zerodha never implements it, and
      // Upstox needs a live session token).
      optionFlow: this.optionFlow,
    });
    this.signals = new IndiaSignalEngine({
      store, cache, events,
      instruments: this.instruments,
      analysis: this.analysis,
      optionFlow: this.optionFlow,
      optionAnalytics: this.optionAnalytics,
      ticks: this.feed,
      primaryTimeframe: indiaConfig.primaryTimeframe as '5m',
      userSettings: this.userSettings,
    });
    this.paper = new IndiaPaperExecutionEngine(store, cache, events, this.instruments, {
      // The feed's synchronous tick book: execute() compares the signal's entry
      // against the live quote and refuses fills that have drifted past the
      // configured limit (PRICE_MOVED) instead of filling a stale analysis.
      ticks: this.feed,
      // User's minimum-profit exit: when set, the paper engine closes a position
      // whose unrealized P&L reaches the user's minimumProfitInr (§23 profit
      // taking) — the value the user sets in the dashboard, not a constant.
      minProfitExit: () => {
        const s = this.userSettings.sync();
        return { enabled: s.minimumProfitInr > 0, targetInr: s.minimumProfitInr };
      },
    });
    this.authority = new IndiaExecutionAuthorityManager({ store, cache, events });
    this.goals = new IndiaGoalEngine(
      store, cache, events,
      this.instruments, this.analysis, this.signals, this.paper, this.authority,
      // The feed's tick book: opportunity scoring reads live bid/ask for the
      // liquidity/spread components without awaiting anything (§7).
      this.feed,
      // §40: goal entries fail closed while ticks are stale — same truth the
      // universal scanner and the health badge read.
      () => this.health.healthy,
    );
    this.historical = new IndiaHistoricalService(store, cache, this.adapter, this.candles, this.instruments);
    // Near-ATM candle warm-up: the goal engine can only trade what it can
    // analyze, and only indices carry boot-seeded candles — every strike sits
    // at NO_DATA until this fetches its intraday bars (spec §5/§11).
    this.warmer = new IndiaCandleWarmer({
      instruments: this.instruments,
      candles: this.candles,
      adapter: this.adapter,
      lastTick: (token) => {
        const t = this.feed.lastTick(token);
        return t ? { ltp: t.ltp } : null;
      },
    });
    this.backtest = new IndiaBacktestEngine(store, cache, events, this.instruments, this.historical);
    this.multiTimeframe = new MultiTimeframeEngine(this.candles, this.indicators);
    this.performanceAnalytics = new PerformanceAnalyticsEngine(store);

    this.wireEvents();
  }

  async init(): Promise<void> {
    await this.session.init();
    await this.authority.init();
    await this.userSettings.init();  // load the user's capital/risk/profit values
    await this.instruments.loadCached();
    await this.paper.init();
    await this.goals.init();   // clean up stale ACTIVE goals from previous sessions
    await this.feed.start();
    // Prime the settings cache so the first scan tick already uses user values
    // (not compiled-in defaults) — get() is otherwise lazy.
    this.userSettings.prime();
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    // Market status transitions + health evaluation (never fabricates).
    this.timers.push(setInterval(() => {
      this.session.checkTransition();
      void this.health.evaluate(this.session.snapshot().marketOpen);
    }, 5_000));

    // Contract lifecycle maintenance (expiry rollover, tradability).
    this.timers.push(setInterval(() => {
      const session = this.session.snapshot();
      this.lifecycle.evaluateAll(session.marketOpen);
    }, 60_000));

    // Signal scanner (market-open only; signals drive universal + goal trading).
    this.timers.push(setInterval(() => {
      const session = this.session.snapshot();
      if (!session.marketOpen || !this.health.healthy) return;
      const authoritySnap = this.authority.snapshot();
      void this.signals.scan(session, authoritySnap).then(async (newSignals) => {
        // Universal AUTO execution: if UNIVERSAL owns authority and mode is AUTO,
        // execute each new signal as a paper position immediately.
        if (
          authoritySnap.owner === 'UNIVERSAL' &&
          authoritySnap.universal.executionMode === 'AUTO' &&
          newSignals.length > 0
        ) {
          for (const signal of newSignals) {
            if (signal.owner !== 'UNIVERSAL') continue;
            try {
              // Portfolio caps (spec §46) come from the USER'S saved settings,
              // not compiled-in constants — the values they set in the dashboard
              // govern the book. The engine refuses with PORTFOLIO_LIMIT /
              // MARGIN_BUDGET_EXHAUSTED / SAME_INSTRUMENT_OPEN instead of filling.
              const s = this.userSettings.sync();
              await this.paper.execute(signal, session, {
                owner: 'UNIVERSAL',
                caps: {
                  maxOpenPositions: s.maxOpenPositions,
                  maxConcurrentMarginInr: s.maxConcurrentMarginInr,
                },
              });
            } catch (err) {
              logger.warn('india: universal signal execution failed', { signalId: signal.signalId, err: String(err) });
            }
          }
        }
      }).catch((err) =>
        logger.warn('india: signal scan failed', { err: String(err) }));
    }, indiaConfig.scannerIntervalMs));

    // Expire stale signals.
    this.timers.push(setInterval(() => {
      void this.signals.expireOldSignals().catch(() => undefined);
    }, 60_000));

    // Goal trading scan (sequential trades; authority gated).
    this.timers.push(setInterval(() => {
      const session = this.session.snapshot();
      void this.goals.scan(session).catch((err) =>
        logger.warn('india: goal scan failed', { err: String(err) }));
    }, indiaConfig.goalScanIntervalMs));

    // Open positions keep their own price source. The poll set is built from
    // "what someone is looking at" — but a position opened from a signal feed
    // is not necessarily on any screen, and a contract nobody has charted
    // receives no ticks: its profit froze at entry, its SL/TP never fired,
    // and the close price was whatever it opened at. Refreshing interest here
    // (the map expires on a 5-minute TTL) pins every open position onto the
    // REST poll for as long as it lives.
    //
    // The previous 60s cadence plus 15s first-pass meant a position opened
    // between polls had no tick source for up to a minute — its `currentPrice`
    // and the frontend's `uPnL` (ticks[tok]?.ltp ?? currentPrice) stayed at the
    // fill price and the user saw a flat line. The tick that would have driven
    // `paper.monitor` never arrived because `pollTokens` only included interest.
    const pinPositions = (): void => {
      for (const p of this.paper.openPositions()) {
        void this.feed.ensureSubscribed(p.instrumentToken).catch(() => undefined);
      }
    };
    pinPositions(); // immediately after start, so a restart's open book is live
    this.timers.push(setInterval(pinPositions, 15_000));

    // Near-ATM candle warm-up (bounded, rotating): first pass shortly after
    // boot, then on its slow cadence. Market-open only — bars are not invented
    // outside session hours (§6).
    const warmTimer = () => {
      const session = this.session.snapshot();
      if (!session.marketOpen) return;
      void this.warmer.warmOnce().catch((err) =>
        logger.warn('india: candle warm-up failed', { err: String(err) }));
    };
    this.timers.push(setTimeout(warmTimer, 45_000) as unknown as NodeJS.Timeout);
    this.timers.push(setInterval(warmTimer, Math.max(60_000, indiaConfig.warmIntervalMs)));

    // REST last-traded-price fallback.
    //
    // On a credential that cannot open the streaming websocket — the read-only analytics
    // token, which is the whole point of the paper-trading stage — this is not a fallback
    // at all, it is the tick source. Everything downstream is built on it: the ticks go
    // through `feed.ingestTick`, so they are validated, sequenced, folded into live
    // candle bars and emitted on `india:tick` exactly as socket ticks are, and the chart
    // advances without the browser asking for anything.
    //
    // Two things about it were wrong. It ran every 30 seconds, which on that setup is the
    // chart's entire refresh rate and reads as frozen. And it polled
    // `primaryIndexInstruments()` — the three indices — so a contract the user searched
    // for and opened had no price source whatsoever; `feed.pollTokens` answers "what is
    // someone looking at" instead.
    //
    // `marketOpen` deliberately does not gate it, only its cadence: a chart opened on a
    // Sunday still has to be able to show Friday's close, and the first poll after the
    // bell has to land without waiting for anything else to notice the market opened.
    let lastLtpPollAt = 0;
    // Consecutive polls that came back empty/failed. The broker answers 200
    // with an EMPTY payload during its own feed gaps and soft-throttle windows
    // — indistinguishable from silence unless counted. Each empty round doubles
    // the interval (capped), so a broker-side stall costs a few probes a minute
    // instead of burning the rate budget blind; one real tick resets instantly.
    let emptyLtpPolls = 0;
    this.timers.push(setInterval(() => {
      if (!this.feed.isStarted) return;
      const now = Date.now();
      const marketOpen = this.session.snapshot().marketOpen;
      const dueIn = marketOpen
        ? Math.min(indiaConfig.ltpPollMs * 2 ** Math.min(emptyLtpPolls, 4), 30_000)
        : indiaConfig.ltpPollClosedMs;
      if (now - lastLtpPollAt < dueIn) return;
      const tokens = this.feed.pollTokens(indiaConfig.ltpPollMax);
      if (tokens.length === 0) return;
      lastLtpPollAt = now;
      // Position maintenance scales its force-close threshold to the poll's
      // live cadence — a throttle window must not liquidate what it starves.
      this.feed.notePollBackoff(dueIn);
      void this.adapter.getLtpBatch(tokens).then(ticks => {
        // Recorded on success only: a failed round leaves coverage unclaimed and
        // every token in it is re-asked next interval.
        this.feed.markPolled(tokens);
        if (ticks.length === 0) {
          emptyLtpPolls += 1;
          if (emptyLtpPolls === 5 || emptyLtpPolls === 40) {
            logger.warn('india: LTP poll returning no quotes', { consecutiveEmpty: emptyLtpPolls, backoffMs: dueIn });
          }
        } else {
          emptyLtpPolls = 0;
        }
        for (const tick of ticks) {
          // Route through the full tick pipeline (validate→candles→event→health).
          this.feed.ingestTick(tick);
        }
      }).catch(() => { emptyLtpPolls += 1; });
    }, Math.max(1000, indiaConfig.ltpPollMs)));

    // Day-OHLC enrichment — the second half of the REST data path.
    //
    // The LTP poll answers "what is the price"; this answers "what kind of day has
    // it been". Day open/high/low and option open interest are fields the LTP
    // endpoint does not carry at all, and nothing else fills them on a credential
    // whose websocket authorizes but never delivers a tick: without this request
    // the index tiles show no range and the option gates see OI only after a chain
    // fetch. One batched call per fire, deliberately slower than the LTP poll so
    // together they stay well inside the broker's rate budget. Not gated on market
    // open (only cadenced) for the same reason the LTP poll is not: the first
    // snapshot after a restart has to arrive even on a Sunday.
    let lastOhlcPollAt = 0;
    this.timers.push(setInterval(() => {
      if (!this.feed.isStarted) return;
      const dueIn = this.session.snapshot().marketOpen ? 0 : indiaConfig.ltpPollClosedMs;
      const now = Date.now();
      if (now - lastOhlcPollAt < dueIn) return;
      lastOhlcPollAt = now;
      void this.feed.enrichOhlc().catch(() => undefined);
    }, Math.max(5000, indiaConfig.ohlcPollMs)));

    // OI flow + chain analytics refresh. Both feed the pre-trade gates through
    // synchronous caches, so their cadence trades gate freshness against the
    // same rolling quota that throttles the LTP poll — the chain endpoint is
    // the heaviest call in the system, and three underlyings × every 45s is
    // what keeps the whole pipeline inside it all session.
    this.timers.push(setInterval(() => {
      const session = this.session.snapshot();
      if (!session.marketOpen) return;
      void this.optionFlow.snapshotAll().catch((err) =>
        logger.warn('india: option-flow refresh failed', { err: String(err) }));
    }, 30_000));

    this.timers.push(setInterval(() => {
      const session = this.session.snapshot();
      if (!session.marketOpen) return;
      void this.optionAnalytics.analyzeAll(INDIA_DEFAULT_UNDERLYINGS).catch((err) =>
        logger.warn('india: option-analytics refresh failed', { err: String(err) }));
    }, 45_000));

    // Position maintenance: expiry + data-staleness exits. The staleness
    // threshold tracks the LTP poll's effective cadence so a broker-side
    // throttle window (empty-round backoff) cannot force-close positions at a
    // loss while the feed itself is merely waiting to ask again.
    this.timers.push(setInterval(() => {
      const session = this.session.snapshot();
      const staleThresholdMs = Math.max(
        indiaConfig.tickStaleMs * 2,
        this.feed.currentPollBackoffMs() * 1.5,
      );
      void this.paper.maintenance(Date.now(), this.health.snapshot.lastTickAt, staleThresholdMs).then((closed) => {
        for (const { position, trade } of closed) void this.goals.onTradeClosed(position, trade);
      }).catch((err) => logger.warn('india: maintenance failed', { err: String(err) }));
    }, 15_000));

    // ML health probe (spec §15): the goal engine fails closed when the model
    // is unavailable, so its serving state is a first-class operational fact —
    // polled here, not per-request.
    this.mlHealth = { status: 'OFFLINE', detail: 'checking…', checkedAt: Date.now() };
    const probe = () => {
      void this.prediction.health().then((h) => {
        this.mlHealth = { status: h.status ?? 'OFFLINE', detail: h.detail, checkedAt: Date.now() };
      }).catch(() => undefined);
    };
    probe();
    this.timers.push(setInterval(probe, 60_000));

    logger.info('india module started', {
      broker: indiaConfig.broker,
      configured: indiaConfig.broker !== 'NONE'
        && (Boolean(indiaConfig.apiKey) || Boolean(indiaConfig.upstoxAnalyticsToken) || Boolean(indiaConfig.accessToken)),
      readOnly: this.adapter.readOnly,
      feedMode: this.adapter.feedMode,
      primaryTimeframe: indiaConfig.primaryTimeframe,
    });
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    void this.feed.stop();
    this.started = false;
  }

  /** Event bus wiring inside the module (independently of the Forex container). */
  private wireEvents(): void {
    const { events } = this.opts;

    // New positions must be polled immediately — the previous 60s timer left the
    // just-opened contract with no tick source for up to a minute and the
    // frontend's `ticks[tok]?.ltp ?? currentPrice` stayed at the fill price.
    events.on('india:position', (pos: { instrumentToken?: string }) => {
      const tok = (pos as { instrumentToken?: string })?.instrumentToken;
      if (tok) void this.feed.ensureSubscribed(tok).catch(() => undefined);
    });

    // Real ticks → paper position SL/TP / trailing / breakeven monitoring.
    events.on('india:tick', (tick: Parameters<IndiaPaperExecutionEngine['monitor']>[0]) => {
      void this.paper.monitor(tick).then((closed) => {
        for (const { position, trade } of closed) {
          void this.goals.onTradeClosed(position, trade);
        }
      }).catch((err) => logger.warn('india: paper monitor failed', { err: String(err) }));
    });

    // Candles → indicator snapshots → (analysis is pulled by scanners).
    events.on('india:candle', () => {
      /* indicators are recomputed on demand by the analysis engine */
    });

    // Market close → goal TODAY_ONLY handling + close open positions.
    events.on('india:market-status', (status: { marketOpen: boolean; status: string }) => {
      if (!status.marketOpen) {
        void this.paper.exitAll('MARKET_CLOSED').then((closed) => {
          for (const { position, trade } of closed) void this.goals.onTradeClosed(position, trade);
        }).catch((err) => logger.warn('india: EOD exit failed', { err: String(err) }));
      }
    });
  }
}