/**
 * Locate the MetaTrader 5 terminal on this machine.
 *
 * WHY A SEPARATE MODULE
 * ---------------------
 * `npm run dev:all` has to bring the MT5 application up with the platform: the
 * bridge and the trader worker both attach to a RUNNING, LOGGED-IN terminal,
 * and a terminal the operator launches by hand is exactly the step that gets
 * forgotten (leaving the binding unverified and every order queued). Hardcoding
 * `C:\Program Files\MetaTrader 5\terminal64.exe` would only work for one
 * installer, and an XM-branded terminal lives somewhere else entirely.
 *
 * So this resolves the path the way a person would, cheapest evidence first:
 *
 *   1. `MT5_PATH`                    — explicit, always wins
 *   2. `.data/mt5-path.txt`          — what was resolved last time
 *   3. the terminal's own `origin.txt` records (one per instance under
 *      `%APPDATA%\MetaQuotes\Terminal\<hash>\`), most recently used first —
 *      this finds an install anywhere on disk, including an XM-branded one
 *   4. a scan of the usual program roots for MT5-looking directories
 *   5. the Windows uninstall registry (`InstallLocation`)
 *   6. Start-Menu shortcuts, by resolving their target
 *
 * Everything is read-only and best-effort: no candidate is an error, and on a
 * non-Windows host the whole thing reports "not found" rather than throwing.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Both MT5 executables: 64-bit first (what everyone installs now). */
export const MT5_EXE_NAMES = ['terminal64.exe', 'terminal.exe'];

const isWindows = os.platform() === 'win32';

function isFile(p) {
  try {
    return Boolean(p) && fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Directories an MT5 install could live in. */
function programRoots() {
  const e = process.env;
  return [...new Set([
    e.ProgramFiles,
    e['ProgramFiles(x86)'],
    e.ProgramW6432,
    e.LOCALAPPDATA ? path.join(e.LOCALAPPDATA, 'Programs') : null,
    e.APPDATA,
    e.SystemDrive ? `${e.SystemDrive}\\` : 'C:\\',
  ].filter(Boolean))];
}

/** Directories under a root that look like a trading-terminal install. */
function installLikeDirs(root, maxDepth = 2) {
  const out = [];
  for (const entry of listDir(root)) {
    if (!entry.isDirectory()) continue;
    if (!/meta|mt5|xm|trading|point|quot|broker/i.test(entry.name)) continue;
    out.push(path.join(root, entry.name));
    if (maxDepth > 1) {
      for (const sub of listDir(path.join(root, entry.name))) {
        if (sub.isDirectory() && /meta|mt5|xm|trading|terminal/i.test(sub.name)) {
          out.push(path.join(root, entry.name, sub.name));
        }
      }
    }
  }
  return out;
}

function exeIn(dir, names = MT5_EXE_NAMES) {
  for (const name of names) {
    const p = path.join(dir, name);
    if (isFile(p)) return p;
  }
  return null;
}

/** MT5 writes each instance's install path to `<instance>/origin.txt` (UTF-16). */
function originCandidates() {
  const bases = [
    process.env.APPDATA ? path.join(process.env.APPDATA, 'MetaQuotes', 'Terminal') : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'MetaQuotes', 'Terminal') : null,
  ].filter(Boolean);
  const out = [];
  for (const base of bases) {
    for (const entry of listDir(base)) {
      if (!entry.isDirectory()) continue;
      const instance = path.join(base, entry.name);
      let raw;
      try {
        raw = fs.readFileSync(path.join(instance, 'origin.txt'), 'utf16le');
      } catch {
        continue;
      }
      const origin = raw.replace(/\u0000/g, '').replace(/^\uFEFF/, '').trim();
      if (!origin) continue;
      const exe = exeIn(origin);
      if (!exe) continue;
      let usedAt = 0;
      try {
        usedAt = fs.statSync(instance).mtimeMs;
      } catch { /* keep 0 */ }
      out.push({ path: exe, usedAt, via: 'terminal origin.txt' });
    }
  }
  return out;
}

function scanCandidates() {
  const out = [];
  for (const root of programRoots()) {
    for (const dir of installLikeDirs(root)) {
      const exe = exeIn(dir);
      if (exe) out.push({ path: exe, usedAt: 0, via: 'program files scan' });
    }
  }
  return out;
}

function registryCandidates() {
  if (!isWindows) return [];
  const script = [
    "$keys = @(",
    "'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',",
    "'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',",
    "'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'",
    ")",
    `Get-ItemProperty $keys -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match 'MetaTrader|MetaQuotes|MT5|XM ' } | Select-Object -ExpandProperty InstallLocation -ErrorAction SilentlyContinue`,
  ].join('; ');
  const res = spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 12_000 });
  if (res.status !== 0 || !res.stdout) return [];
  const out = [];
  for (const line of res.stdout.split(/\r?\n/)) {
    const dir = line.trim();
    if (!dir) continue;
    const exe = exeIn(dir);
    if (exe) out.push({ path: exe, usedAt: 0, via: 'uninstall registry' });
  }
  return out;
}

function shortcutCandidates() {
  if (!isWindows) return [];
  const bases = [
    process.env.ProgramData ? path.join(process.env.ProgramData, 'Microsoft', 'Windows', 'Start Menu', 'Programs') : null,
    process.env.APPDATA ? path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs') : null,
  ].filter(Boolean);
  const links = [];
  for (const base of bases) {
    for (const entry of listDir(base)) {
      const full = path.join(base, entry.name);
      if (entry.isFile() && /\.lnk$/i.test(entry.name) && /meta|xm|mt5|trading/i.test(entry.name)) links.push(full);
      else if (entry.isDirectory() && /meta|xm|mt5|trading/i.test(entry.name)) {
        for (const f of listDir(full)) {
          if (f.isFile() && /\.lnk$/i.test(f.name)) links.push(path.join(full, f.name));
        }
      }
    }
  }
  const out = [];
  for (const lnk of links) {
    const script = `(New-Object -ComObject WScript.Shell).CreateShortcut('${lnk.replace(/'/g, "''")}').TargetPath`;
    const res = spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 12_000 });
    const target = (res.stdout ?? '').trim();
    if (!target) continue;
    if (!MT5_EXE_NAMES.some((n) => target.toLowerCase().endsWith(n))) continue;
    if (!isFile(target)) continue;
    out.push({ path: target, usedAt: 0, via: 'start-menu shortcut' });
  }
  return out;
}

/**
 * Rank candidates: a terminal the operator actually uses (origin.txt, most
 * recent first) beats one merely installed; an XM-branded path beats a generic
 * MetaQuotes one, because XM is the broker this platform trades.
 */
function rank(c, index) {
  const brand = /xm/i.test(c.path) ? 0 : /meta/i.test(c.path) ? 1 : 2;
  return [c.via === 'terminal origin.txt' ? 0 : 1, brand, -c.usedAt, index];
}

function compare(a, b) {
  const ra = rank(a[1], a[0]);
  const rb = rank(b[1], b[0]);
  for (let i = 0; i < ra.length; i += 1) {
    if (ra[i] !== rb[i]) return ra[i] - rb[i];
  }
  return 0;
}

export function cacheFile(root) {
  return path.join(root, '.data', 'mt5-path.txt');
}

export function readCachedPath(root) {
  try {
    const p = fs.readFileSync(cacheFile(root), 'utf8').trim();
    return isFile(p) ? p : null;
  } catch {
    return null;
  }
}

export function writeCachedPath(root, exePath) {
  try {
    fs.mkdirSync(path.join(root, '.data'), { recursive: true });
    fs.writeFileSync(cacheFile(root), `${exePath}\n`, 'utf8');
  } catch { /* caching is a convenience, never fatal */ }
}

/**
 * Resolve the terminal to launch.
 * Returns `{ path, source, candidates }` or null when nothing was found.
 */
export function resolveMt5Path({ root, ignoreCache = false } = {}) {
  const candidates = [];

  const explicit = process.env.MT5_PATH;
  if (explicit) {
    const ok = isFile(explicit);
    return {
      path: ok ? path.resolve(explicit) : null,
      source: ok ? 'MT5_PATH environment variable' : `MT5_PATH points at a missing file: ${explicit}`,
      candidates: ok ? [path.resolve(explicit)] : [],
    };
  }

  if (!isWindows) {
    return { path: null, source: 'not a Windows host (MetaTrader 5 only runs on Windows)', candidates: [] };
  }

  if (!ignoreCache) {
    const cached = readCachedPath(root);
    if (cached) {
      return { path: cached, source: 'remembered from the last run (.data/mt5-path.txt)', candidates: [cached] };
    }
  }

  candidates.push(...originCandidates(), ...scanCandidates(), ...registryCandidates(), ...shortcutCandidates());

  // De-duplicate by resolved path, then rank.
  const seen = new Set();
  const unique = candidates.filter((c) => {
    const key = path.resolve(c.path).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (!unique.length) {
    return {
      path: null,
      source: 'no MetaTrader 5 install found (searched terminal origin files, program folders, the registry and Start-Menu shortcuts)',
      candidates: [],
    };
  }

  unique.sort(compare);
  return { path: unique[0].path, source: unique[0].via, candidates: unique.map((c) => c.path) };
}

/** Is an MT5 terminal process already running? */
export function isMt5Running() {
  if (!isWindows) return false;
  for (const name of MT5_EXE_NAMES) {
    try {
      const out = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 10_000 });
      if ((out.stdout ?? '').toLowerCase().includes(name.toLowerCase())) return true;
    } catch { /* keep trying the other name */ }
  }
  return false;
}

/** Wait until a terminal process exists (the launch is asynchronous). */
export async function waitForMt5Process(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isMt5Running()) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return isMt5Running();
}

/** Every terminal instance MT5 knows about — used for diagnostics. */
export function knownInstances() {
  const bases = [
    process.env.APPDATA ? path.join(process.env.APPDATA, 'MetaQuotes', 'Terminal') : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'MetaQuotes', 'Terminal') : null,
  ].filter(Boolean);
  const out = [];
  for (const base of bases) {
    for (const entry of listDir(base)) {
      if (!entry.isDirectory()) continue;
      let origin = null;
      try {
        origin = fs.readFileSync(path.join(base, entry.name, 'origin.txt'), 'utf16le').replace(/\u0000/g, '').trim();
      } catch { /* no origin record */ }
      out.push({ instance: entry.name, origin });
    }
  }
  return out;
}

/**
 * Bring the terminal up if it is not already running.
 *
 * Returns `{ launched, path, source, reason }` and never throws: a missing
 * install, a refused launch or a terminal that never appears degrades to a
 * `reason` the caller can log, instead of taking the whole startup down.
 * It also remembers the resolved path, so discovery is a one-time cost.
 */
export async function launchMt5Terminal({ root, log = () => {} } = {}) {
  if (process.env.MT5_LAUNCH === '0') {
    return { launched: false, path: null, source: null, reason: 'disabled (MT5_LAUNCH=0)' };
  }
  if (!isWindows) {
    return { launched: false, path: null, source: null, reason: 'not a Windows host (MetaTrader 5 only runs on Windows)' };
  }
  if (isMt5Running()) {
    return { launched: false, path: null, source: null, reason: 'already running' };
  }

  const found = resolveMt5Path({ root });
  if (!found.path) {
    return { launched: false, path: null, source: found.source, reason: 'not found' };
  }

  try {
    spawn(found.path, [], { detached: true, stdio: 'ignore' }).unref();
  } catch (err) {
    return { launched: false, path: found.path, source: found.source, reason: `launch failed: ${String(err && err.message ? err.message : err)}` };
  }
  writeCachedPath(root, found.path);
  log(`launched: ${found.path}`);
  log(`found via ${found.source}`);

  // The launch is asynchronous and the workers attach to a LIVE terminal.
  const up = await waitForMt5Process(30_000);
  if (!up) {
    return { launched: true, path: found.path, source: found.source, reason: 'the process did not appear within 30s' };
  }
  return { launched: true, path: found.path, source: found.source, reason: null };
}

// Allow running this file directly: node scripts/mt5-locate.mjs
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = path.resolve(import.meta.dirname, '..');
  const res = resolveMt5Path({ root, ignoreCache: process.argv.includes('--fresh') });
  console.log('resolved :', res.path ?? '(none)');
  console.log('source   :', res.source);
  console.log('running  :', isMt5Running());
  if (res.candidates.length) console.log('candidates:', res.candidates.join('\n            '));
  const instances = knownInstances();
  if (instances.length) {
    console.log('instances:');
    for (const i of instances) console.log(`  ${i.instance} <- ${i.origin ?? 'no origin.txt'}`);
  }
}
