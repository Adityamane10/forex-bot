You are continuing an existing production-oriented market analysis and paper-trading application.

DO NOT rebuild the existing Forex/Crypto system from scratch.

Your task is to inspect the CURRENT CODEBASE first, understand what has already been implemented, identify exactly what is missing, and then implement a completely separate INDIAN MARKET subsystem inside the existing application.

The Indian subsystem must be architecturally isolated from Forex and Crypto while reusing only genuinely market-agnostic infrastructure such as authentication, Redis, MongoDB, Socket.IO, React state management, charting components, common risk primitives, testing utilities, and shared types where appropriate.

============================================================
1. CURRENT EXISTING TECHNOLOGY STACK
============================================================

The existing application currently uses:

Backend:
- TypeScript 5.5
- strict TypeScript
- Node.js 22
- tsx
- Express 4.19
- Socket.IO 4.7
- Zod 3.23
- JWT
- bcryptjs
- helmet
- cors
- rate limiting
- MongoDB 6 driver
- Redis/ioredis
- Yahoo Finance
- Binance WebSocket
- CCXT 4.5

Frontend:
- React 18.3
- Redux Toolkit 2.2
- Vite 5
- TailwindCSS 3.4
- lightweight-charts 4.2
- Recharts 2.12

ML/Python:
- FastAPI
- uvicorn
- scikit-learn
- XGBoost
- LightGBM
- numpy
- pandas
- joblib

Testing:
- Vitest
- pytest
- existing backend tests
- existing frontend tests

Existing functionality includes:
- Forex real-time market data through MT5
- Crypto real-time Binance WebSocket data
- real-time charts
- scanner
- signals
- positions
- paper trading
- risk
- prediction service
- historical data/backtesting
- news/sentiment components
- Socket.IO real-time UI updates

Do not break any of this.

============================================================
2. CORE OBJECTIVE
============================================================

Add a new completely separate:

INDIAN MARKET

section.

It must behave as a real Indian intraday market subsystem.

Primary initial instruments:

- NIFTY 50
- BANKNIFTY
- FINNIFTY
- MIDCPNIFTY
- supported NSE/BSE index derivatives where the selected broker provides them
- futures
- options
- later expansion to other supported F&O instruments

The initial focus is INTRADAY trading.

The system must use REAL market data.

Absolutely NO:
- fake prices
- random prices
- synthetic ticks
- simulated live movement
- stale data presented as current
- timer-generated fake candles
- Yahoo Finance polling as the authoritative execution feed
- fabricated option prices
- fabricated expiry information

============================================================
3. AUTHORITATIVE DATA SOURCE
============================================================

For Indian live trading, use an authorized broker market-data WebSocket.

Implement a clean broker adapter architecture.

Create:

IndiaBrokerAdapter

with interfaces for:

- connect()
- disconnect()
- authenticate()
- subscribe()
- unsubscribe()
- streamTicks()
- getQuote()
- getInstruments()
- getHistoricalCandles()
- getOrders()
- getPositions()
- getAccount()
- placeOrder()
- modifyOrder()
- cancelOrder()

The initial broker implementation should support the broker selected by the user, preferably:

- Zerodha Kite Connect
OR
- Upstox

Do not make an unofficial scraper the primary execution feed.

The broker WebSocket is the source of truth for live prices.

Use broker/exchange-provided:
- instrument identifiers
- instrument tokens
- trading symbols
- expiry
- strike
- option type
- lot size
- tick size
- exchange segment
- live quote
- bid/ask
- LTP
- volume
- open interest where available

============================================================
4. BROKER ADAPTER ABSTRACTION
============================================================

Create:

backend/src/india/brokers/

Possible structure:

india/
  brokers/
    types.ts
    broker-adapter.ts
    zerodha/
      zerodha-adapter.ts
      zerodha-auth.ts
      zerodha-market-data.ts
      zerodha-orders.ts
    upstox/
      upstox-adapter.ts
      upstox-auth.ts
      upstox-market-data.ts
      upstox-orders.ts

Do not allow the rest of the Indian engine to depend directly on Zerodha or Upstox classes.

All market logic must depend on:

IndiaBrokerAdapter

This allows changing brokers without rewriting the analysis engine.

============================================================
5. GITHUB REPOSITORIES
============================================================

The following repositories were previously researched.

Use them ONLY where they provide genuine value.

DO NOT blindly import all repositories.

------------------------------------------------------------
Fenix
------------------------------------------------------------

Repository:
https://github.com/TheHardeep/fenix

Fenix is a unified Python API for multiple Indian brokers.

Use it as:
- broker abstraction reference
- instrument normalization reference
- order/position/account normalization reference
- potentially as a broker adapter layer ONLY if its current implementation is compatible with the existing application

Do NOT introduce Python into the live market path merely because Fenix exists.

Our existing primary backend is TypeScript/Node.

If direct official broker APIs are cleaner, implement the official broker adapter directly.

------------------------------------------------------------
uniBroker
------------------------------------------------------------

Repository:
https://github.com/SU1199/uniBroker

Evaluate it during implementation.

If it provides useful broker abstraction concepts, use those ideas.

Do not introduce it as a dependency unless it is actively maintained, compatible with the current architecture, and materially improves the Indian broker adapter.

------------------------------------------------------------
NSEPython
------------------------------------------------------------

Repository:
https://github.com/aeron7/nsepython

Use only for supplementary/reference NSE data if required.

Possible uses:
- market-status/reference information
- NSE public data
- research
- historical/reference information
- option-chain/reference analysis where legally/technically appropriate

DO NOT use NSEPython as the primary live WebSocket market feed.

DO NOT use it for execution.

------------------------------------------------------------
Bharat-SM-Data
------------------------------------------------------------

Repository:
https://github.com/Sampad-Hegde/Bharat-SM-Data

Use only where useful for:
- historical/reference data
- derivatives research
- supplemental NSE/BSE data
- development/backfill where appropriate

Do not make it the authoritative live trading feed.

Verify licensing, source availability, reliability, rate limits and legal usage before production use.

------------------------------------------------------------
PaperTrade Broker
------------------------------------------------------------

Repository:
https://github.com/jerinisready/paper-trade-broker

Use as:
- reference for paper broker concepts
- order lifecycle ideas
- account/fund/order/portfolio simulation concepts

DO NOT introduce a second Django backend into the existing Node application unless there is a strong technical reason.

The existing TypeScript paper execution engine remains the main paper broker.

------------------------------------------------------------
LEAN Zerodha Brokerage
------------------------------------------------------------

Repository:
https://github.com/QuantConnect/Lean.Brokerages.Zerodha

Use as:
- reference for Zerodha brokerage modeling
- order behavior
- brokerage/margin concepts
- backtesting/live separation
- security master concepts

Do not import the whole LEAN engine into the project.

------------------------------------------------------------
Indian Algorithmic Trading Community
------------------------------------------------------------

Repository:
https://github.com/Indian-Algorithmic-Trading-Community

Use it as a source for relevant open-source Indian algorithmic trading projects and patterns.

Do not add the organization itself as a runtime dependency.

------------------------------------------------------------
Indian Stock Market GitHub topic
------------------------------------------------------------

https://github.com/topics/indian-stock-market

Use it for discovery only.

Do not install random repositories from the topic.

Every dependency must pass:
- maintenance check
- license check
- API reliability check
- compatibility check
- security review
- real-time suitability check

============================================================
6. REAL-TIME DATA REQUIREMENT
============================================================

The Indian module MUST be event-driven.

Architecture:

Broker WebSocket
    ↓
India Market Data Adapter
    ↓
Tick Normalizer
    ↓
Data Validation
    ↓
Redis
    ↓
Tick Engine
    ↓
Candle Engine
    ↓
Indicators
    ↓
Analysis
    ↓
Prediction
    ↓
Signal Engine
    ↓
Risk Engine
    ↓
Execution Engine
    ↓
Socket.IO
    ↓
React
    ↓
lightweight-charts

Do NOT use frontend polling as the primary real-time mechanism.

Do NOT use REST polling every few seconds as the primary live market feed.

REST can be used for:
- initial state
- historical data
- reconciliation
- instrument master
- recovery
- account data
- order status

WebSocket is the primary live feed.

============================================================
7. TICK NORMALIZATION
============================================================

Normalize broker ticks into a common structure.

Example:

IndiaTick:

- exchange
- segment
- instrumentToken
- tradingSymbol
- underlying
- timestamp
- ltp
- bid
- ask
- bidQuantity
- askQuantity
- volume
- openInterest
- dayOpen
- dayHigh
- dayLow
- previousClose
- lastTradeQuantity
- source
- receivedAt
- marketTimestamp

Never overwrite marketTimestamp with server receive time.

Store both:
- exchange/broker timestamp
- local receive timestamp

This is important for latency and debugging.

============================================================
8. DATA HEALTH
============================================================

Create:

IndiaMarketDataHealthService

Track:

- WebSocket connected
- authentication status
- subscription status
- last tick timestamp
- last heartbeat
- tick age
- reconnect count
- dropped messages if detectable
- stale state
- instrument subscription health

If market is supposed to be open but ticks become stale:

DATA_STALE

Then:

- stop new signals
- stop new automatic trades
- stop automatic execution
- show warning in UI
- attempt reconnect
- require healthy data before resuming execution

Never silently switch to fake data.

Never silently use an old cached tick as a current tick.

============================================================
9. MARKET SESSION ENGINE
============================================================

Create:

IndiaMarketSessionService

The backend must be authoritative.

Use:
Asia/Kolkata

Store timestamps internally in UTC where appropriate, but convert to IST for Indian market logic/UI.

The session engine must know:
- current date
- current IST time
- weekday
- exchange holiday
- special trading day
- pre-open state if relevant
- market open
- market close
- segment status

Do not use the user's phone clock.

============================================================
10. MARKET CLOSED BEHAVIOR
============================================================

This is a hard requirement.

When Indian market is closed:

- no new live ticks
- no simulated movement
- no candle movement
- no indicator updates based on fabricated ticks
- no new executable signals
- no automatic new trades
- no paper order generation
- no fake chart movement

The UI may remain open.

The last real price may remain displayed.

But it must clearly say:

MARKET CLOSED

The chart must stop moving.

Do not create candles using setInterval after market close.

When market reopens:
- reconnect/verify data
- obtain fresh live ticks
- rebuild/reconcile current candle state
- recalculate indicators
- run fresh analysis
- generate new signals

Never execute an old queued signal from before market close.

============================================================
11. CONTRACT MASTER
============================================================

Create:

IndiaInstrumentService

It must obtain actual broker instrument metadata.

Do not hard-code option contracts.

Store:

- instrumentToken
- exchange
- segment
- tradingSymbol
- underlying
- expiry
- strike
- optionType
- lotSize
- tickSize
- freezeQuantity if available
- instrument status
- tradability
- contract type

Support:
- NIFTY
- BANKNIFTY
- FINNIFTY
- MIDCPNIFTY
- futures
- CE
- PE

The system must automatically understand currently valid contracts.

============================================================
12. EXPIRY LIFECYCLE
============================================================

Create:

ContractLifecycleService

For every derivative contract calculate:

- expiry date
- expiry time/cutoff
- time to expiry
- active/expired status
- tradability
- current session

Never hard-code:

"NIFTY always expires Thursday"

or equivalent assumptions.

Use the actual contract master/broker data.

If a contract expires today:
- it remains eligible only while the exchange/broker says it is tradable and the market is open
- after market close/expiry lifecycle completion it becomes EXPIRED
- it must not generate new executable trades

If expiry is tomorrow:
- it remains available during today's valid session
- after today's close, stop because the market is closed
- next valid market session, it may become active again
- after actual expiry, disable it permanently

Never execute stale signals for expired contracts.

============================================================
13. HISTORICAL DATA
============================================================

Indian market must have a separate historical data pipeline.

Create:

india/historical/

Support:
- OHLCV
- multiple timeframes
- index candles
- futures candles
- options candles where available
- volume
- open interest where available
- corporate/contract metadata where appropriate

Historical data must not be mixed blindly with Forex/Crypto datasets.

Normalize everything into a common internal candle format.

============================================================
14. BACKTESTING
============================================================

Create a separate Indian backtesting engine.

It must use the same:
- indicators
- feature engineering
- signal logic
- risk logic
- position sizing
- SL generation
- TP logic
- sequential goal logic
- contract lifecycle logic
- market-session logic

as live/paper mode wherever possible.

Architecture:

Historical Data
    ↓
Same Feature Pipeline
    ↓
Same Indicator Engine
    ↓
Same Analysis Engine
    ↓
Same Signal Engine
    ↓
Same Risk Engine
    ↓
Paper Execution Simulator

Avoid look-ahead bias.

Do not use future candle data to calculate past signals.

Account for:
- brokerage
- taxes/fees when configured
- slippage
- bid/ask where data exists
- tick size
- lot size
- order constraints
- realistic execution latency

============================================================
15. INDIAN ANALYSIS ENGINE
============================================================

Do not simply copy the Forex/Crypto analysis logic and rename it.

Create:

IndiaAnalysisEngine

It must be designed for Indian intraday markets.

Input:
- live ticks
- candles
- volume
- open interest where available
- option-chain information where legitimately available
- market breadth where available
- volatility
- technical indicators
- multi-timeframe features

Output:
- trend
- regime
- momentum
- volatility
- structure
- signal quality
- confidence
- feature snapshot
- prediction
- risk context

============================================================
16. INDICATOR ENGINE
============================================================

Every Indian signal must be generated from appropriate technical analysis.

Indicators may include where justified:

- EMA
- SMA
- VWAP
- RSI
- MACD
- ATR
- ADX
- Bollinger Bands
- volume metrics
- support/resistance
- swing highs/lows
- market structure
- volatility measures
- trend strength
- momentum
- multi-timeframe confirmation

Do NOT blindly apply every indicator to every strategy.

Create an indicator registry.

Each strategy declares required indicators.

Indicators must update from real market data.

Charts must show relevant indicators.

============================================================
17. MULTI-TIMEFRAME ANALYSIS
============================================================

Support multiple timeframes such as:

- 1m
- 3m
- 5m
- 15m
- 30m
- 1h

For intraday signals, use a higher timeframe for context and a lower timeframe for execution where the strategy requires it.

Never use future data.

Synchronize candle boundaries correctly using exchange timestamps.

============================================================
18. MARKET STRUCTURE
============================================================

Implement market-structure features where appropriate:

- swing highs
- swing lows
- breakouts
- breakdowns
- higher highs
- higher lows
- lower highs
- lower lows
- support
- resistance
- trend structure
- volatility expansion/contraction

These features must be derived from actual historical/current market data.

============================================================
19. PREDICTION SERVICE
============================================================

The existing FastAPI prediction service may be reused.

Create an Indian-market prediction pipeline separate from Forex/Crypto feature definitions.

Do not feed incompatible Forex/Crypto features into the Indian model.

Create:

india/ml/

with:
- feature engineering
- training dataset preparation
- model artifacts
- inference
- validation
- model version

Existing:
- scikit-learn
- XGBoost
- LightGBM
- numpy
- pandas
- joblib

can be reused.

Do not claim that ML predictions are guaranteed.

Store:
- model version
- prediction timestamp
- feature version
- probability/confidence
- prediction horizon

============================================================
20. SIGNAL ENGINE
============================================================

Create:

IndiaSignalEngine

Pipeline:

real-time data
→ candles
→ indicators
→ market regime
→ technical analysis
→ prediction
→ signal candidate
→ entry calculation
→ stop-loss calculation
→ target calculation
→ risk/reward
→ liquidity/spread validation
→ freshness validation
→ market session validation
→ contract validation
→ final signal

Signals must contain:

- signalId
- instrument
- side
- entry
- stopLoss
- target
- quantity
- lot size
- risk INR
- expected profit INR
- risk/reward
- confidence
- strategy
- timeframe
- createdAt
- marketTimestamp
- expiresAt if applicable
- status
- analysis snapshot

============================================================
21. SIGNAL FRESHNESS
============================================================

This is mandatory.

Never queue an old signal and execute it later.

Before every execution:
- verify market is open
- verify data is healthy
- get current live market price
- recalculate required conditions
- verify signal still valid
- verify entry hasn't moved beyond acceptable conditions
- verify stop-loss still valid
- verify target still achievable
- verify risk
- verify margin
- verify contract hasn't expired

If invalid:
MARK SIGNAL INVALIDATED

Then:
scan again using current data.

============================================================
22. ENGINE-GENERATED STOP LOSS
============================================================

The user does NOT manually define technical SL for every trade.

The engine calculates SL.

Possible inputs:
- ATR
- swing structure
- support/resistance
- volatility
- market structure
- strategy-specific rules

The engine must not use a fixed arbitrary stop distance for every instrument.

SL must be appropriate for:
- NIFTY
- BANKNIFTY
- FINNIFTY
- futures
- options

and strategy/timeframe.

============================================================
23. USER-GOAL SYSTEM
============================================================

Create:

GoalTradingEngine

User settings:

- amount to use (INR)
- minimum profit target (INR)
- maximum risk (INR)
- maximum margin used per trade (%)
- number of trades
- execution mode
- goal session policy

Example:

Amount = ₹10,000
Minimum profit = ₹200
Max risk = ₹100
Max margin = 20%
Trades = 4
Mode = AUTO

The user defines the profit objective.

The engine determines:
- entry
- quantity
- stop loss
- technical validation
- execution timing
- required indicators
- market conditions

============================================================
24. GOAL TARGET
============================================================

The user's profit target must be treated as a constraint, not a reason to force a trade.

Example:

Required net profit:
₹200

If the engine finds:
Expected net profit ₹80

then:
DO NOT TRADE.

If the engine finds:
Expected net profit ₹250
Risk ₹90
Margin within limit

then:
candidate can pass goal validation.

The engine must never increase risk just to hit the user's target.

============================================================
25. INR P&L
============================================================

Indian-market calculations must be INR-based.

Show:
- entry price INR
- exit price INR
- quantity
- lot size
- gross P&L INR
- charges/costs where configured
- net P&L INR
- risk INR
- target INR
- margin INR
- capital used INR

Do not present USD as the primary currency for Indian trading.

============================================================
26. TAKE PROFIT
============================================================

For Goal Trading:
The user's configured minimum profit target is the target objective.

The engine converts the INR target into the required price/position target based on:
- quantity
- lot size
- side
- entry
- costs
- tick size

The engine must continuously calculate live P&L.

When the configured target is reached:
- exit the position
- record actual P&L
- mark trade completed
- move to the next sequential trade if any remain

Do not immediately reuse the old signal.

============================================================
27. STOP LOSS
============================================================

Stop loss is engine-controlled.

If the market reaches the engine-generated SL:
- exit the position
- record loss
- increment completed trade count if this is defined as a completed attempt
- do not immediately retry the same signal
- perform a completely fresh analysis

The engine must never widen the SL merely to avoid recording a loss.

============================================================
28. TRAILING STOP / DYNAMIC MANAGEMENT
============================================================

Where the strategy supports it, the engine may use:
- trailing stop
- break-even transition
- volatility-based stop adjustment

But:
- never widen risk beyond the configured maximum risk
- never move SL in a way that violates strategy safety
- record every SL change
- preserve audit history

============================================================
29. SEQUENTIAL GOAL TRADES
============================================================

If user sets:

Number of trades = 4

The system MUST execute:

Trade 1
→ close
→ fresh analysis
→ Trade 2
→ close
→ fresh analysis
→ Trade 3
→ close
→ fresh analysis
→ Trade 4
→ close
→ Goal Completed

Never open all four simultaneously.

State:

IDLE
SCANNING
SIGNAL_FOUND
VALIDATING
EXECUTING
POSITION_OPEN
MONITORING
EXITING
TRADE_COMPLETED
SCANNING_NEXT
GOAL_COMPLETED

Track:
- requestedTrades
- completedTrades
- activeTrade
- remainingTrades

============================================================
30. FRESH SIGNAL AFTER EVERY TRADE
============================================================

After Trade 1 closes:

DO NOT:
- reuse signal
- reuse old entry
- reuse old target
- reuse old prediction

Instead:
- clear old signal
- get latest ticks
- rebuild current candles
- update indicators
- rerun analysis
- rerun prediction
- scan for a new opportunity

Only a new valid real-time signal can become Trade 2.

============================================================
31. NO FORCED TRADING
============================================================

If user requests 4 trades but only 2 valid opportunities exist:

Do NOT manufacture the other 2.

Wait for valid opportunities if the session policy allows continuation.

If market closes:
stop new trading.

============================================================
32. MANUAL GOAL MODE
============================================================

If Manual:
- engine finds fresh signal
- engine calculates SL
- engine calculates target
- engine calculates quantity
- engine shows trade
- user presses TRADE
- order passes the same validation/risk checks
- system executes

Never bypass validation.

============================================================
33. AUTO GOAL MODE
============================================================

If Auto:
- engine finds fresh signal
- engine validates it
- engine executes automatically
- monitors real-time
- exits at target/SL/engine exit
- starts fresh analysis
- searches for next trade

============================================================
34. UNIVERSAL SIGNAL ENGINE
============================================================

Create a separate:

UniversalSignalEngine

It must continuously analyze Indian markets independently of Goal Trading.

Universal signals use the same common IndiaAnalysisEngine and indicator infrastructure.

Universal signals can continue while Goal Trading owns execution.

Example:

Goal Trading:
ACTIVE

Universal:
NIFTY BUY
BANKNIFTY SELL
FINNIFTY BUY

These signals are allowed to appear.

But they must show:

SIGNAL ONLY — EXECUTION BLOCKED BY GOAL MODE

============================================================
35. UNIVERSAL TRADING
============================================================

Universal Trading modes:

OFF
MANUAL
AUTO

OFF:
signals only.

MANUAL:
signal → user approval → execution.

AUTO:
Universal engine can execute.

But only if Universal owns execution authority.

============================================================
36. SINGLE EXECUTION AUTHORITY
============================================================

Create:

ExecutionAuthorityManager

States:

NONE
GOAL
UNIVERSAL

Only one can own execution at a time.

If:
GOAL = execution owner

Then:
Goal → CAN EXECUTE
Universal → SIGNAL ONLY

If:
UNIVERSAL = execution owner

Then:
Universal → CAN EXECUTE
Goal → ANALYSIS ONLY

Never allow:
GOAL AUTO + UNIVERSAL AUTO

simultaneously.

============================================================
37. POSITION OWNERSHIP
============================================================

Every position must store:

- positionId
- strategyOwner
- executionMode
- goalId
- signalId
- instrument
- entry
- stopLoss
- target
- quantity
- openedAt
- closedAt

If Goal opened the position:
Universal cannot modify it.

If Universal opened it:
Goal cannot modify it.

Prevent engines from fighting over:
- exits
- SL
- TP
- trailing stops
- cancellations

============================================================
38. GOAL COMPLETION
============================================================

If requestedTrades = 4:

After:
completedTrades = 4

set:
GOAL_COMPLETED

Stop further Goal execution.

Do not automatically open Trade 5.

A new goal must be explicitly started.

============================================================
39. MARKET CLOSE OVERRIDES TRADING
============================================================

When market closes:
- stop new Goal trades
- stop new Universal auto trades
- stop live signal generation
- stop live candle movement
- stop indicator updates based on fake movement
- stop automatic execution

Never execute queued signals after close.

============================================================
40. DATA FAILURE OVERRIDES TRADING
============================================================

If:
market is open
BUT
data is stale/disconnected

then:

DATA_STALE

No new automatic trades.

Do not use cached prices as current prices.

Reconnect.

Only resume after healthy real-time data is confirmed.

============================================================
41. CHARTING
============================================================

Use existing:
lightweight-charts

Create Indian market chart components.

Chart must display:
- real-time candlesticks
- live price
- volume where available
- relevant indicators
- entry
- engine SL
- target
- current position
- signal markers

When market closes:
chart stops moving.

Do not generate synthetic ticks.

Use Socket.IO for real-time updates.

============================================================
42. FRONTEND INDIAN MARKET PAGE
============================================================

Create separate:

IndianMarketPage

Sections:

1. Market status
2. Instrument selector
3. Live chart
4. Indicators
5. Scanner
6. Universal Signals
7. Goal Trading
8. Active Position
9. Orders
10. Goal progress
11. Risk
12. P&L
13. Data health
14. Contract/expiry
15. Backtesting
16. Historical analysis

Goal UI:

Amount to use ₹
Minimum profit ₹
Maximum risk ₹
Maximum margin %
Number of trades
Manual / Auto
Start Goal

Show:

Requested
Completed
Remaining
Active trade
Current signal
Current position
Current P&L
Target
SL
Market status

============================================================
43. REAL-TIME SOCKET EVENTS
============================================================

Add India-specific Socket.IO channels/events.

Examples:

india:tick
india:candle
india:market-status
india:data-health
india:signal
india:signal-invalidated
india:indicator-update
india:position
india:order
india:pnl
india:goal
india:goal-progress
india:contract
india:expiry

JWT authentication must be preserved.

Do not expose unauthorized account/order data.

============================================================
44. REDIS
============================================================

Reuse existing Redis infrastructure.

Use Redis for:
- latest tick
- latest candle
- market status
- pub/sub
- signal events
- position events
- data health

Namespace keys:

india:tick:
india:candle:
india:market:
india:signal:
india:position:
india:goal:
india:contract:

Do not collide with Forex/Crypto keys.

============================================================
45. MONGODB
============================================================

Add separate collections/documents for:

IndiaInstrument
IndiaTickSnapshot where required
IndiaCandle
IndiaSignal
IndiaPosition
IndiaOrder
IndiaGoal
IndiaTrade
IndiaAnalysisSnapshot
IndiaModelPrediction
IndiaBacktestRun

Use indexes on:
- instrument
- timestamp
- expiry
- signal status
- goal ID
- position ID

Avoid storing every raw tick indefinitely unless there is a clear retention strategy.

============================================================
46. RISK ENGINE
============================================================

Create IndiaRiskEngine.

Validate:
- capital
- amount to use
- maximum risk
- margin
- lot size
- quantity
- tick size
- maximum position
- available funds
- contract tradability
- risk/reward
- target feasibility

No trade if risk limits fail.

============================================================
47. POSITION SIZING
============================================================

Position sizing must be engine-controlled.

Inputs:
- available capital
- user amount
- maximum risk
- SL distance
- lot size
- margin
- instrument
- option/future type

Output:
- quantity
- number of lots
- required capital
- margin estimate
- maximum loss
- target profit

Never calculate quantity solely from the desired profit.

Risk comes first.

============================================================
48. PAPER EXECUTION
============================================================

Current project is primarily a paper-trading/testing environment.

Create:

IndiaPaperExecutionEngine

It must behave like real execution as closely as practical.

Use real market ticks to simulate:
- entry
- order fill
- exit
- SL
- TP
- slippage
- fees
- partial fill if modeled
- order status

Do NOT use fake market prices.

Paper execution means:
REAL MARKET DATA
+
SIMULATED ORDER EXECUTION

not:
SIMULATED MARKET DATA.

============================================================
49. LIVE EXECUTION SAFETY
============================================================

Keep live broker execution behind a separate explicit gate.

Default:
LIVE_EXECUTION = FALSE

Require:
- explicit configuration
- broker authentication
- account validation
- order permission
- risk validation
- market-open validation
- data-health validation
- contract validation
- position ownership validation

Never accidentally send paper orders to a live account.

Never accidentally send live orders during testing.

============================================================
50. ORDER RECONCILIATION
============================================================

Create reconciliation logic.

Periodically compare:
- internal paper/live state
- broker order state
- broker position state

Handle:
- rejected
- cancelled
- filled
- partially filled
- pending
- disconnected
- duplicate
- unknown

Never assume an order succeeded merely because an API request returned successfully.

============================================================
51. NEWS / SENTIMENT
============================================================

Existing news infrastructure can be reused.

But Indian news should be isolated into:

IndiaNewsService

Use news as an analysis feature, not as a replacement for market data.

News must never fabricate a market tick.

============================================================
52. BACKTEST VALIDATION
============================================================

Every strategy must be backtested before being enabled for automated paper trading.

Track:
- win rate
- loss rate
- expectancy
- profit factor
- max drawdown
- Sharpe where appropriate
- average win
- average loss
- consecutive losses
- trade count
- slippage sensitivity
- fee sensitivity
- target achievement
- stop-loss frequency

Goal mode backtest must simulate:
- requested trade count
- sequential execution
- fresh signal after every exit
- user profit target
- engine-generated SL
- risk limits
- market hours
- contract expiry
- no overlapping goal trades

============================================================
53. WALK-FORWARD / OUT-OF-SAMPLE
============================================================

Do not rely only on one historical backtest.

Support:
- training period
- validation period
- out-of-sample period
- walk-forward testing where practical

Prevent overfitting.

============================================================
54. TESTING REQUIREMENTS
============================================================

Add comprehensive tests.

Backend:
- broker adapter
- WebSocket reconnect
- tick normalization
- candle builder
- session engine
- holiday handling
- market close
- stale data
- contract expiry
- instrument selection
- indicators
- signal freshness
- risk
- position sizing
- goal engine
- sequential trades
- universal engine
- execution authority
- paper execution
- order reconciliation

ML:
- feature shapes
- missing data
- model loading
- prediction schema
- model versioning

Frontend:
- market status
- chart updates
- market close behavior
- stale data state
- signal display
- goal progress
- manual/auto controls
- universal signal controls
- execution-owner state

============================================================
55. REQUIRED TEST SCENARIOS
============================================================

Test at minimum:

TEST 1:
Market open + healthy feed → ticks update.

TEST 2:
Market closed → ticks/charts/signals stop.

TEST 3:
Market should be open but WebSocket stops → DATA_STALE and trading disabled.

TEST 4:
Signal generated → market moves → old signal becomes invalid → no execution.

TEST 5:
Goal requests 4 trades → only one position exists at any moment.

TEST 6:
Trade 1 closes → old signal is discarded → fresh signal generated for Trade 2.

TEST 7:
No valid signal → system waits rather than forcing trade.

TEST 8:
Goal reaches ₹200 net target → position exits.

TEST 9:
Goal target is impossible within max risk → no trade.

TEST 10:
Universal signal appears while Goal owns execution → Universal signal displayed but cannot trade.

TEST 11:
Universal becomes execution owner → Goal can analyze but cannot trade.

TEST 12:
Attempt to enable both auto modes → reject.

TEST 13:
Goal-owned position → Universal cannot modify.

TEST 14:
Universal-owned position → Goal cannot modify.

TEST 15:
Contract expires → contract becomes non-tradable.

TEST 16:
Today's expiry after market close → no more trading.

TEST 17:
Tomorrow's expiry → remains valid for next session if broker says tradable.

TEST 18:
Market reopens → do not execute previous day's queued signal.

TEST 19:
Requested 4 trades but market closes after 2 → no forced remaining trades.

TEST 20:
Manual mode → signal does not execute without user confirmation.

TEST 21:
Auto mode → qualifying fresh signal executes.

TEST 22:
Stop-loss reached → position exits.

TEST 23:
Take-profit reached → position exits.

TEST 24:
Data stale while position open → stop new entries and activate safe position-management policy.

TEST 25:
Duplicate WebSocket tick/order event → no duplicate trade.

============================================================
56. SECURITY
============================================================

Never commit:
- broker API key
- API secret
- access token
- JWT secret
- database credentials
- Redis credentials

Use .env.

Add separate Indian variables such as:

INDIA_BROKER
INDIA_API_KEY
INDIA_API_SECRET
INDIA_ACCESS_TOKEN
INDIA_REDIRECT_URI

Use encrypted/secure storage if the application already supports it.

Never expose broker credentials to React.

============================================================
57. LOGGING / AUDIT
============================================================

Every signal and trade must be auditable.

Store:
- market timestamp
- receive timestamp
- signal creation
- signal validation
- execution decision
- rejection reason
- indicator snapshot
- prediction
- risk calculation
- entry
- SL
- TP
- exit
- P&L
- owner
- goal ID
- strategy ID

If trade was rejected, store exact reason.

Examples:
SIGNAL_STALE
MARKET_CLOSED
DATA_STALE
EXPIRY
RISK_TOO_HIGH
MARGIN_TOO_HIGH
TARGET_NOT_FEASIBLE
NO_LIQUIDITY
PRICE_MOVED
CONTRACT_NOT_TRADABLE

============================================================
58. IMPLEMENTATION PHASES
============================================================

DO NOT implement everything in one uncontrolled change.

Work step-by-step.

PHASE 0:
Inspect current repository.

Produce:
- architecture map
- existing routes
- existing services
- existing data models
- existing Socket.IO events
- existing Redis keys
- existing React pages
- existing paper execution
- existing ML pipeline
- existing backtesting
- exact integration points

Do not modify code yet.

PHASE 1:
Create India domain structure and shared types.

PHASE 2:
Implement broker adapter abstraction.

PHASE 3:
Implement broker authentication and instrument master.

PHASE 4:
Implement real WebSocket market feed.

PHASE 5:
Implement tick normalization and data health.

PHASE 6:
Implement Indian market session/calendar engine.

PHASE 7:
Implement contract/expiry lifecycle.

PHASE 8:
Implement candle builder.

PHASE 9:
Implement indicator pipeline.

PHASE 10:
Implement India analysis engine.

PHASE 11:
Integrate Indian ML prediction service.

PHASE 12:
Implement Indian signal engine.

PHASE 13:
Implement engine-generated SL and target calculations.

PHASE 14:
Implement India risk and position sizing.

PHASE 15:
Implement Indian paper execution.

PHASE 16:
Implement Goal Trading.

PHASE 17:
Implement sequential trade batches.

PHASE 18:
Implement Universal Signals.

PHASE 19:
Implement Execution Authority Manager.

PHASE 20:
Implement Indian React page and charts.

PHASE 21:
Implement Socket.IO events.

PHASE 22:
Implement historical data.

PHASE 23:
Implement Indian backtesting.

PHASE 24:
Implement complete tests.

PHASE 25:
Run typecheck/build/tests.

PHASE 26:
Run paper trading with real market data.

PHASE 27:
Only after successful validation consider live broker execution.

============================================================
59. DO NOT BREAK CURRENT FOREX/CRYPTO
============================================================

Before every major change:
- run existing tests
- typecheck
- build

After every major change:
- run existing tests
- typecheck
- build
- verify Forex
- verify Crypto
- verify shared Socket.IO
- verify Redis
- verify MongoDB

Indian code must be namespaced.

Do not overwrite:
ForexSignalEngine
CryptoSignalEngine
MT5 adapter
Binance adapter

============================================================
60. REQUIRED DELIVERABLE
============================================================

At the end provide:

1. What already existed.
2. What was missing.
3. What was implemented.
4. Files created.
5. Files modified.
6. Database collections added.
7. API routes added.
8. Socket events added.
9. Redis keys added.
10. Environment variables required.
11. Broker setup instructions.
12. How real-time data flows.
13. How market-close logic works.
14. How expiry logic works.
15. How Goal Trading works.
16. How sequential trades work.
17. How Universal Signals work.
18. How execution authority works.
19. How SL is generated.
20. How TP is calculated.
21. How INR P&L works.
22. How backtesting works.
23. Tests added.
24. Test results.
25. Remaining limitations.

============================================================
61. ABSOLUTE NON-NEGOTIABLE RULES
============================================================

1. Real Indian market data only for live operation.
2. No fake/synthetic live prices.
3. No stale data presented as live.
4. Broker WebSocket is authoritative for live prices.
5. Market close stops live movement and new trading.
6. Data stale stops automatic execution.
7. Expired contracts cannot trade.
8. All INR calculations must be INR-first.
9. User defines Goal profit objective.
10. Engine determines technical SL and required trade mechanics.
11. Engine determines position size.
12. Engine chooses required indicators/tools.
13. Every signal uses the appropriate analysis pipeline.
14. Charts show real-time data and relevant indicators.
15. Old signals are never queued for later execution.
16. Every execution revalidates the signal against current market data.
17. Goal trades are strictly sequential by default.
18. Number of trades means number of completed sequential opportunities.
19. No forced trade merely to satisfy requested trade count.
20. Goal target completion stops the Goal.
21. Universal signals can continue while Goal owns execution.
22. Universal cannot execute while Goal owns execution.
23. Goal cannot execute while Universal owns execution.
24. Only one execution owner exists at a time.
25. One strategy cannot modify another strategy's position.
26. Manual and Auto use the same safety/risk validation.
27. Paper execution uses REAL market data.
28. Live execution remains separately gated.
29. Backtesting must use the same strategy logic as paper/live wherever possible.
30. No look-ahead bias.
31. No hard-coded expiry assumptions.
32. No hard-coded fake market sessions.
33. No credentials in source code.
34. Do not introduce unnecessary duplicate frameworks or services.
35. Do not blindly install every GitHub repository.
36. Inspect existing implementation before changing anything.
37. Preserve current Forex/Crypto functionality.
38. Every implementation step must be tested.
39. If a repository cannot safely satisfy a requirement, do not force it into the architecture.
40. The system must be able to say "NO TRADE" when conditions are not valid.

============================================================
62. FINAL ARCHITECTURE
============================================================

Final high-level architecture:

                     ┌─────────────────────────┐
                     │     INDIAN BROKER        │
                     │ Zerodha / Upstox         │
                     └────────────┬────────────┘
                                  │
                           WebSocket
                                  │
                                  ↓
                     ┌─────────────────────────┐
                     │ India Market Adapter    │
                     └────────────┬────────────┘
                                  ↓
                     ┌─────────────────────────┐
                     │ Tick Normalizer         │
                     │ Data Health              │
                     └────────────┬────────────┘
                                  ↓
                              Redis
                                  │
                                  ↓
                     ┌─────────────────────────┐
                     │ Market Session Engine   │
                     │ Contract Lifecycle      │
                     └────────────┬────────────┘
                                  ↓
                     ┌─────────────────────────┐
                     │ Candle Engine            │
                     └────────────┬────────────┘
                                  ↓
                     ┌─────────────────────────┐
                     │ India Analysis Engine   │
                     │                         │
                     │ Indicators              │
                     │ Trend                   │
                     │ Structure               │
                     │ Volume                  │
                     │ Volatility              │
                     │ Multi-timeframe         │
                     └────────────┬────────────┘
                                  ↓
                     ┌─────────────────────────┐
                     │ India ML Prediction     │
                     └────────────┬────────────┘
                                  ↓
                 ┌────────────────┴────────────────┐
                 ↓                                 ↓
       ┌─────────────────────┐          ┌─────────────────────┐
       │ Goal Signal Engine  │          │ Universal Signal    │
       │                     │          │ Engine              │
       │ ₹ Capital           │          │                     │
       │ ₹ Profit Target     │          │ General signals     │
       │ Max Risk            │          │ Analysis            │
       │ Max Margin          │          │ Prediction          │
       │ Trade Count         │          │                     │
       └──────────┬──────────┘          └──────────┬──────────┘
                  │                                │
                  └────────────────┬───────────────┘
                                   ↓
                    ┌─────────────────────────┐
                    │ Execution Authority     │
                    │                         │
                    │ NONE                    │
                    │ GOAL                    │
                    │ UNIVERSAL               │
                    └────────────┬────────────┘
                                 ↓
                    ┌─────────────────────────┐
                    │ India Risk Engine       │
                    │                         │
                    │ INR Risk                │
                    │ Margin                  │
                    │ Quantity                │
                    │ Lot Size                │
                    │ SL                      │
                    │ TP                      │
                    └────────────┬────────────┘
                                 ↓
                    ┌─────────────────────────┐
                    │ Paper Execution Engine  │
                    └────────────┬────────────┘
                                 ↓
                    ┌─────────────────────────┐
                    │ Position / Order Engine │
                    └────────────┬────────────┘
                                 ↓
                    ┌─────────────────────────┐
                    │ Socket.IO               │
                    └────────────┬────────────┘
                                 ↓
                    ┌─────────────────────────┐
                    │ React Indian Market UI  │
                    │                         │
                    │ Live Chart              │
                    │ Indicators              │
                    │ Scanner                 │
                    │ Signals                 │
                    │ Goal Trading            │
                    │ Universal Signals       │
                    │ Positions               │
                    │ P&L                     │
                    │ Risk                    │
                    │ Expiry                  │
                    └─────────────────────────┘

MongoDB:
- historical persistent state
- signals
- positions
- orders
- goals
- trades
- analysis snapshots
- model predictions
- backtests

Redis:
- latest ticks
- candles
- market state
- pub/sub
- real-time events

FastAPI:
- India ML prediction service

Existing Forex/Crypto:
- remain independent
- share only generic infrastructure where appropriate