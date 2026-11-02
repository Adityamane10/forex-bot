# Dashboard & Chart UX Issues - Frontend Fixes Needed

## Issue 1: Dashboard Index Tiles Show "—" Until Clicked

**Current Behavior:**
```
NIFTY 50        BANK NIFTY      FIN NIFTY
—               —               +0.00%
                                26,261
```

Only FINNIFTY shows data because it was clicked. NIFTY/BANKNIFTY show "—" until user clicks them.

**Root Cause:**
The `India.tsx` component only subscribes to ticks for the **selected** instrument, not all primary indices.

**Location:** `frontend/src/views/India.tsx`

**Current Code Pattern:**
```typescript
const selectedTick = useSelector((s: RootState) => 
  selectedInstr ? s.india.ticks[selectedInstr.instrumentToken] : null
);
```

**Fix Needed:**
1. Subscribe to ticks for ALL primary index tokens on mount:
   ```typescript
   useEffect(() => {
     // Pre-fetch primary index data
     const primaryTokens = ['26000', '26009', '26037']; // NIFTY, BANKNIFTY, FINNIFTY
     
     for (const token of primaryTokens) {
       // Fetch latest tick/LTP
       IndiaApi.getAnalysis(token).catch(() => {});
       
       // Fetch candles for 5m timeframe
       IndiaApi.getCandles(token, '5m', 500).then(data => {
         dispatch(actions.india.candles({
           token, timeframe: '5m', candles: data.candles 
         }));
       }).catch(() => {});
     }
   }, []);
   ```

2. Display LTP for all primary indices in the dashboard tiles:
   ```typescript
   const niftyTick = useSelector((s: RootState) => s.india.ticks['26000']);
   const bankniftyTick = useSelector((s: RootState) => s.india.ticks['26009']);
   const finniftyTick = useSelector((s: RootState) => s.india.ticks['26037']);
   ```

3. Render tiles with real-time data:
   ```typescript
   <IndexTile 
     name="NIFTY 50" 
     token="26000"
     tick={niftyTick}
     selected={selectedToken === '26000'}
     onClick={() => selectIndex('26000')}
   />
   ```

## Issue 2: Timeframe Buttons Require Double-Click

**Current Behavior:**
- Click "1h" → nothing happens
- Click "1h" again → chart loads

**Root Cause:**
The timeframe state updates, but the chart component doesn't trigger a data fetch until the next render cycle.

**Location:** `frontend/src/views/India.tsx` 

**Current Code Pattern:**
```typescript
const handleTimeframeChange = (tf: IndiaTimeframe) => {
  setSelectedTimeframe(tf);
  // Chart doesn't immediately fetch because selectedCandles memo 
  // hasn't recomputed yet
};
```

**Fix Needed:**
1. Immediately fetch candles when timeframe changes:
   ```typescript
   const handleTimeframeChange = async (tf: IndiaTimeframe) => {
     setSelectedTimeframe(tf);
     
     if (!selectedInstr) return;
     
     // Immediate fetch
     try {
       const data = await IndiaApi.getCandles(
         selectedInstr.instrumentToken, 
         tf, 
         2000  // increased from 500
       );
       dispatch(actions.india.candles({
         token: selectedInstr.instrumentToken,
         timeframe: tf,
         candles: data.candles
       }));
     } catch (err) {
       console.error('Candle fetch failed:', err);
     }
   };
   ```

2. Add loading state to show spinner during fetch:
   ```typescript
   const [tfLoading, setTfLoading] = useState(false);
   
   const handleTimeframeChange = async (tf: IndiaTimeframe) => {
     setTfLoading(true);
     setSelectedTimeframe(tf);
     // ... fetch logic ...
     setTfLoading(false);
   };
   ```

## Issue 3: Increase Default Candle Limit

**Current:** Frontend requests 500 bars by default
**Problem:** Lower timeframes (1m/3m) show only 1-2 days with 500 bars

**Fix:**
1. Update default limit in API calls:
   ```typescript
   // In frontend/src/api.ts
   getCandles: (token: string, timeframe: string, limit = 2000) => 
     api(`/india/candles/${token}?timeframe=${timeframe}&limit=${limit}`)
   ```

2. Update Redux initial fetch:
   ```typescript
   // In frontend/src/views/India.tsx
   useEffect(() => {
     if (selectedInstr) {
       IndiaApi.getCandles(
         selectedInstr.instrumentToken, 
         selectedTimeframe, 
         2000  // <-- increased from 500
       ).then(data => {
         dispatch(actions.india.candles({
           token: selectedInstr.instrumentToken,
           timeframe: selectedTimeframe,
           candles: data.candles
         }));
       });
     }
   }, [selectedInstr, selectedTimeframe]);
   ```

## Backend Changes Already Applied ✅

1. ✅ Buffer increased to 5000 bars
2. ✅ All 6 timeframes seeded with 90 days (3 months) of data
3. ✅ Live candle updates emit on every WebSocket tick
4. ✅ IST timezone display via `timeOffsetMs`
5. ✅ Historical + Intraday + WebSocket merged architecture

## Verification After Frontend Fixes

1. Open dashboard → all 3 index tiles should show prices immediately
2. Click any timeframe button → chart loads instantly
3. Check 30m/1h timeframes → should show 3 months of history (May 25 onwards)
4. During market hours → watch chart update in real-time as ticks arrive

## Priority

**HIGH PRIORITY:**
- Issue #1 (Dashboard tiles) - Poor UX, looks broken
- Issue #2 (Double-click) - Confusing for users

**MEDIUM:**
- Issue #3 (Increase limits) - Nice to have for deeper history on lower TFs
