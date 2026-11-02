/**
 * ForexSymbolSpec + validation (spec §3/§4).
 *
 * One place that knows every supported FX symbol's base/quote currencies,
 * contract size, pip geometry and lot constraints — derived from the shared
 * asset master (single source of truth), validated once at construction so a
 * malformed asset entry fails loudly instead of poisoning P&L downstream.
 */
import { FOREX_ASSETS, ForexAsset, getAsset } from '@fx/shared';

export interface ForexSymbolSpec {
  symbol: string;
  baseCurrency: string;
  quoteCurrency: string;
  /** Units of base currency per standard lot (FX convention: 100,000). */
  contractSize: number;
  pipSize: number;
  pipDigits: number;
  minLot: number;
  maxLot: number;
  lotStep: number;
}

function pipDigitsFor(pipSize: number): number {
  // 0.0001 -> 4 decimals carry the pip; JPY pairs 0.01 -> 2.
  const d = Math.round(-Math.log10(pipSize));
  return Number.isFinite(d) && d > 0 ? d : 5;
}

/**
 * Broker-reported lot geometry for one symbol.
 *
 * These come from the BOUND account (`symbol_info` on the live terminal), so a
 * Micro-style account (1,000 units per lot) sizes 100× smaller than a Standard
 * one (100,000) instead of inheriting a built-in constant. Pip geometry is NOT
 * overridable: a pip is a property of the quoted price, not of the account.
 */
export interface BrokerSpecOverride {
  contractSize: number;
  minLot: number;
  maxLot: number;
  lotStep: number;
  stopsLevelPoints?: number;
}

const overrides = new Map<string, BrokerSpecOverride>();
let specVersionCounter = 0;

/** Bumped whenever overrides change, so downstream caches can invalidate. */
export function brokerSpecVersion(): number {
  return specVersionCounter;
}

/**
 * Replace the broker override set (one batch per MT5 heartbeat). Unknown or
 * malformed entries are dropped rather than silently accepted: a bad contract
 * size would mis-size every order.
 */
export function setBrokerSpecOverrides(entries: Array<{ symbol: string; contractSize: number; volumeMin: number; volumeMax: number; volumeStep: number; stopsLevelPoints?: number }>): number {
  overrides.clear();
  for (const e of entries) {
    if (!e?.symbol) continue;
    const ok = e.contractSize > 0 && e.volumeMin > 0 && e.volumeStep > 0 && e.volumeMax >= e.volumeMin;
    if (!ok) continue;
    overrides.set(e.symbol, {
      contractSize: e.contractSize,
      minLot: e.volumeMin,
      maxLot: e.volumeMax,
      lotStep: e.volumeStep,
      stopsLevelPoints: e.stopsLevelPoints,
    });
  }
  specVersionCounter += 1;
  return overrides.size;
}

/** Current override for a symbol (undefined = platform defaults apply). */
export function brokerSpecOverride(symbol: string): BrokerSpecOverride | undefined {
  return overrides.get(symbol);
}

/** Test/teardown hook: drop every broker override. */
export function clearBrokerSpecOverrides(): void {
  overrides.clear();
  specVersionCounter += 1;
}

/** Validated spec for one symbol. Throws when the master entry is unusable. */
export function forexBasedSpec(symbol: string): ForexSymbolSpec {
  const a = FOREX_ASSETS[symbol] as ForexAsset | undefined;
  if (!a) throw new Error(`unknown forex symbol ${symbol}`);
  const o = overrides.get(symbol);
  const spec: ForexSymbolSpec = {
    symbol,
    baseCurrency: a.baseCurrency,
    quoteCurrency: a.quoteCurrency,
    contractSize: o?.contractSize ?? a.contractSize,
    pipSize: a.pipSize,
    pipDigits: pipDigitsFor(a.pipSize),
    minLot: o?.minLot ?? a.minimumLot,
    maxLot: o?.maxLot ?? a.maximumLot,
    lotStep: o?.lotStep ?? a.lotStep,
  };
  validateSpec(spec);
  return spec;
}

export function validateSpec(s: ForexSymbolSpec): void {
  const problems: string[] = [];
  if (!(s.contractSize > 0)) problems.push('contractSize must be > 0');
  if (!(s.pipSize > 0)) problems.push('pipSize must be > 0');
  if (!(s.minLot > 0)) problems.push('minLot must be > 0');
  if (!(s.maxLot >= s.minLot)) problems.push('maxLot must be >= minLot');
  if (!(s.lotStep > 0)) problems.push('lotStep must be > 0');
  if (!s.baseCurrency || !s.quoteCurrency) problems.push('base/quote currency required');
  if (problems.length) throw new Error(`${s.symbol}: ${problems.join('; ')}`);
}

// ---- ACCOUNT-LEVEL TERMS (XM/MT5 pattern) ----------------------------------
// Leverage and margin-rate are ACCOUNT properties reported by the terminal
// (account_info.leverage), not per-symbol constants. When a broker account is
// bound, sizing/margin must use ITS leverage — e.g. XM Standard/Ultra-Low
// accounts report their own leverage, which caps margin per trade.
let accountLeverage = 0; // 0 = no bound account → catalog margin rates apply

/** Adopt the bound account's leverage (account_info.leverage). 0/absent clears. */
export function setAccountLeverage(leverage: number): void {
  accountLeverage = Number.isFinite(leverage) && leverage > 0 ? leverage : 0;
  specVersionCounter += 1;
}

/** Leverage the bound account reports (0 when none is bound). */
export function accountLeverageBound(): number {
  return accountLeverage;
}

/** Test/teardown + unbind hook: drop the account-level leverage. */
export function clearAccountLeverage(): void {
  accountLeverage = 0;
  specVersionCounter += 1;
}

/**
 * EFFECTIVE terms for one symbol — the single source every money path must
 * use. Layers (weakest → strongest):
 *   1. shared asset catalog (built-in defaults),
 *   2. broker-issued symbol_info overrides (contract size, lot geometry) from
 *      the bound MT5/XM account,
 *   3. the account's own leverage as the margin rate (1/leverage).
 * Fills `source` so the UI/API can prove where each number came from.
 */
export function effectiveSpec(symbol: string): ForexSymbolSpec & {
  /** Margin fraction of notional (1/leverage). */
  marginRequirement: number;
  leverage: number;
  source: 'MT5' | 'CATALOG';
} {
  // Crypto and any non-forex symbol must flow through unharmed (they have no
  // FOREX_ASSETS entry): the catalog values apply and no broker override.
  let spec: ForexSymbolSpec;
  try {
    spec = forexBasedSpec(symbol);
  } catch {
    const a = getAsset(symbol);
    spec = {
      symbol, baseCurrency: a.baseCurrency, quoteCurrency: a.quoteCurrency,
      contractSize: a.contractSize, pipSize: a.pipSize,
      pipDigits: pipDigitsFor(a.pipSize), minLot: a.minimumLot,
      maxLot: a.maximumLot, lotStep: a.lotStep,
    };
  }
  const bound = accountLeverage > 0;
  return {
    ...spec,
    marginRequirement: bound ? 1 / accountLeverage : 0,
    leverage: bound ? accountLeverage : 0,
    // marginRequirement 0 = "unknown while unbound" — callers decide the
    // fallback (pip-margin uses the catalog rate; gates treat 0 as unknown).
    source: (spec.contractSize !== FOREX_ASSETS[symbol]?.contractSize
      || spec.minLot !== FOREX_ASSETS[symbol]?.minimumLot
      || spec.lotStep !== FOREX_ASSETS[symbol]?.lotStep
      || bound) ? 'MT5' : 'CATALOG',
  };
}
