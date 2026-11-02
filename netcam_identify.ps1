$ErrorActionPreference = 'SilentlyContinue'

# All dynamic hosts from ARP (excludes this PC and broadcast)
$targets = @('192.168.1.3','192.168.1.8','192.168.1.16','192.168.1.18')
$ports = @(23,80,81,82,85,88,443,554,1935,34567,34900,37777,5000,5555,6036,7676,8000,8001,8004,8080,8081,8443,8554,8899,9000,9100,9527,10000,10554,49152)

Write-Output "=== Wide port scan: $($targets -join ', ') ==="
$pool = [RunspaceFactory]::CreateRunspacePool(1, 80)
$pool.Open()
$jobs = @()
foreach ($ip in $targets) { foreach ($p in $ports) {
  $ps = [PowerShell]::Create().AddScript({
    param($ip, $p)
    $c = New-Object System.Net.Sockets.TcpClient
    try {
      $ar = $c.BeginConnect($ip, $p, $null, $null)
      if ($ar.AsyncWaitHandle.WaitOne(1200) -and $c.Connected) { return "$ip`:$p" }
    } catch {}
    return $null
  }).AddArgument($ip).AddArgument($p)
  $jobs += @{ PS = $ps; Handle = $ps.BeginInvoke() }
}}
$open = @()
foreach ($j in $jobs) {
  $out = $j.PS.EndInvoke($j.Handle)
  if ($out) { $open += $out }
  $j.PS.Dispose()
}
$pool.Close()
$open | Sort-Object | ForEach-Object { Write-Output "  $_ OPEN" }

if (-not $open) { Write-Output "  (no ports open anywhere)"; exit }

# --- Banner grab: HTTP title / Server header / RTSP ---
Write-Output "=== Identification ==="
foreach ($entry in ($open | Sort-Object)) {
  $ip, $port = $entry -split ':'
  if ($port -eq '554') {
    Write-Output "  [$entry] RTSP -> OPTIONS probe:"
    $c = New-Object System.Net.Sockets.TcpClient($ip, [int]$port)
    $s = $c.GetStream(); $s.ReadTimeout = 2000
    $req = "OPTIONS rtsp://${ip}:${port}/ RTSP/1.0`r`nCSeq: 1`r`n`r`n"
    $b = [Text.Encoding]::ASCII.GetBytes($req); $s.Write($b,0,$b.Length)
    $buf = New-Object byte[] 2048
    try { $n = $s.Read($buf,0,2048); Write-Output ("    " + ([Text.Encoding]::ASCII.GetString($buf,0,[Math]::Min($n,300))) -replace "`r`n","`r`n    ") } catch { Write-Output "    (no RTSP response)" }
    $c.Close()
    continue
  }
  if ($port -in @('80','81','82','85','88','443','5000','7550','8000','8001','8080','8081','8443','8899','9000','9527','10000','10554','49152')) {
    $proto = $(if ($port -eq '443' -or $port -eq '8443') {'https'} else {'http'})
    try {
      $resp = Invoke-WebRequest -Uri "$proto`://$ip`:$port/" -TimeoutSec 3 -UseBasicParsing
      $title = [regex]::Match($resp.Content, '<title[^>]*>([^<]+)</title>', 'IgnoreCase').Groups[1].Value.Trim()
      $srv = $resp.Headers['Server']
      Write-Output ("  [$entry] HTTP Server='{0}'  Title='{1}'" -f $srv, $title)
      if (-not $title -and $resp.Content.Length -lt 400) { Write-Output ("    body: " + ($resp.Content -replace '\s+',' ').Substring(0, [Math]::Min(300, $resp.Content.Length))) }
    } catch {
      $msg = $_.Exception.Message
      if ($msg -match 'SSL|secure|tls') {
        try {
          [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
          $resp = Invoke-WebRequest -Uri "https://$ip`:$port/" -TimeoutSec 3 -UseBasicParsing -SkipCertificateCheck
          $title = [regex]::Match($resp.Content, '<title[^>]*>([^<]+)</title>', 'IgnoreCase').Groups[1].Value.Trim()
          Write-Output ("  [$entry] HTTPS Server='{0}'  Title='{1}'" -f $resp.Headers['Server'], $title)
        } catch { Write-Output "  [$entry] HTTPS failed: $($_.Exception.Message)" }
      } else {
        Write-Output "  [$entry] HTTP probe: $msg"
      }
    }
  }
}
Write-Output "=== DONE ==="
