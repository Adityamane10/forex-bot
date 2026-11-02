// Trigger AI retraining through the backend API (builds train/serve-parity
// feature rows server-side, trains walk-forward, promotes the best model).
// Usage: node scripts/train-models.mjs [symbol,symbol,...] [timeframe]
import 'dotenv/config';
import fs from 'fs';

const BACKEND = process.env.BACKEND_URL || 'http://localhost:4000';
const secret = process.env.JWT_SECRET || process.env.APP_JWT_SECRET || 'dev-only-secret-change-me';

// Sign a short-lived operator token with the backend's own secret (never printed).
const { default: jwt } = await import('jsonwebtoken');
const token = jwt.sign(
  { user: { id: 'audit', email: 'audit@local', role: 'USER', createdAt: 0 } },
  secret,
  { expiresIn: '30m' },
);

const symbols = (process.argv[2] || 'XAU/USD,USD/JPY,EUR/USD,GBP/USD,EUR/JPY,GBP/JPY').split(',').map((s) => s.trim());
const timeframe = process.argv[3] || '1h';
const body = { symbols, timeframe, start: 0, end: Date.now(), folds: 3 };

const t0 = Date.now();
const res = await fetch(`${BACKEND}/api/models/train`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(30 * 60_000),
});
const text = await res.text();
fs.writeFileSync('train-result.json', text);
console.log(`HTTP ${res.status} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
try {
  const j = JSON.parse(text);
  if (j.folds) {
    for (const f of j.folds) {
      for (const m of f.models ?? []) {
        console.log(m.error ? `fold: ${m.algorithm} ERROR ${m.error.slice(0, 120)}` : `fold: ${m.algorithm} auc=${m.metrics?.auc} pf=${m.metrics?.profitFactor} deg=${m.metrics?.degenerate ?? false}`);
      }
    }
  }
  console.log('syncedModels:', j.syncedModels ?? '(none)');
} catch {
  console.log(text.slice(0, 400));
}
