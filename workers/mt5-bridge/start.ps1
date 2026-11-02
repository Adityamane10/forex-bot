# MT5 bridge launcher - starts the MetaTrader 5 terminal if needed, then runs
# the tick bridge (history preload + live stream) against the local backend.
#
# Reads from backend\.env (already on this machine):
#   INTERNAL_API_TOKEN   required - must match the backend
#   MT5_LOGIN / MT5_PASSWORD / MT5_SERVER   optional (omit to use the terminal's
#                        saved account; a logged-in demo account is expected)
#
# Usage:
#   powershell -File workers\mt5-bridge\start.ps1                    # 10 majors, preload + stream
#   powershell -File workers\mt5-bridge\start.ps1 -Symbols EURUSD,XAUUSD
#
# The bridge NEVER fabricates data: without a running, logged-in MT5 terminal
# it exits with a clear error instead of inventing ticks.

param(
  [string]$Symbols = "EURUSD,GBPUSD,USDJPY,USDCHF,AUDUSD,USDCAD,NZDUSD,EURGBP,EURJPY,GBPJPY,XAUUSD",
  [switch]$NoPreload,
  # Deep-history export for AI training (bars per symbol/timeframe, 0 = off).
  # 20000 x 1h = ~2.3 years of hourly bars — enough to train a real model.
  [int]$HistoryBars = 20000,
  [string]$HistoryTfs = '1h'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$backendEnv = Join-Path $repoRoot 'backend\.env'

if (-not (Test-Path $backendEnv)) {
  Write-Error "backend\.env not found at $backendEnv - INTERNAL_API_TOKEN is required."
}

# Pull only the keys we need out of .env without clobbering this session.
Get-Content $backendEnv | ForEach-Object {
  if ($_ -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$') {
    $k = $Matches[1]; $v = $Matches[2].Trim('"')
    switch ($k) {
      'INTERNAL_API_TOKEN' { if (-not $env:INTERNAL_API_TOKEN) { $env:INTERNAL_API_TOKEN = $v } }
      'MT5_LOGIN'          { if (-not $env:MT5_LOGIN) { $env:MT5_LOGIN = $v } }
      'MT5_PASSWORD'       { if (-not $env:MT5_PASSWORD) { $env:MT5_PASSWORD = $v } }
      'MT5_SERVER'         { if (-not $env:MT5_SERVER) { $env:MT5_SERVER = $v } }
    }
  }
}

if (-not $env:INTERNAL_API_TOKEN) {
  Write-Error "INTERNAL_API_TOKEN missing from backend\.env - the ingestion endpoint is disabled without it."
}

# Single instance: a second launcher must never stack another bridge - duplicate
# feeds double the tick stream and fight over the MT5 attach. Orphaned bridges
# from a console closed without cleanup are the main cause of flapping ports.
$existing = @(Get-CimInstance Win32_Process -Filter "Name='python.exe' OR Name='py.exe'" |
  Where-Object { $_.CommandLine -like '*mt5-bridge*bridge.py*' })
if ($existing.Count -ge 1) {
  Write-Host ("[mt5-bridge] already running (PID {0}) - nothing to do." -f $existing[0].ProcessId)
  exit 0
}

# Terminal must be running for the Python API to attach. Starting it here does
# NOT log in: first run requires a manual login (demo account), after which the
# terminal remembers the account and reconnects on its own.
$terminal = Get-Process -Name terminal64 -ErrorAction SilentlyContinue
if (-not $terminal) {
  $exe = Join-Path $env:ProgramFiles 'MetaTrader 5\terminal64.exe'
  if (-not (Test-Path $exe)) { Write-Error "MetaTrader 5 terminal not found at $exe" }
  Write-Host '[mt5-bridge] starting MetaTrader 5 terminal...'
  Start-Process -FilePath $exe
  # Give it time to connect to the trade server (login prompt on first run).
  Start-Sleep -Seconds 12
} else {
  Write-Host '[mt5-bridge] terminal already running.'
}

if (-not $env:BACKEND_URL) { $env:BACKEND_URL = 'http://127.0.0.1:4000' }

# Wait for backend health before preload - otherwise every preload POST gets 10061 and blocks forever
$healthTries = 0
while ($healthTries -lt 60) {
  try {
    $null = Invoke-WebRequest -UseBasicParsing -Uri "$env:BACKEND_URL/health" -TimeoutSec 2
    break
  } catch {
    $healthTries++
    Write-Host "[mt5-bridge] waiting for backend $env:BACKEND_URL/health ... ($healthTries/60)"
    Start-Sleep -Seconds 1
  }
}
if ($healthTries -ge 60) { Write-Warning "[mt5-bridge] backend not healthy after 60s - starting anyway (preload will retry)" }

# Pick an interpreter that can really run the bridge (see workers/select-python.ps1).
# `py` used to be assumed good; on a host where the resolved Python cannot find
# its stdlib the bridge died at startup with "Failed to import encodings module"
# and the live feed silently disappeared. Now the choice is probed: the first
# candidate that can actually `import MetaTrader5` wins.
. (Join-Path $PSScriptRoot '..\select-python.ps1')
$sel = Resolve-Mt5Python -RepoRoot $repoRoot
if (-not $sel.cmd) {
  Write-Host '[mt5-bridge] FATAL: no Python interpreter with the MetaTrader5 package could be started - the realtime feed cannot run.' -ForegroundColor Red
  $sel.tried | ForEach-Object { Write-Host ("[mt5-bridge]   tried {0}" -f $_) }
  Write-Host '[mt5-bridge] fix: run `py -m pip install MetaTrader5`, or set MT5_PYTHON to a python.exe that works.'
  exit 1
}
$pythonCmd = $sel.cmd

$argsList = @('-u', (Join-Path $PSScriptRoot 'bridge.py'), '--symbols', $Symbols)
if (-not $NoPreload) { $argsList += '--preload' }
if ($HistoryBars -gt 0) { $argsList += @('--history-bars', [string]$HistoryBars, '--history-tfs', $HistoryTfs) }

Write-Host ("[mt5-bridge] launching: $pythonCmd " + ($argsList -join ' '))
$logFile = Join-Path $repoRoot 'mt5-bridge.log'
Write-Host "[mt5-bridge] logging to $logFile"
$bridgePath = Join-Path $PSScriptRoot 'bridge.py'
# Use UTF8 logging (Tee-Object is UTF16 in PS5.1)
& $pythonCmd @argsList 2>&1 | ForEach-Object { Add-Content -Path $logFile -Value $_ -Encoding UTF8; Write-Host $_ }
