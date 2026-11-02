/**
 * Lightweight metrics registry with Prometheus text exposition.
 *
 * Zero dependencies, zero allocation on the hot path: counters/gauges live in
 * plain Maps, histograms are fixed-bucket cumulative arrays. Every trading
 * engine can record without awaiting anything — `observe`/`inc` are sync and
 * O(1), so the tick path can instrument itself freely.
 *
 * Exposed at GET /api/metrics (Prometheus scrape format).
 */
import { config } from '../config';

export type MetricLabels = Record<string, string | number | undefined>;

interface CounterEntry { help: string; values: Map<string, { labels: MetricLabels; v: number }> }
interface GaugeEntry { help: string; values: Map<string, { labels: MetricLabels; v: number }> }
interface HistEntry {
  help: string;
  buckets: number[];
  /** Cumulative counts per bucket boundary, plus +Inf. */
  series: Map<string, { labels: MetricLabels; counts: number[]; inf: number; sum: number; count: number }>
}

function labelKey(labels: MetricLabels): string {
  const parts = Object.keys(labels).sort().map((k) => `${k}=${labels[k]}`);
  return parts.length ? parts.join(',') : '';
}

function escapeLabel(v: string | number): string {
  return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function renderLabels(labels: MetricLabels, extra?: [string, string | number]): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(labels)) {
    if (v === undefined) continue;
    parts.push(`${k}="${escapeLabel(v)}"`);
  }
  if (extra) parts.push(`${extra[0]}="${escapeLabel(extra[1])}"`);
  return parts.length ? `{${parts.join(',')}}` : '';
}

class Registry {
  private counters = new Map<string, CounterEntry>();
  private gauges = new Map<string, GaugeEntry>();
  private hists = new Map<string, HistEntry>();

  counter(name: string, help: string): Counter {
    let c = this.counters.get(name);
    if (!c) { c = { help, values: new Map() }; this.counters.set(name, c); }
    return new Counter(name, c);
  }

  gauge(name: string, help: string): Gauge {
    let g = this.gauges.get(name);
    if (!g) { g = { help, values: new Map() }; this.gauges.set(name, g); }
    return new Gauge(name, g);
  }

  histogram(name: string, help: string, buckets: number[]): Histogram {
    let h = this.hists.get(name);
    if (!h) { h = { help, buckets: [...buckets].sort((a, b) => a - b), series: new Map() }; this.hists.set(name, h); }
    return new Histogram(name, h);
  }

  /** Prometheus text exposition (content-type text/plain; version=0.0.4). */
  render(): string {
    const out: string[] = [];
    for (const [name, entry] of this.counters) {
      out.push(`# HELP ${name} ${entry.help}`);
      out.push(`# TYPE ${name} counter`);
      if (entry.values.size === 0) out.push(`${name} 0`);
      for (const [, v] of entry.values) out.push(`${name}${renderLabels(v.labels)} ${v.v}`);
    }
    for (const [name, entry] of this.gauges) {
      out.push(`# HELP ${name} ${entry.help}`);
      out.push(`# TYPE ${name} gauge`);
      if (entry.values.size === 0) out.push(`${name} 0`);
      for (const [, v] of entry.values) out.push(`${name}${renderLabels(v.labels)} ${v.v}`);
    }
    for (const [name, entry] of this.hists) {
      out.push(`# HELP ${name} ${entry.help}`);
      out.push(`# TYPE ${name} histogram`);
      if (entry.series.size === 0) continue;
      for (const [, s] of entry.series) {
        let cumulative = 0;
        entry.buckets.forEach((b, i) => {
          cumulative = s.counts[i];
          out.push(`${name}_bucket${renderLabels(s.labels, ['le', String(b)])} ${cumulative}`);
        });
        out.push(`${name}_bucket${renderLabels(s.labels, ['le', '+Inf'])} ${s.inf}`);
        out.push(`${name}_sum${renderLabels(s.labels)} ${s.sum}`);
        out.push(`${name}_count${renderLabels(s.labels)} ${s.count}`);
      }
    }
    return out.join('\n') + '\n';
  }

  /** JSON snapshot (dashboard-friendly). */
  snapshot(): Record<string, unknown> {
    const snap: Record<string, unknown> = { counters: {}, gauges: {}, histograms: {} };
    const c: Record<string, unknown> = {};
    for (const [name, entry] of this.counters) for (const [k, v] of entry.values) c[`${name}{${k}}`] = v.v;
    const g: Record<string, unknown> = {};
    for (const [name, entry] of this.gauges) for (const [k, v] of entry.values) g[`${name}{${k}}`] = v.v;
    const h: Record<string, unknown> = {};
    for (const [name, entry] of this.hists) {
      for (const [k, s] of entry.series) {
        h[`${name}{${k}}`] = {
          count: s.count, sum: Number(s.sum.toFixed(4)),
          p50: percentile(entry.buckets, s.counts, s.inf, 0.5),
          p95: percentile(entry.buckets, s.counts, s.inf, 0.95),
          p99: percentile(entry.buckets, s.counts, s.inf, 0.99),
        };
      }
    }
    (snap.counters as Record<string, unknown>) = c;
    (snap.gauges as Record<string, unknown>) = g;
    (snap.histograms as Record<string, unknown>) = h;
    return snap;
  }
}

function percentile(buckets: number[], counts: number[], inf: number, q: number): number {
  const total = inf;
  if (total === 0) return 0;
  const target = total * q;
  let cumulative = 0;
  for (let i = 0; i < buckets.length; i++) {
    cumulative = counts[i];
    if (cumulative >= target) return buckets[i];
  }
  return Infinity;
}

class Counter {
  constructor(private name: string, private entry: CounterEntry) {}
  inc(labels: MetricLabels = {}, by = 1): void {
    const key = labelKey(labels);
    const cur = this.entry.values.get(key) ?? { labels, v: 0 };
    cur.v += by;
    this.entry.values.set(key, cur);
  }
}

class Gauge {
  constructor(private name: string, private entry: GaugeEntry) {}
  set(labels: MetricLabels, v: number): void {
    this.entry.values.set(labelKey(labels), { labels, v });
  }
}

class Histogram {
  constructor(private name: string, private entry: HistEntry) {}
  observe(labels: MetricLabels, v: number): void {
    const key = labelKey(labels);
    let s = this.entry.series.get(key);
    if (!s) { s = { labels, counts: new Array(this.entry.buckets.length).fill(0), inf: 0, sum: 0, count: 0 }; this.entry.series.set(key, s); }
    for (let i = 0; i < this.entry.buckets.length; i++) {
      if (v <= this.entry.buckets[i]) { s.counts[i]++; break; }
    }
    s.inf++;
    s.sum += v;
    s.count++;
  }
}

/** Latency buckets tuned for trading-pipeline stages (ms). */
export const LATENCY_BUCKETS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

/** Process-wide singleton — created lazily so tests can import it freely. */
let registry: Registry | null = null;
export function metrics(): Registry {
  if (!registry) registry = new Registry();
  return registry;
}

/** Standard instrument set for the trading pipeline. */
export const METRICS = {
  ticksReceived: () => metrics().counter('fx_ticks_received_total', 'Market ticks received'),
  ticksRejected: () => metrics().counter('fx_ticks_rejected_total', 'Market ticks rejected by validation'),
  analysisRuns: () => metrics().counter('fx_analysis_runs_total', 'Full signal-engine analyses', ),
  analysisFailures: () => metrics().counter('fx_analysis_failures_total', 'Analyses that failed mid-pipeline'),
  decisions: () => metrics().counter('fx_decisions_total', 'Decisions produced by the signal engine'),
  ordersQueued: () => metrics().counter('fx_mt5_orders_queued_total', 'MT5 mirror commands queued'),
  orderResults: () => metrics().counter('fx_mt5_order_results_total', 'MT5 order results by status'),
  reconciliationDiffs: () => metrics().counter('fx_reconciliation_diffs_total', 'Broker reconciliation divergences by kind'),
  alertsSent: () => metrics().counter('fx_alerts_sent_total', 'Alert deliveries by channel and status'),
  apiRequests: () => metrics().counter('fx_api_requests_total', 'API requests by route/method/status'),
  tickToDecision: () => metrics().histogram('fx_tick_to_decision_ms', 'Signal-engine full-analysis latency (ms)', LATENCY_BUCKETS),
  aiPredictLatency: () => metrics().histogram('fx_ai_predict_latency_ms', 'AI-engine predict call latency (ms)', LATENCY_BUCKETS),
  orderLatency: () => metrics().histogram('fx_order_latency_ms', 'Order dispatch→execution-result latency (ms)', LATENCY_BUCKETS),
  slippageBps: () => metrics().histogram('fx_slippage_bps', 'Realized slippage per fill (bps)', [0, 0.5, 1, 2, 3, 5, 8, 12, 20, 50]),
  openPositions: () => metrics().gauge('fx_open_positions', 'Open paper positions'),
  wsClients: () => metrics().gauge('fx_ws_clients', 'Connected WebSocket clients'),
  feedStalenessMs: () => metrics().gauge('fx_feed_staleness_ms', 'Per-symbol feed staleness (ms)'),
};

/** Whether the metrics HTTP surface is enabled (default on). */
export function metricsEnabled(): boolean {
  const v = process.env.METRICS_ENABLED;
  return v === undefined || v === '' ? true : v === 'true' || v === '1';
}

/** Prometheus content type header value. */
export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

// Keep `config` referenced so the import stays meaningful if the file evolves.
void config;
