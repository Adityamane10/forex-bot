# Focus the MT5 terminal and press Ctrl+E (AutoTrading toggle), only when the
# MT5 window is verifiably in the foreground.
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder t, int n);
}
"@

$proc = Get-Process terminal64 -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { Write-Output 'NO_MT5_WINDOW'; exit 1 }
Write-Output ("found: " + $proc.MainWindowTitle)

[Win32]::SetForegroundWindow($proc.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 600
$fg = [Win32]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 256
[Win32]::GetWindowText($fg, $sb, 256) | Out-Null
if ($fg -ne $proc.MainWindowHandle) { Write-Output ("FOREGROUND_MISMATCH: " + $sb.ToString()); exit 1 }
Write-Output ("foreground ok: " + $sb.ToString())

$ws = New-Object -ComObject WScript.Shell
$ws.SendKeys('^e')
Start-Sleep -Milliseconds 400
Write-Output 'CTRLE_SENT'
