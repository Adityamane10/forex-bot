import { useEffect, useState } from 'react';
import { Card } from '../components/ui';
import { api } from '../api';
import { UserSettings } from '@fx/shared';
import { curSymbol } from '../format';

export function Settings() {
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [saved, setSaved] = useState(false);
  /** Currency of the BOUND MT5/XM account, when there is one — while bound, the
   *  wallet adopts it (dashboard follows the account, as on the broker platform). */
  const [boundCurrency, setBoundCurrency] = useState<string | null>(null);

  useEffect(() => {
    void api<UserSettings>('/settings').then(setSettings).catch(() => undefined);
    void api<{ accountInfo?: { currency: string } | null }>('/mt5/status')
      .then((s) => setBoundCurrency(s.accountInfo?.currency ?? null))
      .catch(() => undefined);
  }, []);

  if (!settings) return <Card><div className="text-sm text-slate-500">loading settings…</div></Card>;

  const set = <K extends keyof UserSettings>(key: K, value: UserSettings[K]) => setSettings({ ...settings, [key]: value });

  const save = async () => {
    await api('/settings', { method: 'PUT', body: JSON.stringify(settings) });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const num = (key: keyof UserSettings, label: string) => (
    <label className="block">
      <span className="text-[11px] uppercase text-slate-500">{label}</span>
      <input
        type="number"
        value={settings[key] as number}
        onChange={(e) => set(key, Number(e.target.value))}
        className="mt-1 w-full rounded border border-border bg-panel2 px-2 py-1 font-mono text-sm"
      />
    </label>
  );

  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-slate-100">Settings</h1>
        <button onClick={() => void save()} className="rounded bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-500">
          {saved ? 'Saved ✓' : 'Save'}
        </button>
      </div>

      <Card title="Risk Parameters">
        {/* Goal sizing (capital, profit target, risk %, margin %) is edited ONLY
            on Signals → Goal Trading — removed here to keep one goal surface. */}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {num('minRr', 'Minimum R:R')}
          {num('minConfidence', 'Minimum confidence')}
          {num('maxDailyLossPercent', 'Max daily loss %')}
          {num('maxWeeklyLossPercent', 'Max weekly loss %')}
          {num('maxDrawdownPercent', 'Max drawdown %')}
          {num('maxConsecutiveLosses', 'Max consecutive losses')}
          {num('maxOpenPositions', 'Max open positions')}
          {num('maxCorrelatedPositions', 'Max correlated positions')}
          {num('maxLeverage', 'Max leverage per position')}
        </div>
        <p className="mt-2 text-[11px] text-slate-500">
          Forex risk management only — sized like an XM/MT5 account. All goal sizing (amount to use, minimum profit, risk % per trade, margin % per trade, investment filters) lives exclusively on Signals → Goal Trading.
        </p>
      </Card>

      <Card title="Trading Preferences">
        <div className="space-y-3">
          {/* The instrument choice is the 'Trade only' dropdown on the Signals
              page (symbolLock) — the engine treats it as the single source of
              truth, so a second list here would silently disagree with it. */}
          <p className="text-[11px] text-slate-500">
            Instrument selection lives on the Signals page — the “Trade only” dropdown (top right). One symbol scans and trades that symbol only; “All symbols” scans every instrument.
          </p>

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={settings.newsTrading} onChange={(e) => set('newsTrading', e.target.checked)} className="accent-blue-500" />
            News trading enabled
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={settings.singlePositionMode} onChange={(e) => set('singlePositionMode', e.target.checked)} className="accent-blue-500" />
            Single position mode (open multiple while margin allows — entry defers only when the margin/leverage caps are exhausted)
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={settings.highImpactNewsRestriction} onChange={(e) => set('highImpactNewsRestriction', e.target.checked)} className="accent-blue-500" />
            Block signals into high-impact news
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={settings.weekendFlattenEnabled ?? true} onChange={(e) => set('weekendFlattenEnabled', e.target.checked)} className="accent-blue-500" />
            Weekend flatten — auto-close FX positions before the Friday close (FXBot pattern; no entries after 20:00 UTC Fri)
          </label>
          <div className="border-t border-border/60 pt-3">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={settings.trailingStopEnabled} onChange={(e) => set('trailingStopEnabled', e.target.checked)} className="accent-blue-500" />
              Trailing stop (ATR-based, spec §63)
            </label>
            <div className="mt-2 grid grid-cols-2 gap-3 md:grid-cols-3">
              <label className="block">
                <span className="text-[11px] uppercase text-slate-500">Trail anchor</span>
                <select
                  value={settings.trailingStopMode ?? 'price'}
                  onChange={(e) => set('trailingStopMode', e.target.value as 'price' | 'chandelier')}
                  className="mt-1 w-full rounded border border-border bg-panel2 px-2 py-1 text-sm"
                >
                  <option value="price">Price-anchored (classic)</option>
                  <option value="chandelier">Chandelier (swing extreme)</option>
                </select>
              </label>
              {num('trailingStopAtrMultiplier', 'Trailing distance (× ATR)')}
              {num('trailingStopActivateR', 'Activate after (× R profit)')}
            </div>
            <p className="mt-2 text-[11px] text-slate-500">
              Chandelier mode (CEZLSMA pattern): the trail hangs off the highest high / lowest low since entry instead of hugging price, so pullbacks don't clip it.
            </p>
          </div>
          <div className="border-t border-border/60 pt-3">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
              {num('tp1ClosePct', 'TP1 close (% of size)')}
              {num('tp2ClosePct', 'TP2 close (% of size)')}
            </div>
            <p className="mt-2 text-[11px] text-slate-500">
              Partial take profit (Phase 17): each level closes its % of the ORIGINAL size and the position stays open; the remainder is managed by SL/trailing. 100 = full close, 0 = skip the level.
            </p>
            <label className="mt-3 flex items-center gap-2 text-sm">
              <input type="checkbox" checked={settings.breakevenEnabled} onChange={(e) => set('breakevenEnabled', e.target.checked)} className="accent-blue-500" />
              Breakeven stop (Phase 19)
            </label>
            <div className="mt-2 grid grid-cols-2 gap-3 md:grid-cols-3">
              {num('breakevenActivateR', 'Activate after (× R profit)')}
            </div>
          </div>
          <div className="border-t border-border/60 pt-3">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
              {num('slippageBps', 'Paper fill slippage (bps)')}
              <label className="block">
                <span className="text-[11px] uppercase text-slate-500">Signal expiry (minutes)</span>
                <input
                  type="number"
                  value={Math.round((settings.signalExpiryMs ?? 7200000) / 60000)}
                  onChange={(e) => set('signalExpiryMs', Math.max(1, Number(e.target.value)) * 60000)}
                  className="mt-1 w-full rounded border border-border bg-panel2 px-2 py-1 font-mono text-sm"
                />
              </label>
            </div>
            <p className="mt-2 text-[11px] text-slate-500">
              Paper fills are never perfect: BUY fills above the ask, SELL below the bid by the slippage above. A pre-entry signal past its expiry is EXPIRED and re-analyzed — signals never linger indefinitely.
            </p>
          </div>

          <div className="flex items-center gap-2 text-sm">
            <span className="text-slate-400">Account currency:</span>
            <span className="rounded border border-blue-500/40 bg-blue-600/25 px-3 py-0.5 text-xs font-medium text-blue-200">$ USD</span>
            <span className="text-[11px] text-slate-600">
              Forex trades in USD only — exactly like an XM MT5 account. The wallet always adopts the bound MT5 account's
              own settlement currency and shows balances, P&amp;L, targets and risk in it (see Broker &amp; Account).
            </span>
            {boundCurrency && boundCurrency !== 'USD' && (
              <span className="text-[11px] font-medium text-amber-400">
                Bound account settles in {boundCurrency} — the dashboard follows the ACCOUNT, not USD. For a USD-only book, bind a USD-denominated MT5 account.
              </span>
            )}
          </div>
        </div>
      </Card>

      <Card title="Paper Account">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
          {num('paperStartingCapital', `Starting capital (${curSymbol(settings.accountCurrency)})`)}
        </div>
      </Card>
    </div>
  );
}
