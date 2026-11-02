// Audit all open positions: recompute expected P&L vs the engine's mark.
import dotenv from 'dotenv';
dotenv.config({ path: 'backend/.env' });
import jwt from 'jsonwebtoken';
import fs from 'fs';

const secret = process.env.JWT_SECRET || 'dev-only-secret-change-me';
const TOKEN = jwt.sign({ user: { id: 'audit', email: 'audit@local', role: 'USER', createdAt: 0 } }, secret, { expiresIn: '10m' });

const j = async (p) => (await fetch('http://localhost:4000' + p, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();

const known = { // standard contract sizes (MT5 defaults)
  'EUR/USD': 100000, 'GBP/USD': 100000, 'USD/JPY': 100000, 'USD/CAD': 100000,
  'USD/CHF': 100000, 'AUD/USD': 100000, 'NZD/USD': 100000, 'XAU/USD': 100,
};
const pipSize = (s) => (s.includes('JPY') ? 0.01 : s === 'XAU/USD' ? 0.01 : 0.0001);

const { positions } = await j('/api/paper/positions');
console.log(`open positions: ${positions.length}\n`);
let sum = 0;
for (const p of positions) {
  const dir = p.direction === 'BUY' ? 1 : -1;
  const perUnit = dir * (p.currentPrice - p.entryPrice);
  const cs = known[p.symbol] ?? 1;
  const expected = perUnit * p.lots * cs;
  const pips = perUnit / pipSize(p.symbol);
  sum += p.unrealizedPnl ?? 0;
  console.log(
    `${p.symbol} ${p.direction} ${p.lots} lots | entry ${p.entryPrice} cur ${p.currentPrice} | ${pips.toFixed(1)} pips` +
    ` | shown ${p.unrealizedPnl} | expected@CS${cs} ${expected.toFixed(2)}` +
    (Math.abs(expected - (p.unrealizedPnl ?? 0)) > Math.max(1, Math.abs(expected) * 0.15) ? '  <<< MIS-MARKED' : '') +
    ` | targetProfit ${p.targetProfit ?? '-'}`
  );
}
console.log(`\nsum(shown unrealized) = ${sum.toFixed(2)}`);
const acct = await j('/api/paper/account');
console.log(`account: balance ${acct.balance} equity ${acct.equity} unrealized ${acct.unrealizedPnl}`);
