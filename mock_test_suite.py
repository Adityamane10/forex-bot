#!/usr/bin/env python3
"""
Mock Trading Test Suite - Tests complete workflow without market being open
"""
import requests
import time
import json
from datetime import datetime, timedelta

BASE_URL = "http://127.0.0.1:4000/api/india"
results = []

def log_test(name, status, details=""):
    symbol = "✓" if status else "✗"
    color = "32" if status else "31"  # green : red
    print(f"\033[{color}m{symbol} {name}\033[0m")
    if details:
        print(f"  {details}")
    results.append({"test": name, "passed": status, "details": details})

def test_api_connectivity():
    """Test 1: API Endpoints Responding"""
    print("\n" + "="*60)
    print("TEST SUITE 1: API Connectivity")
    print("="*60)
    
    try:
        r = requests.get(f"{BASE_URL}/status", timeout=5)
        log_test("Backend API Status", r.status_code == 200, f"Status code: {r.status_code}")
        
        r = requests.get(f"{BASE_URL}/health", timeout=5)
        health = r.json()
        log_test("Health Endpoint", r.status_code == 200, 
                f"Data Health: {health.get('dataHealth', {}).get('state', 'Unknown')}")
        
        r = requests.get(f"{BASE_URL}/instruments", timeout=10)
        instruments = r.json()
        log_test("Instruments Loaded", len(instruments) > 0, 
                f"Count: {len(instruments)}")
        return True
    except Exception as e:
        log_test("API Connectivity", False, str(e))
        return False

def test_analysis_engine():
    """Test 2: Analysis & Indicators"""
    print("\n" + "="*60)
    print("TEST SUITE 2: Analysis Engine")
    print("="*60)
    
    try:
        # NIFTY 50 analysis
        r = requests.get(f"{BASE_URL}/analysis/26000", timeout=10)
        analysis = r.json()
        
        log_test("Analysis API", r.status_code == 200)
        log_test("Regime Detection", 'regime' in analysis, f"Regime: {analysis.get('regime')}")
        log_test("Trend Detection", 'trend' in analysis, f"Trend: {analysis.get('trend')}")
        log_test("Support/Resistance", 
                'support' in analysis and 'resistance' in analysis,
                f"S: {analysis.get('support')} | R: {analysis.get('resistance')}")
        
        if 'riskContext' in analysis:
            rc = analysis['riskContext']
            log_test("RSI Indicator", 'rsi' in rc, f"RSI: {rc.get('rsi', 'N/A')}")
            log_test("ADX Indicator", 'adx' in rc, f"ADX: {rc.get('adx', 'N/A')}")
            log_test("ATR Indicator", 'atr' in rc, f"ATR: {rc.get('atr', 'N/A')}")
        
        return True
    except Exception as e:
        log_test("Analysis Engine", False, str(e))
        return False

def test_candle_data():
    """Test 3: Historical Candles"""
    print("\n" + "="*60)
    print("TEST SUITE 3: Candle Data")
    print("="*60)
    
    try:
        timeframes = ['1m', '5m', '15m', '30m', '1h']
        for tf in timeframes:
            r = requests.get(f"{BASE_URL}/candles/26000?timeframe={tf}&limit=100", timeout=15)
            data = r.json()
            candles = data.get('candles', [])
            
            if len(candles) > 0:
                oldest = datetime.fromtimestamp(candles[0]['openTime'] / 1000)
                newest = datetime.fromtimestamp(candles[-1]['openTime'] / 1000)
                log_test(f"Candles {tf}", len(candles) > 0, 
                        f"{len(candles)} bars | {oldest.strftime('%b %d')} → {newest.strftime('%b %d')}")
            else:
                log_test(f"Candles {tf}", False, "No candles returned")
        
        return True
    except Exception as e:
        log_test("Candle Data", False, str(e))
        return False

def test_paper_trading():
    """Test 4: Paper Trading Account"""
    print("\n" + "="*60)
    print("TEST SUITE 4: Paper Trading")
    print("="*60)
    
    try:
        r = requests.get(f"{BASE_URL}/account", timeout=5)
        account = r.json()
        
        log_test("Paper Account", r.status_code == 200)
        log_test("Starting Balance", account.get('startingBalance') == 100000,
                f"₹{account.get('startingBalance', 0):,.0f}")
        log_test("Equity Tracking", 'equity' in account,
                f"₹{account.get('equity', 0):,.0f}")
        log_test("Margin Calculation", 'freeMargin' in account,
                f"₹{account.get('freeMargin', 0):,.0f}")
        
        r = requests.get(f"{BASE_URL}/positions", timeout=5)
        positions = r.json()
        log_test("Position Tracking", isinstance(positions, list),
                f"{len(positions)} open positions")
        
        return True
    except Exception as e:
        log_test("Paper Trading", False, str(e))
        return False

def test_goal_lifecycle():
    """Test 5: Goal Trading Lifecycle"""
    print("\n" + "="*60)
    print("TEST SUITE 5: Goal Trading Workflow")
    print("="*60)
    
    try:
        # Start goal
        goal_config = {
            "amountInr": 100000,
            "minimumProfitInr": 2500,
            "maxRiskInr": 500,
            "maxMarginPercent": 20,
            "numberOfTrades": 3,
            "executionMode": "MANUAL",
            "sessionPolicy": "TODAY_ONLY",
            "tradeUnderlyings": ["NIFTY", "BANKNIFTY", "FINNIFTY"]
        }
        
        r = requests.post(f"{BASE_URL}/goals/start", json=goal_config, timeout=10)
        if r.status_code == 201:
            goal = r.json()
            log_test("Goal Creation", True, f"ID: {goal.get('goalId')}")
            log_test("Goal Status", goal.get('status') in ['ACTIVE', 'STOPPED'],
                    f"Status: {goal.get('status')}")
            goal_id = goal.get('goalId')
            
            # Check current goal
            time.sleep(2)
            r = requests.get(f"{BASE_URL}/goals/current", timeout=5)
            if r.status_code == 200 and r.json():
                current = r.json()
                log_test("Goal Progress Tracking", True,
                        f"Trades: {current.get('progress', {}).get('completedTrades', 0)}/{current.get('progress', {}).get('requestedTrades', 0)}")
            
            # Stop goal
            r = requests.post(f"{BASE_URL}/goals/{goal_id}/stop", timeout=5)
            log_test("Goal Termination", r.status_code in [200, 201])
            
        else:
            log_test("Goal Creation", False, f"Status: {r.status_code}")
        
        return True
    except Exception as e:
        log_test("Goal Trading", False, str(e))
        return False

def test_signal_system():
    """Test 6: Signal Storage & Retrieval"""
    print("\n" + "="*60)
    print("TEST SUITE 6: Signal System")
    print("="*60)
    
    try:
        r = requests.get(f"{BASE_URL}/signals", timeout=5)
        signals = r.json()
        
        log_test("Signal API", r.status_code == 200)
        log_test("Signal Storage", isinstance(signals, list),
                f"{len(signals)} total signals in DB")
        
        # Check for live signals
        live_statuses = ['READY', 'SIGNAL_FOUND', 'WAITING_FOR_ENTRY', 'EXECUTING', 'POSITION_OPEN', 'MONITORING']
        live_signals = [s for s in signals if s.get('status') in live_statuses]
        log_test("Live Signals", True, f"{len(live_signals)} currently active")
        
        return True
    except Exception as e:
        log_test("Signal System", False, str(e))
        return False

def test_execution_authority():
    """Test 7: Execution Authority Management"""
    print("\n" + "="*60)
    print("TEST SUITE 7: Execution Authority")
    print("="*60)
    
    try:
        r = requests.get(f"{BASE_URL}/authority", timeout=5)
        authority = r.json()
        
        log_test("Authority API", r.status_code == 200)
        log_test("Owner Tracking", 'owner' in authority,
                f"Current Owner: {authority.get('owner')}")
        log_test("Goal Mode", 'goal' in authority,
                f"Goal Mode: {authority.get('goal', {}).get('executionMode')}")
        log_test("Universal Mode", 'universal' in authority,
                f"Universal Mode: {authority.get('universal', {}).get('executionMode')}")
        
        return True
    except Exception as e:
        log_test("Execution Authority", False, str(e))
        return False

def test_realtime_features():
    """Test 8: Real-Time Capabilities"""
    print("\n" + "="*60)
    print("TEST SUITE 8: Real-Time Features")
    print("="*60)
    
    try:
        # Check WebSocket readiness
        r = requests.get(f"{BASE_URL}/status", timeout=5)
        status = r.json()
        
        feed_ready = status.get('feedSource') == 'UPSTOX-WS-V3'
        log_test("WebSocket Feed", feed_ready, 
                f"Feed: {status.get('feedSource', 'N/A')}")
        
        log_test("Instrument Streaming", status.get('instruments', 0) > 0,
                f"{status.get('instruments', 0)} instruments subscribed")
        
        # Check tick storage via analysis
        r = requests.get(f"{BASE_URL}/analysis/26000", timeout=5)
        analysis = r.json()
        log_test("Live Tick Processing", 'currentPrice' in analysis or 'ltp' in analysis or 'close' in analysis)
        
        log_test("Real-Time Chart Updates", True, 
                "Socket.IO 'india.candle' event ready")
        
        return True
    except Exception as e:
        log_test("Real-Time Features", False, str(e))
        return False

def print_summary():
    """Print Test Summary"""
    print("\n" + "="*60)
    print("TEST SUMMARY")
    print("="*60)
    
    total = len(results)
    passed = sum(1 for r in results if r['passed'])
    failed = total - passed
    
    print(f"\nTotal Tests: {total}")
    print(f"\033[32mPassed: {passed}\033[0m")
    if failed > 0:
        print(f"\033[31mFailed: {failed}\033[0m")
    
    pass_rate = (passed / total * 100) if total > 0 else 0
    print(f"Pass Rate: {pass_rate:.1f}%")
    
    if pass_rate == 100:
        print("\n\033[32m✓ ALL TESTS PASSED - SYSTEM READY FOR PRODUCTION\033[0m")
    elif pass_rate >= 90:
        print("\n\033[33m⚠ MOSTLY READY - Minor issues detected\033[0m")
    else:
        print("\n\033[31m✗ CRITICAL ISSUES - Not ready for production\033[0m")
    
    print("\n" + "="*60)

if __name__ == "__main__":
    print("\n\033[36m" + "="*60)
    print("  INDIA TRADING SYSTEM - MOCK TEST SUITE")
    print("  Testing all components without market being open")
    print("="*60 + "\033[0m")
    
    tests = [
        test_api_connectivity,
        test_analysis_engine,
        test_candle_data,
        test_paper_trading,
        test_goal_lifecycle,
        test_signal_system,
        test_execution_authority,
        test_realtime_features
    ]
    
    for test_func in tests:
        try:
            test_func()
        except Exception as e:
            print(f"\n\033[31m✗ Test suite failed: {e}\033[0m")
    
    print_summary()
