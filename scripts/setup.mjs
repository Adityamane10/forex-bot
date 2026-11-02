/**
 * Local setup helper: installs JS deps, builds shared, installs Python deps.
 * Usage: node scripts/setup.mjs
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const run = (cmd) => {
  console.log(`\n▶ ${cmd}`);
  execSync(cmd, { stdio: 'inherit', cwd: root, shell: true });
};

console.log('FX Intel setup — free/local stack\n');

run('npm install --no-audit --no-fund');
run('npm run build --workspace shared');

const py = process.env.PY || 'py -3.13';
try {
  execSync(`${py} -m pip --version`, { stdio: 'ignore' });
  run(`${py} -m pip install -r ai-engine/requirements.txt`);
} catch {
  console.warn('\n⚠ Python 3.13 not found — install it or set PY="python3.13". The AI engine is optional for demo mode.');
}

console.log(`
Done. Start the stack:

  Terminal 1  backend:   npm run dev:backend
  Terminal 2  ai-engine: npm run dev:ai
  Terminal 3  frontend:  npm run dev:frontend

  or with Docker (Mongo + Redis included):  docker compose up

Open http://localhost:5173 — register an account, then explore the dashboard.
`);
