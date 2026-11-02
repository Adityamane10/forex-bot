# India Market V2 Enhancement Roadmap

## Current State (V1)
**Technical Indicators** ✅
- EMA 9/20/50, SMA 20/50
- RSI 14
- MACD (line, signal, histogram)
- ATR 14
- ADX
- Bollinger Bands
- VWAP
- Swing highs/lows
- Support/Resistance detection
- Market structure (higher-high, lower-low, breakouts)

**ML Pipeline** ✅
- Feature engineering from indicators
- Regime detection (0-8 scale combining ADX/EMA/volatility)
- Strategy selection (BREAKOUT/TREND_FOLLOW/MEAN_REVERSION)
- Optional AI model predictions
- Stop-loss/Take-profit calculation using ATR

## Missing Components for Production Indian Derivatives Trading

### 1. Options Analytics (HIGH PRIORITY)
Currently missing derivatives-specific data required for NIFTY/BANKNIFTY/FINNIFTY options:

**Open Interest (OI) Analytics**
- [ ] Call OI per strike
- [ ] Put OI per strike
- [ ] Change in Call OI (intraday & day-over-day)
- [ ] Change in Put OI (intraday & day-over-day)
- [ ] OI buildup detection (Long buildup, Short buildup, Long unwinding, Short unwinding)
- [ ] OI concentration by strike range
- [ ] Max Pain calculation
- [ ] PCR (Put-Call Ratio) - total, by strike, by underlying

**IV (Implied Volatility) Analytics**
- [ ] Strike-wise IV
- [ ] ATM IV
- [ ] IV percentile (relative to 30/60/90 day range)
- [ ] IV skew (put skew vs call skew)
- [ ] IV change intraday

**Option Chain Structure**
- [ ] ATM strike identification
- [ ] ITM/OTM classification
- [ ] Moneyness calculation
- [ ] Bid/ask spread analysis
- [ ] Option volume by strike
- [ ] Option turnover by strike
- [ ] Greeks (Delta, Gamma, Theta, Vega) if calculable

**Data Sources Required:**
- Upstox `/v2/option/chain` endpoint
- NSE Option Chain API (public/unofficial)
- Store historical OI snapshots for change calculation

### 2. Volume Analysis Enhancements
Current: basic volume tracking
Missing:
- [ ] Relative volume (vs N-day average)
- [ ] Volume moving average (20-period)
- [ ] Volume spike detection (> 2× average)
- [ ] Price-volume confirmation (e.g., breakout on high volume)
- [ ] Volume profile / VWAP bands
- [ ] Cumulative volume delta (CVD) if tick data available

### 3. Market Depth & Microstructure
If Upstox WebSocket provides Level-2 data:
- [ ] Bid/ask imbalance
- [ ] Order book depth (top 5 levels)
- [ ] Spread analysis
- [ ] Large order detection

### 4. Multi-Timeframe Analysis (CRITICAL)
Current: single timeframe (5m default)
Required: hierarchical timeframe context

**Architecture:**
```
1h    → Major trend, key S/R levels
30m   → Intermediate structure, trend confirmation
15m   → Short-term trend
5m    → Entry timeframe (current primary)
3m    → Precision entry/exit
1m    → Order execution context
```

**Implementation:**
- [ ] Multi-TF feature pipeline
- [ ] Trend alignment check across TFs
- [ ] Higher-TF S/R projected to lower TF
- [ ] Divergence detection across TFs
- [ ] Configurable TF hierarchy per strategy

### 5. Enhanced Market Regime Detection
Current: 0-8 regime based on ADX/EMA/volatility
Missing:
- [ ] Volatility regime (low/med/high using realized volatility + IV)
- [ ] ATR regime (current ATR vs 20-day average)
- [ ] Volume regime (average, above-average, spike)
- [ ] Trend strength regime (weak/moderate/strong using ADX + price action)
- [ ] Market phase (accumulation, markup, distribution, markdown)
- [ ] Session context (opening range, midday consolidation, closing auction)

### 6. India-Specific Market Context
- [ ] Market-wide advance/decline ratio
- [ ] INDIA VIX integration
- [ ] FII/DII flow data (if available)
- [ ] Sectoral rotation (NIFTY sectors)
- [ ] Index correlation (NIFTY vs BANKNIFTY divergence)
- [ ] Global cues (SGX Nifty, US futures if trading pre-market)

### 7. Order Execution & Slippage Management
Current: paper execution only
For live trading:
- [ ] Order routing to Upstox/Zerodha
- [ ] Bracket orders (entry + SL + target)
- [ ] OCO orders
- [ ] Partial position sizing
- [ ] Slippage tracking
- [ ] Fill rate monitoring
- [ ] Retry logic for rejected orders

### 8. Risk Engine Enhancements
Current: basic position sizing
Missing:
- [ ] Portfolio heat (total risk across all positions)
- [ ] Correlation-adjusted position sizing
- [ ] Max drawdown tracking
- [ ] Kelly criterion for sizing
- [ ] Greeks-based hedging suggestions
- [ ] Exposure limits by underlying/segment
- [ ] Daily loss limits

## V2 ML Pipeline Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      UPSTOX REAL-TIME DATA                       │
├─────────────────────────────────────────────────────────────────┤
│  • WebSocket Ticks (price, volume, OI)                          │
│  • REST APIs (historical candles, option chain, account)        │
└────────────────────┬────────────────────────────────────────────┘
                     ↓
┌─────────────────────────────────────────────────────────────────┐
│                    TICK & CANDLE ENGINE                          │
├─────────────────────────────────────────────────────────────────┤
│  • Tick validation & sequencing                                 │
│  • Multi-timeframe candle building                              │
│  • Real-time OHLCV + OI tracking                                │
└──────┬──────────────────────────────────────────┬───────────────┘
       ↓                                          ↓
┌──────────────────────┐              ┌──────────────────────────┐
│ TECHNICAL FEATURES   │              │   OPTIONS FEATURES       │
├──────────────────────┤              ├──────────────────────────┤
│ • EMA/SMA/RSI        │              │ • Call/Put OI            │
│ • MACD/ADX           │              │ • PCR                    │
│ • ATR/BB/VWAP        │              │ • Max Pain               │
│ • Market structure   │              │ • IV & IV change         │
│ • Support/Resistance │              │ • Option volume          │
│ • Multi-TF context   │              │ • Bid/ask spread         │
│ • Volume analysis    │              │ • OI buildup/unwinding   │
└──────┬───────────────┘              └──────────┬───────────────┘
       └──────────────┬────────────────────────────┘
                      ↓
         ┌────────────────────────────┐
         │   MARKET STATE ENGINE      │
         ├────────────────────────────┤
         │ • Regime classification    │
         │ • Volatility state         │
         │ • Volume state             │
         │ • Session context          │
         │ • Multi-TF alignment       │
         └────────────┬───────────────┘
                      ↓
         ┌────────────────────────────┐
         │   INDIA V2 ML PIPELINE     │
         ├────────────────────────────┤
         │ • Feature engineering      │
         │ • Primary model            │
         │ • Ensemble/stacking        │
         │ • Meta-labeling            │
         │ • Probability calibration  │
         │ • Purged walk-forward CV   │
         └────────────┬───────────────┘
                      ↓
         ┌────────────────────────────┐
         │      RISK ENGINE           │
         ├────────────────────────────┤
         │ • Position sizing          │
         │ • SL/TP calculation        │
         │ • Portfolio heat           │
         │ • Correlation adjustment   │
         │ • Exposure limits          │
         └────────────┬───────────────┘
                      ↓
         ┌────────────────────────────┐
         │     SIGNAL ENGINE          │
         ├────────────────────────────┤
         │ • Entry/exit logic         │
         │ • Filter application       │
         │ • Signal scoring           │
         │ • Priority ranking         │
         └────────────┬───────────────┘
                      ↓
         ┌────────────────────────────┐
         │  EXECUTION ENGINE          │
         ├────────────────────────────┤
         │ • Goal Trading             │
         │ • Universal Signals        │
         │ • Paper Execution          │
         │ • Live Order Routing       │
         └────────────────────────────┘
```

## Implementation Priority

### Phase 1: Core Options Analytics (4-6 weeks)
1. Upstox option chain integration
2. OI tracking & change calculation
3. PCR calculation
4. Max Pain calculation
5. Basic IV tracking

### Phase 2: Multi-Timeframe & Volume (2-3 weeks)
1. Multi-TF candle engine refactor
2. Relative volume & volume spikes
3. Higher-TF S/R levels
4. TF alignment checks

### Phase 3: Enhanced Regime Detection (2 weeks)
1. Volatility regime using RV + IV
2. ATR-based volatility bands
3. Market phase classification
4. Session context awareness

### Phase 4: Live Execution (4-6 weeks)
1. Upstox live order routing
2. Bracket order support
3. Slippage tracking
4. Risk limits enforcement

### Phase 5: V2 ML Pipeline (6-8 weeks)
1. Options features in training pipeline
2. Multi-TF feature engineering
3. Model retraining with V2 features
4. Walk-forward validation on 2+ years data

## Key Design Principles

1. **No Overfitting**: Don't add 30 indicators just to have more. Focus on non-redundant, derivatives-specific features.

2. **Validation First**: Backtest every new feature on out-of-sample data before deploying.

3. **Real-Time Performance**: Option chain updates every second, ensure low-latency processing.

4. **Fail-Safe**: If OI data unavailable, system falls back to technical-only mode.

5. **Explainability**: Every signal must show which features contributed to the decision.

## Current Gaps Summary

| Category | Current | Missing | Priority |
|---|---|---|---|
| Technical Indicators | 9 core indicators | None (sufficient) | — |
| Options Analytics | None | Full OI/PCR/IV suite | **CRITICAL** |
| Volume Analysis | Basic | Relative vol, spikes | HIGH |
| Multi-Timeframe | Single TF | TF hierarchy | **CRITICAL** |
| Market Regime | Basic (0-8) | Volatility/volume regimes | HIGH |
| Market Context | None | Advance/decline, VIX, FII/DII | MEDIUM |
| Execution | Paper only | Live routing | HIGH |
| Risk Management | Basic sizing | Portfolio heat, Greeks | HIGH |

## Next Steps

1. Review this roadmap with development team
2. Prioritize Phase 1 (Options Analytics) for immediate implementation
3. Set up NSE option chain data pipeline
4. Begin backtest infrastructure for V2 features
5. Plan compute resources for increased feature dimensionality
