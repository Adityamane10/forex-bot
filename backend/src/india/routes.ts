/**
 * Indian subsystem REST API (spec §21, §54). Mounted at /api/india without
 * touching the existing Forex/Crypto routes. All endpoints return real engine
 * state — the UI is never given fabricated data.
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import type { IndiaTimeframe, IndiaSignal, IndiaCandle } from '@fx/shared';
import { IndiaModule } from './index';
import { indiaConfig } from './config';
import { INDIA_COLLECTIONS, INDIA_SESSION_CLOSE_MIN, INDIA_SESSION_OPEN_MIN, INDIA_TIMEFRAMES, INDIA_TIMEFRAME_MS } from '@fx/shared';
import { logger } from '../core/logger';

/**
 * `?timeframe=` and `INDIA_PRIMARY_TIMEFRAME` are both untrusted strings — one from
 * the client, one from the environment — and both were being cast straight to
 * `IndiaTimeframe` and then used as a lookup key. An unrecognised value returned
 * `undefined` from `INDIA_TIMEFRAME_MS`, which made the lookback NaN and left the
 * broker's date formatter to throw a RangeError on an invalid Date: an error that
 * names nothing, three files away from the typo that caused it.
 */
function asTimeframe(value: unknown): IndiaTimeframe | null {
  return typeof value === 'string' && (INDIA_TIMEFRAMES as readonly string[]).includes(value)
    ? (value as IndiaTimeframe)
    : null;
}

const DEFAULT_TIMEFRAME: IndiaTimeframe = asTimeframe(indiaConfig.primaryTimeframe) ?? '5m';

/** Minutes the cash/derivatives session actually trades — 375, derived from the
 *  session constants rather than typed, so moving the session moves this too. */
const SESSION_MINUTES = INDIA_SESSION_CLOSE_MIN - INDIA_SESSION_OPEN_MIN;

const DAY_MS = 86_400_000;

/**
 * The widest span a single broker history request is known to serve.
 *
 * Not a guess at the vendor's documented ceiling: it is the span this repo already
 * has working evidence for. `market-feed.ts` reaches 90 days by asking for three
 * consecutive 30-day windows rather than one 90-day window, and that seed is what
 * makes the index charts render on every timeframe today. So the on-demand path
 * chunks at the same size instead of assuming a wider request would be honoured.
 */
const CHUNK_DAYS = 30;

/**
 * How many of those windows one request is allowed to walk.
 *
 * A single 30-day window covers 300 bars of everything up to 15m, but 300 bars of
 * 30m honestly costs 38 days and 300 bars of 1h costs 72 — so capping the lookback
 * at one window quietly shipped ~265 and ~135 bars against a request for 300, and
 * an indicator with a 200-period lookback simply has no value on a 135-bar series.
 * Two windows reach ~270 bars of 1h and satisfy 30m outright, at the cost of one
 * extra round-trip on the only path where somebody is watching a spinner. A third
 * would buy 1h more depth than any indicator here asks for.
 */
const MAX_CHUNKS = 2;

/**
 * A floor of two calendar weeks, because the market can be shut for four days in
 * a row (a Thursday holiday, Friday, then the weekend) and a window that lands
 * entirely inside a closure returns nothing at all.
 */
const MIN_LOOKBACK_DAYS = 14;

/**
 * How far back to ask the broker, to stand a real chance of `bars` bars of `tf`.
 *
 * The obvious arithmetic — `bars × timeframe` — is wrong, and wrong in a way that
 * only bites the small timeframes. NSE trades 375 minutes a day and is shut for
 * the other 1065, plus every weekend and holiday, so 300 one-minute bars are not
 * "five hours ago": they are the last five *trading* hours, which on a Sunday sit
 * two days behind us. The previous code asked for `now − 300 × 60s` and got a
 * window containing no trading time whatsoever, so 1m/3m/5m came back empty while
 * 15m/30m/1h reached far enough to touch the previous session and rendered fine.
 *
 * Index instruments hid the bug completely, because `market-feed` pre-seeds 90
 * days across all six timeframes for the primary indices at startup. A searched
 * option contract is seeded by nothing and has only this request, which is why
 * the symptom was "CE/PE on 1m, 3m and 5m never loads".
 *
 * So: convert bars into whole trading days, gross up by 7/5 for weekends, add
 * slack for holidays, then clamp into the range this route is willing to fetch.
 */
function lookbackMs(tf: IndiaTimeframe, bars: number): number {
  const tfMinutes = INDIA_TIMEFRAME_MS[tf] / 60_000;
  const tradingDays = Math.ceil((bars * tfMinutes) / SESSION_MINUTES);
  const calendarDays = Math.ceil(tradingDays * 1.4) + 4;
  const bounded = Math.min(CHUNK_DAYS * MAX_CHUNKS, Math.max(MIN_LOOKBACK_DAYS, calendarDays));
  return bounded * DAY_MS;
}

/**
 * The broker's history for `[from, to]`, split into requests no wider than
 * `CHUNK_DAYS`.
 *
 * A failed chunk ends the walk instead of aborting it. Chunks run newest-first, so
 * whatever has already been collected is the most recent history — and a 429 on the
 * second request should leave the chart short, not empty. That is also why this
 * takes a bound `fetchChunk` and swallows its own errors: the caller's two legs are
 * deliberately independent, and a history failure must not discard today's bars.
 *
 * No inter-chunk sleep, unlike the startup seed. That loop issues six timeframes ×
 * three chunks × every index and needs to pace itself; this one issues at most two
 * requests against a ~1000-per-30-minute budget, and every millisecond of it is
 * latency a human is watching.
 */
async function fetchHistoryChunked(
  fetchChunk: (from: number, to: number) => Promise<IndiaCandle[]>,
  from: number,
  to: number,
  onError: (err: unknown) => void,
): Promise<IndiaCandle[]> {
  const out: IndiaCandle[] = [];
  const chunkMs = CHUNK_DAYS * DAY_MS;
  let chunkTo = to;
  for (let i = 0; i < MAX_CHUNKS && chunkTo > from; i++) {
    const chunkFrom = Math.max(from, chunkTo - chunkMs);
    try {
      out.push(...(await fetchChunk(chunkFrom, chunkTo)));
    } catch (err) {
      onError(err);
      break;
    }
    chunkTo = chunkFrom;
  }
  return out;
}

export function createIndiaApiRouter(module: IndiaModule): Router {
  const r = Router();

  /**
   * The earliest an on-demand candle fetch may be attempted again, per token and
   * timeframe. A "next allowed" instant rather than a "last attempted" one, so the
   * two backoffs below are set by writing a time rather than by arithmetic at the
   * read site.
   *
   * Scoped to the router so it dies with it, and a plain Map because the keyspace is
   * bounded by the instruments someone has actually looked at.
   */
  const nextFetchAllowedAt = new Map<string, number>();
  const FETCH_COOLDOWN_MS = 60_000;
  /** A contract that returns nothing will keep returning nothing — a far OTM strike
   *  that has never printed a trade does not start existing in the next minute. */
  const EMPTY_RESULT_BACKOFF_MS = 10 * 60_000;

  // ---- status / config -----------------------------------------------------
  r.get('/status', (_req, res) => {
    const session = module.session.snapshot();
    res.json({
      broker: indiaConfig.broker,
      configured: indiaConfig.broker !== 'NONE'
        && (
          Boolean(indiaConfig.apiKey)
          || Boolean(indiaConfig.upstoxAnalyticsToken)
          || Boolean(indiaConfig.accessToken)
          || (indiaConfig.broker === 'ANGELONE' && Boolean(
            indiaConfig.angelApiKey && indiaConfig.angelClientCode
            && indiaConfig.angelPin && indiaConfig.angelTotpSecret,
          ))
        ),
      liveExecution: indiaConfig.liveExecution,
      readOnly: module.adapter.readOnly,
      feedMode: module.adapter.feedMode,
      // What is actually feeding ticks, not which transport was attempted. The
      // websocket handshake can succeed and still never deliver a frame (the
      // analytics token authorizes V3 and then ignores every subscribe), so the
      // honest label asks whether a socket-sourced tick has arrived recently.
      feedSource: (() => {
        const wsLabel = indiaConfig.broker === 'UPSTOX' ? 'UPSTOX-WS-V3' : indiaConfig.broker === 'ZERODHA' ? 'KITE-WS' : 'NONE';
        if (module.feed.isStreaming()) return wsLabel;
        return indiaConfig.broker === 'NONE' ? 'NONE' : `${indiaConfig.broker}-REST-POLL`;
      })(),
      primaryTimeframe: indiaConfig.primaryTimeframe,
      session: {
        status: session.status,
        marketOpen: session.marketOpen,
        isHoliday: session.isHoliday,
        ist: `${session.ist.hour.toString().padStart(2, '0')}:${session.ist.minute.toString().padStart(2, '0')}`,
        marketOpenAt: session.marketOpenAt,
        marketCloseAt: session.marketCloseAt,
        segments: session.segments,
      },
      health: module.health.snapshot,
      executionAuthority: module.authority.snapshot(),
      /** ML serving state (§15): goal auto-trading fails closed when OFFLINE. */
      ml: module.mlHealth,
      feed: module.feed.stats(),
      instruments: module.instruments.all().length,
    });
  });

  r.get('/health', (_req, res) => {
    res.json({
      dataHealth: module.health.snapshot,
      session: module.session.snapshot(),
      executionAuthority: module.authority.snapshot(),
      stale: module.health.healthy === false,
    });
  });

  // ---- instruments ---------------------------------------------------------
  r.get('/instruments', (req, res) => {
    const underlying = typeof req.query.underlying === 'string' ? req.query.underlying.toUpperCase() : null;
    const list = underlying
      ? module.instruments.all().filter((i) => i.underlying.toUpperCase() === underlying)
      : module.instruments.all();
    res.json(list);
  });

  r.get('/instruments/:token', (req, res) => {
    const instr = module.instruments.getByToken(req.params.token);
    if (!instr) return res.status(404).json({ error: 'instrument not found' });
    res.json(instr);
  });

  // ---- candles & indicators ------------------------------------------------
  r.get('/candles/:token', async (req, res) => {
    const tf = asTimeframe(req.query.timeframe) ?? DEFAULT_TIMEFRAME;
    // Clamped once, here, rather than re-derived at each read below — and finite,
    // because `Number('abc')` is NaN and NaN survives every Math.min/max it touches.
    const requestedLimit = Number(req.query.limit ?? 300);
    const limit = Number.isFinite(requestedLimit) ? Math.min(5000, Math.max(10, requestedLimit)) : 300;
    let candles = module.candles.getCandles(req.params.token, tf, limit);

    // Does the buffer need topping up from the broker?
    //
    // The old test was "the newest bar is older than IST midnight", which is a
    // false positive on every request made while the market is shut: on a Sunday no
    // bar from today exists anywhere, so the buffer was declared stale forever and
    // the view's 15-second poll re-requested the same two endpoints indefinitely.
    // Upstox allows 1000 requests per 30 minutes; a weekend with the tab open spends
    // that budget and then 429s everything, including the calls that would have
    // worked. So: an empty buffer is always worth a try, and a populated one only
    // when the market is actually open and has moved on without us — which is also
    // the case where no live stream is attached and this becomes the fallback.
    const nowMs = Date.now();
    const session = module.session.snapshot();
    const newestBar = candles.length > 0 ? candles[candles.length - 1] : null;
    const behindTheMarket = !!newestBar && newestBar.openTime < nowMs - 2 * INDIA_TIMEFRAME_MS[tf];
    const needsRefresh = !newestBar || (session.marketOpen && behindTheMarket);

    // Attempt-based, not success-based: a strike the broker has no data for returns
    // nothing every time, so a cooldown keyed on success would retry on every poll
    // forever — two requests every fifteen seconds, for a chart that cannot exist.
    const cooldownKey = `${req.params.token}|${tf}`;
    const cooledDown = nowMs >= (nextFetchAllowedAt.get(cooldownKey) ?? 0);

    // Put this contract on the live websocket feed, whether or not the buffer needs
    // topping up.
    //
    // Outside the refresh block on purpose. The boot subscription is capped and ordered
    // by expiry, so an arbitrary strike someone typed into the search box is usually not
    // on it, and before this existed there was no way to add one: its chart advanced
    // only on the frontend's 15-second poll while the index tiles beside it moved tick
    // by tick. Same screen, two different notions of "now".
    //
    // Inside the refresh block it would almost never fire — once the buffer is full and
    // the market is shut, `needsRefresh` is false, which is exactly the state a chart
    // sits in while waiting for the open. Idempotent and cheap after the first call (a
    // Set membership test), so it is safe on a path that runs every fifteen seconds,
    // and not gated on `marketOpen` so the first tick of the next session arrives
    // without waiting for a poll to notice the market opened.
    void module.feed.ensureSubscribed(req.params.token);

    if (needsRefresh && cooledDown && module.feed.isStarted) {
      const instr = module.instruments.getByToken(req.params.token);
      if (instr) {
        nextFetchAllowedAt.set(cooldownKey, nowMs + FETCH_COOLDOWN_MS);
        try {
          // Strategy: Historical V3 for past dates, Intraday V2 for current trading day.
          // `bars` is only a sizing hint for how far back to look — what actually
          // governs the count is the window below and what the contract traded.
          const bars = Math.min(limit, 300);
          const from = nowMs - lookbackMs(tf, bars);
          
          // 1. Fetch historical data (past dates), chunked so 30m and 1h can reach
          //    far enough back to be worth charting. Settled on its own: the adapter
          //    throws on a non-OK response, and under one shared try/catch a
          //    rate-limited history request also threw away today's intraday bars —
          //    the ones the trader is actually looking at.
          const historical = await fetchHistoryChunked(
            (chunkFrom, chunkTo) => module.adapter.getHistoricalCandles(instr.instrumentToken, tf, chunkFrom, chunkTo),
            from,
            nowMs,
            (err) => logger.warn('india: historical candle leg failed', { token: req.params.token, tf, err: String(err) }),
          );
          
          // 2. Fetch intraday data (current trading day). Upstox only serves today
          //    here; Zerodha's adapter returns nothing at all, and its historical
          //    endpoint already includes today — so an empty leg is normal, not a
          //    failure, and must not discard the historical result.
          const intraday = await module.adapter
            .getIntradayCandles(instr.instrumentToken, tf)
            .catch((err: unknown) => {
              logger.warn('india: intraday candle leg failed', { token: req.params.token, tf, err: String(err) });
              return [] as IndiaCandle[];
            });
          
          // 3. Merge, deduplicating by id, freshest wins. The bars already in the
          //    buffer go in first: `candles.seed` *replaces* a buffer rather than
          //    appending to it, so seeding only what this request fetched would
          //    throw away the 90 days `market-feed` seeds for the indices at
          //    startup and leave the chart shorter after a refresh than before it.
          //    Order matters within that: `candles` can end with a live OPEN bar, and
          //    putting the broker's legs after it lets a COMPLETED copy of the same
          //    period win the dedupe. `seed` then drops the superseded open bar, so
          //    it cannot be re-appended on the way back out.
          const mergeMap = new Map<string, IndiaCandle>();
          for (const c of [...candles, ...historical, ...intraday]) mergeMap.set(c.id, c);
          
          // 4. Sort ascending by openTime
          const merged = [...mergeMap.values()].sort((a, b) => a.openTime - b.openTime);
          
          // 5. Seed into buffer
          if (merged.length) {
            await module.candles.seed(instr.instrumentToken, tf, merged);
            logger.info('india: on-demand candles merged', {
              token: req.params.token, symbol: instr.tradingSymbol,
              historical: historical.length, intraday: intraday.length, total: merged.length,
              lookbackDays: Math.round((nowMs - from) / DAY_MS),
            });
          } else {
            // An empty chart with no error above it is otherwise indistinguishable
            // from a broken one. This is the line that says which: the request
            // succeeded and the contract simply did not trade in the window.
            nextFetchAllowedAt.set(cooldownKey, nowMs + EMPTY_RESULT_BACKOFF_MS);
            logger.warn('india: no candles available for instrument', {
              token: req.params.token, symbol: instr.tradingSymbol, tf,
              lookbackDays: Math.round((nowMs - from) / DAY_MS),
            });
          }
          
          // 6. Open the live bar from the current LTP — but only while the market
          //    is actually trading.
          //
          //    This is the fallback for a contract the websocket cannot carry, which
          //    with a read-only analytics token is every contract.
          //
          //    Ungated, though, it stamps `marketTimestamp: nowMs` on whatever the
          //    batch endpoint last knew — which outside session hours is Friday's
          //    close. `candle-engine.onTick` floors that into a bucket with no
          //    market-open check of its own, so a Sunday request minted a Sunday
          //    candle out of a Friday price: invented data, on the chart, in front
          //    of someone deciding whether to take a trade.
          //
          //    It also broke the refresh logic it shares this handler with. That
          //    fabricated bar makes `newestBar` non-null, and `needsRefresh` is
          //    `!newestBar || (marketOpen && behindTheMarket)` — so on the next
          //    request, with the market shut, both sides are false and the broker
          //    is never asked again. A contract whose first fetch came back empty
          //    would therefore sit on one fake bar permanently, which is the
          //    reported symptom arrived at from the opposite direction.
          if (session.marketOpen) {
            try {
              const ohlcData = await module.adapter.getOhlcBatch([instr.instrumentToken]);
              const ohlc = ohlcData[0];
              if (ohlc) {
                module.feed.ingestTick({
                  exchange: instr.exchange, segment: instr.segment,
                  instrumentToken: instr.instrumentToken, tradingSymbol: instr.tradingSymbol,
                  underlying: instr.underlying,
                  marketTimestamp: nowMs, receivedAt: nowMs, timestamp: nowMs,
                  ltp: ohlc.ltp, bid: null, ask: null, bidQuantity: null, askQuantity: null,
                  volume: ohlc.volume, openInterest: ohlc.oi,
                  dayOpen: ohlc.open, dayHigh: ohlc.high, dayLow: ohlc.low,
                  previousClose: ohlc.previousClose, lastTradeQuantity: null,
                  source: 'UPSTOX' as const, tradable: true,
                });
              }
            } catch { /* best-effort */ }
          }
          
          candles = module.candles.getCandles(req.params.token, tf, limit);
        } catch (fetchErr) {
          logger.warn('india: on-demand candle fetch failed', { token: req.params.token, tf, err: String(fetchErr) });
        }
      }
    }

    res.json({ token: req.params.token, timeframe: tf, candles });
  });

  r.get('/indicators/:token', async (req, res) => {
    const tf = asTimeframe(req.query.timeframe) ?? DEFAULT_TIMEFRAME;
    const candles = module.candles.getCandles(req.params.token, tf, 500);
    const snapshot = await module.indicators.getSnapshot(req.params.token, candles, tf, true);
    res.json(snapshot);
  });

  // ---- analysis ------------------------------------------------------------
  r.get('/analysis', async (_req, res) => {
    const session = module.session.snapshot();
    res.json(await module.analysis.analyzeAll(session));
  });

  r.get('/analysis/:token', async (req, res) => {
    const session = module.session.snapshot();
    res.json(await module.analysis.analyze(req.params.token, session));
  });

  // ---- signals -------------------------------------------------------------
  r.get('/signals', async (_req, res) => {
    const stored = await module.store.find<{ _id?: unknown }>(INDIA_COLLECTIONS.signals, {}, { createdAt: -1 }, 200);
    res.json(stored);
  });

  // Manual trade execution: paper-execute a specific signal immediately.
  // Used by the "Trade" button in the UI — places the order at the current
  // market price regardless of AUTO/MANUAL mode setting.
  r.post('/signals/:signalId/execute', async (req, res) => {
    try {
      const stored = await module.store.find<IndiaSignal & { _id?: unknown }>(
        INDIA_COLLECTIONS.signals, { signalId: req.params.signalId }, {}, 1
      );
      const signal = stored[0] as IndiaSignal | undefined;
      if (!signal) return res.status(404).json({ error: 'signal not found' });

      const now = Date.now();
      if ((signal.expiresAt ?? 0) < now) {
        return res.status(409).json({ error: 'signal expired — cannot execute' });
      }
      const deadStatuses: IndiaSignal['status'][] = [
        'EXPIRED', 'INVALIDATED', 'MISSED', 'BLOCKED', 'POSITION_OPEN',
      ];
      if (deadStatuses.includes(signal.status)) {
        return res.status(409).json({ error: `signal status is ${signal.status} — cannot execute` });
      }

      const session = module.session.snapshot();
      // For manual execution we bypass authority checks — the user is explicitly
      // clicking Trade, so honour that intent in both market-open and closed states.
      // Portfolio caps still apply to the OWNER's book (spec §46): a manual fill
      // counts toward the same envelope the engines are bounded by, so a click
      // cannot stack a contract the engine already holds or exceed the margin
      // budget. Same-owner books keep their own limits (GOAL=1, UNIVERSAL=config).
      const ownerCaps = signal.owner === 'GOAL'
        ? { maxOpenPositions: 1 }
        : (() => {
            const s = module.userSettings.sync();
            return {
              maxOpenPositions: s.maxOpenPositions,
              maxConcurrentMarginInr: s.maxConcurrentMarginInr,
            };
          })();
      const position = await module.paper.execute(
        { ...signal, executionMode: 'MANUAL' } as IndiaSignal,
        { ...session, marketOpen: true },  // allow manual execute outside market hours too
        { owner: signal.owner, caps: ownerCaps },
      );
      if (!position) return res.status(422).json({ error: 'paper execution rejected — check instrument tradability' });

      // Update signal status
      await module.store.updateOne(INDIA_COLLECTIONS.signals, { signalId: signal.signalId }, {
        $set: { status: 'POSITION_OPEN', positionId: position.positionId },
      });

      res.status(201).json({ position, signalId: signal.signalId });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'execution failed' });
    }
  });

  // ---- positions / account -------------------------------------------------
  r.get('/positions', (_req, res) => {
    res.json(module.paper.openPositions());
  });

  r.get('/account', (_req, res) => {
    res.json(module.paper.accountSnapshot());
  });

  r.post('/positions/:positionId/close', async (req, res) => {
    const position = module.paper.getPosition(req.params.positionId);
    if (!position) return res.status(404).json({ error: 'position not found' });
    if (position.status !== 'OPEN') return res.status(409).json({ error: 'position already closed' });
    // Prefer a live quote over the possibly-frozen currentPrice: an orphaned
    // contract no longer on the poll list never sees a tick, so its stored
    // price can be hours old. Feed tick → stored price → entry.
    const ltp = module.feed.lastTick(position.instrumentToken)?.ltp;
    const exitPrice = Number.isFinite(ltp) && (ltp as number) > 0 ? (ltp as number) : (position.currentPrice ?? position.entry);
    const result = await module.paper.close(position, exitPrice, 'MANUAL');
    if (!result) return res.status(500).json({ error: 'close failed — see backend logs' });
    res.json({ position: result.position, trade: result.trade });
  });

  // ---- goal trading --------------------------------------------------------
  r.post('/goals/start', async (req, res) => {
    try {
      const body = z.object({
        goalId: z.string().min(1).optional(),
        amountInr: z.number().positive(),
        minimumProfitInr: z.number().positive(),
        maxRiskInr: z.number().positive(),
        maxMarginPercent: z.number().min(1).max(100),
        numberOfTrades: z.number().int().min(1).max(20),
        executionMode: z.enum(['OFF', 'MANUAL', 'AUTO']).default('AUTO'),
        sessionPolicy: z.enum(['TODAY_ONLY', 'CONTINUE_NEXT_SESSION']).default('TODAY_ONLY'),
        tradeUnderlyings: z.array(z.string()).optional(),
        // These two were stripped by the schema for months: the UI sent the
        // user's Goal-Completion and Max-Hold choices, the engine honored
        // defaults instead, and the panel showed a goal that was never quite
        // the one configured.
        profitSemantics: z.enum(['CUMULATIVE', 'PER_TRADE']).default('CUMULATIVE'),
        maxHoldMinutes: z.number().int().min(1).max(480).optional(),
      }).parse(req.body);
      const goal = await module.goals.start({
        ...body,
        goalId: body.goalId ?? `goal-${Date.now()}`,
        createdAt: Date.now(),
      });
      res.status(201).json(goal);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'bad request' });
    }
  });

  /**
   * Goal start used to fail closed whenever UNIVERSAL held execution authority:
   * `goals.start()` calls `authority.acquire('GOAL')`, which denies any request
   * while another owner holds it — and UNIVERSAL is the default owner, so the
   * button answered "execution authority is held by another engine" every time.
   * The user's intent when clicking Start is explicit, so this endpoint now
   * performs a handover first (same pattern as the manual /authority switch):
   * set the goal's mode to AUTO, take authority for GOAL (releasing UNIVERSAL),
   * then start the engine. If the engine still cannot start, roll back so a
   * failed start never silently leaves the platform in GOAL mode.
   */
  r.post('/goals/handover-start', async (req, res) => {
    try {
      const body = z.object({
        goalId: z.string().min(1).optional(),
        amountInr: z.number().positive(),
        minimumProfitInr: z.number().positive(),
        maxRiskInr: z.number().positive(),
        maxMarginPercent: z.number().min(1).max(100),
        numberOfTrades: z.number().int().min(1).max(20),
        executionMode: z.enum(['OFF', 'MANUAL', 'AUTO']).default('AUTO'),
        sessionPolicy: z.enum(['TODAY_ONLY', 'CONTINUE_NEXT_SESSION']).default('TODAY_ONLY'),
        tradeUnderlyings: z.array(z.string()).optional(),
        profitSemantics: z.enum(['CUMULATIVE', 'PER_TRADE']).default('CUMULATIVE'),
        maxHoldMinutes: z.number().int().min(1).max(480).optional(),
      }).parse(req.body);

      const previous = module.authority.snapshot();
      // 1) Arm the goal engine's mode, otherwise acquire() refuses (mode OFF).
      module.authority.setGoalMode(body.executionMode === 'MANUAL' ? 'MANUAL' : 'AUTO', 'goal start requested');
      // 2) Explicit handover: authority is exclusive, so the previous owner
      //    (usually UNIVERSAL) must release before GOAL can take over.
      //    release() also flips that owner's mode OFF, matching the manager's
      //    own stop semantics.
      if (previous.owner !== 'NONE' && previous.owner !== 'GOAL') {
        module.authority.release(previous.owner, 'handover to goal trading');
      }
      if (!module.authority.acquire('GOAL', 'user started goal trading')) {
        throw new Error('could not take execution authority for goal trading');
      }
      // 3) Start the engine; roll back on failure so a dead start never leaves
      //    the platform silently owned by GOAL.
      try {
        const goal = await module.goals.start({
          ...body,
          goalId: body.goalId ?? `goal-${Date.now()}`,
          createdAt: Date.now(),
        });
        res.status(201).json(goal);
      } catch (startErr) {
        module.authority.release('GOAL', 'goal start failed — authority rolled back');
        if (previous.owner === 'UNIVERSAL') {
          // release('GOAL') reset the goal mode to OFF; restore what UNIVERSAL had.
          module.authority.setUniversalMode(previous.universal.executionMode, 'rollback after failed goal start');
          module.authority.acquire('UNIVERSAL', 'rollback after failed goal start');
        }
        throw startErr;
      }
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'bad request' });
    }
  });

  r.post('/goals/:goalId/stop', async (req, res) => {
    const live = module.goals.currentGoal();
    if (req.params.goalId && live && req.params.goalId !== live.goalId) {
      return res.status(404).json({ error: `goal ${req.params.goalId} not active` });
    }
    const goal = await module.goals.stop('ENGINE_EXIT', 'stopped by user');
    res.json(goal);
  });

  r.get('/goals', async (_req, res) => {
    // Primary source: in-memory engine (always current).
    // Secondary: DB for history (completed/stopped goals from previous sessions).
    const live = module.goals.currentGoal();
    const stored = await module.store.find<{ _id?: unknown }>(
      INDIA_COLLECTIONS.goals, {}, { startedAt: -1 }, 50
    );
    // Deduplicate: if a stored goal matches the live goal, use the live version
    const liveId = live?.goalId;
    const deduped = stored.filter((g: any) => g.goalId !== liveId);
    const result = live ? [live, ...deduped] : deduped;
    res.json(result);
  });

  r.get('/goals/current', (_req, res) => {
    const goal = module.goals.currentGoal();
    res.json(goal ? { goal, progress: module.goals.progressSnapshot() } : null);
  });

  // Structured per-stage scan diagnostics (§34): why the goal engine is (or is
  // not) trading, stage by stage — market/feed/ML health, candidate counts and
  // where candidates died. Works with or without an active goal. Both spellings
  // are served: the panel uses /goals/diagnostics, the ops runbook /goal/*.
  const goalDiagnosticsHandler = (_req: Request, res: Response) => {
    const goal = module.goals.currentGoal();
    const session = module.session.snapshot();
    res.json({
      enabled: !!goal && goal.status === 'ACTIVE',
      goalId: goal?.goalId ?? null,
      state: goal?.state ?? 'OFF',
      autoTradeEnabled: goal?.config.executionMode === 'AUTO',
      session: { status: session.status, marketOpen: session.marketOpen },
      dataHealth: module.health.snapshot,
      ml: module.mlHealth,
      authority: module.authority.snapshot(),
      diagnostics: goal?.progress.diagnostics ?? null,
      waitReason: goal?.progress.waitReason ?? null,
    });
  };
  r.get('/goals/diagnostics', goalDiagnosticsHandler);
  r.get('/goal/diagnostics', goalDiagnosticsHandler);
  r.get('/goal/status', goalDiagnosticsHandler);

  // ---- execution authority -------------------------------------------------
  r.get('/authority', (_req, res) => {
    res.json(module.authority.snapshot());
  });

  // ---- user trading settings ------------------------------------------------
  // The values the user sets in the dashboard: capital, minimum profit, max
  // risk/trade, max margin %, and the portfolio caps. The universal engine's
  // sizing and the paper engine's profit-taking exit read these live.
  r.get('/settings', (_req, res) => {
    res.json(module.userSettings.sync());
  });

  r.put('/settings', async (req, res) => {
    try {
      const body = z.object({
        amountInr: z.number().positive().optional(),
        minimumProfitInr: z.number().nonnegative().optional(),
        maxRiskInr: z.number().positive().optional(),
        maxMarginPercent: z.number().min(1).max(100).optional(),
        maxOpenPositions: z.number().int().min(1).max(50).optional(),
        maxConcurrentMarginInr: z.number().positive().optional(),
      }).parse(req.body);
      const saved = await module.userSettings.save(body);
      logger.info('india: user settings updated', { ...saved });
      res.json(saved);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'bad request' });
    }
  });

  r.post('/authority', (req, res) => {
    try {
      const body = z.object({
        owner: z.enum(['GOAL', 'UNIVERSAL']).optional(),
        goalMode: z.enum(['OFF', 'MANUAL', 'AUTO']).optional(),
        universalMode: z.enum(['OFF', 'MANUAL', 'AUTO']).optional(),
        reason: z.string().default('user action'),
      }).parse(req.body);
      if (body.goalMode !== undefined) module.authority.setGoalMode(body.goalMode, body.reason);
      if (body.universalMode !== undefined) module.authority.setUniversalMode(body.universalMode, body.reason);
      if (body.owner !== undefined) {
        if (body.owner === 'GOAL') module.authority.acquire('GOAL', body.reason);
        else module.authority.acquire('UNIVERSAL', body.reason);
      }
      res.json(module.authority.snapshot());
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ---- option flow (OI / PCR / Max Pain) -----------------------------------
  r.get('/option-flow', async (req, res) => {
    try {
      const underlying = typeof req.query.underlying === 'string' ? req.query.underlying.toUpperCase() : null;
      const expiry = typeof req.query.expiry === 'string' && req.query.expiry !== ''
        ? Number(req.query.expiry)
        : null;
      if (underlying) {
        const snap = await module.optionFlow.snapshot(underlying, expiry);
        return res.json(snap ?? { error: 'no option flow for underlying' });
      }
      res.json(await module.optionFlow.snapshotAll());
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'bad request' });
    }
  });

  // ---- option analytics (PCR, Max Pain, ATM, IV, greeks, OI levels) --------
  r.get('/option-analytics', async (req, res) => {
    try {
      const underlying = typeof req.query.underlying === 'string' ? req.query.underlying.toUpperCase() : null;
      if (underlying) {
        // No cast: `analyze` takes a plain string and returns null for anything
        // it cannot serve. The old `as 'NIFTY' | 'BANKNIFTY' | 'FINNIFTY'` was
        // asserting something the query string could not guarantee.
        const analytics = await module.optionAnalytics.analyze(underlying);
        return res.json(analytics ?? { error: 'analytics unavailable' });
      }
      res.json(await module.optionAnalytics.analyzeAll());
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'bad request' });
    }
  });

  // ---- option chain ladder (per-strike OI, IV, greeks, spread) -------------
  // Returns the summary and the ladder from a single chain fetch so the Max Pain
  // marker cannot be drawn from a different snapshot than the bars under it.
  r.get('/option-chain', async (req, res) => {
    try {
      const underlying = typeof req.query.underlying === 'string' ? req.query.underlying.toUpperCase() : 'NIFTY';
      const view = await module.optionAnalytics.chainView(underlying);
      res.json({ underlying, ...view });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'bad request' });
    }
  });

  // ---- NEW: multi-timeframe analysis ---------------------------------------
  r.get('/multi-timeframe/:token', async (req, res) => {
    try {
      const context = await module.multiTimeframe.analyze(req.params.token);
      res.json(context);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'analysis failed' });
    }
  });

  // ---- NEW: performance analytics ------------------------------------------
  r.get('/performance', async (req, res) => {
    try {
      const endDate = typeof req.query.endDate === 'string' ? Number(req.query.endDate) : Date.now();
      const startDate = typeof req.query.startDate === 'string' 
        ? Number(req.query.startDate) 
        : endDate - 30 * 86400000; // Default: last 30 days
      
      const metrics = await module.performanceAnalytics.calculateMetrics(startDate, endDate);
      res.json(metrics);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'calculation failed' });
    }
  });

  // ---- trades / backtests --------------------------------------------------
  r.get('/trades', async (_req, res) => {
    const stored = await module.store.find<{ _id?: unknown }>(INDIA_COLLECTIONS.trades, {}, { closedAt: -1 }, 200);
    res.json(stored);
  });

  r.get('/backtests', async (_req, res) => {
    const stored = await module.store.find<{ _id?: unknown }>(INDIA_COLLECTIONS.backtests, {}, { createdAt: -1 }, 50);
    res.json(stored);
  });

  r.post('/backtests/run', async (req, res) => {
    try {
      const body = z.object({
        runId: z.string().min(1).optional(),
        instruments: z.array(z.string()).min(1),
        timeframe: z.enum(['1m', '3m', '5m', '15m', '30m', '1h']).default('5m'),
        start: z.number(),
        end: z.number(),
        startingCapitalInr: z.number().positive().default(100000),
        maxRiskInr: z.number().positive().default(500),
        maxMarginPercent: z.number().min(1).max(100).default(20),
        minRr: z.number().min(0.5).default(1.5),
        lotSizing: z.enum(['FIXED_LOT', 'RISK_BASED']).default('RISK_BASED'),
        numberOfTrades: z.number().int().min(1).max(50).nullable().default(null),
        goalTargetInr: z.number().positive().nullable().default(null),
        slippageTicks: z.number().min(0).default(1),
        commissionPerLot: z.number().min(0).default(20),
      }).parse(req.body);
      const run = await module.backtest.run({
        ...body,
        runId: body.runId ?? `bt-${Date.now()}`,
      });
      res.status(201).json(run);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'bad request' });
    }
  });

  r.get('/backtests/:runId', (req, res) => {
    const run = module.backtest.getRun(req.params.runId);
    if (!run) return res.status(404).json({ error: 'run not found' });
    res.json(run);
  });

  return r;
}
