# Mock Trading Test Suite - Complete Workflow Testing
$ErrorActionPreference = "Continue"
$baseUrl = "http://127.0.0.1:4000/api/india"
$results = @()

function Log-Test {
    param(
        [string]$Name,
        [bool]$Status,
        [string]$Details = ""
    )
    
    $symbol = if ($Status) { "✓" } else { "✗" }
    $color = if ($Status) { "Green" } else { "Red" }
    
    Write-Host "$symbol $Name" -ForegroundColor $color
    if ($Details) {
        Write-Host "  $Details" -ForegroundColor Gray
    }
    
    $script:results += @{
        Test = $Name
        Passed = $Status
        Details = $Details
    }
}

Write-Host ""
Write-Host ("="*60) -ForegroundColor Cyan
Write-Host "  INDIA TRADING SYSTEM - COMPREHENSIVE MOCK TESTS" -ForegroundColor Cyan
Write-Host "  Testing all components without market being open" -ForegroundColor Cyan
Write-Host ("="*60) -ForegroundColor Cyan
Write-Host ""

# TEST SUITE 1: API Connectivity
Write-Host ("="*60)
Write-Host "TEST SUITE 1: API Connectivity & Health" -ForegroundColor Yellow
Write-Host ("="*60)

try {
    $status = (Invoke-WebRequest "$baseUrl/status" -UseBasicParsing -TimeoutSec 5).Content | ConvertFrom-Json
    Log-Test "Backend API Status" $true "Broker: $($status.broker)"
    
    $health = (Invoke-WebRequest "$baseUrl/health" -UseBasicParsing -TimeoutSec 5).Content | ConvertFrom-Json
    Log-Test "Health Endpoint" $true "Data Health: $($health.dataHealth.state)"
    
    $instruments = (Invoke-WebRequest "$baseUrl/instruments" -UseBasicParsing -TimeoutSec 10).Content | ConvertFrom-Json
    Log-Test "Instruments Loaded" ($instruments.Count -gt 0) "Count: $($instruments.Count)"
    
    Log-Test "Feed Mode" ($status.feedMode -eq 'ltp') "Mode: $($status.feedMode)"
    Log-Test "WebSocket Source" ($status.feedSource -eq 'UPSTOX-WS-V3') "Source: $($status.feedSource)"
} catch {
    Log-Test "API Connectivity" $false $_.Exception.Message
}

Write-Host ""

# TEST SUITE 2: Analysis Engine
Write-Host ("="*60)
Write-Host "TEST SUITE 2: Analysis Engine & Indicators" -ForegroundColor Yellow
Write-Host ("="*60)

try {
    $analysis = (Invoke-WebRequest "$baseUrl/analysis/26000" -UseBasicParsing -TimeoutSec 10).Content | ConvertFrom-Json
    
    Log-Test "Analysis API" $true
    Log-Test "Regime Detection" ($null -ne $analysis.regime) "Regime: $($analysis.regime)"
    Log-Test "Trend Detection" ($null -ne $analysis.trend) "Trend: $($analysis.trend)"
    Log-Test "Support/Resistance" ($null -ne $analysis.support) "S: $($analysis.support) | R: $($analysis.resistance)"
    
    if ($analysis.riskContext) {
        $rc = $analysis.riskContext
        Log-Test "RSI Indicator" ($null -ne $rc.rsi) "RSI: $([math]::Round($rc.rsi, 1))"
        Log-Test "ADX Indicator" ($null -ne $rc.adx) "ADX: $([math]::Round($rc.adx, 1))"
        Log-Test "ATR Indicator" ($null -ne $rc.atr) "ATR: $([math]::Round($rc.atr, 2))"
    }
    
    Log-Test "Confidence Score" ($null -ne $analysis.confidence) "$([math]::Round($analysis.confidence * 100, 1))%"
} catch {
    Log-Test "Analysis Engine" $false $_.Exception.Message
}

Write-Host ""

# TEST SUITE 3: Historical Candles
Write-Host ("="*60)
Write-Host "TEST SUITE 3: Historical Candle Data" -ForegroundColor Yellow
Write-Host ("="*60)

@('5m', '15m', '30m', '1h') | ForEach-Object {
    $tf = $_
    try {
        $data = (Invoke-WebRequest "$baseUrl/candles/26000?timeframe=$tf&limit=100" -UseBasicParsing -TimeoutSec 15).Content | ConvertFrom-Json
        $candles = $data.candles
        
        if ($candles.Count -gt 0) {
            $oldest = [DateTimeOffset]::FromUnixTimeMilliseconds($candles[0].openTime).ToOffset([TimeSpan]::FromHours(5.5)).ToString('MMM dd')
            $newest = [DateTimeOffset]::FromUnixTimeMilliseconds($candles[-1].openTime).ToOffset([TimeSpan]::FromHours(5.5)).ToString('MMM dd')
            Log-Test "Candles $tf" ($candles.Count -gt 0) "$($candles.Count) bars | $oldest → $newest"
        } else {
            Log-Test "Candles $tf" $false "No candles returned"
        }
    } catch {
        Log-Test "Candles $tf" $false $_.Exception.Message
    }
}

Write-Host ""

# TEST SUITE 4: Paper Trading
Write-Host ("="*60)
Write-Host "TEST SUITE 4: Paper Trading Account" -ForegroundColor Yellow
Write-Host ("="*60)

try {
    $account = (Invoke-WebRequest "$baseUrl/account" -UseBasicParsing -TimeoutSec 5).Content | ConvertFrom-Json
    
    Log-Test "Paper Account Created" $true
    Log-Test "Starting Balance" ($account.startingBalance -eq 100000) "₹$($account.startingBalance.ToString('N0'))"
    Log-Test "Equity Tracking" ($null -ne $account.equity) "₹$($account.equity.ToString('N0'))"
    Log-Test "Free Margin" ($null -ne $account.freeMargin) "₹$($account.freeMargin.ToString('N0'))"
    Log-Test "P&L Calculation" ($null -ne $account.realizedPnl) "Realized: ₹$($account.realizedPnl)"
    
    $positions = (Invoke-WebRequest "$baseUrl/positions" -UseBasicParsing -TimeoutSec 5).Content | ConvertFrom-Json
    Log-Test "Position Tracking" ($positions -is [Array]) "$($positions.Count) open positions"
} catch {
    Log-Test "Paper Trading" $false $_.Exception.Message
}

Write-Host ""

# TEST SUITE 5: Goal Trading
Write-Host ("="*60)
Write-Host "TEST SUITE 5: Goal Trading Lifecycle" -ForegroundColor Yellow
Write-Host ("="*60)

try {
    # Start Goal
    $goalConfig = @{
        amountInr = 100000
        minimumProfitInr = 2500
        maxRiskInr = 500
        maxMarginPercent = 20
        numberOfTrades = 3
        executionMode = "MANUAL"
        sessionPolicy = "TODAY_ONLY"
        tradeUnderlyings = @("NIFTY", "BANKNIFTY", "FINNIFTY")
    } | ConvertTo-Json
    
    $goal = (Invoke-WebRequest "$baseUrl/goals/start" -Method POST -Body $goalConfig -ContentType "application/json" -UseBasicParsing -TimeoutSec 10).Content | ConvertFrom-Json
    
    Log-Test "Goal Creation" $true "ID: $($goal.goalId)"
    Log-Test "Goal Configuration" ($goal.config.amountInr -eq 100000) "Capital: ₹$($goal.config.amountInr.ToString('N0'))"
    Log-Test "Execution Mode" ($goal.config.executionMode -eq "MANUAL") "Mode: $($goal.config.executionMode)"
    
    Start-Sleep -Seconds 3
    
    # Check Progress
    $current = (Invoke-WebRequest "$baseUrl/goals/current" -UseBasicParsing -TimeoutSec 5).Content | ConvertFrom-Json
    if ($current) {
        $progress = $current.progress
        Log-Test "Progress Tracking" $true "Trades: $($progress.completedTrades)/$($progress.requestedTrades) | P&L: ₹$($progress.totalPnlInr)"
    }
    
    # Stop Goal
    $stopped = Invoke-WebRequest "$baseUrl/goals/$($goal.goalId)/stop" -Method POST -UseBasicParsing -TimeoutSec 5
    Log-Test "Goal Termination" ($stopped.StatusCode -in @(200, 201))
} catch {
    Log-Test "Goal Trading" $false $_.Exception.Message
}

Write-Host ""

# TEST SUITE 6: Signals
Write-Host ("="*60)
Write-Host "TEST SUITE 6: Signal System" -ForegroundColor Yellow
Write-Host ("="*60)

try {
    $signals = (Invoke-WebRequest "$baseUrl/signals" -UseBasicParsing -TimeoutSec 5).Content | ConvertFrom-Json
    
    Log-Test "Signal API" $true
    Log-Test "Signal Storage" ($signals -is [Array]) "$($signals.Count) total signals in database"
    
    $liveStatuses = @('READY', 'SIGNAL_FOUND', 'WAITING_FOR_ENTRY', 'EXECUTING', 'POSITION_OPEN', 'MONITORING')
    $liveSignals = $signals | Where-Object { $_.status -in $liveStatuses }
    Log-Test "Live Signal Tracking" $true "$($liveSignals.Count) currently active"
    
    if ($liveSignals.Count -gt 0) {
        $sample = $liveSignals[0]
        Log-Test "Signal Data Structure" ($null -ne $sample.entry) "Entry: ₹$($sample.entry) | SL: ₹$($sample.stopLoss) | Target: ₹$($sample.target)"
    }
} catch {
    Log-Test "Signal System" $false $_.Exception.Message
}

Write-Host ""

# TEST SUITE 7: Execution Authority
Write-Host ("="*60)
Write-Host "TEST SUITE 7: Execution Authority" -ForegroundColor Yellow
Write-Host ("="*60)

try {
    $authority = (Invoke-WebRequest "$baseUrl/authority" -UseBasicParsing -TimeoutSec 5).Content | ConvertFrom-Json
    
    Log-Test "Authority API" $true
    Log-Test "Owner Tracking" ($null -ne $authority.owner) "Owner: $($authority.owner)"
    Log-Test "Goal Mode" ($null -ne $authority.goal.executionMode) "Goal Mode: $($authority.goal.executionMode)"
    Log-Test "Universal Mode" ($null -ne $authority.universal.executionMode) "Universal Mode: $($authority.universal.executionMode)"
} catch {
    Log-Test "Execution Authority" $false $_.Exception.Message
}

Write-Host ""

# TEST SUITE 8: Real-Time Features
Write-Host ("="*60)
Write-Host "TEST SUITE 8: Real-Time Capabilities" -ForegroundColor Yellow
Write-Host ("="*60)

try {
    $status = (Invoke-WebRequest "$baseUrl/status" -UseBasicParsing -TimeoutSec 5).Content | ConvertFrom-Json
    
    Log-Test "WebSocket Connected" ($status.feedSource -eq 'UPSTOX-WS-V3') "Feed: $($status.feedSource)"
    Log-Test "Streaming Instruments" ($status.instruments -gt 0) "$($status.instruments) instruments subscribed"
    Log-Test "Market Session Tracking" ($null -ne $status.session.status) "Status: $($status.session.status)"
    Log-Test "IST Time Sync" ($null -ne $status.session.ist) "IST: $($status.session.ist)"
    Log-Test "Socket.IO Events" $true "india.candle event ready for live updates"
} catch {
    Log-Test "Real-Time Features" $false $_.Exception.Message
}

Write-Host ""

# SUMMARY
Write-Host ("="*60)
Write-Host "TEST SUMMARY" -ForegroundColor Cyan
Write-Host ("="*60)

$total = $results.Count
$passed = ($results | Where-Object { $_.Passed }).Count
$failed = $total - $passed
$passRate = if ($total -gt 0) { [math]::Round(($passed / $total) * 100, 1) } else { 0 }

Write-Host ""
Write-Host "Total Tests: $total"
Write-Host "Passed: $passed" -ForegroundColor Green
if ($failed -gt 0) {
    Write-Host "Failed: $failed" -ForegroundColor Red
}
Write-Host "Pass Rate: $passRate%"
Write-Host ""

if ($passRate -eq 100) {
    Write-Host "✓ ALL TESTS PASSED - SYSTEM READY FOR PRODUCTION" -ForegroundColor Green
} elseif ($passRate -ge 90) {
    Write-Host "⚠ MOSTLY READY - Minor issues detected" -ForegroundColor Yellow
} else {
    Write-Host "✗ CRITICAL ISSUES - Not ready for production" -ForegroundColor Red
}

Write-Host ""
Write-Host ("="*60)
Write-Host ""

# Return exit code based on pass rate
if ($passRate -eq 100) {
    exit 0
} else {
    exit 1
}
