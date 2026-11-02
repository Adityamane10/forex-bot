# RISK_ENGINE.md

The risk engine is **independent of prediction** — it can veto any signal and
can never be overridden by an LLM or by a profit target.

## Components

| Concern | Engine | Notes |
|---|---|---|
| Risk per trade / sizing | `positionSizingEngine.ts` | forex: lots via pip value; crypto: quantity via risk ÷ stop distance (per-instrument, §30/§48) |
| Portfolio exposure | `portfolioRiskEngine.ts` | open positions vs capital, max exposure % |
| Correlation / currency exposure | `correlationEngine.ts` | rolling correlations (20/50/100); EUR+GBP+AUD long = one big USD exposure (§51-53) |
| Circuit breakers | `circuitBreakerEngine.ts` | daily/weekly loss, drawdown, consecutive losses, open/correlated positions, leverage, exposure — fed from REAL account state (paper account tracks daily/weekly P&L with UTC window rollover + consecutive-loss counters); a fill-time `evaluateEntryGate()` re-checks the account before any order (§34, §70) |
| Risk level | `riskClassificationEngine.ts` | GREEN/YELLOW/RED weighted from volatility, spread, news, events, ML uncertainty, R:R, regime, data quality, exposure, correlation, drawdown, model health; RED flags → BLOCK (§55) |
| Uncertainty | `uncertaintyEngine.ts` | model disagreement, low confidence, uncertain regime, poor data, wide spread → INSUFFICIENT_CONFIDENCE |
| Global emergency stop | `emergencyStopEngine.ts` | stops NEW signals + orders; preserves positions and monitoring; trigger/release audited (§90) |
| Trailing stop | `trailingStopEngine.ts` | ATR-based, activates after N×R, ratchets, locks profit (§63) |

## Rules enforced

- `WAIT` / `NO_TRADE` / `INSUFFICIENT_CONFIDENCE` are always valid outcomes.
- Risk is **never raised** to satisfy a requested minimum profit — the profit
  constraint returns `NO VALID TRADE UNDER CURRENT CONDITIONS` instead (§50).
- Stale/invalid data, an ML outage, or a risk-engine failure blocks decisions.
- New entries are re-validated at fill time against the current account state
  (daily loss, drawdown, max positions, consecutive losses) — conditions may
  have changed since the signal was created.
- Live execution is disabled by default; the `ExecutionProvider` is a safety
  stub that refuses every order unless live is explicitly enabled AND every
  gate passes (§89).

## Emergency stop behavior

Triggered → no new signals (all symbols return NO_TRADE), no new paper orders,
open positions keep tracking SL/TP, monitoring continues. Release is explicit
and recorded in the audit trail. UI control: System view.
