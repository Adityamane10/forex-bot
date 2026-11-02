$ErrorActionPreference = 'SilentlyContinue'
$subnet = '192.168.1'
$me = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -like "$subnet.*" } | Select-Object -First 1).IPAddress

# --- 1. Parallel ping sweep 1-254 ---
Write-Output "=== Ping sweep $subnet.1-254 ==="
$pool = [RunspaceFactory]::CreateRunspacePool(1, 100)
$pool.Open()
$jobs = @()
1..254 | ForEach-Object {
  $ip = "$subnet.$_"
  $ps = [PowerShell]::Create().AddScript({
    param($ip)
    $p = New-Object System.Net.NetworkInformation.Ping
    try {
      $r = $p.Send($ip, 800)
      if ($r.Status -eq 'Success') { return $ip }
      $c = New-Object System.Net.Sockets.TcpClient
      $ar = $c.BeginConnect($ip, 80, $null, $null)
      [void]$ar.AsyncWaitHandle.WaitOne(400)
      $c.Close()
    } catch {}
    return $null
  }).AddArgument($ip)
  $jobs += @{ PS = $ps; Handle = $ps.BeginInvoke() }
}
$live = @()
foreach ($j in $jobs) {
  $out = $j.PS.EndInvoke($j.Handle)
  if ($out) { $live += $out }
  $j.PS.Dispose()
}
$pool.Close()
Start-Sleep -Seconds 2  # let ARP populate for hosts that dropped ping

# --- 2. ARP harvest (includes hosts ping missed) ---
$arpHosts = @()
arp -a | ForEach-Object {
  if ($_ -match "($subnet\.\d+)\s+([0-9a-fA-F-]{17})\s+dynamic") {
    $arpHosts += @{ IP = $Matches[1]; MAC = $Matches[2].ToLower() }
  }
}
$allTargets = ($arpHosts | ForEach-Object { $_.IP }) + $live | Sort-Object -Unique

Write-Output "=== Live hosts + MAC vendor ==="
$vendors = @{
  'f4-27-56'='2Smart/Comfast'; 'ec-08-6b'='TP-Link'; '50-c2-e8'='TP-Link';
  'a4-2b-b0'='Dahua'; '3c-ef-8c'='Hikvision'; 'c0-56-e3'='Hikvision';
  '44-47-cc'='Hikvision'; 'bc-ad-28'='Hikvision'; '4c-b1-6c'='Xiaomi';
  '78-11-dc'='Xiaomi'; '64-cc-2e'='TP-Link'; 'e8-de-27'='TP-Link';
  'd8-3a-dd'='Xiaomi'; '54-af-97'='Xiaomi'; '1c-57-dc'='Xiaomi';
  '40-31-3c'='Xiaomi'; 'b8-27-eb'='Raspberry Pi'; 'dc-a6-32'='Raspberry Pi';
  'e4-5f-01'='Raspberry Pi'; '00-1e-06'='Tenvis'; '00-12-12'='Wansview';
  '00-12-7b'='Foscam'; '00-26-37'='Foscam'; '24-32-c1'='TP-Link';
  '78-02-f8'='TP-Link'; 'c0-06-c3'='Sricam'; '10-c6-1f'='Sricam';
  'ac-b4-3c'='Sricam'; '34-ce-00'='Dahua'; '90-02-a9'='Dahua';
  '50-c8-55'='Uni/Ubiquiti'; '24-5a-4c'='Hi35xx cam module'; '00-0c-29'='VMware'
}
foreach ($h in $arpHosts) {
  $mac = $h.MAC -replace '-', ':'
  $oui3 = $mac.Substring(0, 8)
  $v = 'unknown'
  foreach ($k in $vendors.Keys) { if ($oui3 -eq $k) { $v = $vendors[$k]; break } }
  $ip = $h.IP
  $tag = $(if ($ip -eq $me) {' (this PC)'} elseif ($ip -eq "$subnet.1") {' (router)'} else {''})
  Write-Output ("  {0,-16} {1}  {2}{3}" -f $ip, $mac.ToUpper(), $v, $tag)
}
foreach ($ip in ($live | Where-Object { $_ -notin ($arpHosts | ForEach-Object { $_.IP }) })) {
  $tag = $(if ($ip -eq $me) {' (this PC)'} elseif ($ip -eq "$subnet.1") {' (router)'} else {''})
  Write-Output ("  {0,-16} (no ARP entry){1}" -f $ip, $tag)
}

# --- 3. Port scan ALL targets (camera-relevant ports) ---
$ports = @(23,80,81,82,88,443,554,1935,34567,34900,37777,5000,5555,6036,7676,8000,8001,8004,8080,8081,8443,8554,8899,9000,9100,9527,10000,10554,49152)
Write-Output "=== TCP scan on: $($allTargets -join ', ') ==="
$pool2 = [RunspaceFactory]::CreateRunspacePool(1, 80)
$pool2.Open()
$jobs2 = @()
foreach ($ip in $allTargets) { foreach ($p in $ports) {
  $ps = [PowerShell]::Create().AddScript({
    param($ip, $p)
    $c = New-Object System.Net.Sockets.TcpClient
    try {
      $ar = $c.BeginConnect($ip, $p, $null, $null)
      if ($ar.AsyncWaitHandle.WaitOne(1200) -and $c.Connected) { return "$ip`:$p" }
    } catch {}
    return $null
  }).AddArgument($ip).AddArgument($p)
  $jobs2 += @{ PS = $ps; Handle = $ps.BeginInvoke() }
}}
$open = @()
foreach ($j in $jobs2) {
  $out = $j.PS.EndInvoke($j.Handle)
  if ($out) { $open += $out }
  $j.PS.Dispose()
}
$pool2.Close()
$open | Sort-Object | ForEach-Object { Write-Output "  $_ OPEN" }

# --- 4. ONVIF + SSDP multicast discovery (from this interface) ---
Write-Output "=== ONVIF WS-Discovery + SSDP ==="
$myIp = $me
$udp = New-Object System.Net.Sockets.UdpClient([System.Net.IPAddress]::Parse($myIp), 0)
$udp.Client.ReceiveTimeout = 4000
$probe = '<?xml version="1.0" encoding="UTF-8"?><soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:wsd="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl"><soap:Header><wsa:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</wsa:Action><wsa:MessageID>urn:uuid:7f4c5e6f-7081-4b2c-9d0e-1f2a3b4c5d7f</wsa:MessageID><wsa:To>urn:schemas-xmlsoap-org:ws:2005-04-discovery</wsa:To></soap:Header><soap:Body><wsd:Probe><wsd:Types>dn:NetworkVideoTransmitter</wsd:Types></wsd:Probe></soap:Body></soap:Envelope>'
$pb = [Text.Encoding]::ASCII.GetBytes($probe)
[void]$udp.Send($pb, $pb.Length, '239.255.255.250', 3702)
$ssdpMsg = "M-SEARCH * HTTP/1.1`r`nHOST: 239.255.255.250:1900`r`nMAN: `"ssdp:discover`"`r`nMX: 3`r`nST: ssdp:all`r`n`r`n"
$mb = [Text.Encoding]::ASCII.GetBytes($ssdpMsg)
[void]$udp.Send($mb, $mb.Length, '239.255.255.250', 1900)
$sw = [Diagnostics.Stopwatch]::StartNew()
$hits = 0
while ($sw.ElapsedMilliseconds -lt 4000) {
  try {
    $ep = New-Object System.Net.IPEndPoint([System.Net.IPAddress]::Any, 0)
    $resp = $udp.Receive([ref]$ep)
    $txt = [Text.Encoding]::UTF8.GetString($resp)
    $xaddr = [regex]::Match($txt, 'http://[0-9.]+:\d+[^<\r\n ]*').Value
    $loc = [regex]::Match($txt, 'LOCATION:\s*(\S+)').Groups[1].Value
    Write-Output ("  FROM {0}  XAddr={1}  LOC={2}" -f $ep.Address, $xaddr, $loc)
    $hits++
  } catch { break }
}
$udp.Close()
if (-not $hits) { Write-Output "  (no discovery replies)" }
Write-Output "=== DONE ==="
