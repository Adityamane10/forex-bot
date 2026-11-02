# Broker & Account Binding (XM → MetaTrader 5)

The platform trades **the account you select**. This document explains what that
means mechanically, what the dashboard shows, and — importantly — what the
platform can and cannot know about an XM account.

Dashboard page: **Trading → Broker & Account**. Env: see [`.env.example`](.env.example),
broker block. Code: `shared/src/broker.ts`, `backend/src/broker/`.

---

## 1. The account type drives everything

Selecting an account type on the dashboard (default **XM:ULTRA_LOW_STANDARD**)
resolves the terms the engines actually trade on:

| Term | Used by |
| --- | --- |
| contract size, min/max/step lot | position sizing (`dynamicLotBreakdown`), margin, pip value |
| stop level (points) | SL/TP placement validity |
| spread (live, per symbol) | cost model, expected value, min-R:R filters |
| commission per lot | net-P&L, profit-target exits, EV |
| leverage / margin call / stop out | margin caps, circuit breakers, risk classification |

Those values reach the engines through `AccountProfileService` →
`setBrokerSpecOverrides()` (`backend/src/forex/symbol-spec.ts`), so a
Micro-style contract (1,000 units/lot) sizes **100× smaller** than a
Standard-style one (100,000). Pip/price geometry is deliberately *not*
overridable: a pip belongs to the quoted price, not to the account.

Switching account type **clears previously confirmed conditions** — those
numbers belonged to the old account.

## 2. Where each value comes from (provenance is a field, not a comment)

Every condition carries the evidence behind it, and the dashboard renders it:

| Evidence | Meaning | Enough for live money? |
| --- | --- | --- |
| `MT5_ACCOUNT` | reported by the bound terminal (`account_info` / `symbol_info`) | yes |
| `OPERATOR_CONFIRMED` | you read it on the broker's own page and recorded it | yes |
| `POLICY_SNAPSHOT` | what the broker publishes for this account type (cited) | yes **once you acknowledge it** for that account type — see §2b |
| `PLATFORM_DEFAULT` | the platform's built-in assumption | **no** — simulation only |
| `UNVERIFIED` | declared but unconfirmed | **no** |

### 2b. What XM publishes (and the one click that makes it live-grade)

Some terms cannot come from MetaTrader at all — a broker does not serve its
commission schedule through the terminal. For those, the platform carries what
the broker *publishes*, with the citation, and treats it as live-grade only while
you have acknowledged it for the selected account type:

* the catalog records **verbatim** XM copy plus the source URL and the date it
  was read (`shared/src/broker.ts`, `PublishedAccountTerms`);
* a published basis is **not** live-grade on its own. The gate holds with
  `published_terms` until `POST /api/broker/terms/acknowledge` (the
  *"I have read these terms"* button on **Trading → Broker & Account**);
* the acknowledgement **lapses** when the broker republishes the page (`policy
  watcher` flags the change) or when you switch account type — it is an
  acknowledgement of *terms*, not a checkbox;
* while it is not acknowledged, published figures are still used for **signals,
  predictions and sizing** (the point of selecting an account type) and are
  labelled `POLICY_SNAPSHOT` everywhere, including in the signal's
  `expectedValue.costProvenance`. They are **not** used for the wallet ledger.

What XM's own page said when it was read (2026-09-17, `/account-types`): XM lists
**Standard**, **Ultra Low**, **Shares** (plus Zero/Professional referenced in its
copy), minimum deposit **$5** for Standard and Ultra Low, and *"All accounts
offer negative balance protection, hedging and Islamic option as standard."* Its
comparison table has rows for `Spreads As Low As`, `Commission`, `Maximum
Leverage`, `Stop Out Level`, `Markets`, `Swap Free`, `Bonus Eligibility` and
`Micro Account Option` — but the numeric cells are loaded by the page's own
client-side script and are **not** in the document itself.

The platform therefore does **not** invent those numbers. What it does:

* Standard / Ultra Low (incl. the Micro option) are modelled as **spread-only**
  (`spreadModel: VARIABLE`, `commissionPerLotUsdRoundTurn: 0`) — XM describes the
  **Zero** account as the one with *"fixed commissions and spreads as low as
  zero"*, i.e. spreads are where a Standard/Ultra Low account is charged;
* Zero is left **unknown** for commission (XM publishes "fixed commissions" but
  not the amount on that page) — so a Zero account is never assumed
  commission-free;
* `Swap Free: yes` for every XM account type, from XM's own "all accounts" copy;
* contract size, lot geometry, leverage, live spread, swaps, stop distance and
  margin levels come from **your bound account**, and diverge from a published
  expectation as a surfaced mismatch, never silently.

If XM charges Ultra Low a per-lot commission after all, confirm the real number
in the confirmation form — the journal then records *your* value and its source
in place of the published one.

Nothing is ever inferred from prose, and an unknown value is never coerced to
0/1/"fine". If a term is unknown, it is unknown.

### What MT5 can tell us about the account

`account_info()`: login, server, company, currency, balance, equity, margin,
leverage, trade mode (DEMO/CONTEST/REAL), margin-call and stop-out levels.
`symbol_info()`: contract size, min/max/step volume, digits, point, minimum stop
distance, current spread, swaps — **per symbol**, for this account.

Commission is *not* exposed by the MetaTrader API. That single term is therefore
either taken from what the broker **publishes** for the account type (and
acknowledged by you — see §2b) or typed in by you. This is why the gate below can
hold orders even with a perfectly healthy binding — the platform refuses to guess
a cost.

### What XM does not give us

XM publishes account terms as web pages; there is **no public API** for account
types, and the site does refuse some automated clients with `403` (observed from
this workspace's own fetching tooling). The backend's watcher did read
`/account-types` successfully in verification (~5 KB of normalized text, hash
recorded), but treat reachability as best-effort, not a guarantee. The watcher
(`backend/src/broker/policy-source.ts`) therefore:

* polls `BROKER_POLICY_URL` on `BROKER_POLICY_REFRESH_MS`,
* hashes a normalized text form of the document and records when it **changes**,
* marks the current conditions as *needing re-confirmation* when it does,
* reports `UNAVAILABLE` + the exact error when it cannot read the page,
* **never** edits trading conditions from a fetched document.

Point `BROKER_POLICY_URL` at a saved copy (a local path or `file:` URL) if the
broker's site stops answering your host and you still want change detection. Everything else keeps working
without it: the bound MT5 account is the primary, live source of the terms that
matter for money math, and you can confirm the rest by hand — each confirmation
is stored with a timestamp and your note, and is auditable
(`broker.conditionsConfirmed` in the audit log).

## 3. Execution gates (fail-closed)

Two gates, deliberately different:

**Live dispatch gate** — orders handed to the MT5 trader worker. Blocked when:

| Code | Condition |
| --- | --- |
| `NO_ACCOUNT` | no MT5 account has reported in |
| `ACCOUNT_STALE` | last heartbeat older than `BROKER_ACCOUNT_MAX_AGE_MS` (default 45s) |
| `TRADE_MODE_UNKNOWN` | the terminal did not say whether the account is DEMO or REAL |
| `TRADE_MODE_CONTEST` | contest accounts are not tradeable |
| `REAL_NOT_ALLOWED` | a REAL account is bound but `ALLOW_REAL_TRADING` is false |
| `CURRENCY_MISMATCH` | account currency is not one the profile lists |
| `CONDITIONS_UNVERIFIED` | a sizing requirement has no live-grade evidence |

Warnings (do not block): `LEVERAGE_MISMATCH`, `BROKER_UNVERIFIED` (the account
does not identify as the selected broker — check you picked the right profile).

### 3b. Live-money readiness (`GET /api/broker/readiness`)

`liveGate` answers *may an order leave*; the readiness checklist answers *which
fact is stopping it*, one row per independently checkable fact:

| Key | Passes when |
| --- | --- |
| `broker_profile` | a broker account type is selected (not the platform default) |
| `worker_online` | the MT5 terminal reported within `BROKER_ACCOUNT_MAX_AGE_MS` |
| `trade_mode` | the terminal said DEMO/REAL (not UNKNOWN/CONTEST) |
| `specs_reported` | `symbol_info` specs arrived (they carry the lot geometry) |
| `terms_complete` | every sizing term is live-grade |
| `published_terms` | broker-published values have been acknowledged (§2b) |
| `spec_agreement` | the broker's contract size agrees with the account type in use, or the broker's value is what sizing uses |
| `real_optin` | for a REAL account: `ALLOW_REAL_TRADING` (and `MT5_ALLOW_REAL=1` on the trader host) |
| `symbol_costs` | every priced symbol has a known spread, commission and contract size (or one symbol, with `?symbol=`) |
| `policy_current` | the broker's page is readable and unchanged since you acknowledged it (WARN only) |
| `broker_identity` | the terminal identifies as the selected broker (WARN only) |

`GET /api/broker/costs?symbols=EUR/USD,USD/JPY` prices each symbol in the
account currency, component by component, with the source of every number:
`LIVE_FEED` (the broker's own bid/ask as the platform is trading it) →
`MT5_SYMBOL_INFO` (the terminal's `symbol_info`) → `ACCOUNT_TERMS` (commission
and spread model) → `PLATFORM_DEFAULT` → `UNKNOWN`.

Rules that keep those numbers honest:

* only the **broker's own quote feed** (the local MT5 bridge, `source: MT5`) may
  define the account's spread. A third-party aggregator's bid/ask is usually
  modelled — and for some pairs rounded too coarsely — so the terminal's
  `symbol_info.spread` is used instead;
* swap is interpreted **only** when the terminal reports `swap_mode = 0`
  (points). Any other mode is reported unknown rather than reinterpreted;
* a component that needs a currency conversion with no live rate stays
  **unknown** with the reason (e.g. a USD account holding USD/JPY while the JPY
  feed is quiet) — the symbol is then held by `symbol_costs`, not traded on a
  substituted rate.

Held orders are **not cancelled**: they stay `PENDING` in the command queue and
execute the moment the gate opens, so an unverified afternoon never silently
becomes a missing trade. The reason is shown on the dashboard, the MT5 status
endpoint (`dispatchBlocked`) and in the log.

**Simulation gate** — paper entries. Never blocked by unverified broker terms
(simulated money sizes nothing real), but every unverified badge and warning is
attached to the signal, so simulated results are never mistaken for
broker-accurate ones. A REAL account being bound is called out explicitly.

## 4. Currency: USD account, live conversion, no fixed price

* The dashboard's **display currency follows the bound MT5 account**
  (`displayCurrency`), because that is the currency the money actually settles
  in. An XM account settles in USD/EUR/… — not in ₹.
* The **wallet currency** (`accountCurrency` setting, `USD`/`INR`/…) is what the
  paper ledger is denominated in. Cross-currency figures convert over the live
  feed only: the `USD/INR` rate published by the market-data engine, with source
  and age shown on the dashboard.
* When that rate is stale or absent, cross-currency **execution is paused**
  (`INR conversion STALE`) rather than substituting a fixed number. There is no
  hardcoded rate anywhere in the money path.
* Switching currency re-initialises the wallet to the same capital value in the
  new currency (positions close as `MANUAL`; history is kept).

## 5. Real money: double opt-in

Two independent switches, both default **off**:

1. Backend host: `ALLOW_REAL_TRADING=true` — opens the live dispatch gate.
2. Trader host: `MT5_ALLOW_REAL=1` — the worker's own guard.

With either missing, a REAL account can be bound and monitored but **no order
leaves**. The MT5 worker refuses REAL and CONTEST accounts outright, reports the
refusal back as a failed command, and logs it.

Before enabling, working through the dashboard in this order is the whole
procedure:

1. Bind the account (start the worker) → confirm **Trade mode: DEMO** and that
   login/server/company match your XM account.
2. Select the account type you actually opened (**XM Ultra Low Standard**).
3. Check the *Trading conditions in use* table: every row marked `REQUIRED`
   under *Live money* must be resolved. Confirm the missing ones (commission
   first) from your XM account page.
4. Watch the gate row turn from `DISPATCH HELD` to `ORDERS MAY DISPATCH`.
5. Only then set `ALLOW_REAL_TRADING=true`.

## 6. Restarting an existing setup

The worker now reports its trade mode, account details and per-symbol contract
specs on every heartbeat. Until it is restarted, the backend sees an account
without a trade mode and **holds every order** (`TRADE_MODE_UNKNOWN`) — nothing
is lost, the queue simply waits. Restart the trader once:

```powershell
# Windows host with the MT5 terminal
.\workers\mt5-trader\start.ps1        # or: node scripts/start-all.mjs
```

The launcher passes `MT5_ALLOW_REAL` through from `backend/.env`.

## 6b. Terms provenance in the journal

Every position and trade records `terms`: the account type it belonged to, the
sizing numbers **with the evidence behind each one**, the per-symbol costs used,
the live conversion rate at that moment, the bound account's identity and the
gate state at decision time (`TermsProvenance`, `shared/src/broker.ts`).

It is written at entry (onto the position) and at exit (onto the trade), and the
same record is available before the fact — `GET /api/broker/terms?symbol=EUR/USD`
returns exactly what a trade opened now would store. That means:

* `GET /api/paper/trades` history shows which account type and which costs each
trade was executed under, even after the account type changes;
* switching account type never re-prices history — a Zero-account trade stays a
  Zero-account trade;
* the signal's `expectedValue.costProvenance` carries the same idea for the
  planning side (`spread`/`commission`/`swap` sources + `brokerSourced`).

## 6c. Verifying it yourself

```bash
# terminal 1 — a throwaway instance (in-memory store, no dev data touched)
PORT=4399 INTERNAL_API_TOKEN=dev-internal-token npx tsx backend/src/index.ts

# terminal 2 — 40 checks across catalog → binding → costs → readiness →
#              acknowledgement → provenance → account-type switch → policy watch
node scripts/verify-broker-binding.mjs
```

The script registers a scratch user, feeds a synthetic MT5 heartbeat, and
asserts every number above. **Run it against a freshly started backend** (it
expects an unbound account at the start). `npm run verify:broker` runs it
against `http://127.0.0.1:4399`.

## 7. Honest limitations

* **The platform cannot prove which XM account type you selected.** MT5 exposes
  company/server/currency/leverage, not a product name. The selection is your
  declaration; the platform cross-checks everything the terminal *does* report
  and warns (`BROKER_UNVERIFIED`, `LEVERAGE_MISMATCH`) when it disagrees.
* **Commission is unverifiable from MT5** — always requires your confirmation.
* **Aggregated swaps are not modelled** from `symbol_info` (the API's
  `swap_mode`/point semantics are not safe to convert into a single per-lot
  pip figure), so swap stays unknown rather than approximate.
* **Policy scraping may be blocked** (see §2). Change detection is best-effort;
  your confirmations are the authoritative record.
* Nothing here is financial advice, and none of it makes predictions certain —
  signals still say `WAIT` / `NO TRADE` when confidence is insufficient.
