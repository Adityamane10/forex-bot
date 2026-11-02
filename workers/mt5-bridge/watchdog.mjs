/**
 * MT5 tick-bridge watchdog.
 *
 * The bridge is the forex realtime feed, but it is a plain python process with
 * no supervisor — twice now it died (backend restart storm / external kill) and
 * charts silently degraded to slow polling until someone noticed. This watcher
 * probes every 15s for a live `bridge.py` process and relaunches start.ps1
 * (detached) when it is gone, so the feed self-heals.
 *
 * Run standalone:   node workers/mt5-bridge/watchdog.mjs
 * Or via dev:all:   npm run dev:all   (starts the watchdog instead of one-shot)
 * Opt out:          MT5_BRIDGE=0 npm run dev:all
 */
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');
const ps1 = path.join(root, 'workers', 'mt5-bridge', 'start.ps1');
const envFile = path.join(root, 'backend', '.env');
const CHECK_MS = 15_000;
/** After spawning, give start.ps1 time to launch terminal+python before the
 *  next probe — otherwise the 12s terminal wait looks like "bridge missing"
 *  and we stack duplicate launchers. Reduced from 120s so charts recover fast after backend restarts. */
const SPAWN_COOLDOWN_MS = 30_000;
const BACKEND_URL = process.env.BACKEND_URL || 'http://127.0.0.1:4000';

if (process.platform !== 'win32') {
  console.error('[MT5-watchdog] Windows only (MetaTrader 5 host) — exiting.');
  process.exit(1);
}
if (!fs.existsSync(ps1)) {
  console.error(`[MT5-watchdog] launcher missing: ${ps1}`);
  process.exit(1);
}
if (!fs.existsSync(envFile)) {
  console.error('[MT5-watchdog] backend/.env not found — INTERNAL_API_TOKEN unavailable.');
  process.exit(1);
}

const tag = '\x1b[33m[MT5-watchdog]\x1b[0m';

/** true/false when the probe answers; null when the probe itself failed
 *  (treat as "unknown" and skip the cycle rather than risk a double start). */
function bridgeProbe() {
  try {
    const out = execSync(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'python.exe' -or $_.Name -eq 'py.exe' } | Where-Object { $_.CommandLine -like '*bridge.py*' } | Measure-Object | Select-Object -ExpandProperty Count"`,
      { stdio: 'pipe', encoding: 'utf8', timeout: 20_000 },
    );
    return Number(out.trim()) > 0;
  } catch {
    return null;
  }
}

function backendHealthy() {
  // Direct fetch — shelling out to PowerShell costs 1–3 s of interpreter
  // startup against this function's own 4 s budget, so a perfectly healthy
  // backend read as "not healthy" whenever the first attempt raced the clock.
  return fetch(`${BACKEND_URL}/health`, { signal: AbortSignal.timeout(5000) })
    .then((r) => r.ok)
    .catch(() => false);
}

let lastSpawnAt = 0;
const watchdogLog = path.join(root, 'mt5-watchdog.log');
// The launcher's OWN output (interpreter probe, python errors) — previously
// thrown away with the hidden window, so a dead worker died invisibly.
const launchOut = path.join(root, 'mt5-bridge-launch.out.log');
const launchErr = path.join(root, 'mt5-bridge-launch.err.log');

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
    const running = bridgeProbe();
    if (running === null) { log('probe failed (null) — skip'); return; }
    if (running) { /* log every 60s to avoid spam */ if (Date.now() % 60000 < CHECK_MS) log('bridge running'); return; }
    if (Date.now() - lastSpawnAt < SPAWN_COOLDOWN_MS) { log(`bridge not running but cooldown ${Math.ceil((SPAWN_COOLDOWN_MS - (Date.now()-lastSpawnAt))/1000)}s — skip`); return; }
    if (!(await backendHealthy())) {
      log('bridge not running but backend not healthy — retry next cycle');
      return;
    }
    lastSpawnAt = Date.now();
    log('bridge not running — starting via Start-Process');
    try {
      // Use Start-Process like the manual test that succeeded — spawn() with detached+ignore was unreliable.
      // stdout/stderr are CAPTURED so a worker that dies instantly says why
      // (read mt5-bridge-launch.out.log / .err.log) instead of vanishing.
      execSync(`powershell -NoProfile -Command "Start-Process -FilePath 'powershell' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${ps1.replace(/'/g, "''")}' -WindowStyle Hidden -RedirectStandardOutput '${launchOut}' -RedirectStandardError '${launchErr}'"`, { stdio: 'ignore', timeout: 10000 });
      log('Start-Process launched start.ps1 (output → mt5-bridge-launch.out.log)');
    } catch (err) {
      log(`launch failed: ${err.message}`);
    }
  } finally {
    ticking = false;
  }
}

console.log(`${tag} watching for bridge.py every ${CHECK_MS / 1000}s`);
tick();
setInterval(tick, CHECK_MS);
tick(); // first check without waiting for the first interval
