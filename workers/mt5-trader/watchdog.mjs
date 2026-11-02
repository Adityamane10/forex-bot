/**
 * MT5 demo-trader watchdog.
 *
 * Mirrors workers/mt5-bridge/watchdog.mjs but supervises trader.py instead
 * of bridge.py. trader.py long-polls /internal/mt5/commands and executes
 * the mirrored OPEN/CLOSE commands on the local MetaTrader 5 demo account.
 * Without a running trader the Mt5MirrorService happily queues every paper
 * trade into MongoDB, the dashboard's "MT5 demo connected" badge lies, and
 * no demo orders ever reach the terminal — the dashboard paper ledger and
 * MT5's USD demo balance silently diverge.
 *
 * Behaviour:
 *   - Probes every 15s for a `python.exe` / `py.exe` whose CommandLine
 *     contains `trader.py` (matches `py -u trader.py` from start.ps1).
 *   - Skips cycles while the backend is unhealthy (mirrors bridge logic).
 *   - On a missing trader: respects a 30s spawn cooldown so back-to-back
 *     probes don't stack detached launchers, then spawns start.ps1 via
 *     `Start-Process ... -WindowStyle Hidden` (the same call proven on
 *     the bridge watchdog).
 *   - Logs to <repo>/mt5-trader-watchdog.log so you can see respawns.
 *
 * Run standalone:   node workers/mt5-trader/watchdog.mjs
 * Or via dev:all:   npm run dev:all   (auto-launched alongside the worker)
 * Opt out:          MT5_TRADER=0 npm run dev:all
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');
const ps1 = path.join(root, 'workers', 'mt5-trader', 'start.ps1');
const envFile = path.join(root, 'backend', '.env');
const CHECK_MS = 15_000;
/** After spawning, give start.ps1 time to attach to MT5 before the next
 *  probe — otherwise we stack duplicate launchers. Same value as the
 *  bridge watchdog (the two have the same attach-to-MT5 latency). */
const SPAWN_COOLDOWN_MS = 30_000;
const BACKEND_URL = process.env.BACKEND_URL || 'http://127.0.0.1:4000';

if (process.platform !== 'win32') {
  console.error('[MT5-trader-watchdog] Windows only (MetaTrader 5 host) — exiting.');
  process.exit(1);
}
if (!fs.existsSync(ps1)) {
  console.error(`[MT5-trader-watchdog] launcher missing: ${ps1}`);
  process.exit(1);
}
if (!fs.existsSync(envFile)) {
  console.error('[MT5-trader-watchdog] backend/.env not found — INTERNAL_API_TOKEN unavailable.');
  process.exit(1);
}

const tag = '\x1b[33m[MT5-trader-watchdog]\x1b[0m';

/** true/false when the probe answers; null when the probe itself failed
 *  (treat as "unknown" and skip the cycle rather than risk a double start). */
function traderProbe() {
  try {
    const out = execSync(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'python.exe' -or $_.Name -eq 'py.exe' } | Where-Object { $_.CommandLine -like '*trader.py*' } | Measure-Object | Select-Object -ExpandProperty Count"`,
      { stdio: 'pipe', encoding: 'utf8', timeout: 20_000 },
    );
    return Number(out.trim()) > 0;
  } catch {
    return null;
  }
}

/** Direct fetch, NOT a PowerShell shell-out: `powershell -Command` alone
 *  burns 1–3s of its own startup inside a 4s budget, so a perfectly healthy
 *  backend (3ms when warm, ~8s on the first post-save store write) read as
 *  "unhealthy" every cycle and the watchdog never launched the trader. */
async function backendHealthy() {
  try {
    const res = await fetch(`${BACKEND_URL}/health`, { signal: AbortSignal.timeout(5_000) });
    return res.ok;
  } catch { return false; }
}

let lastSpawnAt = 0;
const watchdogLog = path.join(root, 'mt5-trader-watchdog.log');
// The launcher's OWN output (interpreter probe, python errors) — previously
// thrown away with the hidden window, so a dead worker died invisibly.
const launchOut = path.join(root, 'mt5-trader-launch.out.log');
const launchErr = path.join(root, 'mt5-trader-launch.err.log');

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  console.log(`${tag} ${msg}`);
  try { fs.appendFileSync(watchdogLog, line); } catch {}
}

let ticking = false;
async function tick() {
  if (ticking) return; // an async cycle must never overlap itself
  ticking = true;
  try {
    const running = traderProbe();
    if (running === null) { log('probe failed (null) — skip'); return; }
    if (running) { /* log every 60s to avoid spam */ if (Date.now() % 60000 < CHECK_MS) log('trader running'); return; }
    if (Date.now() - lastSpawnAt < SPAWN_COOLDOWN_MS) {
      log(`trader not running but cooldown ${Math.ceil((SPAWN_COOLDOWN_MS - (Date.now() - lastSpawnAt)) / 1000)}s — skip`);
      return;
    }
    if (!(await backendHealthy())) {
      log('trader not running but backend not healthy — retry next cycle');
      return;
    }
    lastSpawnAt = Date.now();
    log('trader not running — starting via Start-Process');
    try {
      // Same proven invocation as the bridge watchdog: Start-Process with
      // -WindowStyle Hidden, but stdout/stderr CAPTURED so an instant death
      // is diagnosable (read mt5-trader-launch.out.log / .err.log).
      execSync(`powershell -NoProfile -Command "Start-Process -FilePath 'powershell' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${ps1.replace(/'/g, "''")}' -WindowStyle Hidden -RedirectStandardOutput '${launchOut}' -RedirectStandardError '${launchErr}'"`, { stdio: 'ignore', timeout: 10000 });
      log('Start-Process launched start.ps1 (output → mt5-trader-launch.out.log)');
    } catch (err) {
      log(`launch failed: ${err.message}`);
    }
  } finally {
    ticking = false;
  }
}

console.log(`${tag} watching for trader.py every ${CHECK_MS / 1000}s`);
setInterval(tick, CHECK_MS);
tick(); // first check without waiting for the first interval
