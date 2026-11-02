/**
 * Real-time benchmark on REAL market data.
 *
 * Boots the full backend pipeline with a real provider (YAHOO by default —
 * no key), then measures:
 *
 *   1. DATA FRESHNESS  — age of every real price at arrival (now − quote time)
 *   2. TICK CADENCE    — gap between consecutive real quotes per symbol
 *   3. SIGNAL PIPELINE — full analyzeSymbol() duration on real data
 *                        (candles → indicators → MTF → features → ML → risk)
 *
 * Usage:
 *   npm run bench:realtime            (YAHOO, real data, no key)
 *   BENCH_MS=60000 npm run bench:realtime
 *   MARKET_DATA_PROVIDER=FINNHUB FINNHUB_API_KEY=... npm run bench:realtime
 *
 * The numbers are honest: freshness is the exchange feed's age (network +
 * provider polling), pipeline time is this code's real cost.
 */
import { Container } from '../core/container';
import { CHANNELS } from '../core/context';

const DURATION_MS = Number(process.env.BENCH_MS ?? 30_000);

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

async function main(): Promise<void> {
  const container = new Container();
  await container.init();

  const tickAges: number[] = [];
  const tickGaps: number[] = [];
  const lastTickBySymbol = new Map<string, number>();
  const t0 = Date.now();

  container.ctx.events.on(CHANNELS.tick, (tick: { symbol: string; timestamp: number }) => {
    tickAges.push(Date.now() - tick.timestamp);
    const prev = lastTickBySymbol.get(tick.symbol);
    if (prev) tickGaps.push(tick.timestamp - prev);
    lastTickBySymbol.set(tick.symbol, tick.timestamp);
  });

  await container.start();
  const provider = container.ctx.providers.marketData;
  console.log(`\n[bench] provider=${provider.name} streaming=${provider.streaming} mode=${provider.mode} budget=${provider.pollBudgetPerMinute ?? 'n/a'}/min`);

  // Warm up to steady state: wait until every symbol has delivered a fresh tick
  // and the polling bucket has recovered from the startup history preload.
  const warmupDeadline = Date.now() + 180_000;
  let warm = false;
  while (Date.now() < warmupDeadline) {
    const h = container.marketData.health();
    const symbols = await provider.getSymbols();
    const allFresh = symbols.every((s) => container.marketData.getLatest(s) !== undefined);
    if (h.ok && allFresh) { warm = true; break; }
    await new Promise((r) => setTimeout(r, 5_000));
  }
  console.log(`[bench] warm-up ${warm ? 'complete' : 'TIMED OUT (provider down?)'} — collecting real ticks for ${DURATION_MS / 1000}s...\n`);

  await new Promise((r) => setTimeout(r, DURATION_MS));

  const symbols = await provider.getSymbols();
  const sigTimes: { symbol: string; ms: number; decision: string }[] = [];
  for (const s of symbols) {
    const s0 = performance.now();
    const res = await container.signals.analyzeSymbol(s);
    sigTimes.push({ symbol: s, ms: performance.now() - s0, decision: res.decision });
    console.log(`  ${s.padEnd(7)} ${res.decision.padEnd(22)} ${(performance.now() - s0).toFixed(0).padStart(4)}ms  ${res.reason.slice(0, 70)}`);
  }

  const ages = [...tickAges].sort((a, b) => a - b);
  const gaps = [...tickGaps].sort((a, b) => a - b);
  const st = sigTimes.map((x) => x.ms).sort((a, b) => a - b);
  const health = await provider.health();

  console.log(`\n=== REAL-TIME BENCHMARK (real data, ${provider.name}) — ${DURATION_MS / 1000}s window ===`);
  console.log(`ticks received      : ${tickAges.length} (${(tickAges.length / (DURATION_MS / 1000)).toFixed(1)}/s) across ${symbols.length} symbols`);
  console.log(`data freshness (age): p50 ${(pct(ages, 50) / 1000).toFixed(1)}s | p95 ${(pct(ages, 95) / 1000).toFixed(1)}s | max ${(pct(ages, 100) / 1000).toFixed(1)}s`);
  console.log(`tick cadence        : p50 ${(pct(gaps, 50) / 1000).toFixed(1)}s | p95 ${(pct(gaps, 95) / 1000).toFixed(1)}s`);
  console.log(`signal pipeline (ms): p50 ${pct(st, 50).toFixed(0)} | p95 ${pct(st, 95).toFixed(0)} | max ${pct(st, 100).toFixed(0)}`);
  console.log(`provider health     : ${health.ok ? 'OK' : 'DOWN'} — ${health.detail}`);
  console.log(`elapsed             : ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  await container.stop();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
