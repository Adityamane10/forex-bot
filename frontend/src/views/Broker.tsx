import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Badge, Card, Empty, Table } from '../components/ui';
import { BrokerApi } from '../api';
import { connectSocket } from '../socket';
import { timeAgo } from '../format';
import type { BrokerStatusView, EvidenceKind } from '@fx/shared';

type Catalog = Awaited<ReturnType<typeof BrokerApi.catalog>>;

/** Cost-component source labels: where each per-symbol number came from. */
const COST_SOURCE_LABEL: Record<string, string> = {
  LIVE_FEED: 'LIVE PRICE',
  MT5_SYMBOL_INFO: 'MT5',
  ACCOUNT_TERMS: 'ACCOUNT TERMS',
  PLATFORM_DEFAULT: 'DEFAULT',
  UNKNOWN: 'UNKNOWN',
};

const COST_SOURCE_TONE: Record<string, 'up' | 'warn' | 'muted' | 'info'> = {
  LIVE_FEED: 'up',
  MT5_SYMBOL_INFO: 'up',
  ACCOUNT_TERMS: 'info',
  PLATFORM_DEFAULT: 'muted',
  UNKNOWN: 'warn',
};

function money(value: number | null, ccy: string): string {
  if (value === null) return 'unknown';
  return `${value.toFixed(2)} ${ccy}`;
}

/**
 * Broker & Account — the platform's trading account.
 *
 * Everything on this page exists to answer one question honestly: *what terms
 * is this platform trading on, and where did each number come from?* A term is
 * shown with the evidence behind it (broker-issued, operator-confirmed,
 * platform default, or unknown) and the execution gate says plainly whether an
 * order may leave for the bound MT5 account right now, and if not, why.
 */
const EVIDENCE_TONE: Record<EvidenceKind, 'up' | 'warn' | 'muted' | 'info'> = {
  MT5_ACCOUNT: 'up',
  OPERATOR_CONFIRMED: 'info',
  POLICY_SNAPSHOT: 'info',
  UNVERIFIED: 'warn',
  PLATFORM_DEFAULT: 'muted',
};

const EVIDENCE_LABEL: Record<EvidenceKind, string> = {
  MT5_ACCOUNT: 'BROKER-REPORTED',
  OPERATOR_CONFIRMED: 'CONFIRMED BY YOU',
  POLICY_SNAPSHOT: 'POLICY DOC',
  UNVERIFIED: 'UNVERIFIED',
  PLATFORM_DEFAULT: 'PLATFORM DEFAULT',
};

/** Fields the confirmation form covers: the ones live money depends on. */
const CONFIRMABLE = ['baseCurrencies', 'leverageOptions', 'contractSize', 'minLot', 'maxLot', 'lotStep', 'commissionPerLotUsdRoundTurn', 'typicalSpreadPips', 'stopOutLevelPct'];

export function Broker() {
  const [status, setStatus] = useState<BrokerStatusView | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    try {
      const [s, c] = await Promise.all([BrokerApi.profile(), BrokerApi.catalog()]);
      setStatus(s);
      setCatalog(c);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'broker status unavailable');
    }
  }, []);

  useEffect(() => {
    void load();
    // Realtime: the backend pushes the full account/conditions snapshot on
    // every MT5 heartbeat, selection, confirmation and policy change. The poll
    // is only a safety net for a dropped socket.
    const socket = connectSocket();
    const onProfile = (s: BrokerStatusView) => setStatus(s);
    socket.on('broker.profile', onProfile);
    const timer = window.setInterval(() => void load(), 15_000);
    return () => {
      socket.off('broker.profile', onProfile);
      window.clearInterval(timer);
    };
  }, [load]);

  const act = async (fn: () => Promise<BrokerStatusView>) => {
    setBusy(true);
    try {
      setStatus(await fn());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'action failed');
    } finally {
      setBusy(false);
    }
  };

  const selectAccountType = async (broker: string, accountType: string) => {
    if (status && status.profileId === `${broker}:${accountType}`) return;
    const confirmed = status?.confirmedAt ? window.confirm('Switching account type clears the conditions you confirmed for the previous account. Continue?') : true;
    if (!confirmed) return;
    await act(() => BrokerApi.select(broker, accountType));
  };

  const submitConfirmations = async () => {
    const values: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(draft)) {
      if (raw.trim() === '') continue;
      values[key] = key === 'baseCurrencies' || key === 'leverageOptions' ? raw : Number(raw);
    }
    if (!Object.keys(values).length) return;
    await act(() => BrokerApi.confirmConditions(values, note.trim() || undefined));
    setDraft({});
    setNote('');
  };

  const bound = status?.binding.account ?? null;
  const accounts = useMemo(() => (catalog?.profiles ?? []).filter((p) => p.broker !== 'GENERIC'), [catalog]);

  /**
   * Prefill the confirmation form from everything the catalog carries with
   * broker-published evidence, so confirming the account's real terms is a
   * review-and-click instead of retyping numbers — while the confirm step (and
   * the audit trail it writes) stays explicit.
   */
  const applyPublishedBasis = () => {
    if (!status) return;
    const next: Record<string, string> = {};
    for (const c of status.conditions) {
      if (!CONFIRMABLE.includes(c.key)) continue;
      if (c.evidence === 'POLICY_SNAPSHOT' && c.raw !== null) {
        next[c.key] = Array.isArray(c.raw) ? c.raw.join(', ') : String(c.raw);
      }
    }
    setDraft(next);
    setNote('xm.com account-types page — published basis accepted');
  };

  if (error && !status) return <Card><div className="text-sm text-red-300">{error}</div></Card>;
  if (!status) return <Card><div className="text-sm text-slate-500">reading broker account…</div></Card>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold text-slate-100">Broker &amp; Account</h1>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge tone={status.liveGate.allowed ? 'up' : 'red'}>{status.liveGate.allowed ? 'ORDERS MAY DISPATCH' : 'DISPATCH HELD'}</Badge>
          <Badge tone={status.realExecutionEnabled ? 'red' : 'muted'}>{status.realExecutionEnabled ? 'REAL MONEY ENABLED' : 'DEMO / NO REAL MONEY'}</Badge>
          <span className="text-slate-500">{status.brokerLabel}</span>
        </div>
      </div>
      {error && <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-300">{error}</div>}

      <Card title="Account type — what trades, signals and predictions follow">
        <div className="flex flex-wrap gap-2">
          {accounts.map((p) => {
            const on = status.profileId === p.id;
            return (
              <button
                key={p.id}
                disabled={busy}
                onClick={() => void selectAccountType(p.broker, p.accountType)}
                className={`rounded-md border px-3 py-2 text-left text-xs transition-colors ${
                  on ? 'border-blue-500/40 bg-blue-600/20 text-blue-100' : 'border-border bg-panel2 text-slate-400 hover:border-hairline hover:text-slate-200'
                }`}
              >
                <div className="font-medium">{p.label}</div>
                <div className="mt-0.5 font-mono text-[10px] uppercase text-slate-500">{p.id}</div>
              </button>
            );
          })}
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
          The selected account type drives contract size, lot geometry, minimum stop distance, spread/commission costs,
          margin caps and leverage for signal generation, predictions and position sizing. Values come from the bound MT5
          account where the broker reports them, and from your confirmations otherwise — never from a guess.
        </p>
      </Card>

      <Card
        title="Broker-published terms"
        right={<Badge tone={status.publishedAcknowledged ? 'up' : 'warn'}>{status.publishedAcknowledged ? 'ACKNOWLEDGED' : 'NOT ACKNOWLEDGED'}</Badge>}
      >
        <p className="text-[11px] leading-relaxed text-slate-500">
          Some terms cannot come from MetaTrader — a broker does not publish its commission through the terminal. Those
          values come from what {status.brokerLabel} publishes for{' '}
          <span className="text-slate-300">{status.label}</span>, and they count as live-grade only while you have
          acknowledged them for this account type.
        </p>
        {status.published ? (
          <ul className="mt-3 space-y-1.5">
            {status.published.quotes.map((q) => (
              <li key={q} className="border-l-2 border-border pl-2 text-[12px] italic leading-relaxed text-slate-400">
                &ldquo;{q}&rdquo;
              </li>
            ))}
          </ul>
        ) : (
          <div className="mt-3 text-[12px] text-slate-500">This account type has no published terms recorded.</div>
        )}
        {status.published && (
          <>
            <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
              <span className="text-slate-400">Cost basis in use:</span> {status.published.costBasis}
              {' '}
              <a className="text-blue-300 hover:underline" href={status.published.sourceUrl} target="_blank" rel="noreferrer">
                Read it on {status.published.sourceUrl.replace(/^https?:\/\//, '')}
              </a>{' '}
              (read {new Date(status.published.retrievedAt).toISOString().slice(0, 10)})
            </p>
            <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-3">
              <Field label="Minimum deposit" value={status.published.minDepositUsd === null ? 'not published' : `$${status.published.minDepositUsd}`} />
              <Field label="Markets" value={<span className="text-[11px]">{status.published.markets ?? 'not published'}</span>} />
              <Field label="Rows the broker publishes" value={<span className="text-[11px]">{status.published.publishedRows.join(' · ')}</span>} />
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
              The platform will not invent the numbers behind those rows: they come from your bound account&apos;s live data
              or from your confirmation below, and the broker&apos;s page is re-read continuously so a change is flagged.
            </p>
          </>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            onClick={() => void act(() => BrokerApi.acknowledgeTerms())}
            disabled={busy}
            className="rounded bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-40"
          >
            {status.publishedAcknowledged ? 'Re-acknowledge published terms' : 'I have read these terms'}
          </button>
          {status.publishedAcknowledgedAt !== null && (
            <span className="text-[11px] text-slate-500">acknowledged {timeAgo(status.publishedAcknowledgedAt)}</span>
          )}
          <button
            onClick={applyPublishedBasis}
            disabled={busy || status.conditions.every((c) => c.evidence !== 'POLICY_SNAPSHOT')}
            title="Fills the confirmation fields with the values the broker publishes for this account type"
            className="rounded border border-border px-3 py-1.5 text-xs text-slate-300 hover:border-hairline disabled:opacity-40"
          >
            Load them into the confirmation form
          </button>
        </div>
      </Card>

      <Card title="Execution gate" right={<span className="text-[11px] text-slate-500">why orders do or do not leave</span>}>
        {status.liveGate.allowed && status.liveGate.warnings.length === 0 && (
          <div className="text-sm text-emerald-300">The bound account matches the selected profile and its conditions are broker-confirmed.</div>
        )}
        <ul className="space-y-1.5">
          {status.liveGate.reasons.map((r) => (
            <li key={r} className="flex gap-2 text-[13px] text-red-300">
              <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-red-400" />
              <span>{r}</span>
            </li>
          ))}
          {status.liveGate.warnings.map((r) => (
            <li key={r} className="flex gap-2 text-[13px] text-amber-300/90">
              <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400/70" />
              <span>{r}</span>
            </li>
          ))}
        </ul>
        {status.liveGate.reasons.length > 0 && (
          <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
            Held orders are not cancelled: they stay queued and execute the moment the gate opens, so nothing is lost while
            the account is unverified.
          </p>
        )}
      </Card>

      <Card title="Live-money readiness" right={<Badge tone={status.readiness.ready ? 'up' : 'red'}>{status.readiness.ready ? 'READY FOR REAL MONEY' : `${status.readiness.blocking.length} BLOCKER${status.readiness.blocking.length === 1 ? '' : 'S'}`}</Badge>}>
        <p className="text-[11px] leading-relaxed text-slate-500">
          Every fact the platform needs before an order may leave for the broker, checked independently. A red row is not
          a warning — it is the reason no live order can be dispatched right now.
        </p>
        <ul className="mt-3 space-y-1.5">
          {status.readiness.items.map((i) => (
            <li key={i.key} className="flex items-start gap-2 text-[12px]">
              <span className={`mt-[6px] h-1.5 w-1.5 shrink-0 rounded-full ${i.ok ? 'bg-emerald-400' : i.severity === 'BLOCK' ? 'bg-red-400' : 'bg-amber-400'}`} />
              <span className="w-56 shrink-0 text-slate-300">{i.label}</span>
              <span className={i.ok ? 'text-slate-400' : i.severity === 'BLOCK' ? 'text-red-200' : 'text-amber-200/90'}>{i.detail}</span>
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Bound MT5 account" right={bound ? <Badge tone={status.binding.bound ? 'up' : 'warn'}>{status.binding.bound ? 'LIVE BINDING' : 'STALE'}</Badge> : <Badge tone="red">NOT BOUND</Badge>}>
        {!bound ? (
          <Empty text="No MetaTrader 5 account has reported in. Start the trader worker (workers/mt5-trader/trader.py) or the all-in-one dev script so the platform can see the account it is trading." />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Field label="Login" value={String(bound.login)} />
              <Field label="Server" value={bound.server || '—'} />
              <Field label="Company" value={bound.company || 'not reported'} />
              <Field label="Trade mode" value={<Badge tone={bound.tradeMode === 'DEMO' ? 'up' : bound.tradeMode === 'REAL' ? 'red' : 'warn'}>{bound.tradeMode}</Badge>} />
              <Field label="Currency" value={bound.currency} />
              <Field label="Leverage" value={bound.leverage ? `1:${bound.leverage}` : 'not reported'} />
              <Field label="Balance" value={bound.balance.toFixed(2)} />
              <Field label="Equity" value={(bound.equity ?? bound.balance).toFixed(2)} />
              <Field label="Margin call / stop out" value={`${bound.marginCallLevelPct ?? '—'}% / ${bound.stopOutLevelPct ?? '—'}%`} />
              <Field label="Broker symbol specs" value={`${status.binding.specsReported} symbols`} />
              <Field label="Last heartbeat" value={status.binding.ageMs === null ? 'never' : `${Math.round(status.binding.ageMs / 1000)}s ago`} />
            </div>
            {status.binding.issues.length > 0 && (
              <div className="mt-3 space-y-1">
                {status.binding.issues.map((i) => (
                  <div key={i.code} className="flex items-start gap-2 text-[12px]">
                    <Badge tone={i.severity === 'BLOCK' ? 'red' : 'warn'}>{i.severity}</Badge>
                    <span className={i.severity === 'BLOCK' ? 'text-red-200' : 'text-amber-200/90'}>{i.message}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </Card>

      <Card title="Trading conditions in use" right={<span className="text-[11px] text-slate-500">resolved per field, with provenance</span>}>
        <Table head={['Condition', 'Value', 'Evidence', 'Source', 'Live money']}>
          {status.conditions.map((c) => (
            <tr key={c.key}>
              <td className="text-[13px] text-slate-200">
                {c.label}
                {c.unit && <span className="ml-1 text-[11px] text-slate-500">({c.unit})</span>}
              </td>
              <td className={`font-mono text-[13px] ${c.raw === null ? 'text-slate-500' : 'text-slate-100'}`}>{c.display}</td>
              <td><Badge tone={EVIDENCE_TONE[c.evidence]}>{EVIDENCE_LABEL[c.evidence]}</Badge></td>
              <td className="max-w-[260px] truncate text-[11px] text-slate-500" title={c.source}>{c.source}</td>
              <td>{c.requiredForLive ? (c.liveGrade ? <Badge tone="up">USABLE</Badge> : <Badge tone="red">REQUIRED</Badge>) : <span className="text-[11px] text-slate-600">—</span>}</td>
            </tr>
          ))}
        </Table>

        <div className="mt-4 border-t border-border/60 pt-3">
          <div className="eyebrow">Confirm from the broker</div>
          <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
            MetaTrader exposes contract specs, leverage and margin levels, but not everything (commission, and any term
            your terminal does not publish). Read those on the broker&apos;s own account page and record them here.
            {status.marketUrl && (
              <>
                {' '}
                <a className="text-blue-300 hover:underline" href={status.marketUrl} target="_blank" rel="noreferrer">
                  Open the broker&apos;s account terms
                </a>
              </>
            )}
          </p>
          <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-3">
            {status.conditions
              .filter((c) => CONFIRMABLE.includes(c.key))
              .map((c) => (
                <label key={c.key} className="block">
                  <span className="text-[11px] uppercase text-slate-500">
                    {c.label}
                    {c.unit ? ` (${c.unit})` : ''}
                  </span>
                  <input
                    value={draft[c.key] ?? ''}
                    onChange={(e) => setDraft({ ...draft, [c.key]: e.target.value })}
                    placeholder={c.display === 'unknown' ? 'unknown' : c.display}
                    className="mt-1 w-full rounded border border-border bg-panel2 px-2 py-1 font-mono text-sm text-slate-200"
                  />
                </label>
              ))}
          </div>
          <label className="mt-3 block">
            <span className="text-[11px] uppercase text-slate-500">Where you read it (kept with the audit trail)</span>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. xm.com account page, checked 2026-09-17"
              className="mt-1 w-full rounded border border-border bg-panel2 px-2 py-1 text-sm text-slate-200"
            />
          </label>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              onClick={() => void submitConfirmations()}
              disabled={busy || Object.keys(draft).length === 0}
              className="rounded bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-40"
            >
              Confirm conditions
            </button>
            <button
              onClick={() => void act(() => BrokerApi.clearConditions())}
              disabled={busy || status.confirmedAt === null}
              className="rounded border border-border px-3 py-1.5 text-xs text-slate-300 hover:border-hairline disabled:opacity-40"
            >
              Clear confirmations
            </button>
            {status.confirmedAt !== null && <span className="text-[11px] text-slate-500">last confirmed {timeAgo(status.confirmedAt)}</span>}
          </div>
        </div>
      </Card>

      <Card
        title="Per-symbol account costs"
        right={
          <div className="flex items-center gap-2">
            <Badge tone={status.costBasisActive ? 'up' : 'muted'}>
              {status.costBasisActive ? 'IN FORCE FOR MONEY' : 'PLANNING BASIS ONLY'}
            </Badge>
            <span className="text-[11px] text-slate-500">
              {status.costs.length === 0
                ? 'waiting for the bound account'
                : `${status.costs.filter((c) => c.complete).length}/${status.costs.length} fully priced`}
            </span>
          </div>
        }
      >
        <p className="text-[11px] leading-relaxed text-slate-500">
          What one lot of each symbol costs on this account: spread + commission for a round turn, and the overnight swap.
          The spread is priced on the live bid/ask the platform is trading on (falling back to the terminal&apos;s own
          symbol_info), swaps come from the broker&apos;s symbol_info, and the commission follows the selected account type
          — a spread-only XM account applies no per-lot commission. Unknown components are shown as unknown, never as zero.
        </p>
        {!status.costBasisActive && (
          <p className="mt-2 rounded border border-amber-500/25 bg-amber-500/5 px-2.5 py-2 text-[11px] leading-relaxed text-amber-200/90">
            These are the selected account type&apos;s PLANNING figures: signals, predictions and sizing already follow
            them, but the wallet keeps the platform-default commission until a MetaTrader account is bound or you
            acknowledge the broker&apos;s published terms above.
          </p>
        )}
        {status.costs.length === 0 ? (
          <div className="mt-3 text-[12px] text-slate-500">
            No symbol costs yet: bind the MT5 account so the broker can report its contract specs.
          </div>
        ) : (
          <div className="mt-3">
            <Table head={['Symbol', 'Broker symbol', 'Spread (pips)', 'Spread / lot', 'Commission / lot', 'Round turn / lot', 'Swap long / short (night)', 'Complete']}>
              {status.costs.map((c) => (
                <tr key={c.symbol}>
                  <td className="font-mono text-[13px] text-slate-200">{c.symbol}</td>
                  <td className="font-mono text-[12px] text-slate-500">{c.brokerSymbol ?? '—'}</td>
                  <td className="font-mono text-[12px] text-slate-300" title={c.spreadPips.detail}>
                    {c.spreadPips.value === null ? 'unknown' : c.spreadPips.value.toFixed(2)}
                  </td>
                  <td className="font-mono text-[12px] text-slate-300" title={c.spreadPerLot.detail}>
                    {money(c.spreadPerLot.value, status.displayCurrency)}
                    <div><Badge tone={COST_SOURCE_TONE[c.spreadPerLot.source]}>{COST_SOURCE_LABEL[c.spreadPerLot.source]}</Badge></div>
                  </td>
                  <td className="font-mono text-[12px] text-slate-300" title={c.commissionPerLot.detail}>
                    {money(c.commissionPerLot.value, status.displayCurrency)}
                    <div><Badge tone={COST_SOURCE_TONE[c.commissionPerLot.source]}>{COST_SOURCE_LABEL[c.commissionPerLot.source]}</Badge></div>
                  </td>
                  <td className="font-mono text-[12px] text-slate-100" title={c.roundTurnPerLot.detail}>
                    {money(c.roundTurnPerLot.value, status.displayCurrency)}
                  </td>
                  <td className="font-mono text-[11px] text-slate-400" title={`${c.swapLongPerLotNight.detail} · ${c.swapShortPerLotNight.detail}`}>
                    {c.swapLongPerLotNight.value === null ? 'unknown' : c.swapLongPerLotNight.value.toFixed(2)} /{' '}
                    {c.swapShortPerLotNight.value === null ? 'unknown' : c.swapShortPerLotNight.value.toFixed(2)}
                  </td>
                  <td>
                    {c.complete ? <Badge tone="up">YES</Badge> : <Badge tone="warn">missing {c.missing.join('/')}</Badge>}
                  </td>
                </tr>
              ))}
            </Table>
          </div>
        )}
      </Card>

      {status.specMismatches.length > 0 && (
        <Card title="Broker vs platform specs" right={<span className="text-[11px] text-slate-500">broker values are the ones in use</span>}>
          <Table head={['Symbol', 'Field', 'Platform', 'Broker', 'Severity']}>
            {status.specMismatches.map((m) => (
              <tr key={`${m.symbol}-${m.field}`}>
                <td className="font-mono text-[13px] text-slate-200">{m.symbol}</td>
                <td className="text-[12px] text-slate-400">{m.field}</td>
                <td className="font-mono text-[12px] text-slate-500">{m.platform}</td>
                <td className="font-mono text-[12px] text-slate-100">{m.broker}</td>
                <td><Badge tone={m.severity === 'BLOCK' ? 'red' : 'warn'}>{m.severity}</Badge></td>
              </tr>
            ))}
          </Table>
        </Card>
      )}

      <Card title="Broker policy watch" right={<Badge tone={status.policy.status === 'FRESH' ? 'up' : status.policy.status === 'UNAVAILABLE' ? 'red' : 'warn'}>{status.policy.status}</Badge>}>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Field label="Source" value={<span className="break-all text-[11px]">{status.policy.sourceUrl || 'not configured'}</span>} />
          <Field label="Last checked" value={status.policy.lastAttemptAt ? timeAgo(status.policy.lastAttemptAt) : 'never'} />
          <Field label="Last read" value={status.policy.fetchedAt ? timeAgo(status.policy.fetchedAt) : 'never'} />
          <Field label="Last change" value={status.policy.changedAt ? timeAgo(status.policy.changedAt) : '—'} />
        </div>
        {status.policy.lastError && (
          <p className="mt-3 rounded border border-amber-500/25 bg-amber-500/5 px-2.5 py-2 text-[11px] leading-relaxed text-amber-200/90">
            Automatic check failed: <span className="font-mono">{status.policy.lastError}</span>. The platform keeps polling and
            will flag a change the moment it can read the page — until then the conditions above stay exactly as you confirmed
            them, and anything still unverified is treated as unknown rather than assumed.
          </p>
        )}
        {status.policy.reviewRequired && (
          <p className="mt-3 rounded border border-amber-500/30 bg-amber-500/5 px-2.5 py-2 text-[11px] text-amber-200">
            The published terms changed since you last confirmed them. Re-check the affected conditions and confirm again —
            the platform will not update its own trading conditions from a fetched document.
          </p>
        )}
        <button
          onClick={() => void BrokerApi.recheckPolicy().catch(() => undefined)}
          disabled={busy}
          className="mt-3 rounded border border-border px-3 py-1.5 text-xs text-slate-300 hover:border-hairline disabled:opacity-40"
        >
          Check now
        </button>
      </Card>

      <Card title="Conversion" right={<span className="text-[11px] text-slate-500">live rate only — no fixed price</span>}>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Field label="Display currency" value={status.displayCurrency} />
          <Field label="Wallet currency" value={status.accountCurrency} />
          <Field
            label="Live rate"
            value={status.fx ? `1 ${status.fx.pair.split('/')[0]} = ${status.fx.rate.toFixed(4)} ${status.fx.pair.split('/')[1]}` : 'no rate yet'}
          />
          <Field
            label="Rate age"
            value={status.fx ? <span className={status.fx.stale ? 'text-amber-300' : ''}>{Math.round(status.fx.ageMs / 1000)}s — {status.fx.source}{status.fx.stale ? ' (STALE)' : ''}</span> : '—'}
          />
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
          Money is shown in the bound account&apos;s currency, exactly as the broker reports it — balance, equity, margin,
          profit targets and per-trade P&L all mirror the account. Position sizing still converts quote-currency moves into
          the account currency over the live feed above; when that feed is stale or absent the platform pauses sizing instead
          of substituting a fixed rate.
        </p>
      </Card>
    </div>
  );
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-md border border-border bg-panel2 px-3 py-2">
      <div className="eyebrow">{label}</div>
      <div className="mt-0.5 font-mono text-[13px] text-slate-100">{value}</div>
    </div>
  );
}
