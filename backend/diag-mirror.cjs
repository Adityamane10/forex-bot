// Mirror diagnosis: status, recent mirrors, open paper positions, worker log.
const fs = require('fs');
const env = {};
for (const line of fs.readFileSync(__dirname + '/.env', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^"|"$/g, '');
}
const jwt = require('jsonwebtoken');
const token = jwt.sign({user:{id:'diag',email:'d@l',role:'ADMIN',createdAt:Date.now()}}, env.JWT_SECRET||'dev-only-secret-change-me',{expiresIn:'10m'});
const H = { Authorization: 'Bearer ' + token };
(async () => {
  const st = await fetch('http://127.0.0.1:4000/api/mt5/status', { headers: H }).then(r=>r.json());
  console.log('mirror status:', JSON.stringify(st));
  const pos = await fetch('http://127.0.0.1:4000/api/paper/positions', { headers: H }).then(r=>r.json());
  console.log('open paper positions:', Array.isArray(pos) ? pos.length : JSON.stringify(pos).slice(0,150));
  const mir = await fetch('http://127.0.0.1:4000/api/mt5/mirrors', { headers: H }).then(r=>r.json());
  const rows = Array.isArray(mir) ? mir : [];
  const recent = rows.filter(x => Date.now() - x.createdAt < 6 * 3600_000);
  console.log(`mirrors (last 6h): ${recent.length}`);
  for (const r of recent.slice(0, 15)) {
    console.log(` ${new Date(r.createdAt).toLocaleTimeString()} ${r.action} ${r.symbol} lots=${r.lots} → ${r.status}${r.mt5Ticket ? ' #'+r.mt5Ticket : ''}${r.error ? ' ERR: '+String(r.error).slice(0,60) : ''}`);
  }
})().catch(e => console.log('ERR', e.message));
