/**
 * Signal state machine. Every transition is recorded; invalid transitions are
 * rejected. Old signals are never silently changed — they are explicitly
 * invalidated with a recorded reason.
 */
import { Signal, SignalState } from '@fx/shared';

const TRANSITIONS: Record<SignalState, SignalState[]> = {
  CANDIDATE: ['ANALYZING', 'INVALIDATED', 'DATA_ERROR', 'INSUFFICIENT_CONFIDENCE', 'RISK_BLOCKED', 'MODEL_BLOCKED', 'NEWS_BLOCKED', 'EXPIRED', 'CANCELLED'],
  ANALYZING: ['QUALIFIED', 'INVALIDATED', 'DATA_ERROR', 'INSUFFICIENT_CONFIDENCE', 'RISK_BLOCKED', 'MODEL_BLOCKED', 'NEWS_BLOCKED', 'EXPIRED', 'CANCELLED'],
  QUALIFIED: ['SIGNAL_CREATED', 'INVALIDATED', 'MISSED', 'EXPIRED', 'RISK_BLOCKED', 'CANCELLED'],
  SIGNAL_CREATED: ['WAITING_FOR_ENTRY', 'INVALIDATED', 'MISSED', 'EXPIRED', 'CANCELLED'],
  WAITING_FOR_ENTRY: ['ENTRY_REACHED', 'MISSED', 'INVALIDATED', 'EXPIRED', 'CANCELLED'],
  ENTRY_REACHED: ['POSITION_ACTIVE', 'INVALIDATED', 'MISSED', 'CANCELLED'],
  POSITION_ACTIVE: ['TP1_HIT', 'TP2_HIT', 'SL_HIT', 'TRAILING', 'CLOSED', 'INVALIDATED'],
  TP1_HIT: ['TP2_HIT', 'TRAILING', 'SL_HIT', 'CLOSED'],
  TP2_HIT: ['TRAILING', 'SL_HIT', 'CLOSED'],
  TRAILING: ['TP2_HIT', 'SL_HIT', 'CLOSED', 'INVALIDATED'],
  SL_HIT: ['CLOSED', 'PERFORMANCE_RECORDED'],
  CLOSED: ['PERFORMANCE_RECORDED'],
  EXPIRED: ['PERFORMANCE_RECORDED'],
  INVALIDATED: ['PERFORMANCE_RECORDED'],
  MISSED: ['PERFORMANCE_RECORDED'],
  CANCELLED: ['PERFORMANCE_RECORDED'],
  DATA_ERROR: ['INVALIDATED'],
  RISK_BLOCKED: ['CANDIDATE'],
  MODEL_BLOCKED: ['CANDIDATE'],
  NEWS_BLOCKED: ['CANDIDATE'],
  INSUFFICIENT_CONFIDENCE: ['CANDIDATE'],
  PERFORMANCE_RECORDED: [],
};

/**
 * True while a signal is still pre-position (no paper position opened yet).
 * Only these states can be EXPIRED or invalidated by a weakening thesis;
 * an opened position is governed by the paper engine instead.
 */
export function isPreEntryState(state: SignalState): boolean {
  return ['CANDIDATE', 'ANALYZING', 'QUALIFIED', 'SIGNAL_CREATED', 'WAITING_FOR_ENTRY', 'ENTRY_REACHED'].includes(state);
}

/**
 * Spec §93: a signal must never remain valid indefinitely. Once past its
 * expiresAt it is EXPIRED and a fresh analysis must run.
 */
export function signalExpired(signal: Signal, now: number): boolean {
  return signal.expiresAt > 0 && now > signal.expiresAt;
}

export class SignalStateMachine {
  private allowed(from: SignalState, to: SignalState): boolean {
    return TRANSITIONS[from]?.includes(to) ?? false;
  }

  transition(signal: Signal, to: SignalState, note: string, now = Date.now()): { ok: boolean; reason?: string } {
    if (!this.allowed(signal.state, to)) {
      return { ok: false, reason: `invalid transition ${signal.state} -> ${to}` };
    }
    signal.state = to;
    signal.updatedAt = now;
    signal.events.push({ state: to, timestamp: now, note });
    // Keep the event history bounded: goal signals re-mark on every tick, and
    // this array once grew the persisted store past 300 MB — the synchronous
    // store flush then blocked the backend event loop and timed out live tick
    // pushes. 50 transitions is ample for display and debugging.
    if (signal.events.length > 50) signal.events = signal.events.slice(-50);
    return { ok: true };
  }
}
