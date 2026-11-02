import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ensureDemoAuth, DEMO_EMAIL, getToken } from './api';

function shimStorage(): void {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  });
}

function mockAuth(token: string, registerStatus = 200, loginStatus = 200): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string, opts?: { body?: string }) => {
    if (url === '/api/auth/register') {
      if (registerStatus !== 200) return { ok: false, status: registerStatus, json: async () => ({ error: 'email already registered' }) };
      return { ok: true, status: 200, json: async () => ({ token, user: { id: 'u1', email: DEMO_EMAIL, role: 'USER' } }) };
    }
    if (url === '/api/auth/login') {
      if (loginStatus !== 200) return { ok: false, status: loginStatus, json: async () => ({ error: 'invalid credentials' }) };
      return { ok: true, status: 200, json: async () => ({ token, user: { id: 'u1', email: DEMO_EMAIL, role: 'USER' } }) };
    }
    throw new Error(`unexpected url ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  shimStorage();
  vi.restoreAllMocks();
});

describe('demo auto-auth (HIGH-1 regression)', () => {
  it('returns an existing token without calling the API', async () => {
    const fetchMock = mockAuth('token-x');
    localStorage.setItem('fx_token', 'token-x');
    const t = await ensureDemoAuth();
    expect(t).toBe('token-x');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('registers the demo identity when no token exists and persists it', async () => {
    const fetchMock = mockAuth('demo-token-1');
    const t = await ensureDemoAuth();
    expect(t).toBe('demo-token-1');
    expect(getToken()).toBe('demo-token-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toBe('/api/auth/register');
    expect(JSON.parse(opts.body)).toEqual({ email: DEMO_EMAIL, password: expect.any(String) });
  });

  it('falls back to login when the demo identity already exists', async () => {
    const fetchMock = mockAuth('demo-token-2', 400);
    const t = await ensureDemoAuth();
    expect(t).toBe('demo-token-2');
    expect(getToken()).toBe('demo-token-2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[1] as [string])[0]).toBe('/api/auth/login');
  });

  it('returns null when the backend is unreachable', async () => {
    const fetchMock = mockAuth('never', 500, 500);
    const t = await ensureDemoAuth();
    expect(t).toBeNull();
    expect(getToken()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});