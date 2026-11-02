# ECONOMIC_EVENTS.md

## Providers

| Provider | Source | Free? | Key? | Notes |
|---|---|---|---|---|
| `CENTRALBANK` (default) | Official **Fed FOMC** (federalreserve.gov), **BoE MPC** (bankofengland.co.uk), **BoJ MPM** (boj.or.jp), **ECB** (ecb.europa.eu) pages merged with the free ForexFactory weekly JSON | yes | no | each source fails independently; cached 15 min; no fabricated events |
| `FOREXFACTORY` | public weekly JSON calendar (nfs.faireconomy.media) only | yes | no | cached 10 min |
| `NONE` | disabled | — | — | no fabricated events |

The `CENTRALBANK` provider parses the official meeting-date pages of the four
central banks. It emits the next 4-6 weeks of rate decisions (FOMC, BoE MPC,
BoJ MPM, ECB) as HIGH-impact events with the documented typical announcement
times (Fed 2pm ET on the last meeting day; BoE noon UK; BoJ 12:00 JST on the
last meeting day; ECB 13:15 CET). Times are labeled as typical — the pages
publish dates, not exact times. ForexFactory adds the detailed calendar
(CPI/NFP/GDP/PMI with forecasts); when it is rate-limited or down, the
official central-bank dates still work.

## Event model

Each event: `event, currency, timestamp, impact (LOW/MEDIUM/HIGH),
forecast, previous, actual, source` plus computed `timeToEventMs`,
`eventRisk` (0..1) and `postEventState`.

## Event risk windows

- **Pre-window**: 2 h before a HIGH/MEDIUM event → risk elevated.
- **Post-window**: 1 h after → volatility risk persists.
- `assess()` returns `imminentHighImpact`, `eventsInWindow`, `eventRisk`,
  affected currencies and a human-readable detail.

The engine keeps a 60-day lookahead so official rate decisions (usually
announced 4-6 weeks ahead) appear on the calendar.

## How the signal engine uses it

- High-impact events raise the news/event risk components of the risk
  classification (RED flag) and can block news-sensitive strategies when
  `highImpactNewsRestriction` is enabled.
- `eventRisk` is a feature; regime detection can mark the market
  `NEWS_DRIVEN` when a high-impact event is in the window.
- Calendar refreshes re-analyze the affected pairs immediately (event-driven
  signal engine).
- If the calendar provider is down, event risk is "unknown" and
  news-sensitive strategies increase uncertainty / block per the configured
  safe policy.

## Honest limitations

- Official pages state meeting **dates**; announcement **times** are the
  documented typical times and are labeled as such.
- The ForexFactory feed is a public, unofficial mirror of the publisher's
  calendar and may rate-limit (429) or disappear; verify events before acting
  on them. It is not a substitute for a licensed data feed in production.
- In backtests, events are only included when legitimate historical data
  exists (`includeEvents` is false by default).
