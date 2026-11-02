$ErrorActionPreference = 'SilentlyContinue'
$wifiIp = '192.168.1.13'

# --- Sanity check: TCP to router admin port ---
Write-Output "=== Sanity check (router 192.168.1.1:80) ==="
$sc = New-Object System.Net.Sockets.TcpClient
$ar0 = $sc.BeginConnect('192.168.1.1', 80, $null, $null)
$ok0 = $ar0.AsyncWaitHandle.WaitOne(2000) -and $sc.Connected
Write-Output ("  192.168.1.1:80 -> {0}" -f $(if ($ok0) { 'OPEN' } else { 'closed/filtered' }))
$sc.Close()

# --- WS-Discovery (ONVIF IP cameras advertise here) ---
Write-Output "=== WS-Discovery (ONVIF camera probe) ==="
$udp = New-Object System.Net.Sockets.UdpClient([System.Net.IPAddress]::Parse($wifiIp), 0)
$udp.Client.ReceiveTimeout = 5000
$udp.Client.SendTimeout = 2000
$udp.Connect('239.255.255.250', 3702)

$probeGeneric = '<?xml version="1.0" encoding="UTF-8"?><soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:wsd="http://schemas.xmlsoap.org/ws/2005/04/discovery"><soap:Header><wsa:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</wsa:Action><wsa:MessageID>urn:uuid:2c3b4d5e-6f70-4a1b-8c9d-0e1f2a3b4c5d</wsa:MessageID><wsa:To>urn:schemas-xmlsoap-org:ws:2005:04:discovery</wsa:To></soap:Header><soap:Body><wsd:Probe/></soap:Body></soap:Envelope>'
$probeOnvif = '<?xml version="1.0" encoding="UTF-8"?><soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:wsd="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl"><soap:Header><wsa:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</wsa:Action><wsa:MessageID>urn:uuid:3d4c5e6f-7081-4b2c-9d0e-1f2a3b4c5d6e</wsa:MessageID><wsa:To>urn:schemas-xmlsoap-org:ws:2005:04:discovery</wsa:To></soap:Header><soap:Body><wsd:Probe><wsd:Types>dn:NetworkVideoTransmitter</wsd:Types></wsd:Probe></soap:Body></soap:Envelope>'

foreach ($p in @($probeGeneric, $probeOnvif)) {
  $b = [System.Text.Encoding]::ASCII.GetBytes($p)
  [void]$udp.Send($b, $b.Length)
  Start-Sleep -Milliseconds 150
}
$sw = [Diagnostics.Stopwatch]::StartNew()
$seen = @{}
while ($sw.ElapsedMilliseconds -lt 5000) {
  try {
    $ep = New-Object System.Net.IPEndPoint([System.Net.IPAddress]::Any, 0)
    $resp = $udp.Receive([ref]$ep)
    $txt = [System.Text.Encoding]::UTF8.GetString($resp)
    $addr = [regex]::Match($txt, 'http://[0-9.]+:\d+[^<\r\n" ]*').Value
    $types = [regex]::Match($txt, 'Types>([^<]+)').Groups[1].Value
    if (-not $seen.ContainsKey($ep.Address.ToString() + $addr)) {
      $seen[$ep.Address.ToString() + $addr] = 1
      Write-Output ("  RESPONDER={0}  Types={1}  XAddr={2}" -f $ep.Address, $types, $addr)
    }
  } catch { break }
}
$udp.Close()

# --- SSDP (UPnP: TVs, cameras, NVRs) ---
Write-Output "=== SSDP (UPnP devices) ==="
$ssdp = New-Object System.Net.Sockets.UdpClient([System.Net.IPAddress]::Parse($wifiIp), 0)
$ssdp.Client.ReceiveTimeout = 5000
$msg = "M-SEARCH * HTTP/1.1`r`nHOST: 239.255.255.250:1900`r`nMAN: `"ssdp:discover`"`r`nMX: 3`r`nST: ssdp:all`r`n`r`n"
$mb = [System.Text.Encoding]::ASCII.GetBytes($msg)
$ssdp.Connect('239.255.255.250', 1900)
[void]$ssdp.Send($mb, $mb.Length)
$sw2 = [Diagnostics.Stopwatch]::StartNew()
$seen2 = @{}
while ($sw2.ElapsedMilliseconds -lt 5000) {
  try {
    $ep2 = New-Object System.Net.IPEndPoint([System.Net.IPAddress]::Any, 0)
    $r2 = $ssdp.Receive([ref]$ep2)
    $t2 = [System.Text.Encoding]::UTF8.GetString($r2)
    $st = [regex]::Match($t2, 'ST:\s*(.+)').Groups[1].Value.Trim()
    $loc = [regex]::Match($t2, 'LOCATION:\s*(.+)').Groups[1].Value.Trim()
    $srv = [regex]::Match($t2, 'SERVER:\s*(.+)').Groups[1].Value.Trim()
    $key = $ep2.Address.ToString() + $st + $loc
    if (-not $seen2.ContainsKey($key)) {
      $seen2[$key] = 1
      Write-Output ("  RESPONDER={0}  ST={1}  SRV={2}  LOC={3}" -f $ep2.Address, $st, $srv, $loc)
    }
  } catch { break }
}
$ssdp.Close()

# --- TCP port scan (camera-related ports, parallel via runspaces) ---
Write-Output "=== TCP port scan (camera ports) ==="
$ips = arp -a | Select-String '192\.168\.1\.\d+\s+[0-9a-f-]+\s+dynamic' | ForEach-Object { ($_ -split '\s+')[1] }
Write-Output ("  Scanning targets: {0}" -f ($ips -join ', '))
$ports = @(80,88,443,554,1935,5000,7676,8000,8001,8080,8081,8554,8899,9100,10000,34567,37777,49152)
$pool = [RunspaceFactory]::CreateRunspacePool(1, 40)
$pool.Open()
$all = @()
foreach ($ip in $ips) { foreach ($p in $ports) {
  $ps = [PowerShell]::Create().AddScript({
    param($ip, $p)
    $c = New-Object System.Net.Sockets.TcpClient
    try {
      $ar = $c.BeginConnect($ip, $p, $null, $null)
      if ($ar.AsyncWaitHandle.WaitOne(1200) -and $c.Connected) { return "  $ip`:$p OPEN" }
    } catch {}
    return $null
  }).AddArgument($ip).AddArgument($p)
  $all += @{ PS = $ps; Handle = $ps.BeginInvoke() }
}}
foreach ($entry in $all) {
  $out = $entry.PS.EndInvoke($entry.Handle)
  if ($out) { $out | ForEach-Object { Write-Output $_ } }
  $entry.PS.Dispose()
}
$pool.Close()
Write-Output "=== DONE ==="
