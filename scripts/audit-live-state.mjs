// One-off audit of live USD flow state. Read-only.
const BASE = 'http://localhost:4000';
const TOKEN = (process.env.AUDIT_TOKEN || '').trim();
const j = async (p) => {
  try {
    const r = await fetch(BASE + p, { headers: { Authorization: `Bearer ${TOKEN}` } });
    return await r.json();
  } catch (e) { return { err: String(e) }; }
};
const out = {};

out.settings = await j('/api/settings');
out.account = await j('/api/paper/account');
out.positions = await j('/api/paper/positions');
out.goal = await j('/api/goal/analysis');
out.mt5 = await j('/api/mt5/status');

// Trim big arrays
if (Array.isArray(out.positions)) out.positions = out.positions.slice(0, 5);
if (Array.isArray(out.goal)) out.goal = out.goal.slice(0, 3);

console.log(JSON.stringify(out, null, 2));
