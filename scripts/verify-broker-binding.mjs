/**
 * End-to-end verification of the broker account binding against a running
 * backend (default http://127.0.0.1:4399).
 *
 * It exercises exactly the path the user asked to be sure about:
 *   XM account type selected  →  MT5 heartbeat with the broker's own account
 *   facts and per-symbol specs  →  binding resolves the terms, prices each
 *   symbol's spread/commission/swap with provenance  →  the live-money gate
 *   says what is missing  →  acknowledging the broker's published terms opens
 *   it  →  switching account type re-prices everything and lapses the
 *   acknowledgement.
 *
 * Run:  node scripts/verify-broker-binding.mjs [baseUrl] [internalToken]
 *       npm run verify:broker
 *
 * It talks to a backend YOU started, and expects that backend to be FRESH (no
 * MT5 account bound yet). See BROKER.md §6c for the one-liner; the throwaway
 * instance there uses an in-memory store, so no development data is touched.
 */
const BASE = process.argv[2] ?? 'http://127.0.0.1:4399';
const INTERNAL_TOKEN = process.argv[3] ?? 'dev-internal-token';
/** Account currency the cost view is expressed in (the bound account's). */
const CURRENCY = 'USD';

let failures = 0;
function check(label, ok, detail = '') {
  const mark = ok ? 'PASS' : 'FAIL';
  if (!ok) failures += 1;
  console.log(`${mark}  ${label}${detail ? ` — ${detail}` : ''}`);
}

async function call(path, { method = 'GET', body, token, internal = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (internal) headers['X-Internal-Token'] = INTERNAL_TOKEN;
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* keep raw text */
  }
  return { status: res.status, body: parsed };
}

const ACCOUNT_HEARTBEAT = {
  workerId: 'verify-trader',
  account: {
    login: 91827364,
    server: 'XMGlobal-MT5-Demo',
    company: 'XM Global Limited',
    balance: 5000,
    currency: 'USD',
    equity: 5012,
    profit: 12,
    margin: 100,
    freeMargin: 4912,
    leverage: 1000,
    tradeMode: 'DEMO',
    marginCallLevelPct: 50,
    stopOutLevelPct: 20,
    symbolSpecs: [
      {
        symbol: 'EURUSD', platformSymbol: 'EUR/USD', contractSize: 100000,
        volumeMin: 0.01, volumeMax: 50, volumeStep: 0.01, digits: 5, point: 0.00001,
        stopsLevelPoints: 0, spreadPoints: 8, swapLong: -5.2, swapShort: 1.1, swapMode: 0, fillingMode: 1,
      },
      {
        symbol: 'USDJPY', platformSymbol: 'USD/JPY', contractSize: 100000,
        volumeMin: 0.01, volumeMax: 50, volumeStep: 0.01, digits: 3, point: 0.001,
        stopsLevelPoints: 0, spreadPoints: 12, swapLong: -18.4, swapShort: 4.2, swapMode: 0, fillingMode: 1,
      },
    ],
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const email = `broker-verify-${Date.now()}@fx.local`;
const reg = await call('/auth/register', { method: 'POST', body: { email, password: 'verify-pass-123' } });
if (reg.status !== 201) {
  console.error('could not register a verification user:', reg.status, reg.body);
  process.exit(1);
}
const token = reg.body.token;

// ---- 1. Catalog default and the held gate ---------------------------------
let snap = (await call('/broker/profile', { token })).body;
check('default profile is XM Ultra Low Standard', snap.profileId === 'XM:ULTRA_LOW_STANDARD', snap.profileId);
check('no MT5 account is bound yet', snap.binding.bound === false);
check('live dispatch is held with a reason', snap.liveGate.allowed === false && snap.liveGate.reasons.length > 0, snap.liveGate.reasons[0] ?? '');
check('published terms are carried with a citation', typeof snap.published?.sourceUrl === 'string' && snap.published.quotes.length > 0);
check('published terms are NOT live-grade before acknowledgement', snap.publishedAcknowledged === false);
check('wallet cost basis is not in force yet', snap.costBasisActive === false);
check('costs list is empty before a binding', Array.isArray(snap.costs) && snap.costs.length === 0);

// ---- 2. Complete the binding ----------------------------------------------
const hb = await call('/internal/mt5/heartbeat', { method: 'POST', internal: true, body: ACCOUNT_HEARTBEAT });
check('heartbeat accepted', hb.status === 200, JSON.stringify(hb.body));

let bound = null;
for (let i = 0; i < 20 && !bound?.binding?.bound; i += 1) {
  await sleep(300);
  snap = (await call('/broker/profile', { token })).body;
  bound = snap;
}
check('binding is live after the heartbeat', snap.binding.bound === true, `age ${snap.binding.ageMs}ms`);
check('account identity came from the terminal', snap.binding.account?.company === 'XM Global Limited' && snap.binding.account?.leverage === 1000);
check('broker symbol specs were received', snap.binding.specsReported === 2, `${snap.binding.specsReported} specs`);
check('display currency follows the bound account', snap.displayCurrency === 'USD');
const contractRow = snap.conditions.find((c) => c.key === 'contractSize');
check('contract size is broker-reported', contractRow?.evidence === 'MT5_ACCOUNT', `${contractRow?.display} via ${contractRow?.source}`);

// ---- 3. Per-symbol account costs ------------------------------------------
const eur = snap.costs.find((c) => c.symbol === 'EUR/USD');
// The market feed here is a modelled/aggregated one, so the broker's own
// symbol_info must be the source that wins for this account (a modelled spread
// is a platform assumption and may never outrank the broker's number).
check('per-symbol costs exist for every bound symbol', snap.costs.length === 2, snap.costs.map((c) => c.symbol).join(', '));
check('spread is priced from the broker\'s own data', eur?.spreadPerLot.source === 'MT5_SYMBOL_INFO' && Math.abs(eur.spreadPerLot.value - 8) < 1e-3, JSON.stringify(eur?.spreadPerLot));
check('Ultra Low Standard carries no per-lot commission', eur?.commissionPerLot.value === 0, JSON.stringify(eur?.commissionPerLot));
check('commission is labelled with its source', eur?.commissionPerLot.source === 'ACCOUNT_TERMS', eur?.commissionPerLot.detail ?? '');
check('round-turn cost is spread + commission', Math.abs(eur?.roundTurnPerLot.value - 8) < 1e-3, String(eur?.roundTurnPerLot.value));
check('swap is quoted per side in the quote currency', Math.abs(eur?.swapLongPerLotNight.value - 5.2) < 1e-6 && Math.abs(eur?.swapShortPerLotNight.value + 1.1) < 1e-6);
check('stop level came from the broker', eur?.stopLevelPoints.source === 'MT5_SYMBOL_INFO');
const jpy = snap.costs.find((c) => c.symbol === 'USD/JPY');
// USD/JPY is quoted in JPY: 12 points × point 0.001 × contract 100000 = 1200 JPY
// per lot. The point size, not a global pip constant, sets the scale.
check('a JPY pair is priced on its own point size, not a global pip constant',
  !/0\.00001/.test(jpy?.spreadPerLot.detail ?? '') && /point 0\.001/.test(jpy?.spreadPerLot.detail ?? ''),
  jpy?.spreadPerLot.detail ?? '');
// USD/JPY is quoted in JPY: its cost is only "complete" when a LIVE JPY→USD
// rate exists to express it in the account currency. When the JPY feed is
// quiet the platform must say unknown-with-reason rather than invent a rate,
// so either outcome is accepted — a made-up number is not.
const jpyPriced = jpy?.complete === true && jpy.spreadPerLot.value !== null && jpy.spreadPerLot.value > 0;
const jpyHonestlyUnknown = jpy?.complete === false && jpy.missing.includes('spread') && /conversion/.test(jpy.spreadPerLot.detail);
check('the JPY pair is either priced in USD or honestly unknown', jpyPriced || jpyHonestlyUnknown,
  jpyPriced ? `USD/JPY spread ${jpy.spreadPerLot.value} ${CURRENCY}` : jpyHonestlyUnknown ? jpy.spreadPerLot.detail : JSON.stringify(jpy?.spreadPerLot));
check('every bound symbol is priced or explains the gap', snap.costs.every((c) => c.complete || c.missing.length > 0),
  JSON.stringify(snap.costs.filter((c) => !c.complete).map((c) => [c.symbol, c.missing, c.spreadPerLot.detail])));

// ---- 4. Readiness gate ----------------------------------------------------
const readiness = (await call('/broker/readiness?symbol=EUR/USD', { token })).body;
check('readiness is reported item by item', Array.isArray(readiness.items) && readiness.items.length >= 8, `${readiness.items?.length} items`);
check('the blockers name the commission and the unacknowledged published basis', readiness.ready === false
  && readiness.items.filter((i) => !i.ok && i.severity === 'BLOCK').map((i) => i.key).sort().join(',') === 'published_terms,terms_complete',
  readiness.blocking.join(' | '));
const perSymbol = (await call('/broker/readiness?symbol=GBP/USD', { token })).body;
check('an unpriceable symbol is held separately', perSymbol.ready === false && perSymbol.blocking.join(' ').includes('GBP/USD'), perSymbol.blocking.join(' | '));

// ---- 5. Acknowledge the broker's published terms ---------------------------
snap = (await call('/broker/terms/acknowledge', { method: 'POST', token })).body;
check('acknowledgement is recorded', snap.publishedAcknowledged === true, String(snap.publishedAcknowledgedAt));
check('the account cost basis is now in force for money', snap.costBasisActive === true);
const ready = (await call('/broker/readiness?symbol=EUR/USD', { token })).body;
check('the live gate opens for a bound demo account', ready.ready === true, ready.blocking.join(' | '));
const zeroBlockers = (await call('/broker/readiness', { token })).body;
const everySymbolPriced = snap.costs.every((c) => c.complete);
check('account-wide readiness is clear exactly when every symbol is priced',
  zeroBlockers.ready === everySymbolPriced,
  `ready=${zeroBlockers.ready} everySymbolPriced=${everySymbolPriced} ${zeroBlockers.blocking.join(' | ') || 'clear'}`);

// ---- 6. Terms provenance for the journal ----------------------------------
const terms = (await call('/broker/terms?symbol=EUR/USD', { token })).body;
check('provenance names the account type', terms.profileId === 'XM:ULTRA_LOW_STANDARD');
check('provenance records every sizing field with evidence', Array.isArray(terms.fields) && terms.fields.length >= 10
  && terms.fields.every((f) => f.evidence && typeof f.source === 'string'), `${terms.fields?.length} fields`);
const journalCommission = terms.fields.find((f) => f.key === 'commissionPerLotUsdRoundTurn');
check('journal keeps the commission and its provenance', journalCommission?.value === '0' && journalCommission?.evidence === 'POLICY_SNAPSHOT', JSON.stringify(journalCommission));
check('provenance carries the costs used', terms.costs?.symbol === 'EUR/USD' && terms.costs.commissionPerLot.value === 0);
check('provenance carries the binding and gate state', terms.binding.login === 91827364 && terms.liveReady === true);

// ---- 7. Changing the account type re-prices everything --------------------
snap = (await call('/broker/profile', { method: 'PUT', token, body: { broker: 'XM', accountType: 'XM_ZERO' } })).body;
check('account type switch takes effect immediately', snap.profileId === 'XM:XM_ZERO');
check('the switch lapses the published-terms acknowledgement', snap.publishedAcknowledged === false);
check('the switch clears account-specific confirmations', snap.confirmedAt === null);
const zero = (await call('/broker/costs?symbols=EUR/USD', { token })).body;
check('Zero is not assumed commission-free', zero.costs[0].commissionPerLot.value === null && zero.costs[0].missing.includes('commission'), JSON.stringify(zero.costs[0].commissionPerLot));

snap = (await call('/broker/profile', { method: 'PUT', token, body: { broker: 'XM', accountType: 'ULTRA_LOW_STANDARD' } })).body;
const back = (await call('/broker/costs?symbols=EUR/USD', { token })).body;
check('switching back restores the spread-only basis', snap.profileId === 'XM:ULTRA_LOW_STANDARD' && back.costs[0].commissionPerLot.value === 0 && back.costs[0].complete === true);

// ---- 8. The policy watcher is actually watching the broker ----------------
const policy = (await call('/broker/policy', { token })).body;
check('the broker page is being watched', typeof policy.sourceUrl === 'string' && policy.sourceUrl.includes('xm.com'), `${policy.status} ${policy.sourceUrl}`);
check('the watcher records what it read (bytes/hash/errors)', policy.contentBytes !== null || policy.lastError !== null,
  policy.lastError ? `last error: ${policy.lastError}` : `${policy.contentBytes} bytes, hash ${String(policy.contentHash).slice(0, 12)}`);

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
