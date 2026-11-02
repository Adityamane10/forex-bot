import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { timingSafeEqual } from 'crypto';
import { z } from 'zod';
import { Container } from '../core/container';
import { AuthService } from '../auth/auth';
import { ALL_SYMBOLS, BROKER_ACCOUNT_CATALOG, BROKER_IDS, BrokerId, CONDITION_FIELDS, CRYPTO_ASSETS, FOREX_ASSETS, UserSettings, BacktestConfig, Tick, Timeframe, TIMEFRAME_MS, assetClassFor, defaultProfile, getAsset, pipsToPrice } from '@fx/shared';
import { dailyReport, dayReport, setReportConverter } from '../engines/reports';
import { config } from '../config';
import { TrainingDataBuilder } from '../ai/trainingData';
import { FEATURE_VERSION } from '../engines/featureEngine';
import { logger } from '../core/logger';
import { metrics, metricsEnabled, PROMETHEUS_CONTENT_TYPE } from '../ops/metrics';

export function createApiRouter(
  container: Container,
  auth: AuthService,
  extra: Array<{ path: string; router: Router }> = [],
  authLimiter?: RequestHandler,
): Router {
  const r = Router();
  const requireAuth = auth.middleware();

  // ---- health / ready ----------------------------------------------------
  r.get('/health', (_req, res) => {
    res.json({ status: 'ok', time: Date.now(), version: '0.1.0' });
  });
  r.get('/ready', async (_req, res) => {
    const report = await container.health.check(true);
    res.status(report.signalGenerationAllowed ? 200 : 503).json(report);
  });

  // ---- auth ---------------------------------------------------------------
  const authRoutes = Router();
  if (authLimiter) authRoutes.use(authLimiter);  authRoutes.post('/register', async (req, res) => {
    try {
      const body = z.object({ email: z.string().email(), password: z.string().min(8) }).parse(req.body);
      const result = await auth.register(body.email, body.password);
      await container.ctx.audit.record('user.registered', 'user', result.user.id);
      res.status(201).json(result);
    } catch (err) {
      // Constant generic message: differentiating "email already registered"
      // enables account enumeration.
      if (err instanceof Error && err.message.includes('registered')) {
        return res.status(400).json({ error: 'registration failed' });
      }
      res.status(400).json({ error: err instanceof Error ? err.message : 'bad request' });
    }
  });
  authRoutes.post('/login', async (req, res) => {
    try {
      const body = z.object({ email: z.string().email(), password: z.string() }).parse(req.body);
      const result = await auth.login(body.email, body.password);
      res.json(result);
    } catch (err) {
      res.status(401).json({ error: err instanceof Error ? err.message : 'unauthorized' });
    }
  });
  authRoutes.get('/me', requireAuth, (req: Request, res: Response) => {
    res.json({ user: (req as { user?: unknown }).user });
  });
  r.use('/auth', authRoutes);

  // ---- AUTHENTICATION GATE -------------------------------------------------
  // Everything below was previously anonymous: anyone who could reach the API
  // could trade, reset the wallet, change risk caps and read the audit log.
  // Public surface = /health, /ready, /auth/* only; internal feed endpoints
  // authenticate with their own shared-token check inside their handlers.
  r.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith('/internal')) return next(); // X-Internal-Token checked per handler
    return requireAuth(req, res, next);
  });

  // ---- assets -------------------------------------------------------------
  r.get('/assets', (_req, res) => {
    const assets = [
      ...Object.values(FOREX_ASSETS).map((a) => ({
        symbol: a.symbol, assetClass: 'FOREX' as const, pipSize: a.pipSize,
        pricePrecision: a.pricePrecision, quantityPrecision: a.quantityPrecision,
        enabled: a.enabled, baseCurrency: a.baseCurrency, quoteCurrency: a.quoteCurrency, venue: 'FOREX',
      })),
      ...Object.values(CRYPTO_ASSETS).map((a) => ({
        symbol: a.symbol, assetClass: 'CRYPTO' as const, pipSize: a.tickSize,
        pricePrecision: a.pricePrecision, quantityPrecision: a.quantityPrecision,
        enabled: a.enabled, baseCurrency: a.baseAsset, quoteCurrency: a.quoteAsset, venue: a.exchange,
      })),
    ];
    res.json({ assets, symbols: ALL_SYMBOLS });
  });
  r.get('/assets/:symbol', (req, res) => {
    try {
      const asset = getAsset(req.params.symbol);
      res.json({ ...asset, assetClass: assetClassFor(req.params.symbol) });
    } catch {
      return res.status(404).json({ error: 'asset not found' });
    }
  });

  // ---- market data ---------------------------------------------------------
  r.get('/market/:symbol', (req, res) => {
    const tick = container.marketData.getLatest(req.params.symbol);
    if (!tick) return res.status(404).json({ error: 'no market data yet' });
    res.json(tick);
  });
  r.get('/market', (_req, res) => {
    res.json(container.marketData.statsSummary());
  });
  r.get('/ticks', (_req, res) => {
    res.json({ ticks: container.marketData.getAllLatest() });
  });

  // ---- candles & indicators ------------------------------------------------
  // Lazy real-history seeding: intraday timeframes build live from ticks and
  // can be sparse right after boot. On the first request for a timeframe with
  // too few bars, fetch real history from the provider and seed the engine
  // (once per pair/timeframe — never hammers the free-tier budget).
  const lazySeedState = new Map<string, number>(); // key -> last attempt ms
  r.get('/candles/:symbol', async (req, res) => {
    const symbol = req.params.symbol;
    const tf = (req.query.timeframe as string) ?? '1h';
    // `Number('abc')` is NaN and Math.min(1000, NaN) stays NaN — the old code
    // sliced the FULL buffer (unbounded payload). Garbage degrades to default.
    const limitRaw = Number(req.query.limit ?? 300);
    const limit = Math.min(1000, Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 300);
    let candles = container.candles.getCandles(symbol, tf as never, limit);
    const key = `${symbol}|${tf}`;
    // Lazy real-history seed with a bounded retry: a transient provider hiccup
    // (throttle/empty payload) must not permanently starve the timeframe.
    // When the MT5 bridge is the live feed (source=MT5) the seed is SKIPPED —
    // the bridge preloads real history itself, and mixing Yahoo bars into an
    // MT5 chart is exactly the data mismatch users hit before.
    const bridgeActive = container.marketData.isBridgeActive();
    if (candles.length < 120 && !bridgeActive) {
      const lastAttempt = lazySeedState.get(key) ?? 0;
      if (Date.now() - lastAttempt > 60_000) {
        lazySeedState.set(key, Date.now());
        try {
          const tfMs = TIMEFRAME_MS[tf as Timeframe];
          const bars = Math.max(200, Math.min(300, Math.floor((24 * 3600_000) / tfMs) + 120));
          const history = await container.ctx.providers.marketData.getHistoricalCandles(symbol, tf as Timeframe, Date.now() - bars * tfMs, Date.now());
          if (history.length > candles.length) {
            await container.candles.seed(symbol, tf as Timeframe, history);
            candles = container.candles.getCandles(symbol, tf as never, limit);
          }
        } catch (err) {
          logger.warn('lazy candle seed failed', { symbol, tf, err: String(err) });
        }
      }
    }
    res.json({ symbol, timeframe: tf, candles });
  });
  r.get('/indicators/:symbol', async (req, res) => {
    const tf = (req.query.timeframe as string) ?? '1h';
    const snap = await container.indicators.getSnapshot(req.params.symbol, tf as never, true);
    res.json(snap ?? { error: 'insufficient data' });
  });

  // ---- multi-timeframe / price action / levels ------------------------------
  r.get('/analysis/:symbol', async (req, res) => {
    const symbol = req.params.symbol;
    const timeframes = ['1m', '5m', '15m', '30m', '1h', '4h', '1D'] as const;
    const candlesByTf: Record<string, unknown> = {};
    const indicatorsByTf: Record<string, unknown> = {};
    for (const tf of timeframes) {
      candlesByTf[tf] = container.candles.getCandles(symbol, tf, 260);
      const snap = await container.indicators.getSnapshot(symbol, tf, true);
      if (snap) indicatorsByTf[tf] = snap;
    }
    const mtf = container.multiTimeframe.analyze(candlesByTf as never, indicatorsByTf as never, symbol, Date.now());
    res.json({ mtf });
  });

  // ---- crypto exchange adapter (spec §9, normalized CCXT interface) ---------
  r.get('/crypto/markets', async (_req, res) => {
    try {
      const markets = await container.ctx.providers.cryptoExchange.getMarkets();
      const spot = markets.filter((m) => m.spot && m.active && m.quoteAsset === 'USDT');
      res.json({ markets: spot.slice(0, 100), total: spot.length });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'crypto exchange unavailable' });
    }
  });
  r.get('/crypto/market/:symbol', async (req, res) => {
    try {
      const symbol = req.params.symbol;
      const [quote, orderBook, market] = await Promise.all([
        container.ctx.providers.cryptoExchange.getQuote(symbol),
        container.ctx.providers.cryptoExchange.getOrderBook(symbol, 10),
        container.ctx.providers.cryptoExchange.getMarket(symbol),
      ]);
      res.json({ symbol, quote, orderBook, market });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'crypto exchange unavailable' });
    }
  });

  // ---- signals --------------------------------------------------------------
  r.get('/signals', (_req, res) => {
    res.json({ signals: container.signals.getActive() });
  });
  // Static routes must be declared BEFORE the :id param route or "history"
  // would be captured as an id (404 for /signals/history).
  r.get('/signals/history', async (_req, res) => {
    const signals = await container.store.find('signals', {}, { timestamp: -1 }, 100);
    res.json({ signals });
  });
  r.get('/signals/:id', async (req, res) => {
    const signal = container.signals.getActive().find((s) => s.id === req.params.id);
    if (!signal) return res.status(404).json({ error: 'signal not found' });
    const snapshot = await container.snapshots.getBySignalId(signal.id);
    res.json({ signal, snapshot });
  });
  // Manual cancel (spec §9 CANCELLED) — a pre-position signal is cancelled by
  // the user and removed; the next analysis pass may create a fresh one.
  r.post('/signals/:id/cancel', async (req, res) => {
    const result = await container.signals.cancelSignal(req.params.id);
    if (!result.ok) return res.status(400).json({ error: result.reason ?? 'cannot cancel' });
    res.json({ ok: true });
  });
  // User-initiated "trade now" on a specific signal (spec §53): backend still
  // runs the full fill-time gate, sizing and USD goal check before opening.
  r.post('/signals/:id/execute', async (req, res) => {
    const result = await container.executeSignal(req.params.id);
    if (!result.ok) {
      const reason = result.reason ?? 'cannot execute signal';
      // 404 = the signal is gone/expired (client should refresh its list);
      // 409 = a risk/sizing gate refused the trade (the reason says which).
      const gone = /no longer active|not found/i.test(reason);
      return res.status(gone ? 404 : 409).json({ error: reason });
    }
    res.json({ ok: true, position: result.position });
  });

  // ---- news / events ----------------------------------------------------------
  r.get('/news', async (req, res) => {
    const currency = req.query.currency as string | undefined;
    const items = currency ? await container.news.getCurrencyNews(currency) : container.news.getLatest();
    res.json({ news: items });
  });
  r.get('/events', async (_req, res) => {
    res.json({ events: container.events.getUpcoming(50) });
  });
  r.get('/sentiment', async (req, res) => {
    const symbol = (req.query.symbol as string) ?? 'EUR/USD';
    const news = container.news.getLatest();
    const items = news.filter((n) => n.currencies.some((c) => symbol.split('/').includes(c)));
    const sentiment = await container.sentiment.aggregateByCurrency(items);
    res.json({ sentiment });
  });

  // ---- risk ------------------------------------------------------------------
  r.get('/risk', async (req, res) => {
    const account = container.paper.getAccount();
    const positions = container.paper.getOpenPositions();
    const report = await container.health.check(true);
    const settings = await container.signals.loadSettings();
    // Advisory skfolio analytics (best-effort; never gates trading).
    const portfolio = await container.portfolioAnalytics.get('1h');
    res.json({
      account,
      openPositions: positions.length,
      system: report,
      settings,
      exposure: container.portfolioRisk.assess(positions as never, account?.equity ?? 0, 0, 0, account?.equity ?? 0),
      portfolio,
    });
  });

  // ---- paper trading ------------------------------------------------------------
  r.get('/paper/account', (_req, res) => {
    const account = container.paper.getAccount();
    if (!account) return res.status(404).json({ error: 'no account' });
    res.json(account);
  });
  r.get('/paper/orders', async (_req, res) => {
    const orders = await container.store.find('paperOrders', {}, { createdAt: -1 }, 100);
    res.json({ orders });
  });
  r.get('/paper/positions', (_req, res) => {
    // §16/§28: canonical forex view (units, pips, quote P&L, conversion rate,
    // margin) refreshed at read time — the frontend never recomputes money.
    res.json({ positions: container.paper.enrichedOpenPositions() });
  });
  r.get('/paper/trades', async (_req, res) => {
    res.json({ trades: await container.paper.recentTrades(100) });
  });

  // ---- TRADING REPORTS (real closed-trade history — no synthetic data) -----
  // Aggregation lives in engines/reports.ts (unit-testable, shared). The
  // converter wires the paper engine's LIVE FX service for margin figures.
  setReportConverter((amount, from, to) => container.paper.convert(amount, from, to)?.rate ?? null);
  r.get('/reports/daily', async (req, res) => {
    res.json(await dailyReport(container.store, container.paper.getAccount(), Math.min(Math.max(Number(req.query.days ?? 400) || 400, 1), 1100)));
  });

  r.get('/reports/day/:date', async (req, res) => {
    const rep = await dayReport(container.store, container.paper.getAccount(), req.params.date);
    if (!rep) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    res.json(rep);
  });

  r.post('/paper/manual', async (req, res) => {
    const parsed = z.object({
      symbol: z.string(),
      direction: z.enum(['BUY', 'SELL']),
      lots: z.number().positive().optional(),
      sl: z.number().positive().optional(),
      tp: z.number().positive().optional(),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid request' });
    const { symbol, direction, lots, sl, tp } = parsed.data;
    const result = await container.paper.openManual(symbol, direction, { lots, sl, tp });
    if (!result.ok) return res.status(400).json({ error: result.reason });
    res.json({ position: result.position });
  });
  r.post('/paper/close/:positionId', async (req, res) => {
    let pos = container.paper.getOpenPositions().find((p) => p.id === req.params.positionId);
    if (!pos) {
      // Restart-orphan repair: the DB shows this position OPEN but the live
      // engine lost it from memory (e.g. closed by MT5 reconciliation while the
      // paper map wasn't reloaded). A 404 here would wedge the row open in the
      // dashboard forever — refresh from the store once, then decide.
      await container.paper.reloadOpenPositions().catch(() => undefined);
      pos = container.paper.getOpenPositions().find((p) => p.id === req.params.positionId);
    }
    if (!pos) return res.status(404).json({ error: 'position not found' });
    // §10: manual close executes on the correct side of the spread — a BUY
    // exits at the BID, a SELL at the ASK. Never the mid.
    const tick = container.marketData.getLatest(pos.symbol);
    const exit = pos.direction === 'BUY'
      ? (tick?.bid ?? pos.currentPrice)
      : (tick?.ask ?? pos.currentPrice);
    const trade = await container.paper.closePosition(pos, exit, 'MANUAL');
    res.json({ trade });
  });

  // Partial close: realize P&L on part of the position, keep the rest managed.
  r.post('/paper/close-partial/:positionId', async (req, res) => {
    const parsed = z.object({ lots: z.number().positive() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'body must be {lots: number}' });
    const pos = container.paper.getOpenPositions().find((p) => p.id === req.params.positionId);
    if (!pos) return res.status(404).json({ error: 'position not found' });
    if (parsed.data.lots >= pos.lots) return res.status(400).json({ error: `partial lots (${parsed.data.lots}) must be below the position size (${pos.lots}) — use the full close endpoint` });
    const tick = container.marketData.getLatest(pos.symbol);
    const exit = pos.direction === 'BUY' ? (tick?.bid ?? pos.currentPrice) : (tick?.ask ?? pos.currentPrice);
    const trade = await container.paper.closePosition(pos, exit, 'MANUAL', parsed.data.lots);
    if (!trade) return res.status(400).json({ error: 'partial close rejected (below minimum lot, or already closing)' });
    res.json({ trade, remainingLots: pos.lots });
  });

  // Modify SL/TP on an open position (also mirrors to the paper engine's exit
  // checks on the next tick). MT5 mirror: the change rides the next poll via
  // the position book sync.
  r.post('/paper/modify/:positionId', async (req, res) => {
    const parsed = z.object({
      sl: z.number().positive().nullable().optional(),
      tp: z.number().positive().nullable().optional(),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'body must be {sl?: number|null, tp?: number|null}' });
    const result = container.paper.modifyProtection(req.params.positionId, { sl: parsed.data.sl, tp: parsed.data.tp });
    if (!result.ok) return res.status(400).json({ error: result.reason });
    res.json({ position: result.position });
  });

  // Break-even: move SL to entry ( protects the position at zero risk).
  r.post('/paper/breakeven/:positionId', async (req, res) => {
    const pos = container.paper.getOpenPositions().find((p) => p.id === req.params.positionId);
    if (!pos) return res.status(404).json({ error: 'position not found' });
    const result = container.paper.modifyProtection(req.params.positionId, { sl: pos.entryPrice });
    if (!result.ok) return res.status(400).json({ error: result.reason });
    res.json({ position: result.position });
  });
  // User-initiated re-arm of the risk breakers (consecutive losses + P&L
  // windows). Balance and history are untouched. The breakers stay hard
  // limits against automatic behavior; this is the explicit acknowledgment
  // that clears a manual-trading deadlock.
  r.post('/paper/reset-risk', async (_req, res) => {
    const account = await container.paper.resetRiskCounters();
    if (!account) return res.status(404).json({ error: 'no account' });
    logger.info('paper risk counters reset by user');
    res.json({ account });
  });

  // ---- MT5 demo mirror (dashboard control) ----------------------------------
  // ALWAYS-ON execution: every paper trade is placed on the MT5 demo account's
  // real demo balance and appears in BOTH places (dashboard + MT5 terminal).
  // The old toggle is kept for compat but always reports enabled=true.
  r.get('/mt5/status', async (_req, res) => {
    const s = await container.mt5Mirror.status();
    // Enrich with paper<->MT5 conversion for the dashboard banner.
    const acct = container.paper.getAccount();
    // FOREX IS USD-ONLY: the wallet adopts the bound account's currency (USD
    // for XM), so no INR equivalent is exposed on the forex status surface.
    const paper = acct ? { balance: acct.balance, currency: acct.currency, equity: acct.equity } : null;
    res.json({ ...s, paper });
  });

  r.get('/mt5/mirrors', async (_req, res) => {
    const rows = await container.ctx.store.find('Mt5MirrorCommands', {}, { createdAt: -1 }, 100);
    res.json((rows as Array<Record<string, unknown>>).map((r2) => {
      const { _id, ...rest } = r2;
      void _id;
      return rest;
    }));
  });

  r.post('/mt5/enable', async (req, res) => {
    const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'body must be {enabled: boolean}' });
    await container.mt5Mirror.setEnabled(parsed.data.enabled);
    res.json(await container.mt5Mirror.status());
  });

  // ---- KILL SWITCH: flatten everything --------------------------------------
  // Closes ALL open dashboard positions immediately (paper + MT5 mirror CLOSE
  // commands). The MT5 worker's FLATTEN action additionally sweeps any position
  // the platform owns in the terminal. This is the one button you want to be
  // able to find fast.
  r.post('/mt5/flatten-all', async (req, res) => {
    const parsed = z.object({
      includeForeign: z.boolean().optional().default(false),
      reason: z.string().max(300).optional(),
    }).safeParse(req.body ?? {});
    const includeForeign = parsed.success ? parsed.data.includeForeign : false;
    const open = container.paper.getOpenPositions();
    const closed: string[] = [];
    const failed: Array<{ positionId: string; error: string }> = [];
    for (const pos of open) {
      try {
        const tick = container.marketData.getLatest(pos.symbol);
        const exit = pos.direction === 'BUY' ? (tick?.bid ?? pos.currentPrice) : (tick?.ask ?? pos.currentPrice);
        const trade = await container.paper.closePosition(pos, exit, 'MANUAL');
        if (trade) closed.push(pos.id); else failed.push({ positionId: pos.id, error: 'close returned null' });
      } catch (err) {
        failed.push({ positionId: pos.id, error: String(err) });
      }
    }
    // Sweep the terminal itself (kill-switch semantics: the operator wants a
    // clean slate, not just a clean dashboard).
    let mt5Sweep: { ok: boolean; closed: number; failed: number; errors?: Array<{ ticket: number; error: string }> } | null = null;
    try {
      mt5Sweep = await container.mt5Mirror.queueFlatten(includeForeign);
    } catch (err) {
      logger.warn('flatten-all: mt5 sweep failed', { err: String(err) });
    }
    await container.ctx.audit.record('trading.flatten_all', 'positions', `${closed.length}`, undefined, {
      failed: failed.length, includeForeign, reason: parsed.success ? parsed.data.reason : undefined,
    });
    await container.alerts.emit('RISK_BLOCKED', `FLATTEN ALL executed: ${closed.length} dashboard position(s) closed${failed.length ? `, ${failed.length} failed` : ''}${parsed.success && parsed.data.reason ? ` — ${parsed.data.reason}` : ''}`, undefined, 'CRITICAL').catch(() => undefined);
    logger.warn('flatten-all executed', { closed: closed.length, failed: failed.length, includeForeign });
    res.json({ ok: failed.length === 0, closed: closed.length, failed, mt5Sweep });
  });

  // Last reconciliation report (broker positions vs dashboard).
  r.get('/mt5/reconciliation', (_req, res) => {
    const last = container.reconciliation.getLast();
    if (!last) return res.status(404).json({ error: 'no reconciliation report yet — waiting for the first worker heartbeat with positions' });
    res.json(last);
  });

  // ---- Prometheus metrics (scrape target) ----------------------------------
  r.get('/metrics', (_req, res) => {
    if (!metricsEnabled()) return res.status(404).json({ error: 'metrics disabled' });
    res.set('Content-Type', PROMETHEUS_CONTENT_TYPE);
    res.send(metrics().render());
  });
  r.get('/metrics/json', (_req, res) => {
    if (!metricsEnabled()) return res.status(404).json({ error: 'metrics disabled' });
    res.json(metrics().snapshot());
  });

  // Goal progress: today's net P&L vs the user's USD target, and whether
  // auto entries are currently paused because the goal is reached.
  r.get('/paper/goal-progress', async (_req, res) => {
    res.json(await container.getGoalProgress());
  });

  // Add paper funds to the wallet (dashboard "Add Balance"). Credits balance
  // + equity + drawdown baseline; positions and history untouched.
  r.post('/paper/add-funds', async (req, res) => {
    const parsed = z.object({ amount: z.number().positive().max(10_000_000) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'amount must be a positive number (max 10,000,000)' });
    const account = await container.paper.addFunds(parsed.data.amount);
    if (!account) return res.status(404).json({ error: 'no paper account' });
    logger.info('paper funds added', { amount: parsed.data.amount, currency: account.currency });
    res.json({ account });
  });

  // Canonical live conversion for display (§20/§26): "1 EUR = ₹x" under a
  // market quote, with the rate's provenance. Null when never available.
  r.get('/paper/convert', (req, res) => {
    const amount = Number(req.query.amount ?? '1');
    const from = String(req.query.from ?? '').toUpperCase();
    const to = String(req.query.to ?? container.paper.getAccount()?.currency ?? 'USD').toUpperCase();
    if (!from || !Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'amount and from are required' });
    }
    const r = container.paper.convert(amount, from, to);
    if (!r) return res.status(503).json({ error: `no ${from}->${to} conversion rate has ever been available` });
    res.json({ ...r, to });
  });

  // Dynamic-lot preview (§13/§14): the full sizing breakdown for a candidate
  // trade against the LIVE wallet — limits per constraint, final lot, margin,
  // risk at SL. Read-only; nothing is opened.
  r.get('/paper/lot-preview', async (req, res) => {
    const symbol = String(req.query.symbol ?? 'EUR/USD').toUpperCase();
    const direction = req.query.direction === 'SELL' ? 'SELL' : 'BUY';
    if (!ALL_SYMBOLS.includes(symbol as never)) return res.status(400).json({ error: `unknown symbol ${symbol}` });
    const tick = container.marketData.getLatest(symbol);
    if (!tick) return res.status(503).json({ error: `no live quote for ${symbol}` });
    const entry = direction === 'BUY' ? (tick.ask ?? tick.mid) : (tick.bid ?? tick.mid);
    // Default planning SL when the caller supplies none: 50 pips FX, 2% crypto.
    const asset = getAsset(symbol);
    let sl = Number(req.query.sl);
    if (!Number.isFinite(sl) || sl <= 0) {
      sl = assetClassFor(symbol) === 'CRYPTO'
        ? (direction === 'BUY' ? entry * 0.98 : entry * 1.02)
        : (direction === 'BUY' ? entry - pipsToPrice(symbol, 50) : entry + pipsToPrice(symbol, 50));
    }
    // dynamicLotBreakdown can throw StaleRateError before the first USD→INR
    // tick lands after a restart — that crashed the whole process (unhandled
    // in an express handler). Degrade to "no preview" instead.
    let breakdown: ReturnType<typeof container.paper.dynamicLotBreakdown>;
    try {
      breakdown = container.paper.dynamicLotBreakdown(symbol, entry, sl);
    } catch (err) {
      logger.warn('lot-preview: sizing unavailable', { symbol, err: String(err) });
      return res.status(503).json({ error: `dynamic sizing unavailable right now (${err instanceof Error ? err.name : 'rate unavailable'})` });
    }
    if (!breakdown) return res.status(400).json({ error: 'dynamic sizing applies to forex symbols only' });

    // Expected P&L at TP2×SL distance for context (§14).
    const tpMove = Math.abs(entry - sl) * 2;
    let expected: { amount: number } | null = null;
    if (breakdown.valid && tpMove > 0) {
      try {
        expected = container.paper.convert(tpMove * breakdown.finalLots * asset.contractSize, getAsset(symbol).quoteCurrency, container.paper.getAccount()?.currency ?? 'USD');
      } catch (err) {
        logger.warn('lot-preview: conversion unavailable', { symbol, err: String(err) });
      }
    }

    res.json({
      symbol,
      direction,
      entry,
      slPlanned: sl,
      ...breakdown,
      expectedProfitAtTp2x: expected?.amount ?? null,
      leverageFromSpec: asset.marginRequirement > 0 ? Math.round(1 / asset.marginRequirement) : null,
    });
  });

  // ---- backtests ----------------------------------------------------------------
  const backtestSchema = z.object({
    symbols: z.array(z.string()).min(1),
    timeframes: z.array(z.enum(['1m', '5m', '15m', '30m', '1h', '4h', '1D'])).min(1),
    start: z.number(),
    end: z.number(),
    startingCapital: z.number().default(10000),
    riskPercent: z.number().default(1),
    minRr: z.number().default(1.5),
    minConfidence: z.number().default(0.55),
    maxOpenPositions: z.number().default(3),
    commissionPerLot: z.number().default(7),
    slippagePips: z.number().default(0.2),
    spreadMultiplier: z.number().default(1),
    useMl: z.boolean().default(false),
    includeNews: z.boolean().default(false),
    includeEvents: z.boolean().default(false),
  });
  r.post('/backtests', async (req, res) => {
    try {
      const parsed = backtestSchema.parse(req.body) as unknown as BacktestConfig;
      // The returned id must match the stored result, so GET /backtests/:id works.
      const backtestId = crypto.randomUUID();
      res.status(202).json({ backtestId, status: 'QUEUED' });
      void container.backtest.run(parsed, backtestId).then((result) => {
        logger.info('backtest completed', { backtestId: result.backtestId, trades: result.trades?.length, status: result.status });
      });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'bad request' });
    }
  });
  r.get('/backtests', async (_req, res) => {
    res.json({ backtests: await container.backtest.list(20) });
  });
  r.get('/backtests/:id', async (req, res) => {
    const bt = await container.store.findOne('backtests', { backtestId: req.params.id });
    if (!bt) return res.status(404).json({ error: 'backtest not found' });
    res.json(bt);
  });

  // ---- models / MLOps -------------------------------------------------------------
  r.get('/models', async (_req, res) => {
    const [local, remote] = await Promise.all([container.models.list(), container.ai.listModels()]);
    res.json({ local, remote });
  });
  r.post('/models/train', async (req, res) => {
    try {
      const body = z.object({
        symbols: z.array(z.string()).min(1),
        timeframe: z.string().default('1h'),
        start: z.number(),
        end: z.number(),
        folds: z.number().default(3),
      }).parse(req.body);
      // Build the training payload with the SAME feature pipeline that runs
      // live (train/serve parity), then hand rows + candles to the AI engine.
      // Candle history comes from the ingested MT5 export + live closes.
      const tf = body.timeframe as Timeframe;
      const payload = await new TrainingDataBuilder({ candles: container.candles, store: container.ctx.store }).build(body.symbols, tf);
      if (Object.keys(payload.candles).length === 0) {
        res.status(400).json({ error: 'no symbol has enough candle history for training — ingest MT5 history via /internal/candles/history (need >= 250 bars per symbol)' });
        return;
      }
      const result = await container.ai.train({
        symbols: Object.keys(payload.candles),
        timeframe: body.timeframe,
        start: body.start,
        end: body.end,
        folds: body.folds,
        featureVersion: FEATURE_VERSION,
        data: payload.candles as unknown as Record<string, unknown[]>,
        featureRows: payload.featureRows,
      });
      // sync the freshly trained models into the local registry so promotion works
      const remote = await container.ai.listModels();
      const synced = await container.models.syncFromAi(remote.local);
      res.json({ ...result, syncedModels: synced });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'bad request' });
    }
  });
  r.get('/models/calibration', async (_req, res) => {
    res.json(await container.models.computeCalibrationMetrics());
  });
  r.post('/models/promote', async (_req, res) => {
    try {
      const remote = await container.ai.listModels();
      const synced = await container.models.syncFromAi(remote.local);
      const local = await container.models.evaluateChallenger();
      const ai = await container.ai.promote();
      res.json({ local, remote: { ...ai, synced } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'promotion failed' });
    }
  });
  r.get('/datasets', async (_req, res) => {
    res.json({ datasets: await container.ai.listDatasets() });
  });
  r.get('/drift', async (_req, res) => {
    const remote = await container.ai.driftStatus().catch(() => ({}));
    res.json({ remote, local: container.drift.getLastReport() });
  });

  // ---- system -----------------------------------------------------------------------
  r.get('/system/status', async (req, res) => {
    // wsClients is periodically written by the server bootstrap (real count).
    const wsConnected = ((req.app.get('wsClients') as number | undefined) ?? 0) > 0;
    const report = await container.health.check(wsConnected);
    const offsetRaw = await container.ctx.cache.get('mt5:server-offset-ms').catch(() => null);
    const mt5ServerOffsetMs = offsetRaw ? Number(offsetRaw) : 0;
    res.json({ ...report, emergencyStop: container.emergencyStop.status(), mt5ServerOffsetMs });
  });
  // Global emergency stop (spec §90): trigger/release with an audit record.
  r.post('/system/emergency-stop', requireAuth, async (req: Request, res: Response) => {
    try {
      const body = z.object({
        action: z.enum(['trigger', 'release']),
        reason: z.string().min(3).max(500),
      }).parse(req.body);
      const user = (req as { user?: { id?: string } }).user;
      if (body.action === 'trigger') await container.emergencyStop.trigger(body.reason, user?.id);
      else await container.emergencyStop.release(body.reason, user?.id);
      res.json(container.emergencyStop.status());
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'bad request' });
    }
  });
  r.get('/system/market', (_req, res) => {
    res.json(container.marketData.statsSummary());
  });
  r.get('/system/alerts', async (_req, res) => {
    res.json({ alerts: await container.alerts.recent(50) });
  });
  r.get('/system/audit', async (req, res) => {
    const limitRaw = Number(req.query.limit ?? 100);
    // NaN passed the old `if (limit && limit > 0)` guard in both stores and
    // dumped the ENTIRE audit log. Clamp here AND in the store layer.
    const limit = Math.min(500, Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 100);
    res.json({ audit: await container.ctx.audit.list({ limit }) });
  });

  // ---- user settings -------------------------------------------------------------------
  r.get('/settings', async (req, res) => {
    const settings = await container.signals.loadSettings();
    res.json(settings);
  });
  r.put('/settings', async (req, res) => {
    const parsed = z
      .object({
        minimumProfit: z.number().min(0),
        availableCapital: z.number().min(100),
        accountCurrency: z.string().regex(/^[A-Z]{3}$/, 'account currency must be a 3-letter ISO code'),
        maxRiskPercent: z.number().min(0.01).max(100),
        minRr: z.number().min(0.5),
        minConfidence: z.number().min(0.5).max(0.95),
        maxDailyLossPercent: z.number().min(0.1).max(100),
        maxWeeklyLossPercent: z.number().min(0.1).max(100),
        maxDrawdownPercent: z.number().min(0.1).max(100),
        maxConsecutiveLosses: z.number().int().min(1).max(100),
        maxOpenPositions: z.number().int().min(1).max(50),
        maxCorrelatedPositions: z.number().int().min(1).max(50),
        maxCurrencyExposurePercent: z.number().min(0),
        maxLeverage: z.number().min(1).max(1000),
        singlePositionMode: z.boolean(),
        autoTradeEnabled: z.boolean(),
        maxMarginUsedPct: z.number().min(0).max(100),
        /** Investment filters (Signals → Goal Trading): reject any sized
         *  position whose notional falls outside the range — 0 disables a side.
         *  These were missing from the schema for months: the Settings page PUT
         *  them and zod silently dropped them, so they never persisted. */
        minimumInvestment: z.number().min(0),
        maximumPositionSize: z.number().min(0),
    signalMode: z.enum(['goal', 'strict']),
    selectedPairs: z.array(z.string()),
    /** Goal-session trade cap (§ goal): pause auto entries after N closed trades. */
    goalMaxTrades: z.number().int().min(1).max(500).nullable(),
        selectedTimeframes: z.array(z.string()),
        preferredSessions: z.array(z.string()),
        newsTrading: z.boolean(),
        highImpactNewsRestriction: z.boolean(),
        weekendFlattenEnabled: z.boolean().optional(),
        trailingStopEnabled: z.boolean(),
        trailingStopMode: z.enum(['price', 'chandelier']).optional(),
        lotMode: z.enum(['auto', 'manual']).optional(),
        manualLot: z.number().min(0).max(1000).optional(),
        trailingStopAtrMultiplier: z.number().min(0.5).max(10),
        trailingStopActivateR: z.number().min(0.2).max(5),
        paperStartingCapital: z.number(),
        /** Symbol lock (XM/MT5 pattern): null/'' clears the lock. Validated
         *  against ALL_SYMBOLS so a typo can never silently silence signals. */
        symbolLock: z.string().nullable().refine((v) => {
          if (!v) return true;
          return ALL_SYMBOLS.includes(v.toUpperCase());
        }, { message: 'unknown symbol for symbolLock' }),
      })
      .partial()
      .safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid settings' });
    const merged = { ...(await container.signals.loadSettings()), ...parsed.data } as unknown as UserSettings;
    // FOREX IS USD-ONLY (XM-style): the account-currency switch existed for the
    // old INR paper wallet era. With a bound broker account the wallet follows
    // the ACCOUNT's currency anyway, and forex money math must never silently
    // flip to another unit — force USD server-side regardless of what a client
    // sends. (India-market INR settings are a separate subsystem and untouched.)
    merged.accountCurrency = 'USD';
    // A NEW goal session (target or trade-cap changed) restarts the closed-
    // trades counter: stamp the baseline so § goal counts only this attempt.
    if (parsed.data.minimumProfit !== undefined || parsed.data.goalMaxTrades !== undefined) {
      merged.goalBaselineAt = Date.now();
    }
    await container.store.updateOne('userSettings', {}, { $set: { ...merged } as never, $unset: { success: 1, data: 1 } }, true);
    container.portfolioRisk.updateSettings(merged);
    if (parsed.data.accountCurrency !== undefined) container.noteAccountCurrency(merged.accountCurrency);
    // Symbol lock is realtime: engine cache invalidated + MT5 dispatch gate
    // adopts it before the next worker poll; scanner re-sweeps immediately.
    // Pre-entry signals OUTSIDE the new lock are dropped at once — they were
    // created before the lock existed and no longer represent the locked
    // universe; leaving them live would show tradeable rows the fill gate
    // would refuse anyway.
    if (parsed.data.symbolLock !== undefined) {
      container.noteSymbolLock(parsed.data.symbolLock);
      const lock = (parsed.data.symbolLock ?? '').toUpperCase() || null;
      if (lock) {
        for (const s of container.signals.getActive()) {
          if (s.symbol.toUpperCase() !== lock && !s.positionId) {
            await container.signals.cancelSignal(s.id, `symbol lock changed to ${lock}`).catch(() => undefined);
          }
        }
      }
    }
    if (parsed.data.minimumProfit !== undefined || parsed.data.goalMaxTrades !== undefined || parsed.data.signalMode !== undefined) {
      container.signals.invalidateAccountRiskCache();
    }
    // Switching currency or wallet size resets the paper wallet to the new
    // currency/capital (positions close as MANUAL; history is kept).
    if (parsed.data.accountCurrency !== undefined || parsed.data.paperStartingCapital !== undefined) {
      await container.paper.reinitAccount();
    }
    // Goal/risk changes re-evaluate every asset immediately — the user sees
    // the signals matching their new goal without waiting for the next sweep.
    void container.scanner.scanOnce().catch(() => undefined);
    res.json(merged);
  });

  // ---- scanner ---------------------------------------------------------------------------
  r.get('/scanner', (_req, res) => {
    res.json({ rankings: container.scanner.getRankings() });
  });
  r.post('/scanner/refresh', async (_req, res) => {
    const rankings = await container.scanner.scanOnce();
    res.json({ rankings });
  });

  // ---- goal mode: live per-symbol goal feasibility (which asset can cover
  // the set profit goal right now, and the exact plan to do it) --------------
  r.get('/goal-signals', (_req, res) => {
    // analyses carry the per-row AI gate (PASS/BLOCKED + model probability +
    // exact refusal reason) so the UI can show WHY a row cannot execute.
    res.json({ analyses: container.signals.getGoalAnalyses() });
  });

  // ---- internal feed ingestion (MT5 bridge and similar local workers) ----------------------
  // Guarded by a shared secret (INTERNAL_API_TOKEN); the endpoint is disabled entirely
  // when the secret is not configured. This is how the zero-polling MT5 tick stream
  // enters the engine.
  const requireInternal = (req: Request, res: Response, next: () => void) => {
    if (!config.internalApiToken) {
      res.status(503).json({ error: 'internal API disabled (set INTERNAL_API_TOKEN)' });
      return;
    }
    const a = Buffer.from(String(req.headers['x-internal-token'] ?? ''));
    const b = Buffer.from(config.internalApiToken);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    // The MT5 bridge reports its server→UTC offset so the UI can display
    // chart times exactly as the MT5 terminal shows them (broker server time).
    const offset = Number(req.headers['x-mt5-server-offset-ms']);
    if (Number.isFinite(offset)) {
      void container.ctx.cache.set('mt5:server-offset-ms', String(offset), 3600_000).catch(() => undefined);
    }
    next();
  };

  const tickSchema = z.object({
    timestamp: z.number().positive(),
    symbol: z.string(),
    bid: z.number().positive(),
    ask: z.number().positive(),
    mid: z.number().positive(),
    spread: z.number().nonnegative().default(0),
    source: z.string().default('BRIDGE'),
    spreadModeled: z.boolean().optional(),
  });
  r.post('/internal/ticks', requireInternal, async (req, res) => {
    try {
      const body = z.object({ ticks: z.array(tickSchema).min(1).max(500) }).parse(req.body);
      let accepted = 0;
      let rejected = 0;
      for (const t of body.ticks) {
        // A pushing source is an external stream: it may hold REST polling off
        // for its symbols while it stays fresh.
        container.marketData.noteExternalSource(t.source);
        const tick = { ...t, mode: 'LIVE' as const };
        await container.marketData.handleTick(tick as Tick);
        accepted++;
      }
      res.json({ accepted, rejected });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'bad request' });
    }
  });

  const candleSchema = z.object({
    symbol: z.string(),
    timeframe: z.enum(['1m', '5m', '15m', '30m', '1h', '4h', '1D']),
    candles: z.array(z.object({
      open: z.number(), high: z.number(), low: z.number(), close: z.number(),
      openTime: z.number(), closeTime: z.number(),
    })).min(1).max(5000),
  });
  r.post('/internal/candles', requireInternal, async (req, res) => {
    try {
      const body = candleSchema.parse(req.body);
      const candles = body.candles.map((c) => ({
        ...c,
        symbol: body.symbol,
        timeframe: body.timeframe as Timeframe,
        volume: 0,
        state: 'COMPLETED' as const,
        completed: true,
        updatedAt: c.closeTime,
      }));
      await container.candles.seed(body.symbol, body.timeframe as Timeframe, candles);
      res.json({ ok: true, seeded: candles.length });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'bad request' });
    }
  });

  // ---- Deep history ingest (MT5 training-data export) -----------------------
  // The bridge (or a script) pushes years of completed bars here; they are
  // bulk-upserted into Mongo so the AI training-data builder has enough real
  // history to train a non-degenerate model. Batches of up to 20k bars.
  r.post('/internal/candles/history', requireInternal, async (req, res) => {
    try {
      const body = candleSchema.extend({ candles: z.array(z.object({
        open: z.number(), high: z.number(), low: z.number(), close: z.number(),
        openTime: z.number(), closeTime: z.number(),
      })).min(1).max(20000) }).parse(req.body);
      const candles = body.candles.map((c) => ({
        ...c,
        symbol: body.symbol,
        timeframe: body.timeframe as Timeframe,
        volume: 0,
        state: 'COMPLETED' as const,
        completed: true,
        updatedAt: c.closeTime,
      }));
      const written = await container.candles.ingestHistory(body.symbol, body.timeframe as Timeframe, candles);
      res.json({ ok: true, written });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'bad request' });
    }
  });

  // ---- MT5 demo-account mirror (trader.py worker) ---------------------------
  // Long-polled command queue + result sink for the local MetaTrader 5 demo
  // executor. Same INTERNAL_API_TOKEN trust as the tick bridge.
  r.post('/internal/mt5/commands', requireInternal, async (req, res) => {
    try {
      const body = z.object({ workerId: z.string().min(1).max(64) }).parse(req.body);
      const commands = await container.mt5Mirror.pollCommands(body.workerId);
      // Heartbeat piggybacks on every poll.
      container.mt5Mirror.noteHeartbeat(body.workerId);
      res.json({ commands });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'bad request' });
    }
  });

  r.post('/internal/mt5/results', requireInternal, async (req, res) => {
    try {
      const body = z.object({
        results: z.array(z.object({
          id: z.string(),
          ok: z.boolean(),
          // min(0), not positive(): some brokers fill the order and still report
          // order id 0 on the deal response. Rejecting the whole result made the
          // mirror re-serve the command forever (duplicate fills observed live).
          ticket: z.number().int().min(0).optional(),
          price: z.number().optional(),
          error: z.string().max(300).optional(),
          already_closed: z.boolean().optional(),
        })).min(1).max(50),
      }).parse(req.body);
      for (const r2 of body.results) await container.mt5Mirror.applyResult(r2);
      res.json({ ok: true, applied: body.results.length });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'bad request' });
    }
  });

  // The heartbeat is also the broker-account feed: currency, leverage, margin
  // levels and the broker's OWN per-symbol contract specs (`symbol_info`).
  // Those specs are what make lot sizing follow the selected account type.
  const mt5SymbolSpecSchema = z.object({
    symbol: z.string().min(1),
    platformSymbol: z.string().min(1),
    contractSize: z.number().positive(),
    volumeMin: z.number().positive(),
    volumeMax: z.number().positive(),
    volumeStep: z.number().positive(),
    digits: z.number().int(),
    point: z.number().positive(),
    stopsLevelPoints: z.number().nonnegative().default(0),
    spreadPoints: z.number().nonnegative().default(0),
    swapLong: z.number().default(0),
    swapShort: z.number().default(0),
    // -1/absent = the terminal did not report a swap mode; only 0 (points) is
    // interpreted by the cost model.
    swapMode: z.number().int().nullable().optional(),
    fillingMode: z.number().int().nullable().optional(),
    path: z.string().optional(),
    description: z.string().optional(),
  });
  r.post('/internal/mt5/heartbeat', requireInternal, async (req, res) => {
    try {
      const body = z.object({
        workerId: z.string().min(1),
        account: z.object({
          login: z.number(), server: z.string(),
          balance: z.number(), currency: z.string(),
          equity: z.number().optional(), profit: z.number().optional(), margin: z.number().optional(),
          freeMargin: z.number().optional(), company: z.string().optional(),
          leverage: z.number().positive().optional(),
          // Absent = UNKNOWN, which the gate treats as "not proven safe".
          tradeMode: z.enum(['DEMO', 'CONTEST', 'REAL', 'UNKNOWN']).optional(),
          marginCallLevelPct: z.number().nonnegative().optional(),
          stopOutLevelPct: z.number().nonnegative().optional(),
          symbolSpecs: z.array(mt5SymbolSpecSchema).max(200).optional(),
          // Live broker positions for reconciliation (server-side SL/TP closures).
          positions: z.array(z.object({
            ticket: z.number().int().positive(),
            symbol: z.string().min(1),
            brokerSymbol: z.string().min(1),
            direction: z.enum(['BUY', 'SELL']),
            lots: z.number().positive(),
            openPrice: z.number(),
            currentPrice: z.number().optional(),
            profit: z.number().optional(),
            swap: z.number().optional(),
            sl: z.number().optional(),
            tp: z.number().optional(),
            magic: z.number().int().optional(),
          })).max(500).optional(),
        }).optional(),
      }).parse(req.body);
      container.mt5Mirror.noteHeartbeat(
        body.workerId,
        body.account ? { tradeMode: 'UNKNOWN', ...body.account } : null,
      );
      // Reconcile on every heartbeat that carries positions: this is the
      // broker→dashboard truth loop (server-side SL/TP closures heal here).
      if (body.account?.positions) {
        void container.reconciliation.reconcile(body.account.positions).catch((err) =>
          logger.warn('mt5 reconciliation failed', { err: String(err) }));
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'bad request' });
    }
  });

  // ---- broker account binding -----------------------------------------------
  // Which broker account the platform trades, the conditions the engines
  // actually use, and whether orders may be dispatched to the bound terminal.
  r.get('/broker/catalog', (_req, res) => {
    res.json({
      brokers: BROKER_IDS,
      defaults: { profileId: defaultProfile().id, broker: defaultProfile().broker, accountType: defaultProfile().accountType },
      profiles: BROKER_ACCOUNT_CATALOG.map((p) => ({
        id: p.id, broker: p.broker, accountType: p.accountType, label: p.label,
        marketUrl: p.marketUrl, note: p.note,
      })),
      conditionFields: CONDITION_FIELDS.map((f) => ({ key: f.key, label: f.label, unit: f.unit, kind: f.kind })),
    });
  });

  r.get('/broker/profile', async (_req, res) => {
    res.json(await container.broker.status());
  });

  r.put('/broker/profile', async (req, res) => {
    const parsed = z.object({
      broker: z.enum(BROKER_IDS as unknown as [BrokerId, ...BrokerId[]]),
      accountType: z.string().min(2).max(64),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid broker selection' });
    try {
      const snap = await container.broker.setAccountType(parsed.data.broker, parsed.data.accountType);
      await container.ctx.audit.record('broker.accountTypeSelected', 'broker', snap.profileId, undefined, {
        profileId: snap.profileId,
        liveGateAllowed: snap.liveGate.allowed,
      });
      res.json(snap);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'invalid broker selection' });
    }
  });

  /** Operator confirmation of the broker's real terms (read from the broker). */
  r.post('/broker/conditions/confirm', async (req, res) => {
    const parsed = z.object({
      values: z.record(z.union([z.number(), z.string(), z.boolean(), z.array(z.union([z.number(), z.string()]))])),
      note: z.string().max(300).optional(),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid conditions' });
    try {
      const snap = await container.broker.confirmConditions(parsed.data.values as never, parsed.data.note);
      await container.ctx.audit.record('broker.conditionsConfirmed', 'broker', snap.profileId, undefined, {
        keys: Object.keys(parsed.data.values),
        note: parsed.data.note,
      });
      res.json(snap);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'invalid conditions' });
    }
  });

  r.post('/broker/conditions/clear', async (_req, res) => {
    const snap = await container.broker.clearConfirmations();
    await container.ctx.audit.record('broker.conditionsCleared', 'broker', snap.profileId);
    res.json(snap);
  });

  /**
   * "I have read the terms the broker publishes for this account type."
   *
   * This is what turns broker-PUBLISHED values (e.g. XM Ultra Low Standard
   * being priced on its spread, with no per-lot commission) into live-grade
   * evidence — and it lapses when the broker republishes the page or when the
   * account type changes.
   */
  r.post('/broker/terms/acknowledge', async (_req, res) => {
    const snap = await container.broker.acknowledgePublishedTerms();
    await container.ctx.audit.record('broker.publishedTermsAcknowledged', 'broker', snap.profileId, undefined, {
      policy: snap.policy.contentHash,
      ackAt: snap.publishedAcknowledgedAt,
    });
    res.json(snap);
  });

  /** Broker policy watcher: did the published terms change since we confirmed? */
  r.get('/broker/policy', (_req, res) => {
    res.json(container.policySource.snapshot());
  });
  r.post('/broker/policy/refresh', async (_req, res) => {
    res.json(await container.policySource.refresh());
  });

  /**
   * Per-symbol account costs: what ONE LOT of each symbol costs on the bound
   * account (spread + commission + overnight swap), component by component
   * with the source of every number. `?symbols=EUR/USD,GBP/USD` narrows it.
   */
  r.get('/broker/costs', (req, res) => {
    const raw = typeof req.query.symbols === 'string' ? req.query.symbols : '';
    const symbols = raw.split(',').map((s) => s.trim()).filter(Boolean);
    const costs = container.broker.costsFor(symbols);
    res.json({
      accountCurrency: container.broker.displayCurrency(),
      costs,
      complete: costs.length > 0 && costs.every((c) => c.complete),
    });
  });

  /**
   * Live-money readiness: the consolidated checklist behind "may real money
   * move through this account right now", optionally for one symbol.
   */
  r.get('/broker/readiness', (req, res) => {
    const symbol = typeof req.query.symbol === 'string' && req.query.symbol.trim() ? req.query.symbol.trim() : undefined;
    res.json(container.broker.readiness(symbol));
  });

  /**
   * Terms provenance for a symbol (or for the account): which account type a
   * decision would be made under, every number that would size it, where each
   * number came from and the live gate state. This is the same record written
   * onto positions and trades.
   */
  r.get('/broker/terms', (req, res) => {
    const symbol = typeof req.query.symbol === 'string' && req.query.symbol.trim() ? req.query.symbol.trim() : undefined;
    res.json(container.broker.termsProvenance(symbol));
  });

  /** Live conversion backing every cross-currency money figure. */
  r.get('/broker/fx', async (_req, res) => {
    const snap = await container.broker.status();
    res.json({
      fx: snap.fx,
      accountCurrency: snap.accountCurrency,
      displayCurrency: snap.displayCurrency,
      mt5Currency: snap.binding.account?.currency ?? null,
    });
  });

  // ---- extra subsystem routers (India markets) -----------------------------
  // Mounted INSIDE the authenticated gate: the India trading surface (execute,
  // close, authority flips, goal engine) used to be fully anonymous.
  // `e.path` is `/api/india` (full mount point from index.ts); `r` is already
  // at `/api`, so strip the `/api` prefix to avoid `/api/api/india` → 404.
  for (const e of extra) {
    const sub = e.path.replace(/^\/api/, '') || '/';
    r.use(sub.startsWith('/') ? sub : `/${sub}`, e.router);
  }

  return r;
}
