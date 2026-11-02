import { goalFeasibility, accountQuoteRate, toAccountCurrency } from './src/math/forexMath';
import { getAsset } from '@fx/shared';

const BASE = 'http://127.0.0.1:4000';
const j = async (p: string) => (await fetch(BASE + p)).json();

const settings = await j('/api/settings');
const signals = (await j('/api/signals')).signals as any[];
const ticks = (await j('/api/ticks')).ticks as any[];
const positions = (await j('/api/paper/positions')).positions as any[];

const getMid = (s: string) => ticks.find((t) => t.symbol === s)?.mid;
const toAcc = (s: string, q: number) => toAccountCurrency(s, settings.accountCurrency, q, getMid);

for (const sig of signals.filter((s) => s.state === 'ENTRY_REACHED' && !s.positionId)) {
  const t = ticks.find((x) => x.symbol === sig.symbol);
  if (!t) { console.log(sig.symbol, '-> NO TICK'); continue; }
  const fill = sig.direction === 'BUY' ? (t.ask ?? t.mid) : (t.bid ?? t.mid);
  const asset = getAsset(sig.symbol);
  const lotsFor = sig.plannedLots;
  const marginAccount = toAcc(sig.symbol, lotsFor * asset.contractSize * fill * asset.marginRequirement);
  const notionalAccount = toAcc(sig.symbol, lotsFor * asset.contractSize * fill);
  let openMargin = 0;
  for (const p of positions) {
    const pa = getAsset(p.symbol);
    openMargin += toAcc(p.symbol, p.lots * pa.contractSize * p.entryPrice * pa.marginRequirement);
  }
  const equity = settings.availableCapital;
  const totalMarginPct = ((openMargin + marginAccount) / equity) * 100;
  const positionLeverage = notionalAccount / equity;
  const gate = settings.maxMarginUsedPct > 0 && totalMarginPct > settings.maxMarginUsedPct
    ? `margin ${totalMarginPct.toFixed(1)}% > max ${settings.maxMarginUsedPct}%`
    : positionLeverage > settings.maxLeverage
      ? `lev ${positionLeverage.toFixed(1)} > max ${settings.maxLeverage}`
      : 'ok';
  console.log(sig.symbol.padEnd(10), 'gate:', gate, '| planned', lotsFor, '| mid', t.mid);
}