import { useEffect } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../store';
import { Card, Table, Badge, Empty } from '../components/ui';
import { fmtDateTime } from '../format';
import { api } from '../api';
import { store as appStore, actions } from '../store';
import { EconomicEvent, NewsItem } from '@fx/shared';

function requireStore() {
  return { store: appStore, actions };
}

export function News() {
  const news = useSelector((s: RootState) => s.news.news);
  const events = useSelector((s: RootState) => s.news.events);

  useEffect(() => {
    void api<{ events: EconomicEvent[] }>('/events').then((r) => {
      const { store, actions } = requireStore();
      store.dispatch(actions.news.events(r.events));
    });
  }, []);

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-slate-100">News & Economic Calendar</h1>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={`Latest Forex News (${news.length})`}>
          {news.length === 0 ? (
            <Empty text="No news provider configured (NEWS_PROVIDER=NONE). Set NEWS_PROVIDER=RSS for free public feeds, or NEWS_API_KEY for a paid feed. The system never fabricates news." />
          ) : (
            <div className="scroll-thin max-h-[520px] space-y-2 overflow-y-auto">
              {news.slice(0, 50).map((n: NewsItem) => (
                <div key={n.id} className="rounded border border-border/60 bg-panel2 p-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="text-sm text-slate-200">{n.headline}</div>
                    <Badge tone={n.importance === 'HIGH' ? 'red' : n.importance === 'MEDIUM' ? 'warn' : 'muted'}>{n.importance}</Badge>
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-[11px] text-slate-500">
                    <span>{n.source}</span>
                    <span>{fmtDateTime(n.timestamp)}</span>
                    {n.currencies.map((c) => <span key={c} className="rounded bg-slate-700/50 px-1 font-mono">{c}</span>)}
                    {n.url && <a href={n.url} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline">source ↗</a>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title="Economic Calendar">
          {events.length === 0 ? (
            <Empty text="No calendar provider configured (ECONOMIC_CALENDAR_PROVIDER=NONE). Set FOREXFACTORY for the free public calendar." />
          ) : (
            <div className="scroll-thin max-h-[520px] space-y-1 overflow-y-auto">
              {events.slice(0, 40).map((e: EconomicEvent) => (
                <div key={e.id} className="flex items-center justify-between rounded border border-border/60 bg-panel2 px-2 py-1.5 text-sm">
                  <div>
                    <div className="text-slate-200">{e.event}</div>
                    <div className="text-[11px] text-slate-500">
                      {e.currency} · {fmtDateTime(e.timestamp)}
                      {e.forecast !== null && <span> · f/c <span className="font-mono">{e.forecast}</span></span>}
                      {e.previous !== null && <span> · prev <span className="font-mono">{e.previous}</span></span>}
                      {e.actual !== null && <span> · actual <span className="font-mono text-emerald-400">{e.actual}</span></span>}
                    </div>
                  </div>
                  <Badge tone={e.impact === 'HIGH' ? 'red' : e.impact === 'MEDIUM' ? 'warn' : 'muted'}>{e.impact}</Badge>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
