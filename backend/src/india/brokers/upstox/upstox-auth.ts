/**
 * Upstox OAuth2 authentication (spec §3). Official flow:
 *  1. Redirect the user to the authorization dialog.
 *  2. Upstox redirects back with ?code=...
 *  3. Exchange the code for an access token via the token endpoint.
 */
import { BrokerAuthResult, BrokerCredentials } from '../types';

const API = 'https://api.upstox.com/v2';

export function upstoxLoginUrl(clientId: string, redirectUri: string): string {
  const p = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code' });
  return `${API}/login/authorization/dialog?${p.toString()}`;
}

export async function upstoxToken(
  credentials: BrokerCredentials,
): Promise<BrokerAuthResult> {
  // Pre-issued analytics token: free, read-only, long-lived. No OAuth needed.
  if (credentials.analyticsToken) {
    return {
      userId: 'upstox-analytics',
      accessToken: credentials.analyticsToken,
      apiKey: credentials.apiKey,
      broker: credentials.broker,
      authenticated: true,
      readOnly: true,
    };
  }
  if (credentials.accessToken && !credentials.requestToken) {
    return {
      userId: 'upstox-user',
      accessToken: credentials.accessToken,
      apiKey: credentials.apiKey,
      broker: credentials.broker,
      authenticated: true,
    };
  }
  if (!credentials.requestToken) {
    throw new Error('Upstox requires an analytics_token, a pre-issued access_token, or a code from the authorization dialog');
  }
  const res = await fetch(`${API}/login/authorization/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      code: credentials.requestToken,
      client_id: credentials.apiKey,
      client_secret: credentials.apiSecret,
      redirect_uri: credentials.redirectUri ?? '',
      grant_type: 'authorization_code',
    }).toString(),
  });
  const json = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
  if (!res.ok || !json.access_token) {
    throw new Error(`upstox token failed: ${json.error ?? ''} ${json.error_description ?? res.status}`);
  }
  return {
    userId: 'upstox-user',
    accessToken: json.access_token,
    apiKey: credentials.apiKey,
    broker: credentials.broker,
    authenticated: true,
  };
}

export function upstoxHeaders(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' };
}