import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { actions, RootState } from '../store';
import { Card, Stat, Badge, ModeBadge, Empty, Spinner } from '../components/ui';
import { CandleChart } from '../components/CandleChart';
import { fmt, fmtPrice } from '../format';
import { api } from '../api';
import { setActiveTimeframe } from '../socket';
import { CRYPTO_SYMBOLS, DEFAULT_SYMBOLS, IndicatorSnapshot, Signal, Tick, Timeframe, TIMEFRAMES } from '@fx/shared';

/** Live tick-age badge: how stale the current quote is. Forex (Yahoo free tier)
 *  refreshes every ~15-30 s by design; crypto streams in realtime. */
function TickAge({ tick }: { tick?: Tick | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);
  if (!tick || !Number.isFinite(tick.mid)) return <span className="text-xs text-slate-500">no quote</span>;
  const age = Math.max(0, Math.round((now - (tick.receivedAt ?? tick.timestamp)) / 1000));
  const tone = age < 5 ? 'text-emerald-400' : age < 30 ? 'text-amber-400' : 'text-red-400';
  return <span className={`text-xs ${tone}`}>{age}s</span>;
}

/** One cell of the quote rail: a tracked label over a large mono figure. */
function Readout({ label, value, tone = 'text-slate-100' }: { label: string; value: ReactNode; tone?: string }) {
  return (
    <div className="px-3 py-2 sm:px-3.5">
      <div className="eyebrow">{label}</div>
      <div className={`font-mono text-[15px] leading-tight ${tone}`}>{value}</div>
    </div>
  );
}

/** A labelled measurement row. Values are right-aligned so a column of numbers
 *  can be scanned and compared at a glance. */
function Reading({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border/60 py-[5px]">
      <span className="text-[12px] text-slate-400">{label}</span>
      <span className="font-mono text-[12px] text-slate-100">{value}</span>
    </div>
  );
}

export function Market({ symbol }: { symbol: string }) {
  const dispatch = useDispatch();
  // Timeframe lives in the store so it survives view switches (switching assets
  // keeps your chosen timeframe instead of resetting to 1h).
  const tf = useSelector((s: RootState) => s.view.tf) as Timeframe;
  const setTf = (t: Timeframe) => dispatch(actions.view.setTf(t));
  // MT5 broker server time offset — chart axis matches the MT5 terminal.
  const mt5OffsetMs = useSelector((s: RootState) => s.system.mt5OffsetMs);
  const candles = useSelector((s: RootState) => s.market.candles[`${symbol}|${tf}`] as unknown[] | undefined);
  const tick = useSelector((s: RootState) => s.market.ticks[symbol]);
  const active = useSelector((s: RootState) => s.signals.active);
  const [indicators, setIndicators] = useState<IndicatorSnapshot | null>(null);
  const [mtf, setMtf] = useState<{ consensus: string; timeframes: Array<{ timeframe: string; trend: string; momentum: string }> } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const signal = useMemo(() => active.find((s) => s.symbol === symbol), [active, symbol]);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(id);
    async function refresh() {
      // Symbols contain a slash (EUR/USD) and must be URL-encoded in the path
      // or Express treats them as extra route segments (404).
      const enc = encodeURIComponent(symbol);
      setActiveTimeframe(tf);
      // A 10s timeout on every fetch: if the backend is warming up or a feed
      // is slow, the view shows a retry state instead of spinning forever.
      const sig = AbortSignal.timeout(10_000);
      // Candles first, on their own: the chart renders the moment they arrive
      // even if indicator/MTF computation is slow on a cold timeframe.
      try {
        const candlesRes = await api<{ candles: unknown[] }>(`/candles/${enc}?timeframe=${tf}&limit=300`, { signal: sig });
        const store = (await import('../store')).store;
        store.dispatch((await import('../store')).actions.market.candles({ symbol: `${symbol}|${tf}`, candles: candlesRes.candles }));
        setLoadError(null);
      } catch (err) {
        setLoadError(err instanceof Error && err.name === 'TimeoutError' ? `market data request timed out — retrying…` : `market data unavailable — retrying…`);
      }
      // Indicators + MTF best-effort in parallel — never block the chart on them.
      try {
        const [ind, analysis] = await Promise.all([
          api<IndicatorSnapshot>(`/indicators/${enc}?timeframe=${tf}`, { signal: sig }),
          api<{ mtf: { consensus: string; timeframes: Array<{ timeframe: string; trend: string; momentum: string }> } }>(`/analysis/${enc}`, { signal: sig }),
        ]);
        setIndicators(ind);
        setMtf(analysis.mtf);
      } catch {
        /* indicators are best-effort — the chart is already rendering */
      }
    }
  }, [symbol, tf, active.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const v = indicators?.values ?? {};

  const go = (s: string) => dispatch(actions.view.go({ view: 'market', symbol: s }));

  // Indicators that live on the price scale are shown at the instrument's own
  // precision — an EMA200 rounded to three decimals cannot be compared to a
  // five-decimal price, which made the trend readings useless.
  const reading = (val: unknown, priceScale = false) => {
    if (val === null || val === undefined || val === '—') return <span className="text-slate-500">—</span>;
    if (typeof val === 'string') return val;
    return priceScale ? fmtPrice(Number(val), symbol) : fmt(Number(val), 3);
  };

  const supertrend = v.supertrendDirection === 1 ? 'UP' : v.supertrendDirection === -1 ? 'DOWN' : '—';

  // Indicators grouped by what they measure. Same fifteen readings as before,
  // arranged so related figures sit next to each other. The third tuple slot
  // marks a reading as being on the price scale.
  const groups: Array<{ heading: string; rows: Array<[string, unknown, boolean?]> }> = [
    {
      heading: 'Momentum',
      rows: [
        ['RSI (14)', v.rsi14],
        ['Stochastic K', v.stochK],
        ['CCI (20)', v.cci20],
        ['MACD histogram', v.macdHistogram],
        ['ADX', v.adx],
      ],
    },
    {
      heading: 'Volatility',
      rows: [
        ['ATR (14)', v.atr14, true],
        ['ATR %', v.atrPct],
        ['Bollinger width', v.bbWidth],
        ['Bollinger position', v.bbPosition],
      ],
    },
    {
      heading: 'Trend',
      rows: [
        ['EMA 9', v.ema9, true],
        ['EMA 20', v.ema20, true],
        ['EMA 50', v.ema50, true],
        ['EMA 100', v.ema100, true],
        ['EMA 200', v.ema200, true],
      ],
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="eyebrow mb-1.5">Instrument</div>
          <div className="flex items-center gap-3">
            <h1 className="font-mono text-[22px] font-medium leading-none text-slate-100">{symbol}</h1>
            <select
              value={symbol}
              onChange={(e) => go(e.target.value)}
              className="rounded border border-border bg-panel2 px-2 py-1 font-mono text-xs text-slate-300 outline-none transition-colors hover:border-hairline focus:border-blue-400"
              aria-label="instrument"
            >
              <optgroup label="FOREX">
                {DEFAULT_SYMBOLS.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </optgroup>
              <optgroup label="CRYPTO">
                {CRYPTO_SYMBOLS.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </optgroup>
            </select>
            <ModeBadge mode={tick?.mode ?? ''} />
          </div>
        </div>

        {/* Quote rail — the live price is the most important figure on the page,
            so it gets the largest type and its own machined enclosure. */}
        <div className="flex max-w-full flex-wrap items-stretch divide-x divide-border overflow-hidden rounded-md border border-border bg-panel shadow-panel">
          <Readout label="Bid" value={tick ? fmtPrice(tick.bid, symbol) : '—'} />
          <Readout label="Ask" value={tick ? fmtPrice(tick.ask, symbol) : '—'} />
          <Readout label="Spread" value={tick ? fmtPrice(tick.spread, symbol) : '—'} tone="text-amber-400" />
          <div className="px-3 py-2 sm:px-3.5">
            <div className="eyebrow">Quote age</div>
            <div className="leading-tight">
              <TickAge tick={tick} />
            </div>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        {/* Segmented control: one enclosure, hairline dividers, lit selection. */}
        <div className="inline-flex divide-x divide-border overflow-hidden rounded-md border border-border bg-panel2">
          {TIMEFRAMES.map((t) => (
            <button
              key={t}
              onClick={() => setTf(t)}
              aria-pressed={tf === t}
              className={`px-3 py-1.5 font-mono text-[11px] font-medium transition-colors ${
                tf === t ? 'bg-slate-100/[0.09] text-slate-100' : 'text-slate-500 hover:bg-slate-100/[0.04] hover:text-slate-200'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
        <span className="ml-auto text-[11px] text-slate-600">Candles stream live · full refresh every 15s</span>
      </div>

      <Card>
        {candles && candles.length ? (
          /* No `levels` prop: the app has no real support/resistance feed, and
             the previous stand-in re-drew the signal's own stop and targets a
             second time in the opposite colour — a green "S1" line sitting
             exactly on the red stop loss. The signal's own lines are drawn
             once, correctly, by CandleChart. */
          <CandleChart candles={candles as never} symbol={symbol} signal={signal} tick={tick} timeOffsetMs={mt5OffsetMs} />
        ) : (
          <div className="flex h-[380px] flex-col items-center justify-center gap-2">
            <Spinner />
            {loadError && <div className="text-xs text-amber-400">{loadError}</div>}
          </div>
        )}
      </Card>

      {signal && (
        <Card title={`Active Signal — ${signal.direction}`} right={<Badge tone={signal.direction === 'BUY' ? 'up' : 'down'}>{signal.state}</Badge>}>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-8">
            <Stat label="Entry" value={fmtPrice(signal.entry.preferredEntry, symbol)} sub={`${fmtPrice(signal.entry.entryMin, symbol)} – ${fmtPrice(signal.entry.entryMax, symbol)}`} />
            <Stat label="SL" value={fmtPrice(signal.stopLoss.price, symbol)} sub={`${fmt(signal.stopLoss.pips, 1)} pips`} />
            <Stat label="TP1" value={fmtPrice(signal.takeProfit.tp1, symbol)} sub={`R:R ${fmt(signal.takeProfit.rr1, 2)}`} />
            <Stat label="TP2" value={signal.takeProfit.tp2 ? fmtPrice(signal.takeProfit.tp2, symbol) : '—'} sub={signal.takeProfit.rr2 ? `R:R ${fmt(signal.takeProfit.rr2, 2)}` : undefined} />
            <Stat label="Prob" value={fmt(signal.probability * 100, 1) + '%'} sub="updates live" />
            <Stat label="Confidence" value={fmt(signal.confidence * 100, 0) + '%'} />
            <Stat label="EV / trade" value={fmt(signal.expectedValue.evPerTrade, 2)} />
            <Stat label="Risk" value={signal.risk.level} />
          </div>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title={`Indicators — ${tf}`}
          right={
            <Badge tone={supertrend === 'UP' ? 'up' : supertrend === 'DOWN' ? 'down' : 'muted'}>
              Supertrend {supertrend}
            </Badge>
          }
        >
          <div className="space-y-4">
            {groups.map((g) => (
              <div key={g.heading}>
                <div className="eyebrow mb-1">{g.heading}</div>
                <div className="grid gap-x-6 sm:grid-cols-2">
                  {g.rows.map(([label, val, isPrice]) => (
                    <Reading key={label} label={label} value={reading(val, isPrice)} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card
          title="Multi-Timeframe"
          right={
            mtf ? (
              <Badge tone={mtf.consensus === 'BULLISH' ? 'up' : mtf.consensus === 'BEARISH' ? 'down' : 'warn'}>{mtf.consensus}</Badge>
            ) : undefined
          }
        >
          {mtf ? (
            <div className="divide-y divide-border/70">
              {mtf.timeframes.map((t) => (
                <div key={t.timeframe} className="flex items-center justify-between gap-3 py-2">
                  <span className="w-10 shrink-0 font-mono text-[12px] text-slate-300">{t.timeframe}</span>
                  <Badge tone={t.trend === 'BULLISH' ? 'up' : t.trend === 'BEARISH' ? 'down' : 'muted'}>{t.trend}</Badge>
                  <span className="ml-auto text-[11px] text-slate-500">
                    momentum <span className="font-mono text-slate-300">{t.momentum}</span>
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <Empty text="Multi-timeframe analysis is not available for this instrument yet." />
          )}
        </Card>
      </div>
    </div>
  );
}
