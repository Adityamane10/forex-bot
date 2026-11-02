# One-click launcher for the forex-bot platform

Double-click **`ForexBot.exe`** — that's it. No terminal, no commands.

## What it does, in order

1. **Single instance** — a second double-click just shows "already running" (kernel mutex; two launches can never duel over ports).
2. **Frees ports 4000 / 5173 / 8500** — a half-closed previous run can't wedge the start.
3. **Starts the full stack** via the project's own orchestrator (`npm run dev:all`) in a visible console window:
   - `@fx/shared` TypeScript watcher,
   - backend API (port 4000),
   - frontend dashboard (port 5173),
   - AI engine (port 8500),
   - **MetaTrader 5 terminal** — auto-discovered (origin.txt → Program Files) and launched if not already running,
   - **MT5 tick bridge** — streams live broker prices into the backend,
   - **MT5 order worker** — executes dashboard orders on the bound account (guarded: refuses real-money accounts unless `MT5_ALLOW_REAL=1`).
4. **Opens the dashboard** in your browser automatically (probes IPv4 and IPv6 loopback).
5. **Watches health from the tray** — icon text shows backend state; a balloon warns if the API stops answering.
6. **Exit — stop everything** (tray menu) stops the whole tree cleanly: orchestrator, backend, frontend, AI engine, both MT5 workers, and frees the ports.

## Where the exe is

`scripts\launcher\ForexBot.exe` (built from `ForexBot.cs`, ~20 KB, needs only the .NET Framework that ships with Windows).

### Rebuild (only needed after editing ForexBot.cs)

```powershell
& 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe' /nologo /target:winexe `
  /out:scripts\launcher\ForexBot.exe `
  /r:System.dll /r:System.Core.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll `
  scripts\launcher\ForexBot.cs
```

## Desktop shortcut

Run once:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\launcher\create-shortcut.ps1
```

That puts **ForexBot** on your Desktop (and pins it in the Start Menu's user tiles). The shortcut starts in the project root, so the exe always finds the repo.

## Verify a machine without starting anything

```
ForexBot.exe --check
```

Prints PASS/FAIL for: repo layout, npm, AI-engine venv, frontend/backend deps, `backend\.env` INTERNAL_API_TOKEN (needed by the MT5 workers), MT5 terminal discovery, and whether the three ports are free. Results are appended to `.data\forexbot-launcher.log`.

## Stop the platform from a script (or if the tray is gone)

```
ForexBot.exe --stop
```

Signals the running instance to exit gracefully — identical to the tray's Exit: the whole tree stops (orchestrator, backend, frontend, AI engine, MT5 workers) and the ports are freed. Verified: after `--stop`, zero listeners on 4000/5173/8500 and zero leftover project processes.

Starting over is always safe: a launch first frees the ports and sweeps any leftover process from a previous run — even after a crash or a task-manager kill, two stacks can never interleave.

## Troubleshooting

| Symptom | Where to look |
| --- | --- |
| A service dies at start | The platform console window (it IS the log). The launcher also logs to `.data\forexbot-launcher.log`. |
| "MT5 workers skipped" balloon | `backend\.env` is missing or has no `INTERNAL_API_TOKEN`. |
| MT5 terminal not found | Install MetaTrader 5 and log in once; or set `MT5_PATH` for the orchestrator. The tray tip shows what was tried. |
| Dashboard did not open | Open `http://localhost:5173` manually; the frontend may still be compiling on the first run (~30 s). |
| Backend DOWN balloon | Check the console window; common cause: port 4000 held by a leftover process (the launcher frees it on next start). |

## Design notes (why it looks like this)

- **One child process.** The exe spawns `npm run dev:all` and nothing else. The orchestrator already knows how to start every service, launch MT5, wait for health and supervise the workers with watchdogs — duplicating that in C# proved strictly worse (a raw C# spawn of `python.exe` failed where node's spawn works, and process-tree cleanup needed the exact knowledge the orchestrator already has).
- **Mutex, not PID file**, for single-instance: two launches in the same second both read a stale PID file; a kernel mutex cannot race.
- **Tree-kill on exit** (`taskkill /F /T` on the orchestrator) plus a port sweep: uvicorn-style reloaders leave children holding duplicated socket handles that a plain parent kill never reclaims.
- **C# 5** on purpose: it builds with the compiler built into Windows — no SDK, no installer.
