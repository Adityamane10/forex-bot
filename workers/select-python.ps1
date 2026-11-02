# Shared Python discovery for the MT5 workers.
#
# Why this exists: `py` is not always a usable interpreter. On a host where the
# resolved Python cannot find its own stdlib, the worker dies at startup with
# "Fatal Python error: Failed to import encodings module" and NOTHING reaches
# the operator — the watchdog just logs "trader not running — cooldown" every
# cycle while the dashboard shows a binding that quietly ages out. A worker that
# cannot run must say so.
#
# So each candidate is probed with the import the worker actually needs, and the
# first one that answers wins. MT5_PYTHON overrides the whole search (set it to
# a python.exe path when a host has several).
function Resolve-Mt5Python {
  param(
    [Parameter(Mandatory = $true)][string]$RepoRoot,
    # Extra candidates to try before the defaults (host-specific paths).
    [string[]]$Extra = @()
  )

  $candidates = @()
  if ($env:MT5_PYTHON) { $candidates += $env:MT5_PYTHON }
  $candidates += $Extra
  # The project venv FIRST: it is provisioned by this repo with MetaTrader5
  # installed, so it is always the known-good interpreter. System `py`/
  # `python` stay as fallbacks only — on hosts where the default install is
  # broken (e.g. a 3.14 that cannot import its own encodings module), the
  # venv-first order is what keeps the workers alive.
  $venv = Join-Path $RepoRoot 'ai-engine\venv\Scripts\python.exe'
  if (Test-Path $venv) { $candidates += $venv }
  $candidates += @('py', 'python', 'python3')

  $tried = @()
  foreach ($cand in $candidates) {
    if (-not $cand) { continue }
    try {
      # The probe is the real dependency: the MetaTrader5 package must be
      # importable by THIS interpreter, not merely installed somewhere.
      $out = & $cand -c 'import MetaTrader5' 2>&1
      if ($LASTEXITCODE -eq 0) {
        return @{ cmd = $cand; tried = $tried }
      }
      $first = ($out | Select-Object -First 1)
      if (-not $first) { $first = "(exit $LASTEXITCODE, no output)" }
      $tried += ("{0} -> {1}" -f $cand, $first)
    } catch {
      $tried += ("{0} -> {1}" -f $cand, $_.Exception.Message)
    }
  }
  return @{ cmd = $null; tried = $tried }
}
