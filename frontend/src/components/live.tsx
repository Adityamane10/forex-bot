/**
 * Live-UI primitives: toasts, sound alerts, price-flash, animated numbers.
 *
 * Everything here is deliberately dependency-free and interruption-safe:
 * toasts render outside React (a tiny event emitter + a mounted host), sounds
 * are synthesized with WebAudio (no assets, no autoplay issues — a user
 * gesture arms the context), and price flash is a pure CSS class swap.
 */
import { useEffect, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// Toasts — module-level event bus so ANY view (even non-React code paths like
// socket handlers) can raise a toast with a single call: toast('msg', 'up').
// ---------------------------------------------------------------------------

export type ToastKind = 'up' | 'down' | 'warn' | 'info';
export interface ToastItem { id: number; kind: ToastKind; text: string; at: number }

type ToastListener = (t: ToastItem) => void;
const listeners = new Set<ToastListener>();
let toastSeq = 1;

export function toast(text: string, kind: ToastKind = 'info'): void {
  const item: ToastItem = { id: toastSeq++, kind, text, at: Date.now() };
  for (const l of listeners) { try { l(item); } catch { /* a broken listener must not break others */ } }
}

export function subscribeToasts(l: ToastListener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

const TOAST_STYLES: Record<ToastKind, string> = {
  up: 'border-emerald-500/40 bg-emerald-950/80 text-emerald-100',
  down: 'border-red-500/40 bg-red-950/80 text-red-100',
  warn: 'border-amber-500/40 bg-amber-950/80 text-amber-100',
  info: 'border-slate-100/20 bg-slate-900/90 text-slate-100',
};
const TOAST_ICON: Record<ToastKind, string> = { up: '✓', down: '✕', warn: '⚠', info: 'ℹ' };

/** Host component — mounts once in App; renders the live toast stack. */
export function ToastHost() {
  const [items, setItems] = useState<ToastItem[]>([]);
  useEffect(() => {
    const off = subscribeToasts((t) => {
      setItems((cur) => [...cur.slice(-4), t]);
      window.setTimeout(() => setItems((cur) => cur.filter((x) => x.id !== t.id)), 5000);
    });
    return off;
  }, []);
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-80 flex-col gap-2" role="status" aria-live="polite">
      {items.map((t) => (
        <div
          key={t.id}
          className={`animate-slide-up pointer-events-auto flex items-start gap-2 rounded-lg border px-3 py-2 text-xs shadow-lift backdrop-blur ${TOAST_STYLES[t.kind]}`}
        >
          <span className="mt-[1px] font-bold">{TOAST_ICON[t.kind]}</span>
          <span className="min-w-0 flex-1 break-words leading-relaxed">{t.text}</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sound alerts — WebAudio synthesized tones. No audio assets, and the context
// is created lazily on the first user interaction (browser autoplay policy).
// ---------------------------------------------------------------------------

type SoundName = 'signal' | 'open' | 'close' | 'alarm';

let audioCtx: AudioContext | null = null;
let soundMuted = false;

try {
  soundMuted = window.localStorage.getItem('fx.soundMuted') === '1';
} catch { /* private mode */ }

export function setSoundMuted(muted: boolean): void {
  soundMuted = muted;
  try { window.localStorage.setItem('fx.soundMuted', muted ? '1' : '0'); } catch { /* ignore */ }
}
export function isSoundMuted(): boolean { return soundMuted; }

function ensureCtx(): AudioContext | null {
  if (soundMuted) return null;
  try {
    if (!audioCtx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      audioCtx = new Ctor();
    }
    if (audioCtx.state === 'suspended') void audioCtx.resume();
    return audioCtx;
  } catch { return null; }
}

function tone(ctx: AudioContext, freq: number, startMs: number, durMs: number, gain = 0.06, type: OscillatorType = 'sine'): void {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  const t0 = ctx.currentTime + startMs / 1000;
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + durMs / 1000);
  osc.connect(g).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + durMs / 1000 + 0.02);
}

/** Arm the audio context on the first user gesture (autoplay policy). */
export function armAudio(): void {
  const el = document.documentElement;
  const once = () => { ensureCtx(); el.removeEventListener('pointerdown', once); el.removeEventListener('keydown', once); };
  el.addEventListener('pointerdown', once, { once: true });
  el.addEventListener('keydown', once, { once: true });
}

export function playSound(name: SoundName): void {
  const ctx = ensureCtx();
  if (!ctx) return;
  switch (name) {
    case 'signal': // two rising notes — a new signal
      tone(ctx, 660, 0, 120); tone(ctx, 880, 130, 160);
      break;
    case 'open': // soft blip — position opened
      tone(ctx, 520, 0, 90, 0.05, 'triangle'); tone(ctx, 780, 100, 120, 0.05, 'triangle');
      break;
    case 'close': // descending pair — position closed
      tone(ctx, 700, 0, 110, 0.05, 'triangle'); tone(ctx, 480, 120, 150, 0.05, 'triangle');
      break;
    case 'alarm': // urgent triple-pulse — risk event
      tone(ctx, 220, 0, 140, 0.09, 'square'); tone(ctx, 220, 180, 140, 0.09, 'square'); tone(ctx, 220, 360, 220, 0.09, 'square');
      break;
  }
}

// ---------------------------------------------------------------------------
// PriceFlash — green/red background pulse when a live number changes.
// ---------------------------------------------------------------------------

/**
 * Wraps a live numeric display: on every `value` change the number flashes
 * green (up) or red (down) for 500ms. Zero re-render cost beyond the class
 * swap; the previous direction is tracked in a ref.
 */
export function PriceFlash({ value, className = '', children }: { value: number | null | undefined; className?: string; children?: React.ReactNode }) {
  const prev = useRef<number | null>(null);
  const [flash, setFlash] = useState<'up' | 'down' | null>(null);
  useEffect(() => {
    if (value == null || !Number.isFinite(value)) return;
    const before = prev.current;
    prev.current = value;
    if (before === null || value === before) return;
    setFlash(value > before ? 'up' : 'down');
    const id = window.setTimeout(() => setFlash(null), 500);
    return () => window.clearTimeout(id);
  }, [value]);
  const tone = flash === 'up' ? 'flash-up' : flash === 'down' ? 'flash-down' : '';
  return <span className={`${className} ${tone}`}>{children}</span>;
}

// ---------------------------------------------------------------------------
// useNow — a shared 1 Hz clock hook for "N s ago" badges.
// ---------------------------------------------------------------------------

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}
