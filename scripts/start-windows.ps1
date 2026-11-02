# Start every dev server in its own terminal window.
#
# Mirrors scripts/start-all.mjs (same services, same env) but one window per
# process so logs don't interleave and any server can be restarted alone.
#
#   powershell -File scripts\start-windows.ps1
#   MT5_BRIDGE=0 powershell -File scripts\start-windows.ps1   # skip MT5 workers
#
# Closing a window stops that server. The MT5 workers are supervised by their
# watchdogs (they wait for backend health, then launch start.ps1 themselves,
# which also starts/attaches the MetaTrader 5 terminal).

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot

function Start-DevWindow([string]$Title, [string]$Command, [string]$WorkingDir) {
  $inner = "`$host.UI.RawUI.WindowTitle = '$Title'; Set-Location '$WorkingDir'; $Command"
  Start-Process powershell -ArgumentList '-NoExit', '-Command', $inner
  Write-Host "  started: $Title"
}

Write-Host "Starting dev servers in separate windows from $repoRoot`n"

# 1) shared watcher - rebuilds @fx/shared on edit (backend restarts on it).
#    NOTE: run `npm run build:shared` once before the backend's first start.
Start-DevWindow 'shared' 'npm run dev:shared' $repoRoot

# 2) backend (port 4000) - STORE_FILE set exactly like start-all.mjs.
$storeFile = Join-Path $repoRoot '.data\store.json'
Start-DevWindow 'backend' "`$env:STORE_FILE = '$storeFile'; npm run dev:backend" $repoRoot

# 3) ai-engine (port 8500) - prefer the project venv, fall back to PATH python.
$venvPy = Join-Path $repoRoot 'ai-engine\venv\Scripts\python.exe'
if (Test-Path $venvPy) { $py = '.\venv\Scripts\python.exe' } else { $py = 'python' }
Start-DevWindow 'ai-engine' "$py -m uvicorn app.main:app --reload --port 8500" (Join-Path $repoRoot 'ai-engine')

# 4) frontend (port 5173)
Start-DevWindow 'frontend' 'npm run dev:frontend' $repoRoot

# 5) MT5 tick bridge + demo trader, each supervised by its own watchdog.
if ($env:MT5_BRIDGE -ne '0') {
  Start-DevWindow 'MT5-bridge-watchdog' 'node workers\mt5-bridge\watchdog.mjs' $repoRoot
}
if ($env:MT5_TRADER -ne '0') {
  Start-DevWindow 'MT5-trader-watchdog' 'node workers\mt5-trader\watchdog.mjs' $repoRoot
}

Write-Host "`nAll windows launched:"
Write-Host '  Frontend  -> http://localhost:5173'
Write-Host '  Backend   -> http://localhost:4000'
Write-Host '  AI Engine -> http://localhost:8500'
