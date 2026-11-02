/**
 * ForexPipService (spec §11/§12) + ForexMarginService (spec §14/§15).
 *
 * Pip geometry per symbol from validated specs — JPY pairs pip at 0.01,
 * majors at 0.0001, never a global constant. Pip VALUE is position-sized:
 *
 *   pipValueQuote = pipSize × lots × contractSize
 *
 * Margin is exposure/leverage — never a P&L multiplier:
 *
 *   notionalQuote = lots × contractSize × price      (quote currency)
 *   requiredMargin = notional converted to account ÷ effective leverage
 *
 * Both keep the quote-currency figure alongside the INR one (spec §15).
 */
import { getAsset } from '@fx/shared';
import { brokerSpecVersion, effectiveSpec, ForexSymbolSpec, accountLeverageBound } from './symbol-spec';
import { CurrencyConversionService } from './currency-conversion';

/** Cached specs, tagged with the broker-override version they were built from:
 *  when the bound MT5 account reports new lot geometry the whole cache is stale
 *  and must be rebuilt, or a Micro account would keep sizing as a Standard one. */
const specs = new Map<string, { spec: ForexSymbolSpec; version: number }>();

export function specFor(symbol: string): ForexSymbolSpec {
  const version = brokerSpecVersion();
  const hit = specs.get(symbol);
  if (hit && hit.version === version) return hit.spec;
  // effectiveSpec (not forexBasedSpec): crypto and any non-forex symbol must
  // flow through with catalog values instead of throwing — an ETH/USDT tick
  // degraded every crypto position here once per pass before this fallback.
  const spec = effectiveSpec(symbol);
  specs.set(symbol, { spec, version });
  return spec;
}

/** Price units per pip. Crypto-safe: falls back to getAsset().pipSize. */
export function pipSize(symbol: string): number {
  try { return specFor(symbol).pipSize; } catch { return getAsset(symbol).pipSize; }
}

/** price difference → pips. */
export function toPips(symbol: string, priceDiff: number): number {
  try { return priceDiff / specFor(symbol).pipSize; } catch { return priceDiff / getAsset(symbol).pipSize; }
}

/** pips → price difference. */
export function pipsToPriceDiff(symbol: string, pips: number): number {
  try { return pips * specFor(symbol).pipSize; } catch { return pips * getAsset(symbol).pipSize; }
}

/** Pip value in the pair's QUOTE currency for `lots` lots. */
export function pipValueQuote(symbol: string, lots: number): number {
  try {
    const s = specFor(symbol);
    return s.pipSize * lots * s.contractSize;
  } catch {
    const a = getAsset(symbol);
    return a.pipSize * lots * a.contractSize;
  }
}

/**
 * Pip value in the account currency (INR), converted live. Throws
 * StaleRateError when the conversion path has no rate at all; callers that
 * merely display may catch and surface "STALE" instead.
 */
export function pipValueAccount(
  symbol: string,
  lots: number,
  accountCurrency: string,
  fx: CurrencyConversionService,
): { value: number; stale: boolean; quote: number } {
  const q = pipValueQuote(symbol, lots);
  const r = fx.quoteToAccount(symbol, accountCurrency, q);
  return { value: r.amount, stale: r.stale, quote: q };
}

export interface MarginBreakdown {
  /** lots × contractSize × price, in the pair's QUOTE currency. */
  notionalQuote: number;
  /** Same notional in the account currency (INR). */
  notionalAccount: number;
  /** Required margin in the account currency = notionalAccount / leverage. */
  requiredMarginAccount: number;
  /** Effective leverage implied by the asset's margin requirement (1/mr). */
  leverage: number;
  stale: boolean;
  rate: number;
}

/**
 * Required margin from NOTIONAL — lot size drives exposure, leverage divides
 * it into margin. Never multiplies profit.
 */
export function requiredMargin(
  symbol: string,
  lots: number,
  price: number,
  accountCurrency: string,
  fx: CurrencyConversionService,
): MarginBreakdown {
  const s = specFor(symbol);
  // getAsset (not FOREX_ASSETS directly): crypto symbols must not crash the
  // margin path — their mapped spec carries marginRequirement too.
  const asset = getAsset(symbol);
  const notionalQuote = lots * s.contractSize * price;
  const conv = fx.quoteToAccount(symbol, accountCurrency, notionalQuote);
  // While an account is bound, ITS reported leverage (account_info) sets the
  // margin rate — the same number the MT5/XM terminal enforces.
  const boundLev = accountLeverageBound();
  const mr = boundLev > 0 ? 1 / boundLev : (asset.marginRequirement > 0 ? asset.marginRequirement : 1);
  return {
    notionalQuote,
    notionalAccount: conv.amount,
    // marginRequirement is the FRACTION of notional held as margin (1/leverage).
    requiredMarginAccount: conv.amount * mr,
    leverage: Math.round(1 / mr),
    stale: conv.stale,
    rate: conv.rate,
  };
}
