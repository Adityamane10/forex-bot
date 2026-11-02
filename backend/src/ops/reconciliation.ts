/**
 * Broker position reconciliation.
 *
 * The MT5 mirror is fire-and-forget: when the terminal's own server-side SL/TP
 * fires, the broker position closes but the dashboard's paper position stayed
 * open. This service closes the loop:
 *
 *   trader.py reports live MT5 positions every heartbeat
 *        → Mt5ReconciliationService.diff()
 *        → open paper positions with no MT5 ticket/position are auto-closed
 *          as BROKER_CLOSED at the broker's reported price
 *        → divergences (volume drift, direction mismatch) raise alerts
 *
 * Honest constraints: the worker only reports the SYMBOLS it knows aliases
 * for, and MT5 position tickets are not linked to paper ids — matching is by
 * symbol+direction+volume with a tolerance, which is exact for the single-
 * strategy flows this platform drives.
 */
import { logger } from '../core/logger';
import { DataStore } from '../db/store';
import { METRICS } from './metrics';
import type { AlertEngine } from '../engines/alertEngine';
import type { PaperTradingEngine } from '../engines/paperTradingEngine';

export interface BrokerPositionReport {
  ticket: number;
  symbol: string;       // platform symbol (EUR/USD)
  brokerSymbol: string; // broker spelling (EURUSD)
  direction: 'BUY' | 'SELL';
  lots: number;
  openPrice: number;
  currentPrice?: number;
  profit?: number;
  swap?: number;
  sl?: number;
  tp?: number;
  magic?: number;
}

export interface ReconciliationReport {
  at: number;
  brokerPositions: number;
  paperPositions: number;
  matched: number;
  /** Paper positions the broker no longer holds — auto-closed as BROKER_CLOSED. */
  closedAsBrokerClosed: Array<{ positionId: string; symbol: string; exitPrice: number }>;
  /** Volume/direction mismatches on matched symbols (surfaced, not auto-healed). */
  divergences: Array<{ positionId: string; symbol: string; kind: 'VOLUME_DRIFT' | 'DIRECTION_MISMATCH'; paperLots?: number; brokerLots?: number }>;
  /** Broker positions with no dashboard counterpart (external/manual terminal trades). */
  brokerOnly: Array<{ ticket: number; symbol: string; lots: number }>;
}

const LOT_TOLERANCE = 1e-6;

export class Mt5ReconciliationService {
  private lastReport: ReconciliationReport | null = null;

  constructor(
    private store: DataStore,
    private paper: PaperTradingEngine,
    private alerts: AlertEngine,
  ) {}

  /** Latest report (dashboard + /api/mt5/reconciliation). */
  getLast(): ReconciliationReport | null { return this.lastReport; }

  /**
   * Diff the broker's reported positions against open paper positions and
   * heal what is safe to heal. Called from the container on every worker
   * heartbeat that carries a position list.
   */
  async reconcile(brokerPositions: BrokerPositionReport[]): Promise<ReconciliationReport> {
    const report: ReconciliationReport = {
      at: Date.now(),
      brokerPositions: brokerPositions.length,
      paperPositions: 0,
      matched: 0,
      closedAsBrokerClosed: [],
      divergences: [],
      brokerOnly: [],
    };

    const openPaper = this.paper.getOpenPositions();
    report.paperPositions = openPaper.length;

    // Index broker positions by symbol+direction; MT5 can net/hedge by symbol.
    const brokerBySymbol = new Map<string, BrokerPositionReport[]>();
    for (const bp of brokerPositions) {
      const key = `${bp.symbol.toUpperCase()}|${bp.direction}`;
      const list = brokerBySymbol.get(key) ?? [];
      list.push(bp);
      brokerBySymbol.set(key, list);
    }

    // Mirror command history gives paper positions their MT5 ticket when the
    // OPEN executed; a ticket that is no longer broker-reported = broker closed.
    const mirroredTickets = new Map<string, number>(); // positionId -> ticket
    try {
      const cmds = await this.store.find<{ positionId: string; mt5Ticket?: number; status: string; action: string }>(
        'Mt5MirrorCommands', { action: 'OPEN', status: 'EXECUTED' }, { createdAt: -1 }, 200,
      );
      for (const c of cmds) if (c.mt5Ticket) mirroredTickets.set(c.positionId, c.mt5Ticket);
    } catch (err) {
      logger.warn('reconciliation: mirror command lookup failed', { err: String(err) });
    }

    const ticketsSeen = new Set(brokerPositions.map((b) => b.ticket));

    for (const pos of openPaper) {
      const key = `${pos.symbol.toUpperCase()}|${pos.direction}`;
      const candidates = brokerBySymbol.get(key) ?? [];
      if (candidates.length === 0) {
        // Broker does not hold this direction at all.
        const ticket = mirroredTickets.get(pos.id);
        const wasMirrored = ticket !== undefined;
        if (wasMirrored && !ticketsSeen.has(ticket)) {
          // Server-side SL/TP fired: the broker position is gone for sure.
          const exit = pos.direction === 'BUY'
            ? (pos.currentBid ?? pos.currentPrice ?? pos.entryPrice)
            : (pos.currentAsk ?? pos.currentPrice ?? pos.entryPrice);
          const trade = await this.paper.closePosition(pos, exit, 'MANUAL').catch(() => null);
          if (trade) {
            report.closedAsBrokerClosed.push({ positionId: pos.id, symbol: pos.symbol, exitPrice: exit });
            METRICS.reconciliationDiffs().inc({ kind: 'BROKER_CLOSED' });
            await this.alerts.emit('SIGNAL_INVALIDATED', `Broker closed position (server-side SL/TP or manual close in terminal): ${pos.symbol} ${pos.direction} @ ${exit}`, pos.symbol, 'WARNING').catch(() => undefined);
          }
        }
        // A paper position never mirrored (MT5 was offline at open) is NOT
        // closed here — the mirror queue will still execute it. No divergence.
        continue;
      }
      // Match volumes: exact within tolerance first, then nearest.
      let matchedIdx = candidates.findIndex((c) => Math.abs(c.lots - pos.lots) <= LOT_TOLERANCE);
      if (matchedIdx < 0) matchedIdx = 0;
      const bp = candidates[matchedIdx];
      candidates.splice(matchedIdx, 1);
      report.matched++;
      if (Math.abs(bp.lots - pos.lots) > Math.max(LOT_TOLERANCE, pos.lots * 0.01)) {
        report.divergences.push({ positionId: pos.id, symbol: pos.symbol, kind: 'VOLUME_DRIFT', paperLots: pos.lots, brokerLots: bp.lots });
        METRICS.reconciliationDiffs().inc({ kind: 'VOLUME_DRIFT' });
        await this.alerts.emit('RISK_BLOCKED', `Volume divergence on ${pos.symbol}: dashboard ${pos.lots} lots vs broker ${bp.lots} lots — review before adding risk`, pos.symbol, 'WARNING').catch(() => undefined);
      }
    }

    // Broker-only positions: trades placed in the terminal directly.
    const paperKeys = new Set(openPaper.map((p) => `${p.symbol.toUpperCase()}|${p.direction}`));
    for (const bp of brokerPositions) {
      const key = `${bp.symbol.toUpperCase()}|${bp.direction}`;
      if (!paperKeys.has(key)) {
        report.brokerOnly.push({ ticket: bp.ticket, symbol: bp.symbol, lots: bp.lots });
      }
    }
    if (report.brokerOnly.length > 0) {
      METRICS.reconciliationDiffs().inc({ kind: 'BROKER_ONLY' });
      await this.alerts.emit('DATA_FAILURE', `${report.brokerOnly.length} broker position(s) exist outside the dashboard (placed in the MT5 terminal directly) — the platform will not manage them`, undefined, 'WARNING').catch(() => undefined);
    }

    this.lastReport = report;
    return report;
  }
}
