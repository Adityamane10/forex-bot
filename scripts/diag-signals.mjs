// Throwaway: full goal analysis for XAU/USD (gate refusal reason).
const BASE = 'http://127.0.0.1:4000';
const CREDS = { email: process.env.DIAG_EMAIL, password: process.env.DIAG_PASSWORD };
if (!CREDS.email || !CREDS.password) {
  console.error('Set DIAG_EMAIL and DIAG_PASSWORD before running this diagnostic.');
  process.exit(1);
}

const r = await fetch(BASE + '/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(CREDS),
});
const { token } = await r.json();
const H = { Authorization: 'Bearer ' + token };
const gs = await (await fetch(BASE + '/api/goal-signals', { headers: H })).json();
for (const a of gs.analyses ?? []) {
  console.log('---- ' + (a.symbol ?? '?') + ' ----');
  console.log(JSON.stringify(a, null, 1).slice(0, 2600));
}
