/**
 * Start everything with a single command: npm run dev:all
 *
 * Before starting, kills any process occupying ports 4000, 8500 or 5173
 * so stale processes from a previous run never cause EADDRINUSE crashes.
 *
 * Starts in parallel:
 *   1. Shared       (tsc watch — rebuilds @fx/shared on edit, backend restarts on it)
 *   2. Backend      (tsx watch — port 4000)
 *   3. AI Engine    (uvicorn  — port 8500)
 *   4. Frontend     (vite     — port 5173)
 *   5. MT5 bridge   (tick stream into :4000 — skipped when already running,
 *                    opt out with MT5_BRIDGE=0)
 *   6. MT5 trader   (executes mirrored paper trades on the local MT5 demo
 *                    account — every dashboard OPEN/CLOSE actually hits MT5.
 *                    Skipped with MT5_TRADER=0. Watchdog is also launched so
 *                    a dead trader.py auto-respawns, same model as the bridge.)
 *
 *   0. MT5 terminal   (the MetaTrader 5 application itself — located
 *                    automatically, launched detached, and given time to log in
 *                    before the bridge/trader attach. Already-running terminals
 *                    are left alone. `node scripts/mt5-locate.mjs` shows what
 *                    it found and where.)
 *
 * Optional env vars:
 *   MT5_PATH      — explicit path to terminal64.exe (overrides auto-discovery)
 *   MT5_LAUNCH    — set 0 to not launch the terminal at all
 *   MT5_WAIT_MS   — settle time after the terminal process appears (default 5000)
 *   AI_PORT       — override AI engine port (default 8500)
 *   PORT          — override backend port (default 4000)
 *   MT5_BRIDGE    — set 0 to skip the MT5 tick-bridge worker
 *   MT5_TRADER    — set 0 to skip the MT5 demo trader worker (trader.py)
 */

import { spawn, execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { launchMt5Terminal } from './mt5-locate.mjs';

const root      = path.resolve(import.meta.dirname, '..');
const isWindows = os.platform() === 'win32';

const C = {
  reset: '\x1b[0m', cyan: '\x1b[36m', green: '\x1b[32m',
  yellow: '\x1b[33m', red: '\x1b[31m', blue: '\x1b[34m', magenta: '\x1b[35m',
};
const tag = (name, color) => `${color}[${name}]${C.reset}`;

// Load .env before anything reads configuration, so the ports and terminal
// settings below, the child processes and the worker launchers all agree.
// Real environment variables always win over the files.
loadEnvFiles(['.env', 'backend/.env']);

// ── Free a port (kill whatever is using it) ──────────────────────────────────
function freePort(port) {
  if (!/^\d+$/.test(String(port)) || Number(port) < 1 || Number(port) > 65535) return;
  try {
    if (isWindows) {
      // Match both 0.0.0.0:4000 and [::]:4000 LISTENING lines
      const out = execSync(`netstat -ano | findstr "LISTENING" | findstr ":${port} "`,
        { stdio: 'pipe', encoding: 'utf8' });
      const pids = new Set(
        out.split('\n')
          .map(l => l.trim().split(/\s+/).pop())
          .filter(p => p && /^\d+$/.test(p) && p !== '0')
      );
      for (const pid of pids) {
        try {
          execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
          console.log(`${tag('cleanup', C.yellow)} killed PID ${pid} on port ${port}`);
        } catch { /* already gone */ }
      }
    } else {
      spawnSync('fuser', ['-k', `${port}/tcp`], { stdio: 'ignore' });
    }
  } catch { /* port was free */ }
}

// ── Sweep orphaned MT5 workers from previous runs ───────────────────────────
// A closed console does not kill its DETACHED python workers. Left behind, they
// keep pushing ticks/heartbeats to a dead backend and any new stack starts
// alongside 4 bridges + 6 traders (observed live) — duplicated feeds, racing
// executors, flapping ports. Kill them before anything new is started.
function killOrphanedMt5Workers() {
  if (!isWindows) return;
  try {
    const out = execSync(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='python.exe' OR Name='py.exe'\" | Where-Object { $_.CommandLine -like '*mt5-bridge*bridge.py*' -or $_.CommandLine -like '*mt5-trader*trader.py*' } | ForEach-Object { $_.ProcessId }"`,
      { stdio: 'pipe', encoding: 'utf8', timeout: 20_000 },
    );
    const pids = out.split(/\r?\n/).map(s => s.trim()).filter(p => /^\d+$/.test(p));
    if (pids.length === 0) return;
    console.log(`${tag('cleanup', C.yellow)} sweeping ${pids.length} orphaned MT5 worker(s) from a previous run…`);
    for (const pid of pids) {
      try { execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' }); } catch { /* already gone */ }
    }
  } catch { /* query failed — the single-instance guards below still protect us */ }
}
killOrphanedMt5Workers();

function isPortListening(port) {
  if (!isWindows) return false;
  try {
    const out = execSync(`netstat -ano | findstr "LISTENING" | findstr ":${port} "`, { stdio: 'pipe', encoding: 'utf8' });
    return out.trim().length > 0;
  } catch { return false; }
}

async function waitForPortFree(port, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isPortListening(port)) return true;
    await new Promise(r => setTimeout(r, 300));
  }
  return !isPortListening(port);
}

async function waitForBackendHealth(port, timeoutMs = 60000) {
  const url = `http://127.0.0.1:${port}/health`;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      // Use fetch via node http - execSync curl alternative with powershell
      execSync(`powershell -NoProfile -Command "Invoke-WebRequest -UseBasicParsing -Uri ${url} -TimeoutSec 2 | Out-Null"`, { stdio: 'ignore', timeout: 4000 });
      return true;
    } catch { /* not ready */ }
    await new Promise(r => setTimeout(r, 800));
  }
  return false;
}

// ── MT5 terminal ─────────────────────────────────────────────────────────────
// The platform's own promise is that every dashboard OPEN/CLOSE reaches the
// broker account. That needs the MetaTrader terminal RUNNING and LOGGED IN, so
// it starts here with everything else instead of being a step the operator has
// to remember (a locally-launched terminal is the one thing that silently turns
// "MT5 connected" into "commands queued forever").
//
// `scripts/mt5-locate.mjs` finds the install (MT5_PATH → remembered path →
// the terminal's own origin.txt records → program folders → registry → Start
// Menu), so a normal install needs no configuration at all.
async function startMt5Terminal() {
  const res = await launchMt5Terminal({
    root,
    log: (m) => console.log(`${tag('MT5', C.cyan)} ${m}`),
  });

  if (res.reason === 'already running') {
    console.log(`${tag('MT5', C.green)} terminal already running — bridge and trader will attach to it`);
    return { launched: false, waitMs: 0 };
  }
  if (!res.launched) {
    console.log(`${tag('MT5', C.yellow)} terminal not launched — ${res.reason}`);
    if (res.reason === 'not found') {
      console.log(`${tag('MT5', C.yellow)} ${res.source}`);
      console.log(`${tag('MT5', C.yellow)} set MT5_PATH="C:\\path\\to\\terminal64.exe" (or MT5_LAUNCH=0 to silence this) and re-run; until then the binding stays unverified and orders queue`);
    }
    return { launched: false, waitMs: 0 };
  }

  if (res.reason) {
    console.log(`${tag('MT5', C.red)} ${res.reason} — starting the rest anyway (the workers retry)`);
    return { launched: true, waitMs: 0 };
  }
  // Let the terminal finish loading (and auto-login) so the first MT5 call from
  // the bridge/trader does not fail and land them in a retry cooldown.
  const settle = Number(process.env.MT5_WAIT_MS ?? 5000);
  return { launched: true, waitMs: Number.isFinite(settle) && settle > 0 ? settle : 0 };
}

// ── Process launcher ─────────────────────────────────────────────────────────
function startProcess(name, color, cmd, args, cwd, extraEnv = {}) {
  const label = tag(name, color);
  const needsShell = isWindows && (cmd === 'npm' || cmd === 'npx' || cmd.endsWith('.cmd'));
  const proc = spawn(cmd, args, {
    shell: needsShell, stdio: 'pipe', cwd,
    env: { ...process.env, ...extraEnv },
  });
  proc.stdout?.on('data', d => {
    for (const l of d.toString().trimEnd().split('\n'))
      if (l.trim()) process.stdout.write(`${label} ${l}\n`);
  });
  proc.stderr?.on('data', d => {
    for (const l of d.toString().trimEnd().split('\n'))
      if (l.trim()) process.stderr.write(`${label} ${l}\n`);
  });
  proc.on('close', code => { if (code && code !== 0) console.error(`${label} exited ${code}`); });
  proc.on('error', err  => console.error(`${label} error: ${err.message}`));
  return proc;
}

// ── .env loading (for the terminal settings above) ──────────────────────────
// The worker launchers read backend/.env themselves; this only makes the MT5
// terminal settings (MT5_PATH / MT5_LAUNCH / MT5_WAIT_MS) settable the same way
// instead of requiring them on the command line. Real environment variables
// always win, and a missing/malformed file is simply ignored.
function loadEnvFiles(files) {
  for (const rel of files) {
    let text;
    try {
      text = fs.readFileSync(path.join(root, rel), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      const key = m[1];
      let value = m[2].trim();
      if (/^(".*"|'.*')$/.test(value)) value = value.slice(1, -1);
      else value = value.replace(/\s+#.*$/, '').trim();
      if (process.env[key] === undefined && value !== '') process.env[key] = value;
    }
  }
}

// ── Python interpreter ───────────────────────────────────────────────────────
function aiPython() {
  const w = path.join(root, 'ai-engine', 'venv', 'Scripts', 'python.exe');
  const u = path.join(root, 'ai-engine', 'venv', 'bin', 'python');
  if (isWindows && fs.existsSync(w)) return w;
  if (!isWindows && fs.existsSync(u)) return u;
  return isWindows ? 'python' : 'python3';
}

// ── Main ─────────────────────────────────────────────────────────────────────
// `PORT=0` (or anything non-numeric) means "unset" — same rule the backend
// applies in backend/src/config.ts. Reading it as a real port made
// waitForBackendHealth() poll http://127.0.0.1:0, so the MT5 bridge and trader
// never got the green light to start.
function portEnv(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
const BACKEND_PORT  = portEnv('PORT', 4000);
const AI_PORT       = portEnv('AI_PORT', 8500);
const FRONTEND_PORT = 5173;

console.log('\n🧹 Freeing ports before start…');
freePort(BACKEND_PORT);
freePort(AI_PORT);
freePort(FRONTEND_PORT);

// Wait until ports are actually free — taskkill is async, 600ms was too short and left EADDRINUSE
for (const p of [BACKEND_PORT, AI_PORT, FRONTEND_PORT]) {
  const freed = await waitForPortFree(p, 8000);
  if (!freed) console.log(`${tag('cleanup', C.yellow)} port ${p} still LISTENING after 8s — will retry on start`);
}
await new Promise(r => setTimeout(r, 800));

// Build @fx/shared BEFORE anything else imports it.
//
// The backend resolves the workspace package to its compiled dist/, and several
// India-market modules import exports that only exist after a build. A stale
// dist turns those imports into runtime TypeErrors that silently empty every
// candle fetch; a missing dist crashes the boot outright. The watcher below
// keeps it fresh from here, but the first build has to exist before the
// backend's first import — hence synchronous, once, up front.
console.log('📦 Building @fx/shared…');
try {
  execSync('npm run build:shared', { cwd: root, stdio: 'inherit' });
} catch (err) {
  console.error(`${tag('shared', C.red)} build failed — continuing, but India market data may not load`);
}

const mt5 = await startMt5Terminal();
const mt5Wait = mt5.waitMs;
if (mt5Wait > 0) console.log(`${tag('MT5', C.yellow)} waiting ${mt5Wait}ms for the terminal to finish loading…`);

setTimeout(() => {
  console.log('\n▶  Starting all services…\n');

  startProcess(
    'shared', C.green,
    'npm', ['run', 'dev:shared'],
    root
  );

  startProcess(
    'backend', C.blue,
    'npm', ['run', 'dev', '--workspace', 'backend'],
    root,
    { STORE_FILE: path.join(root, '.data', 'store.json') }
  );

  startProcess(
    'ai-engine', C.magenta,
    aiPython(),
    ['-m', 'uvicorn', 'app.main:app', '--reload', `--port=${AI_PORT}`],
    path.join(root, 'ai-engine')
  );

  startProcess(
    'frontend', C.cyan,
    'npm', ['run', 'dev', '--workspace', 'frontend'],
    root
  );

  // ── MT5 tick bridge ────────────────────────────────────────────────────────
  // The bridge is the forex realtime feed: it pushes MT5 ticks into the
  // backend's internal endpoint. Charts were empty because the old logic
  // only spawned the watchdog detached (no preload wait) and the 600ms
  // port-free wait left EADDRINUSE -> backend dead -> bridge gets
  // connection refused and never recovers until watchdog's 120s cooldown.
  // New: wait for backend health, then launch bridge directly + watchdog.
  if (process.env.MT5_BRIDGE !== '0') {
    const backendEnv = path.join(root, 'backend', '.env');
    if (!fs.existsSync(backendEnv)) {
      console.log(`${tag('MT5-bridge', C.yellow)} skipped — backend/.env (INTERNAL_API_TOKEN) missing`);
    } else if (!isWindows) {
      console.log(`${tag('MT5-bridge', C.yellow)} skipped — requires Windows (start workers/mt5-bridge/start.ps1 manually)`);
    } else {
      const alreadyRunning = (() => {
        try {
          const out = execSync(
            `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'python.exe' -or $_.Name -eq 'py.exe' } | Where-Object { $_.CommandLine -like '*bridge.py*' } | Measure-Object | Select-Object -ExpandProperty Count"`,
            { stdio: 'pipe', encoding: 'utf8', timeout: 8000 },
          );
          return Number(out.trim()) > 0;
        } catch { return false; }
      })();
      if (alreadyRunning) {
        console.log(`${tag('MT5-bridge', C.green)} already running — watchdog will supervise`);
        startProcess('MT5-watchdog', C.yellow, 'node', [path.join(root, 'workers', 'mt5-bridge', 'watchdog.mjs')], root);
      } else {
        // Wait for backend to be healthy before preloading — otherwise bridge.py
        // preload blocks forever (retries=-1) or streaming drops ticks with 10061.
        (async () => {
          console.log(`${tag('MT5-bridge', C.yellow)} waiting for backend http://127.0.0.1:${BACKEND_PORT}/health ...`);
          const ok = await waitForBackendHealth(BACKEND_PORT, 65000);
          if (!ok) {
            console.log(`${tag('MT5-bridge', C.red)} backend not healthy after 65s — starting watchdog anyway (bridge will retry)`);
          } else {
            console.log(`${tag('MT5-bridge', C.green)} backend healthy — launching MT5 bridge`);
          }
          // Start watchdog first (it will launch start.ps1 if needed)
          startProcess('MT5-watchdog', C.yellow, 'node', [path.join(root, 'workers', 'mt5-bridge', 'watchdog.mjs')], root);
          // Also launch bridge immediately (don't wait 15s for watchdog poll) — watchdog will dedupe via cooldown
          await new Promise(r => setTimeout(r, 1500));
          try {
            const stillRunning = (() => {
              try {
                const o = execSync(`powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'python.exe' -or $_.Name -eq 'py.exe' } | Where-Object { $_.CommandLine -like '*bridge.py*' } | Measure-Object | Select-Object -ExpandProperty Count"`, { stdio: 'pipe', encoding: 'utf8', timeout: 8000 });
                return Number(o.trim()) > 0;
              } catch { return false; }
            })();
            if (!stillRunning) {
              console.log(`${tag('MT5-bridge', C.cyan)} launching start.ps1 directly for instant ticks`);
              const ps1 = path.join(root, 'workers', 'mt5-bridge', 'start.ps1');
              // detached launch with log to mt5-bridge.log
              const child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], { detached: true, stdio: 'ignore' });
              child.unref();
            }
          } catch (e) {
            console.error(`${tag('MT5-bridge', C.red)} direct launch failed: ${e.message}`);
          }
        })();
      }
    }
  }

  // ── MT5 demo trader (ALWAYS-ON demo execution) ────────────────────────────
  // Mirrors the bridge block above. Without this worker running, the
  // Mt5MirrorService queues every OPEN/CLOSE into MongoDB but nothing
  // ever executes them — the dashboard's "MT5 demo connected" promise
  // silently breaks. The watchdog below auto-respawns trader.py if it
  // dies (terminal disconnect, manual kill, etc.).
  if (process.env.MT5_TRADER !== '0') {
    const backendEnv = path.join(root, 'backend', '.env');
    const traderPs1 = path.join(root, 'workers', 'mt5-trader', 'start.ps1');
    const traderWatchdog = path.join(root, 'workers', 'mt5-trader', 'watchdog.mjs');
    if (!fs.existsSync(backendEnv)) {
      console.log(`${tag('MT5-trader', C.yellow)} skipped — backend/.env (INTERNAL_API_TOKEN) missing`);
    } else if (!isWindows) {
      console.log(`${tag('MT5-trader', C.yellow)} skipped — requires Windows (start workers/mt5-trader/start.ps1 manually)`);
    } else if (!fs.existsSync(traderPs1)) {
      console.log(`${tag('MT5-trader', C.red)} launcher missing: ${traderPs1}`);
    } else {
      const alreadyRunning = (() => {
        try {
          const out = execSync(
            `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'python.exe' -or $_.Name -eq 'py.exe' } | Where-Object { $_.CommandLine -like '*trader.py*' } | Measure-Object | Select-Object -ExpandProperty Count"`,
            { stdio: 'pipe', encoding: 'utf8', timeout: 8000 },
          );
          return Number(out.trim()) > 0;
        } catch { return false; }
      })();
      if (alreadyRunning) {
        console.log(`${tag('MT5-trader', C.green)} already running — watchdog will supervise`);
        if (fs.existsSync(traderWatchdog)) {
          startProcess('MT5-trader-watchdog', C.yellow, 'node', [traderWatchdog], root);
        }
      } else {
        // Wait for backend health so the first /internal/mt5/commands poll
        // doesn't return 10061 and immediately mark the trader as broken.
        (async () => {
          console.log(`${tag('MT5-trader', C.yellow)} waiting for backend http://127.0.0.1:${BACKEND_PORT}/health ...`);
          const ok = await waitForBackendHealth(BACKEND_PORT, 65000);
          if (!ok) {
            console.log(`${tag('MT5-trader', C.red)} backend not healthy after 65s — starting trader anyway (it will retry)`);
          } else {
            console.log(`${tag('MT5-trader', C.green)} backend healthy — launching MT5 demo trader`);
          }
          if (fs.existsSync(traderWatchdog)) {
            startProcess('MT5-trader-watchdog', C.yellow, 'node', [traderWatchdog], root);
          }
          await new Promise(r => setTimeout(r, 1500));
          try {
            const stillRunning = (() => {
              try {
                const o = execSync(
                  `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'python.exe' -or $_.Name -eq 'py.exe' } | Where-Object { $_.CommandLine -like '*trader.py*' } | Measure-Object | Select-Object -ExpandProperty Count"`,
                  { stdio: 'pipe', encoding: 'utf8', timeout: 8000 },
                );
                return Number(o.trim()) > 0;
              } catch { return false; }
            })();
            if (!stillRunning) {
              console.log(`${tag('MT5-trader', C.cyan)} launching start.ps1 directly for instant demo execution`);
              const child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', traderPs1], { detached: true, stdio: 'ignore' });
              child.unref();
            }
          } catch (e) {
            console.error(`${tag('MT5-trader', C.red)} direct launch failed: ${e.message}`);
          }
        })();
      }
    }
  }

  console.log(`\n  Frontend  → http://localhost:${FRONTEND_PORT}`);
  console.log(`  Backend   → http://localhost:${BACKEND_PORT}`);
  console.log(`  AI Engine → http://localhost:${AI_PORT}`);
  console.log('\nCtrl+C to stop all.\n');

  process.on('SIGINT', () => { console.log('\nShutting down…'); process.exit(0); });
}, mt5Wait);
