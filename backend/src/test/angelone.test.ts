import { describe, it, expect } from 'vitest';
import { decodeBase32, generateTotp } from '../india/brokers/angelone/angelone-auth';
import {
  parseAngelExpiry,
  angelUnderlying,
  mapAngelRows,
} from '../india/brokers/angelone/angelone-market-data';
import type { AngelScripRow } from '../india/brokers/angelone/angelone-market-data';

// ---------------------------------------------------------------------------
// Angel One SmartAPI adapter — offline, deterministic pieces (spec §3, §11).
// The whole point of this adapter: a live Indian-market feed with NO static-IP
// pinning, so the platform survives ISP IP rotation.
// ---------------------------------------------------------------------------

describe('TOTP (RFC 6238, SHA-1, 6 digits)', () => {
  // Secret "12345678901234567890" in Base32 — the RFC's own test key.
  const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

  it('matches published RFC vectors', () => {
    // T=59s → 94287082 (8-digit) → 287082 at 6 digits
    expect(generateTotp(SECRET, 59_000)).toBe('287082');
    // T=1111111109s → 07081804 → 081804
    expect(generateTotp(SECRET, 1_111_111_109_000)).toBe('081804');
  });

  it('decodes Base32 including padding/space noise', () => {
    // 8 base32 chars = 40 bits = 5 bytes
    expect(decodeBase32('GEZDGNBV').toString()).toBe('12345');
    // First half of the RFC test secret decodes to its ASCII prefix
    expect(decodeBase32('gezdgnbvgy3tqojq ====')?.toString()).toBe('1234567890');
  });

  it('changes every step window', () => {
    const a = generateTotp(SECRET, 59_000);
    const b = generateTotp(SECRET, 89_000);
    expect(a).not.toBe(b);
  });
});

describe('instrument master mapping (spec §11)', () => {
  const idxRow: AngelScripRow = {
    token: '99926000', symbol: 'Nifty 50', name: 'NIFTY', expiry: '',
    strike: '0.000000', lotsize: '1', instrumenttype: 'AMXIDX',
    exch_seg: 'NSE', tick_size: '0.000000',
  };
  const optRow: AngelScripRow = {
    token: '47071', symbol: 'NIFTY01SEP2626150CE', name: 'NIFTY',
    expiry: '01SEP2026', strike: '2615000.000000', lotsize: null,
    instrumenttype: 'OPTIDX', exch_seg: 'NFO', tick_size: '5.000000',
  };
  const futRow: AngelScripRow = {
    token: '48704', symbol: 'NIFTY27OCT26FUT', name: 'NIFTY',
    expiry: '27OCT2026', strike: '0.000000', lotsize: null,
    instrumenttype: 'FUTIDX', exch_seg: 'NFO', tick_size: '5.000000',
  };

  it('maps index rows to NSE_INDEX instruments with canonical underlyings', () => {
    const [nifty] = mapAngelRows([idxRow]);
    expect(nifty.contractType).toBe('INDEX');
    expect(nifty.segment).toBe('NSE_INDEX');
    expect(nifty.underlying).toBe('NIFTY');
    expect(nifty.instrumentToken).toBe('99926000');
  });

  it('maps option rows: CE/PE from symbol, strike ÷100, DDMMMYYYY expiry parsed as IST', () => {
    const [opt] = mapAngelRows([optRow]);
    expect(opt.contractType).toBe('OPT');
    expect(opt.optionType).toBe('CE');
    expect(opt.strike).toBe(26150);
    expect(opt.segment).toBe('NSE_OPT');
    const expected = Date.UTC(2026, 8, 1) - 19_800_000;
    expect(opt.expiry).toBe(expected);
  });

  it('maps futures rows to NSE_FUT', () => {
    const [fut] = mapAngelRows([futRow]);
    expect(fut.contractType).toBe('FUT');
    expect(fut.segment).toBe('NSE_FUT');
  });

  it('keeps only the traded underlyings and known row types', () => {
    const rows: AngelScripRow[] = [
      idxRow,
      optRow,
      futRow,
      { ...idxRow, name: 'NIFTY IT' },                        // index we do not trade
      { ...optRow, token: '1', symbol: 'SBIN01SEP26800CE', name: 'SBIN' }, // stock option
      { ...optRow, token: '2', instrumenttype: '' },           // cash equity row
    ];
    const mapped = mapAngelRows(rows);
    expect(mapped.map((m) => m.instrumentToken)).toEqual(['99926000', '47071', '48704']);
  });

  it('parses expiry for contract lifecycle (§23)', () => {
    expect(parseAngelExpiry('01SEP2026')).toBe(Date.UTC(2026, 8, 1) - 19_800_000);
    expect(parseAngelExpiry('')).toBeNull();
    expect(parseAngelExpiry('XX')).toBeNull();
  });
});

describe('underlying normalisation from this master\'s naming', () => {
  it('handles index names exactly as Angel emits them', () => {
    expect(angelUnderlying('NIFTY')).toBe('NIFTY');
    expect(angelUnderlying('NIFTY BANK')).toBe('BANKNIFTY');
    expect(angelUnderlying('Nifty Fin Service')).toBe('FINNIFTY');
    expect(angelUnderlying('NIFTY MIDCAP SELECT')).toBe('MIDCPNIFTY');
  });
});
