/**
 * Opportunity scanner. Continuously evaluates all configured assets and
 * produces a ranked list of opportunities using expected value, risk,
 * confidence, spread, exposure and correlation. The scanner never emits
 * fabricated opportunities — every row comes from the real pipeline.
 */
import { OpportunityRanking } from '@fx/shared';
import { FxContext, CHANNELS } from '../core/context';
import { logger } from '../core/logger';
import { SignalEngine } from './signalEngine';

export class ScannerEngine {
  private rankings = new Map<string, OpportunityRanking>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private ctx: FxContext, private signalEngine: SignalEngine) {}

  async start(intervalMs: number): Promise<void> {
    await this.scanOnce();
    this.timer = setInterval(() => void this.scanOnce(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async scanOnce(): Promise<OpportunityRanking[]> {
    if (this.running) return this.getRankings();
    this.running = true;
    try {
      const settings = await this.signalEngine.loadSettings();
      const goalMode = settings.signalMode === 'goal';
      // The user's symbol selector (Settings → selected pairs / Goal panel)
      // governs BOTH modes: an empty list means everything, a non-empty list
      // is a whitelist. Scanning symbols outside it would open trades the
      // user explicitly excluded.
      let symbols = await this.signalEngine.enabledSymbols();
      if (symbols.length === 0) symbols = await this.ctx.providers.marketData.getSymbols();
      const results = [];
      for (const symbol of symbols) {
        try {
          const res = goalMode
            ? await this.signalEngine.analyzeForGoal(symbol)
            : await this.signalEngine.analyzeSymbol(symbol);
          results.push({ symbol, res });
        } catch (err) {
          logger.warn('scanner symbol failed', { symbol, err: String(err) });
        }
      }
      const rankings: OpportunityRanking[] = results.map(({ symbol, res }) => {
        // Goal mode: the analysis carries the per-symbol goal verdict directly
        // (achievable = real BUY/SELL with a live plan; everything else keeps
        // its honest reason). Strict mode keeps the full-pipeline semantics.
        if (goalMode) {
          const g = res as import('@fx/shared').GoalAnalysis;
          const decision: import('@fx/shared').Decision = g.achievable
            ? g.direction ?? 'WAIT'
            : g.direction ? 'WAIT' : 'NO_TRADE';
          const score = g.achievable ? (g.probability ?? 0.5) * 100 * (g.direction === 'BUY' ? 1 : -1) : 0;
          return {
            symbol,
            decision,
            score: Number(score.toFixed(1)),
            probability: g.probability ?? 0.5,
            confidence: g.confidence,
            riskLevel: g.achievable ? 'YELLOW' : 'GREEN',
            regime: 'RANGING',
            spreadPips: 0,
            expectedValue: g.achievable ? g.expectedProfit : 0,
            reason: g.achievable
              ? `${g.direction} — entry ${g.entry} SL ${g.stopLoss} TP ${g.takeProfit} — profit ${g.expectedProfit} within caps`
              : g.reason,
            updatedAt: Date.now(),
          };
        }
        const a = res as import('./signalEngine').AnalyzeResult;
        const score = a.decision === 'BUY' || a.decision === 'SELL'
          ? (a.probability ?? 0.5) * 100 * (a.decision === 'BUY' ? 1 : -1)
          : 0;
        return {
          symbol,
          decision: a.decision,
          score: Number(score.toFixed(1)),
          probability: a.probability ?? 0.5,
          confidence: a.signal?.confidence ?? 0,
          // Risk classification only exists for real setups; a WAIT/NO_TRADE has no
          // evaluated risk, so show neutral YELLOW rather than a misleading RED.
          riskLevel: a.signal?.risk.level ?? 'YELLOW',
          // Real regime when analysis completed (even for WAIT); UNCERTAIN only
          // when analysis could not run at all.
          regime: a.regime ?? a.signal?.regime.regime ?? 'UNCERTAIN',
          spreadPips: 0,
          expectedValue: a.signal?.expectedValue.evPerTrade ?? 0,
          reason: a.reason,
          updatedAt: Date.now(),
        };
      });
      // Rank (spec §55): BUY/SELL first — ordered by EXPECTED VALUE, then
      // confidence. The highest-confidence trade is NOT automatically the
      // best trade; EV is the economic ranking, not raw probability.
      rankings.sort((a, b) => {
        const rank = (r: OpportunityRanking) => (r.decision === 'BUY' || r.decision === 'SELL' ? 0 : 1);
        if (rank(a) !== rank(b)) return rank(a) - rank(b);
        if (a.decision !== 'WAIT' && b.decision !== 'WAIT') {
          const evDiff = Math.abs(b.expectedValue) - Math.abs(a.expectedValue);
          if (Math.abs(evDiff) > 1e-9) return evDiff;
        }
        return Math.abs(b.score) - Math.abs(a.score);
      });
      this.rankings = new Map(rankings.map((r) => [r.symbol, r]));
      // Universe shrink (symbol lock): analyses for symbols that were not
      // scanned this sweep are stale by definition — drop them so the UI's
      // goal card shows only the locked universe.
      this.signalEngine.pruneGoalAnalyses(new Set(results.map((r) => r.symbol)));
      this.ctx.events.emit('scanner.update', rankings);
      if (goalMode) this.ctx.events.emit('goal.update', this.signalEngine.getGoalAnalyses());
      return rankings;
    } finally {
      this.running = false;
    }
  }

  getRankings(): OpportunityRanking[] {
    return [...this.rankings.values()];
  }
}
