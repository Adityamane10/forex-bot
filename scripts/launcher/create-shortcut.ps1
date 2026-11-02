# Creates a Desktop shortcut (and Start Menu tile) for ForexBot.exe.
# Run once from anywhere:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\launcher\create-shortcut.ps1
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
$exe = Join-Path $PSScriptRoot 'ForexBot.exe'

if (-not (Test-Path $exe)) {
  Write-Error "ForexBot.exe not found at $exe - build it first (see scripts\launcher\README.md)."
}

$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop 'ForexBot.lnk'

$shell = New-Object -ComObject WScript.Shell
$sc = $shell.CreateShortcut($shortcutPath)
$sc.TargetPath = $exe
$sc.WorkingDirectory = $repoRoot
$sc.Description = 'Start the forex-bot platform: backend, dashboard, AI engine, MetaTrader 5 and workers'
$sc.IconLocation = "$exe,0"
$sc.Save()

Write-Host "Desktop shortcut created: $shortcutPath"
Write-Host "Double-click it to start the whole platform (dashboard opens automatically)."
