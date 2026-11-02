/**
 * Zerodha Kite Connect authentication (spec §3). Official OAuth flow:
 *  1. Redirect the user to the login URL.
 *  2. After login the broker redirects with ?request_token=...
 *  3. Exchange the request token for an access token via the session API.
 * No unofficial scraping is used — this is the official broker API.
 */
import { BrokerAuthResult, BrokerCredentials, IndiaBrokerName } from '../types';

const BASE = 'https://api.kite.trade';
const LOGIN = 'https://kite.trade/connect/login';

export function kiteLoginUrl(apiKey: string): string {
  return `${LOGIN}?v=3&api_key=${encodeURIComponent(apiKey)}`;
}

/**
 * Exchange an OAuth request token (from the login redirect) for an access
 * token. Also accepts a pre-issued access token for headless setups.
 */
export async function kiteSession(
  credentials: BrokerCredentials,
): Promise<BrokerAuthResult> {
  if (credentials.accessToken && !credentials.requestToken) {
    return {
      userId: 'kite-user',
      accessToken: credentials.accessToken,
      apiKey: credentials.apiKey,
      broker: credentials.broker,
      authenticated: true,
    };
  }
  if (!credentials.requestToken) {
    throw new Error('Kite Connect requires a request_token from the login redirect, or a pre-issued access_token');
  }
  const res = await fetch(`${BASE}/session/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Kite-Version': '3',
    },
    body: new URLSearchParams({
      api_key: credentials.apiKey,
      request_token: credentials.requestToken,
      api_secret: credentials.apiSecret,
    }).toString(),
  });
  const json = (await res.json()) as {
    status?: string;
    data?: { access_token: string; user_id: string };
    error_type?: string;
    message?: string;
  };
  if (!res.ok || !json.data?.access_token) {
    throw new Error(`Kite session failed: ${json.error_type ?? ''} ${json.message ?? res.status}`);
  }
  return {
    userId: json.data.user_id,
    accessToken: json.data.access_token,
    apiKey: credentials.apiKey,
    broker: credentials.broker as IndiaBrokerName,
    authenticated: true,
  };
}

export interface KiteProfile {
  user_id: string;
  user_name: string;
  exchanges: string[];
}

export async function kiteProfile(apiKey: string, accessToken: string): Promise<KiteProfile | null> {
  const res = await fetch(`${BASE}/user/profile`, {
    headers: authHeaders(apiKey, accessToken),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { data?: KiteProfile };
  return json.data ?? null;
}

export async function kiteLogout(apiKey: string, accessToken: string): Promise<void> {
  await fetch(`${BASE}/session/token`, { method: 'DELETE', headers: authHeaders(apiKey, accessToken) }).catch(() => undefined);
}

export function authHeaders(apiKey: string, accessToken: string): Record<string, string> {
  return {
    Authorization: `token ${apiKey}:${accessToken}`,
    'X-Kite-Version': '3',
  };
}