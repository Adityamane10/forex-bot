# REMAINING WORK

Generated 2026-08-18 after the continuation pass. Only genuinely incomplete
items are listed — completed work is documented in IMPLEMENTATION_STATUS.md.

Legend: DONE / PARTIAL / BLOCKED / NOT REQUIRED

## Verification state at this point

- Backend tests: 172/172 green (161 pre-existing + 10 new in the first pass + 1
  combined-exit test added in the second pass).
- Frontend tests: 3/3. Python AI tests: 12/12 (unchanged, not re-run this pass —
  ai-engine untouched).
- Typecheck: backend + frontend clean. Frontend production build passes.
- Live run verified: real Yahoo forex + Binance crypto WS, candles, scanner on
  all 17 symbols, WebSocket fan-out (3384 ticks / 20 s), no crashes.

## Genuinely remaining items

| Item | Status | Notes |
|---|---|---|
| Combined exit path test: trailing + partial TP + breakeven enabled together | DONE | Added to paperExits.test.ts (8th test): trailing ratchets stop above entry, breakeven correctly skipped (would have loosened), TP1/TP2 close 50%/40% of ORIGINAL size, trailing stop exits the 0.1-lot remainder. Also made pushTick use a fixed tiny spread (the DEMO test feed's spread can balloon and the derived offset made crafted ticks exceed the 5% market-data jump guard → deterministic rejects in sequence). |
| Python AI engine live check in this environment | PARTIAL | ai-engine/ not started here; backend correctly WAITs (MODEL_BLOCKED) when it is down. Run `npm run dev:ai` to enable signals, then re-verify. |
| MongoDB/Redis durable run | BLOCKED | Not installed in this environment; in-memory fallbacks are active and clearly labeled. Docker Compose is provided (docker-compose.yml) but Docker is not available here to verify. |
| Docker compose full-stack verification | BLOCKED | Same environment limitation (no Docker). |
| FinBERT optional sentiment model | NOT REQUIRED | Lexicon fallback labeled RULE_BASED; FinBERT is an optional install. |
| Multi-exchange CCXT venues (beyond Binance) | NOT REQUIRED | CCXT adapter is venue-generic; no exchange keys are configured and execution is disabled by design (paper-only build). |
| Perpetual/futures + funding-aware risk for crypto | NOT REQUIRED | Spot-only by design; funding metadata exists and is zero for spot. |
| On-chain data source | NOT REQUIRED | Honest UNAVAILABLE state; no free keyless source configured. No fabricated data. |
| Live broker execution | NOT REQUIRED | Disabled by design (ENABLE_LIVE_TRADING=false, DisabledExecutionProvider). |

## Next exact step

1. ~~Restart the backend on :4000 with the fixed code~~ **DONE** — stale pre-fix
   instance (pid 8168) was replaced; :4000 now runs the current source, verified
   healthy: 17/17 symbols, WebSocket up, no scanner crashes, AI engine DOWN is
   the only unhealthy component (expected — ai-engine not started). Log:
   `C:\Users\Aditya\AppData\Local\Temp\opencode\backend4000.log`.
2. Start the Python AI engine (`npm run dev:ai`), then verify a real
   BUY/SELL/NO_TRADE signal plus an auto paper fill on live data.
3. When a real Mongo/Redis/Docker environment is available, verify the
   compose stack and durable persistence.