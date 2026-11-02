const fs = require('fs');
const env = {};
for (const line of fs.readFileSync(__dirname + '/.env', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^"|"$/g, '');
}
const jwt = require('jsonwebtoken');
const token = jwt.sign({user:{id:'diag',email:'d@l',role:'ADMIN',createdAt:Date.now()}}, env.JWT_SECRET||'dev-only-secret-change-me',{expiresIn:'10m'});
const H = { Authorization: 'Bearer ' + token };
const get = async (p) => (await fetch('http://127.0.0.1:4000/api' + p, { headers: H })).json();
(async () => {
  const tj = await get('/paper/trades');
  const trades = tj.trades || [];
  const mirrors = await get('/mt5/mirrors');
  const recent = trades.filter(t => Date.now() - t.closeTime < 12 * 3600_000);
  console.log(`recent dashboard trades: ${recent.length}, mirror rows: ${mirrors.length}`);
  const byPos = {};
  for (const mrow of mirrors) (byPos[mrow.positionId] ||= []).push(mrow);
  for (const t of recent.slice(0, 12)) {
    const ms = byPos[t.positionId] || [];
    console.log('---');
    console.log(`${t.symbol} ${t.direction} ${t.lots}lots | dashPnL=${t.pnl} | grossQuote=${t.grossQuotePnl} fxRate=${t.fxRate} src=${t.fxRateSource} stale=${t.fxStale} | reason=${t.exitReason} closed=${new Date(t.closeTime).toLocaleTimeString()}`);
    if (ms.length) console.log(`   mirror: ${ms.map(x=>`${x.action}:${x.status}${x.mt5Ticket?'#'+x.mt5Ticket:''}${x.error?'/'+x.error.slice(0,40):''}`).join(' ')}`);
  }
})().catch(e => console.log('ERR', e.message));
