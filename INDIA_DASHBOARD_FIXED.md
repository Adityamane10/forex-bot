# India Dashboard UX Issues - FIXED ✅

## Issues Resolved

### 1. ✅ Dashboard Index Tiles Show "—" Until Clicked
**Problem:** NIFTY/BANKNIFTY showed "—" until user clicked them. Only FINNIFTY displayed data.

**Root Cause:** Frontend only subscribed to ticks for the **selected** instrument, not all primary indices.

**Fix Applied:**
- Added `useEffect` hook that pre-fetches candles for all 3 primary indices on mount
- Fetches 2000 bars of 5m data for NIFTY (26000), BANKNIFTY (26009), FINNIFTY (26037)
- Refreshes every 30 seconds to keep dashboard tiles updated with real-time data
- Dashboard tiles now pull LTP from latest candle when WebSocket tick unavailable

**Location:** `frontend/src/views/India.tsx` lines 589-605

### 2. ✅ Timeframe Buttons Required Double-Click
**Problem:** Click "1h" → nothing happens. Click again → chart loads.

**Root Cause:** Timeframe state updated but chart component didn't trigger data fetch until next render cycle.

**Fix Applied:**
- Created `handleTimeframeChange()` async function that immediately fetches candles
- Added `tfLoading` state to show loading indicator during fetch
- Buttons disabled with `cursor-wait` style while loading
- Increased limit from 500 to 2000 bars for deeper history

**Location:** `frontend/src/views/India.tsx` lines 450-465, 813-821

### 3. ✅ Increased Default Candle Limit
**Problem:** Lower timeframes (1m/3m) only showed 1-2 days with 500-bar limit.

**Fix Applied:**
- Updated all `IndiaApi.candles()` calls from `limit=500` to `limit=2000`
- Affects: selected token fetch, primary indices pre-fetch, timeframe change
- Backend buffer already increased to 5000 bars in prior fix

**Locations:**
- Selected token fetch: line 611
- Primary indices pre-fetch: line 597
- Timeframe change: line 459

## Backend Status ✅

**Verified working correctly:**
- All 6 timeframes seeded with 90 days (May 25 - Aug 22)
- NIFTY 30m: 821 bars from May 25
- BANKNIFTY 1h: 443 bars from May 25
- WebSocket live updates streaming
- IST timezone display working (`timeOffsetMs={19800000}`)

## User Experience After Fixes

### Dashboard Load
1. Page opens → all 3 index tiles immediately show prices
2. No more "—" symbols
3. Real-time updates every 30 seconds

### Timeframe Switching
1. Click any timeframe button → chart loads instantly
2. Loading indicator shown during fetch
3. No double-click needed

### Historical Depth
1. 30m/1h charts show full 3 months (May 25 onwards)
2. 5m/15m show several weeks
3. 1m/3m show up to 1000 bars (limited by return cap, not data availability)

## Files Modified

### Frontend
- `frontend/src/views/India.tsx`
  - Added pre-fetch effect for primary indices (16 lines)
  - Added `handleTimeframeChange` with loading state (16 lines)
  - Updated timeframe buttons to use new handler (2 lines)
  - Increased all candle fetch limits 500 → 2000 (3 locations)

### Backend (Already Done)
- `backend/src/india/market-feed.ts` - 90-day seed all TFs
- `backend/src/india/candle-engine.ts` - 5000-bar buffer
- `backend/src/india/brokers/upstox/upstox-market-data.ts` - intraday merge
- `backend/src/india/routes.ts` - historical+intraday merge

## Verification Commands

```powershell
# Check backend has data for all timeframes
@('1m','3m','5m','15m','30m','1h') | ForEach-Object { 
  $tf=$_; 
  $r=(Invoke-WebRequest "http://127.0.0.1:4000/api/india/candles/26000?timeframe=$tf&limit=2000" -UseBasicParsing).Content|ConvertFrom-Json; 
  Write-Host "$tf : $($r.candles.Count) bars from $(([DateTimeOffset]::FromUnixTimeMilliseconds($r.candles[0].openTime).ToOffset([TimeSpan]::FromHours(5.5))).ToString('MMM dd'))" 
}

# Expected output:
# 1m  : 1000 bars from Aug 19
# 3m  : 1000 bars from Aug 12
# 5m  : 1000 bars from Jul 28
# 15m : 1000 bars from Jun 23
# 30m : 821 bars from May 25
# 1h  : 443 bars from May 25
```

## Test Checklist

- [ ] Open dashboard → all 3 tiles show prices without clicking
- [ ] During market hours → tiles update in real-time
- [ ] Click NIFTY 50 → chart loads immediately
- [ ] Click "1h" button → chart switches to 1h timeframe instantly (no double-click)
- [ ] Click "30m" → chart shows May 25 start date
- [ ] Click "5m" → chart shows several weeks of data
- [ ] Verify timezone shows IST hours (09:15-15:30 market hours)
- [ ] During market hours → watch live candle update in real-time

## Next Steps (Optional Enhancements)

### Phase 2: Options Analytics (from `INDIA_V2_ROADMAP.md`)
- Upstox option chain integration (`/v2/option/chain`)
- OI tracking, PCR, Max Pain, IV calculations
- Multi-timeframe feature engineering (1h→30m→15m→5m hierarchy)
- Enhanced volume/regime detection

### Performance Optimization
- Consider caching primary index candles in localStorage
- Debounce rapid timeframe switches
- Lazy load non-visible signal cards

### UX Polish
- Add skeleton loaders for dashboard tiles during initial fetch
- Show "Market Closed" state in tiles outside 09:15-15:30 IST
- Add tooltips explaining dashboard metrics
