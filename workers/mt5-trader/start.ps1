# MT5 trader launcher: loads backend\.env credentials into the session, then
# runs trader.py (long-poll executor for the dashboard mirror).
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$backendEnv = Join-Path $repoRoot 'backend\.env'

if (-not (Test-Path $backendEnv)) {
  Write-Error "backend\.env not found at $backendEnv - INTERNAL_API_TOKEN is required."
}

Get-Content $backendEnv | ForEach-Object {
  if ($_ -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$') {
    $k = $Matches[1]; $v = $Matches[2].Trim('"')
    switch ($k) {
      'INTERNAL_API_TOKEN' { if (-not $env:INTERNAL_API_TOKEN) { $env:INTERNAL_API_TOKEN = $v } }
      'MT5_LOGIN'          { if (-not $env:MT5_LOGIN)          { $env:MT5_LOGIN = $v } }
      'MT5_PASSWORD'       { if (-not $env:MT5_PASSWORD)       { $env:MT5_PASSWORD = $v } }
      'MT5_SERVER'         { if (-not $env:MT5_SERVER)         { $env:MT5_SERVER = $v } }
      # Live-money opt-in for THIS worker. Unset/false keeps the worker refusing
      # every order on a REAL or CONTEST MT5 account (see trader.py).
      'MT5_ALLOW_REAL'     { if (-not $env:MT5_ALLOW_REAL)     { $env:MT5_ALLOW_REAL = $v } }
    }
  }
}

if (-not $env:INTERNAL_API_TOKEN) {
  Write-Error 'INTERNAL_API_TOKEN missing from backend\.env.'
}

# Single instance: a second launcher must never stack another trader - duplicate
# executors double-heartbeat the wallet mirror and race for the same MT5 attach.
$existing = @(Get-CimInstance Win32_Process -Filter "Name='python.exe' OR Name='py.exe'" |
  Where-Object { $_.CommandLine -like '*mt5-trader*trader.py*' })
if ($existing.Count -ge 1) {
  Write-Host ("[mt5-trader] already running (PID {0}) - nothing to do." -f $existing[0].ProcessId)
  exit 0
}

# Pick an interpreter that can really run the worker (see workers/select-python.ps1).
# A bare `py` used to die with "Failed to import encodings module" and take the
# order executor with it - silently, so the dashboard just showed a binding that
# kept going stale. Now the choice is probed and a dead end is reported.
. (Join-Path $PSScriptRoot '..\select-python.ps1')
$sel = Resolve-Mt5Python -RepoRoot $repoRoot

if (-not $sel.cmd) {
  Write-Host '[mt5-trader] FATAL: no Python interpreter with the MetaTrader5 package could be started -' -ForegroundColor Red
  Write-Host '[mt5-trader] without it the dashboard can bind an account but no order can ever reach MT5.' -ForegroundColor Red
  $sel.tried | ForEach-Object { Write-Host ("[mt5-trader]   tried {0}" -f $_) }
  Write-Host '[mt5-trader] fix: run `py -m pip install MetaTrader5`, or set MT5_PYTHON to a python.exe that works.'
  exit 1
}

Write-Host ("[mt5-trader] interpreter: {0}" -f $sel.cmd)
Write-Host '[mt5-trader] launching trader.py...'
& $sel.cmd -u (Join-Path $PSScriptRoot 'trader.py')
