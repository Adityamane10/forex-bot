/**
 * Option chain summary: what the option book is pricing, and how much of it we
 * actually know.
 *
 * Two things changed here beyond styling. First, the payload type now comes from
 * `@fx/shared` instead of a local copy — the local copy had drifted to a subset
 * of the real shape, so ATM data, IV rank, expected move, days-to-expiry,
 * liquidity and data quality were all being computed by the backend and thrown
 * away here. Second, the data arrives over the websocket. The old version
 * polled `/option-analytics` every 30 seconds for numbers the backend already
 * pushes on `india.optionAnalytics` whenever it recomputes them.
 *
 * The single REST call that remains fills the panel before the first push lands
 * — otherwise a market-closed session, where the refresh timer never fires,
 * would show an empty panel forever.
 */
import { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import type { IndiaOptionAnalytics, IndiaStrikeSignificance } from '@fx/shared';
import { IndiaApi } from '../../api';
import { actions, RootState } from '../../store';
import { fmtCur, timeAgo } from '../../format';
import { expiryCountdown, ivPct, level } from './optionFormat';

const cls = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(' ');

/** Analytics older than this are labelled stale rather than shown as current. */
const STALE_AFTER_MS = 120_000;

function Pill({ children, color, title }: { children: React.ReactNode; color: string; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium ${color}`}>
      {children}
    </span>
  );
}

function StatBox({ label, value, sub, color }: { label: string; value: React.ReactNode; sub?: string; color?: string }) {
  return (
    <div className="rounded bg-slate-800/40 px-2.5 py-2">
      <div className="text-[10px] text-slate-500 uppercase tracking-wide">{label}</div>
      <div className={cls('mt-0.5 font-mono text-sm font-semibold', color ?? 'text-slate-200')}>{value}</div>
      {sub && <div className="text-[10px] text-slate-600 mt-0.5">{sub}</div>}
    </div>
  );
}

/**
 * The signature of this panel: the option market prices a distribution, not a
 * point. Spot sits on a line, the ±1σ move implied by ATM IV is shaded around
 * it, and Max Pain — the strike where option writers lose least, i.e. where the
 * book would rather expiry happened — is marked against it. Reading those three
 * numbers off a stat grid tells you far less than seeing which side of the
 * implied range Max Pain sits on.
 */
function ImpliedRange({
  spot, expectedMove, maxPain, support, resistance,
}: {
  spot: number;
  expectedMove: number;
  maxPain: number | null;
  support: number[];
  resistance: number[];
}) {
  // Pad so the shaded band never touches the edges, and so Max Pain stays on
  // screen even when it sits well outside one sigma.
  const painGap = maxPain == null ? 0 : Math.abs(maxPain - spot) * 1.2;
  const pad = Math.max(expectedMove * 1.6, painGap, spot * 0.002);
  const lo = spot - pad;
  const hi = spot + pad;
  if (!(hi > lo)) return null;
  const at = (v: number) => Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
  const bandLeft = at(spot - expectedMove);
  const bandRight = at(spot + expectedMove);

  return (
    <div className="rounded bg-slate-800/40 px-3 pt-5 pb-6">
      <div className="relative h-6">
        {/* full range */}
        <div className="absolute top-3 h-px w-full bg-slate-700" />
        {/* ±1 sigma implied by ATM IV over the remaining life. Achromatic on
            purpose — a range is not a direction, and in this design system a
            saturated pixel always means gain, loss or risk. */}
        <div
          className="absolute top-[9px] h-1.5 rounded-full bg-blue-400/25"
          style={{ left: `${bandLeft}%`, width: `${Math.max(0.5, bandRight - bandLeft)}%` }}
        />
        {[
          ...support.map((v) => ({ v, kind: 'support' as const })),
          ...resistance.map((v) => ({ v, kind: 'resistance' as const })),
        ].map(({ v, kind }) => (
          <div
            key={`${kind}-${v}`}
            title={`OI ${kind} ${level(v)}`}
            className={cls('absolute top-2 h-2 w-px', kind === 'support' ? 'bg-emerald-500/60' : 'bg-red-500/60')}
            style={{ left: `${at(v)}%` }}
          />
        ))}
        {maxPain != null && (
          <>
            <div
              className="absolute top-1 h-4 w-px bg-amber-400"
              style={{ left: `${at(maxPain)}%` }}
            />
            <div
              className="absolute top-6 -translate-x-1/2 whitespace-nowrap font-mono text-[10px] text-amber-400/90"
              style={{ left: `${at(maxPain)}%` }}
            >
              {level(maxPain)}
            </div>
          </>
        )}
        <div
          className="absolute top-0 h-6 w-px bg-slate-100 transition-[left] duration-500 motion-reduce:transition-none"
          style={{ left: `${at(spot)}%` }}
        />
        <div
          className="absolute -top-4 -translate-x-1/2 whitespace-nowrap font-mono text-[10px] font-semibold text-slate-100 transition-[left] duration-500 motion-reduce:transition-none"
          style={{ left: `${at(spot)}%` }}
        >
          {level(spot, 2)}
        </div>
      </div>
      <div className="mt-1 flex items-baseline justify-between font-mono text-[10px] text-slate-500">
        <span>{level(spot - expectedMove)}</span>
        <span className="text-slate-400">
          ±{level(expectedMove)} <span className="text-slate-600">1σ · {((expectedMove / spot) * 100).toFixed(2)}%</span>
        </span>
        <span>{level(spot + expectedMove)}</span>
      </div>
    </div>
  );
}

function StrikeRow({ strike, isSupport, isResistance }: { strike: IndiaStrikeSignificance; isSupport: boolean; isResistance: boolean }) {
  return (
    <div className="flex items-center justify-between rounded bg-slate-800/40 px-2 py-1.5">
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs font-semibold text-slate-200">{level(strike.strike)}</span>
        {strike.significance === 'HIGH' && <Pill color="bg-yellow-500/20 text-yellow-300">KEY</Pill>}
        {isSupport && <Pill color="bg-panel2 text-slate-400" title="Heaviest put OI — writers defend below">SUP</Pill>}
        {isResistance && <Pill color="bg-panel2 text-slate-400" title="Heaviest call OI — writers defend above">RES</Pill>}
      </div>
      <div className="flex items-center gap-3 text-[10px]">
        <div>
          <span className="text-slate-500">C:</span>
          <span className="ml-1 text-emerald-400">{(strike.callOI / 1000).toFixed(0)}k</span>
          {strike.callOIChange !== 0 && (
            <span className={cls('ml-0.5', strike.callOIChange > 0 ? 'text-emerald-500' : 'text-red-500')}>
              {strike.callOIChange > 0 ? '+' : ''}{(strike.callOIChange / 1000).toFixed(0)}k
            </span>
          )}
        </div>
        <div>
          <span className="text-slate-500">P:</span>
          <span className="ml-1 text-red-400">{(strike.putOI / 1000).toFixed(0)}k</span>
          {strike.putOIChange !== 0 && (
            <span className={cls('ml-0.5', strike.putOIChange > 0 ? 'text-emerald-500' : 'text-red-500')}>
              {strike.putOIChange > 0 ? '+' : ''}{(strike.putOIChange / 1000).toFixed(0)}k
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/** "3d 4h" / "2h 15m" / "48m" — an expiry countdown reads better than a decimal. */
function expiryLabel(a: IndiaOptionAnalytics): string {
  return expiryCountdown(a.minutesToExpiry, a.daysToExpiry);
}

export function OptionAnalyticsPanel({ underlying }: { underlying: string }) {
  const dispatch = useDispatch();
  // Annotated rather than cast: the record genuinely may not hold this key yet,
  // and TypeScript's index signatures pretend otherwise.
  const analytics: IndiaOptionAnalytics | undefined = useSelector((s: RootState) => s.india.optionAnalytics[underlying]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    setError(null);
    // One fetch, not a poll. The reducer discards a payload older than what it
    // already holds, so this landing after the first socket push is harmless.
    void IndiaApi.getOptionAnalytics(underlying)
      .then((res) => {
        if (!mounted) return;
        if (!res) {
          setError(`No option chain available for ${underlying} yet.`);
          return;
        }
        dispatch(actions.india.optionAnalytics(res));
      })
      .catch((err: unknown) => {
        if (mounted) setError(err instanceof Error ? err.message : 'Failed to load option analytics');
      });
    return () => {
      mounted = false;
    };
  }, [underlying, dispatch]);

  if (!analytics) {
    return (
      <div className="rounded border border-slate-700/50 bg-slate-800/30 p-4">
        <div className={cls('text-center text-sm', error ? 'text-red-400' : 'text-slate-400')}>
          {error ?? 'Loading option analytics…'}
        </div>
      </div>
    );
  }

  const { pcr, maxPain, atm, sentiment, ivAnalysis, oiActivity, liquidity, dataQuality, oiLevels } = analytics;
  const stale = Date.now() - analytics.timestamp > STALE_AFTER_MS;
  const oiOnly = dataQuality.source === 'OI_ONLY';

  // High PCR = put writers dominant = support beneath the market = bullish.
  const pcrColor = pcr.byOI > 1.2 ? 'text-emerald-400' : pcr.byOI < 0.8 ? 'text-red-400' : 'text-slate-300';
  const sentimentColor =
    sentiment.signal === 'BULLISH' ? 'text-emerald-400' : sentiment.signal === 'BEARISH' ? 'text-red-400' : 'text-slate-400';
  const sentimentBar =
    sentiment.signal === 'BULLISH' ? 'bg-emerald-500' : sentiment.signal === 'BEARISH' ? 'bg-red-500' : 'bg-slate-500';
  const reasons = Array.isArray(sentiment.reasons) && sentiment.reasons.length ? sentiment.reasons : [sentiment.reason];

  // IV rank is only reported once there is enough history to mean it; until then
  // say so instead of printing a percentile computed from two days of data.
  const ivRankValue = ivAnalysis.ivRank;
  const spreadPct = liquidity.atmSpreadPct;
  const support = oiLevels.support;
  const resistance = oiLevels.resistance;

  return (
    <div className="rounded border border-slate-700/50 bg-slate-800/30 p-3 space-y-3">
      <div className="flex items-center justify-between gap-2 border-b border-slate-700 pb-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
          Option chain · {underlying}
        </span>
        <div className="flex items-center gap-1.5">
          {oiOnly && (
            <Pill
              color="bg-amber-500/20 text-amber-300"
              title="Open interest is real, but premiums and quotes are missing from this feed — so IV, greeks and spreads cannot be computed. Not a failure; a thinner feed."
            >
              OI ONLY
            </Pill>
          )}
          {stale && <Pill color="bg-slate-600/30 text-slate-400" title="No refresh recently — the market is probably closed.">STALE</Pill>}
          <span className="font-mono text-[10px] text-slate-500">{timeAgo(analytics.timestamp)}</span>
        </div>
      </div>

      {analytics.spotPrice != null && analytics.expectedMove != null && analytics.expectedMove > 0 ? (
        <ImpliedRange
          spot={analytics.spotPrice}
          expectedMove={analytics.expectedMove}
          maxPain={maxPain.strike}
          support={support}
          resistance={resistance}
        />
      ) : (
        <div className="rounded bg-slate-800/40 px-3 py-2 text-[10px] text-slate-500">
          Implied range unavailable — needs ATM implied volatility{oiOnly ? ', which this feed does not carry' : ''}.
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <StatBox label="PCR (OI)" value={pcr.byOI.toFixed(2)} sub={`Vol ${pcr.byVolume.toFixed(2)}`} color={pcrColor} />
        <StatBox
          label="Max Pain"
          value={level(maxPain.strike)}
          sub={`${(maxPain.confidence * 100).toFixed(0)}% conf`}
        />
        <StatBox
          label="ATM straddle"
          value={atm.straddlePremium != null ? fmtCur(atm.straddlePremium, 'INR') : '—'}
          sub={`${level(atm.strike)} strike`}
        />
        <StatBox
          label="Expiry in"
          value={expiryLabel(analytics)}
          sub={analytics.daysToExpiry != null ? `${analytics.daysToExpiry.toFixed(1)} DTE` : undefined}
          color={analytics.daysToExpiry != null && analytics.daysToExpiry < 1 ? 'text-amber-400' : undefined}
        />
      </div>

      <div className="rounded bg-slate-800/40 p-2.5">
        <div className="flex items-baseline justify-between">
          <span className={cls('text-xs font-semibold tracking-wide', sentimentColor)}>{sentiment.signal}</span>
          <span className="font-mono text-[10px] text-slate-500">{(sentiment.strength * 100).toFixed(0)}% conviction</span>
        </div>
        <div className="mt-1.5 h-1 w-full rounded-full bg-slate-700/60">
          <div
            className={cls('h-1 rounded-full', sentimentBar)}
            style={{ width: `${Math.max(2, Math.min(100, sentiment.strength * 100))}%` }}
          />
        </div>
        <ul className="mt-2 space-y-0.5">
          {reasons.map((r) => (
            <li key={r} className="text-[10px] text-slate-400">
              <span className="text-slate-600">·</span> {r}
            </li>
          ))}
        </ul>
      </div>

      {oiActivity && (
        <div className="rounded bg-slate-800/40 p-2.5">
          <div className="text-[10px] text-slate-500 uppercase mb-1">OI activity</div>
          <div className="flex items-center justify-between">
            <div>
              <Pill color={
                oiActivity.type === 'BUILDUP' ? 'bg-blue-500/20 text-blue-300' :
                oiActivity.type === 'UNWINDING' ? 'bg-orange-500/20 text-orange-300' :
                'bg-slate-500/20 text-slate-400'
              }>
                {oiActivity.type}
              </Pill>
              <span className="ml-2 text-xs text-slate-400">{oiActivity.side}</span>
            </div>
            <div className="font-mono text-xs text-slate-400">{(oiActivity.strength * 100).toFixed(0)}%</div>
          </div>
          <div className="text-[10px] text-slate-500 mt-1">{oiActivity.description}</div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <StatBox
          label="ATM IV"
          value={ivPct(ivAnalysis.atmIV)}
          sub={`chain avg ${ivPct(ivAnalysis.averageIV)}`}
        />
        <StatBox
          label="IV rank"
          value={ivRankValue != null ? ivRankValue.toFixed(0) : '—'}
          sub={
            ivRankValue != null
              ? `${ivAnalysis.ivWindowDays}d window`
              : `needs history — ${ivAnalysis.ivWindowDays}d so far`
          }
          color={ivRankValue == null ? 'text-slate-500' : ivRankValue >= 80 ? 'text-amber-400' : undefined}
        />
        <StatBox
          label="IV skew"
          value={(ivAnalysis.ivSkew * 100).toFixed(1)}
          sub={ivAnalysis.ivSkew > 0 ? 'puts bid — fear' : 'calls bid — chase'}
        />
        <StatBox
          label="ATM spread"
          value={spreadPct != null ? `${(spreadPct * 100).toFixed(2)}%` : '—'}
          sub={`${liquidity.tradableStrikes}/${liquidity.totalStrikes} tradable`}
          color={spreadPct != null && spreadPct > 0.05 ? 'text-red-400' : undefined}
        />
      </div>

      {analytics.topStrikes.length > 0 && (
        <div>
          <div className="text-[10px] text-slate-500 uppercase mb-1.5">Heaviest strikes</div>
          <div className="space-y-1">
            {analytics.topStrikes.slice(0, 5).map((strike) => (
              <StrikeRow
                key={strike.strike}
                strike={strike}
                isSupport={support.includes(strike.strike)}
                isResistance={resistance.includes(strike.strike)}
              />
            ))}
          </div>
        </div>
      )}

      {dataQuality && (
        <div className="border-t border-slate-700/60 pt-2 font-mono text-[10px] text-slate-600">
          {dataQuality.strikesWithOi}/{dataQuality.strikesTotal} strikes with OI · {dataQuality.strikesWithIv} solved for IV ·{' '}
          {dataQuality.hasBaseline ? 'OI baseline set' : 'no OI baseline yet'}
        </div>
      )}
    </div>
  );
}
