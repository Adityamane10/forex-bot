import { describe, it, expect, vi, beforeEach } from 'vitest';
import { connectSocket } from './socket';
import { store, actions } from './store';
import { Candle } from '@fx/shared';

const { ioMock, handlers } = vi.hoisted(() => {
  const handlers = new Map<string, (p?: unknown) => void>();
  const ioMock = vi.fn(() => ({
    connected: false,
    on: (_e: string, h: (p?: unknown) => void) => {
      handlers.set(_e, h);
    },
    emit: vi.fn(),
    // disposeSocket() tears down an existing socket before opening a replacement;
    // without these the second connectSocket() in a module's lifetime throws.
    removeAllListeners: vi.fn(),
    disconnect: vi.fn(),
  }));
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
    clear: () => storage.clear(),
  });
  return { ioMock, handlers };
});

vi.mock('socket.io-client', () => ({ io: ioMock }));

function makeCandle(openTime: number, close = 1.1): Candle {
  return {
    symbol: 'EUR/USD',
    assetClass: 'FOREX',
    timeframe: '1h',
    open: 1.09,
    high: 1.11,
    low: 1.08,
    close,
    volume: 100,
    openTime,
    closeTime: openTime + 3_600_000,
    state: 'COMPLETED' as Candle['state'],
    completed: true,
    updatedAt: openTime + 3_600_000,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  ioMock.mockClear();
  handlers.clear();
  store.dispatch(actions.market.candles({ symbol: 'EUR/USD|1h', candles: [] }));
  vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ candles: [] }) }) as Response));
});

describe('candle apply-in-place (MED-2 regression)', () => {
  it('appends the completed candle to the cached series without a REST refetch', () => {
    const seed = [makeCandle(100), makeCandle(100 + 3_600_000), makeCandle(100 + 7_200_000)];
    store.dispatch(actions.market.candles({ symbol: 'EUR/USD|1h', candles: seed }));
    connectSocket();
    const handler = handlers.get('market.candle');
    expect(handler).toBeDefined();
    const fresh = makeCandle(100 + 10_800_000, 1.12);
    handler?.(fresh);
    const candles = store.getState().market.candles['EUR/USD|1h'] as Candle[];
    expect(candles).toHaveLength(4);
    expect(candles[candles.length - 1].openTime).toBe(100 + 10_800_000);
    expect(candles[candles.length - 1].close).toBe(1.12);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('dedupes a repeated candle event (keeps the newest state)', () => {
    const seed = [makeCandle(100)];
    store.dispatch(actions.market.candles({ symbol: 'EUR/USD|1h', candles: seed }));
    connectSocket();
    const handler = handlers.get('market.candle');
    handler?.(makeCandle(100, 1.05));
    handler?.(makeCandle(100, 1.06));
    const candles = store.getState().market.candles['EUR/USD|1h'] as Candle[];
    expect(candles).toHaveLength(1);
    expect(candles[0].close).toBe(1.06);
  });

  it('falls back to the REST refetch for a malformed payload', async () => {
    connectSocket();
    const handler = handlers.get('market.candle');
    handler?.(undefined);
    expect(fetch).toHaveBeenCalledTimes(1);
    const url = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toContain('/api/candles/EUR%2FUSD');
  });
});