/**
 * Multi-Timeframe Context Panel - displays hierarchical TF analysis
 */
import { useEffect, useState } from 'react';
import { IndiaApi } from '../../api';
import type { IndiaTimeframe } from '@fx/shared';

interface TimeframeAnalysis {
  timeframe: IndiaTimeframe;
  trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  trendStrength: number;
  structure: 'UPTREND' | 'DOWNTREND' | 'RANGING' | 'CHOPPY';
  marketPhase: 'MARKUP' | 'MARKDOWN' | 'ACCUMULATION' | 'DISTRIBUTION';
  support: number;
  resistance: number;
  swingHigh: number | null;
  swingLow: number | null;
  momentum: 'STRONG_UP' | 'WEAK_UP' | 'NEUTRAL' | 'WEAK_DOWN' | 'STRONG_DOWN';
  rsi: number;
  macdSignal: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  volumeState: 'HIGH' | 'AVERAGE' | 'LOW';
  volumeTrend: 'INCREASING' | 'DECREASING' | 'STABLE';
  lastClose: number;
  changePercent: number;
  barsInTrend: number;
}

interface MultiTimeframeContext {
  token: string;
  timestamp: number;
  timeframes: {
    h1: TimeframeAnalysis;
    m30: TimeframeAnalysis;
    m15: TimeframeAnalysis;
    m5: TimeframeAnalysis;
    m3?: TimeframeAnalysis;
    m1?: TimeframeAnalysis;
  };
  alignment: {
    trend: 'ALIGNED_BULLISH' | 'ALIGNED_BEARISH' | 'MIXED' | 'NO_TREND';
    strength: number;
    description: string;
  };
  keyLevels: Array<{
    support: number[];
    resistance: number[];
    source: string;
  }>;
  divergences: Array<{
    type: 'BULLISH' | 'BEARISH';
    timeframes: [IndiaTimeframe, IndiaTimeframe];
    description: string;
    strength: 'WEAK' | 'MODERATE' | 'STRONG';
  }>;
  entryQuality: {
    score: number;
    factors: string[];
  };
}

const cls = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(' ');

function Pill({ children, color }: { children: React.ReactNode; color: string }) {
  return <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium ${color}`}>{children}</span>;
}

const TF_LABELS: Record<string, string> = {
  '1h': '1H', '30m': '30M', '15m': '15M', '5m': '5M', '3m': '3M', '1m': '1M'
};

export function MultiTimeframePanel({ instrumentToken }: { instrumentToken: string }) {
  const [context, setContext] = useState<MultiTimeframeContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    const fetch = async () => {
      try {
        setLoading(true);
        const data = await IndiaApi.getMultiTimeframe(instrumentToken) as MultiTimeframeContext;
        if (mounted) {
          setContext(data);
          setError(null);
        }
      } catch (err) {
        if (mounted) {
          setError(err instanceof Error ? err.message : 'Failed to load multi-timeframe analysis');
        }
      } finally {
        if (mounted) setLoading(false);
      }
    };
    
    fetch();
    const interval = setInterval(fetch, 30000); // Refresh every 30s
    
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [instrumentToken]);

  if (loading && !context) {
    return (
      <div className="rounded border border-slate-700/50 bg-slate-800/30 p-4">
        <div className="text-center text-slate-400 text-sm">Loading multi-timeframe analysis...</div>
      </div>
    );
  }

  if (error || !context) {
    return (
      <div className="rounded border border-slate-700/50 bg-slate-800/30 p-4">
        <div className="text-center text-red-400 text-sm">{error || 'No data available'}</div>
      </div>
    );
  }

  const alignmentColor = 
    context.alignment.trend === 'ALIGNED_BULLISH' ? 'bg-emerald-500/20 text-emerald-300' :
    context.alignment.trend === 'ALIGNED_BEARISH' ? 'bg-red-500/20 text-red-300' : 
    'bg-slate-500/20 text-slate-400';

  const entryQualityColor =
    context.entryQuality.score >= 80 ? 'text-emerald-400' :
    context.entryQuality.score >= 60 ? 'text-yellow-400' :
    context.entryQuality.score >= 40 ? 'text-orange-400' : 'text-red-400';

  const timeframes = [context.timeframes.h1, context.timeframes.m30, context.timeframes.m15, context.timeframes.m5]
    .filter(Boolean) as TimeframeAnalysis[];

  return (
    <div className="rounded border border-slate-700/50 bg-slate-800/30 p-3 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-700 pb-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
          Multi-Timeframe Context
        </span>
        <Pill color={alignmentColor}>
          {context.alignment.trend} ({(context.alignment.strength * 100).toFixed(0)}%)
        </Pill>
      </div>

      {/* Alignment Summary */}
      <div className="rounded bg-slate-800/40 p-2.5">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[10px] text-slate-500 uppercase">Trend Alignment</span>
          <span className={cls('font-mono text-lg font-bold', entryQualityColor)}>
            {context.entryQuality.score}
          </span>
        </div>
        <div className="text-[10px] text-slate-400">{context.alignment.description}</div>
        {context.entryQuality.factors.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {context.entryQuality.factors.map((factor, i) => (
              <Pill key={i} color="bg-blue-500/20 text-blue-300">{factor}</Pill>
            ))}
          </div>
        )}
      </div>

      {/* Timeframe Grid */}
      <div className="space-y-1.5">
        <div className="text-[10px] text-slate-500 uppercase">Timeframes</div>
        {timeframes.map((tf) => {
          const trendColor = 
            tf.trend === 'BULLISH' ? 'text-emerald-400' :
            tf.trend === 'BEARISH' ? 'text-red-400' : 'text-slate-400';
          
          const momentumIcon = 
            tf.momentum.includes('STRONG_UP') ? '⬆⬆' :
            tf.momentum.includes('WEAK_UP') ? '⬆' :
            tf.momentum.includes('STRONG_DOWN') ? '⬇⬇' :
            tf.momentum.includes('WEAK_DOWN') ? '⬇' : '→';

          return (
            <div key={tf.timeframe} className="flex items-center justify-between rounded bg-slate-800/40 px-2.5 py-1.5">
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs font-semibold text-slate-300 w-8">
                  {TF_LABELS[tf.timeframe]}
                </span>
                <Pill color={
                  tf.trend === 'BULLISH' ? 'bg-emerald-500/20 text-emerald-300' :
                  tf.trend === 'BEARISH' ? 'bg-red-500/20 text-red-300' :
                  'bg-slate-500/20 text-slate-400'
                }>
                  {tf.trend}
                </Pill>
                <span className="text-xs">{momentumIcon}</span>
              </div>
              <div className="flex items-center gap-3 text-[10px]">
                <span className="text-slate-500">
                  RSI: <span className={cls(
                    'font-mono',
                    tf.rsi > 70 ? 'text-red-400' : tf.rsi < 30 ? 'text-emerald-400' : 'text-slate-300'
                  )}>{tf.rsi.toFixed(0)}</span>
                </span>
                <span className="text-slate-500">
                  {tf.changePercent > 0 ? '+' : ''}{tf.changePercent.toFixed(2)}%
                </span>
                <Pill color={
                  tf.structure === 'UPTREND' ? 'bg-emerald-600/20 text-emerald-400' :
                  tf.structure === 'DOWNTREND' ? 'bg-red-600/20 text-red-400' :
                  'bg-slate-600/20 text-slate-400'
                }>
                  {tf.structure}
                </Pill>
              </div>
            </div>
          );
        })}
      </div>

      {/* Key Levels */}
      {context.keyLevels.length > 0 && (
        <div>
          <div className="text-[10px] text-slate-500 uppercase mb-1.5">Key Levels (HTF → LTF)</div>
          <div className="space-y-1">
            {context.keyLevels.slice(0, 3).map((level, i) => (
              <div key={i} className="rounded bg-slate-800/40 px-2.5 py-1.5">
                <div className="text-[10px] text-slate-400 mb-1">{level.source}</div>
                <div className="flex items-center gap-3 text-xs">
                  {level.support.length > 0 && (
                    <div>
                      <span className="text-slate-500">S:</span>
                      <span className="ml-1 text-emerald-400 font-mono">
                        {level.support.slice(0, 2).map(s => s.toFixed(0)).join(', ')}
                      </span>
                    </div>
                  )}
                  {level.resistance.length > 0 && (
                    <div>
                      <span className="text-slate-500">R:</span>
                      <span className="ml-1 text-red-400 font-mono">
                        {level.resistance.slice(0, 2).map(r => r.toFixed(0)).join(', ')}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Divergences */}
      {context.divergences.length > 0 && (
        <div>
          <div className="text-[10px] text-slate-500 uppercase mb-1.5">Divergences</div>
          <div className="space-y-1">
            {context.divergences.map((div, i) => (
              <div key={i} className="flex items-center justify-between rounded bg-slate-800/40 px-2.5 py-1.5">
                <div>
                  <Pill color={
                    div.type === 'BULLISH' ? 'bg-emerald-500/20 text-emerald-300' :
                    'bg-red-500/20 text-red-300'
                  }>
                    {div.type}
                  </Pill>
                  <span className="ml-2 text-xs text-slate-400">
                    {TF_LABELS[div.timeframes[0]]} vs {TF_LABELS[div.timeframes[1]]}
                  </span>
                </div>
                <Pill color={
                  div.strength === 'STRONG' ? 'bg-yellow-500/20 text-yellow-300' :
                  div.strength === 'MODERATE' ? 'bg-blue-500/20 text-blue-300' :
                  'bg-slate-500/20 text-slate-400'
                }>
                  {div.strength}
                </Pill>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
