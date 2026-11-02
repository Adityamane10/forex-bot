import { useEffect, useRef } from 'react';
import {
  createChart, ColorType, IChartApi, ISeriesApi, CandlestickData, LineData, UTCTimestamp, LineStyle, IPriceLine,
  SeriesMarker, Time,
} from 'lightweight-charts';
import { Candle, Signal, getAsset } from '@fx/shared';

/**
 * Chart palette — the same tokens as the rest of the app, restated as hex
 * because lightweight-charts draws to canvas and cannot read Tailwind classes.
 * Keep these in step with `tailwind.config.js` / the `:root` vars in index.css.
 */
const PANEL = '#111110';
const BORDER = '#262521';
const ASH = '#96938A';
const BONE = '#D5D1C4';
const GAIN = '#34D6A0';
const LOSS = '#FF6B5E';
const CAUTION = '#F7B23F';
/** Structural reference levels sit a step deeper than the signal's own lines,
 *  so the trade plan reads in front of the map. */
const GAIN_DEEP = '#14BE87';
const LOSS_DEEP = '#F2453B';

interface Props {
  candles: Candle[];
  symbol: string;
  signal?: Signal | null;
  levels?: { support: number[]; resistance: number[] };
  /** Live price for the current symbol — updates the in-progress bar and the
   * live price line on every tick. */
  tick?: { mid: number } | null;
  /** MT5 broker server time offset (ms). Shifts displayed times so the chart
   * matches the MT5 terminal (server time) instead of UTC. 0 = plain UTC. */
  timeOffsetMs?: number;
  /** Indicator overlays (EMA/SMA …) drawn as lines over the price series.
   * Points are { time: epochSeconds, value } on the SAME clock as openTime. */
  overlays?: Array<{ name: string; color: string; points: Array<{ time: number; value: number }> }>;
}

export function CandleChart({ candles, symbol, signal, levels, tick, timeOffsetMs = 0, overlays }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeries = useRef<ISeriesApi<'Candlestick'> | null>(null);
  /** Live market price — a one-point line whose label sits on the right axis. */
  const livePriceSeries = useRef<ISeriesApi<'Line'> | null>(null);
  const priceLines = useRef<IPriceLine[]>([]);
  /** Indicator overlay lines, keyed by name so a prop change updates in place. */
  const overlaySeries = useRef<Map<string, ISeriesApi<'Line'>>>(new Map());
  /** Key of the last data actually applied to the chart (first|last|len|lastClose). */
  const dataKey = useRef<string | null>(null);
  /** First bar time of the current series — a change means a brand-new series. */
  const firstTime = useRef<number | null>(null);
  /** Last time written to the live-price line (for monotonic update()). */
  const lastLivePriceTime = useRef<number | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const chart = createChart(el, {
      width: el.clientWidth || 640,
      height: 380,
      layout: {
        background: { type: ColorType.Solid, color: PANEL },
        textColor: ASH,
        fontFamily: "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 10,
      },
      // Grid is a faint ruling, not a cage: horizontals help price comparison,
      // verticals stay almost invisible so the candles carry the picture.
      grid: { vertLines: { color: '#191815' }, horzLines: { color: '#1F1E1A' } },
      timeScale: { timeVisible: true, secondsVisible: false, borderColor: BORDER, rightOffset: 4 },
      rightPriceScale: { borderColor: BORDER, scaleMargins: { top: 0.1, bottom: 0.14 } },
      crosshair: {
        mode: 0,
        vertLine: { color: 'rgba(213,209,196,0.34)', width: 1, style: LineStyle.Dotted, labelBackgroundColor: '#26251F' },
        horzLine: { color: 'rgba(213,209,196,0.34)', width: 1, style: LineStyle.Dotted, labelBackgroundColor: '#26251F' },
      },
      // Etched instrument label rather than a logo stamp.
      watermark: {
        visible: true,
        text: symbol,
        color: 'rgba(213,209,196,0.05)',
        fontSize: 34,
        fontFamily: "'IBM Plex Mono', ui-monospace, monospace",
        horzAlign: 'left',
        vertAlign: 'top',
      },
    });
    let precision = 2;
    let minMove = 0.01;
    try { const a = getAsset(symbol); precision = a.pricePrecision; minMove = a.pointSize; } catch { /* unknown symbol */ }
    const cs = chart.addCandlestickSeries({ upColor: GAIN, downColor: LOSS, borderVisible: false, wickUpColor: GAIN, wickDownColor: LOSS, priceLineVisible: true, priceFormat: { type: 'price', precision, minMove } });
    // Live market price: amber one-point line, its label always visible on the
    // right price axis and moving with every real tick.
    const lps = chart.addLineSeries({ color: CAUTION, lineWidth: 1, priceLineVisible: true, lastValueVisible: true, crosshairMarkerVisible: false });
    candleSeries.current = cs;
    livePriceSeries.current = lps;
    chartRef.current = chart;

    // Follow the container width so the chart stays sharp when the sidebar,
    // window or panel layout changes.
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 0) chart.applyOptions({ width: Math.floor(w) });
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      // Every ref must be reset, not just the chart: React StrictMode tears the
      // effect down and re-runs it on the same instance, and a surviving dataKey
      // would make the data effect skip setData() on the new chart — a blank
      // chart on first load in development.
      candleSeries.current = null;
      livePriceSeries.current = null;
      overlaySeries.current.clear();
      priceLines.current = [];
      dataKey.current = null;
      firstTime.current = null;
      lastLivePriceTime.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the etched label in step with the selected symbol.
  useEffect(() => {
    chartRef.current?.applyOptions({ watermark: { text: symbol } });
  }, [symbol]);

  useEffect(() => {
    const chart = chartRef.current;
    const cs = candleSeries.current;
    if (!chart || !cs) return;

    // lightweight-charts requires strictly ascending unique timestamps.
    // Sort + dedupe by openTime (keep the last, i.e. the live bar) to
    // survive any feed quirk.
    const seen = new Set<number>();
    const data: CandlestickData[] = [];
    for (const c of [...candles].sort((a, b) => a.openTime - b.openTime)) {
      // Constant offset keeps the series strictly ascending and shows the axis
      // in MT5 server time when the offset is known.
      const t = (c.openTime + timeOffsetMs) / 1000;
      if (seen.has(t)) continue;
      seen.add(t);
      data.push({ time: t as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close });
    }
    const last = data[data.length - 1];
    const key = last ? `${data[0].time}|${last.time}|${data.length}|${last.close}` : 'empty';
    const freshSeries = firstTime.current === null || (data.length > 0 && data[0].time !== firstTime.current);

    // Preserve the user's zoom/pan: only replace the series when the data
    // actually changed, and only auto-fit on a brand-new series (first load or
    // symbol/timeframe switch). Updates to the live bar keep the view stable.
    if (dataKey.current !== key) {
      dataKey.current = key;
      firstTime.current = data.length > 0 ? (data[0].time as number) : null;
      cs.setData(data);
      if (freshSeries && data.length > 0) chart.timeScale().fitContent();
    }

    // Levels and signal levels are horizontal price lines, not time-series
    // points — this keeps every level visible at once and avoids the
    // duplicate-timestamp assertion (setData rejects repeated times).
    for (const pl of priceLines.current) cs.removePriceLine(pl);
    priceLines.current = [];
    const addLine = (price: number, color: string, title: string) => {
      if (!Number.isFinite(price) || price <= 0) return;
      priceLines.current.push(cs.createPriceLine({ price, color, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title }));
    };
    if (levels) {
      levels.support.forEach((s, i) => addLine(s, GAIN_DEEP, `S${i + 1}`));
      levels.resistance.forEach((r, i) => addLine(r, LOSS_DEEP, `R${i + 1}`));
    }
    if (signal && signal.state !== 'INVALIDATED' && signal.state !== 'MISSED') {
      // Entry is bone, not amber: amber already means "live price" on this
      // chart, and two amber lines would be read as the same thing.
      addLine(signal.entry.preferredEntry, BONE, 'ENTRY');
      addLine(signal.stopLoss.price, LOSS, 'SL');
      addLine(signal.takeProfit.tp1, GAIN, 'TP1');
      if (signal.takeProfit.tp2) addLine(signal.takeProfit.tp2, GAIN, 'TP2');
    }

    // BUY/SELL signal markers (spec §53) — placed at the signal's creation
    // timestamp so the chart shows where the opportunity was identified.
    // Stale markers disappear with the signal (invalidated/missed/expired).
    const markers: SeriesMarker<Time>[] = [];
    if (signal && signal.state !== 'INVALIDATED' && signal.state !== 'MISSED' && signal.state !== 'EXPIRED') {
      markers.push({
        time: ((signal.timestamp + timeOffsetMs) / 1000) as UTCTimestamp,
        position: signal.direction === 'BUY' ? 'belowBar' : 'aboveBar',
        color: signal.direction === 'BUY' ? GAIN : LOSS,
        shape: signal.direction === 'BUY' ? 'arrowUp' : 'arrowDown',
        text: signal.direction === 'BUY' ? 'BUY' : 'SELL',
      });
    }
    cs.setMarkers(markers);
  }, [candles, signal, levels, timeOffsetMs]);

  // Indicator overlays: one line series per named overlay, created on first
  // appearance and updated in place afterwards so switching instruments or
  // timeframes never leaves a stale line from the previous chart behind.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const map = overlaySeries.current;

    const wanted = new Map((overlays ?? []).map((o) => [o.name, o]));
    for (const [name, ser] of [...map]) {
      if (!wanted.has(name)) {
        chart.removeSeries(ser);
        map.delete(name);
      }
    }
    for (const [name, o] of wanted) {
      let ser = map.get(name);
      if (!ser) {
        ser = chart.addLineSeries({
          color: o.color,
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        });
        map.set(name, ser);
      }
      // Same clock as the candles (epochSeconds + display offset), deduped and
      // ascending — lightweight-charts asserts both.
      const seen = new Set<number>();
      const pts = o.points
        .filter((p) => Number.isFinite(p.value) && p.value > 0 && !seen.has(p.time) && seen.add(p.time))
        .sort((a, b) => a.time - b.time)
        .map((p) => ({ time: ((p.time * 1000 + timeOffsetMs) / 1000) as UTCTimestamp, value: p.value }));
      ser.setData(pts);
    }
  }, [overlays, timeOffsetMs]);

  // Live bar + live price line: move the in-progress candle and the right-axis
  // price label with every real tick so the chart flows with the market.
  useEffect(() => {
    const cs = candleSeries.current;
    const lps = livePriceSeries.current;
    if (!cs || !lps || !tick || !Number.isFinite(tick.mid)) return;
    const last = candles[candles.length - 1];
    if (!last) return;
    const t = ((last.openTime + timeOffsetMs) / 1000) as UTCTimestamp;
    cs.update({
      time: t,
      open: last.open,
      high: Math.max(last.high, tick.mid),
      low: Math.min(last.low, tick.mid),
      close: tick.mid,
    });
    // update() requires monotonic time; after a symbol/timeframe switch the new
    // series starts older, so fall back to setData() (one point — cheap).
    const pt: LineData = { time: t, value: tick.mid };
    if (lastLivePriceTime.current === null || t >= lastLivePriceTime.current) {
      lps.update(pt);
    } else {
      lps.setData([pt]);
    }
    lastLivePriceTime.current = t;
  }, [tick, candles, timeOffsetMs]);

  return <div ref={ref} className="w-full overflow-hidden rounded-md" />;
}
