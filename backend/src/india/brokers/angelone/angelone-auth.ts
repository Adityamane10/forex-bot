/**
 * Angel One SmartAPI authentication (spec §56).
 *
 * SmartAPI login = client code + 4-digit PIN + a TOTP generated from the
 * secret Angel shows during app setup. Returns three tokens:
 *   jwtToken   — REST bearer (all market-data calls)
 *   refreshToken — silent re-login
 *   feedToken  — websocket (unused while this adapter runs REST-poll mode)
 *
 * TOTP is implemented locally against RFC 6238 (SHA-1, 30s step) with Node's
 * crypto only — no new runtime dependency, deterministic and testable.
 * NOTE: unlike Upstox, Angel One pins NO static IP — that is the whole reason
 * this adapter exists.
 */
import crypto from 'crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function decodeBase32(secret: string): Buffer {
  const clean = secret.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s step) from a Base32 secret. */
export function generateTotp(base32Secret: string, atMs: number = Date.now()): string {
  const key = decodeBase32(base32Secret);
  const counter = Math.floor(atMs / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter % 2 ** 32, 4);
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, '0');
}

export interface AngelCredentials {
  apiKey: string;
  clientCode: string;
  pin: string;
  totpSecret: string;
}

export interface AngelSession {
  apiKey: string;
  accessToken: string; // jwtToken
  refreshToken: string;
  feedToken: string;
  readOnly: boolean;
  broker: 'ANGELONE';
  userId: string;
}

const API_ROOT = 'https://apiconnect.angelone.in';

/** Headers Angel requires on every call — including two it never reads but rejects when absent. */
export function angelHeaders(session: Pick<AngelSession, 'apiKey' | 'accessToken'>): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: `Bearer ${session.accessToken}`,
    'X-PrivateKey': session.apiKey,
    'X-UserType': 'USER',
    'X-SourceID': 'WEB',
    'X-ClientLocalIP': '127.0.0.1',
    'X-ClientPublicIP': '127.0.0.1',
    'X-MACAddress': '00:00:00:00:00:00',
  };
}

export async function angelLogin(creds: AngelCredentials): Promise<AngelSession> {
  const res = await fetch(`${API_ROOT}/rest/auth/angelbroking/user/v1/loginByPassword`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-PrivateKey': creds.apiKey,
      'X-UserType': 'USER',
      'X-SourceID': 'WEB',
      'X-ClientLocalIP': '127.0.0.1',
      'X-ClientPublicIP': '127.0.0.1',
      'X-MACAddress': '00:00:00:00:00:00',
    },
    body: JSON.stringify({
      clientcode: creds.clientCode,
      password: creds.pin,
      totp: generateTotp(creds.totpSecret),
      state: 'fx',
    }),
  });
  const json = (await res.json().catch(() => ({}))) as {
    status?: boolean | string;
    message?: string;
    data?: { jwtToken?: string; refreshToken?: string; feedToken?: string };
  };
  const jwt = json.data?.jwtToken;
  if (!res.ok || !jwt) {
    throw new Error(`angelone login failed (${res.status}): ${json.message ?? 'no jwtToken'}`);
  }
  return {
    apiKey: creds.apiKey,
    accessToken: jwt,
    refreshToken: json.data?.refreshToken ?? '',
    feedToken: json.data?.feedToken ?? '',
    readOnly: true, // paper stage: data only, never orders
    broker: 'ANGELONE',
    userId: creds.clientCode,
  };
}
