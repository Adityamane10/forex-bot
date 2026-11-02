/**
 * Asset metadata. Every asset (forex or crypto) carries precision, contract
 * specs and risk parameters so every downstream calculation (sizing, P&L,
 * risk, expected value) is deterministic per instrument. Forex assets keep
 * pip/lot semantics; crypto assets map tick/quantity semantics onto the same
 * fields (pipSize = tickSize, contractSize = 1 unit, commissionPerLot = 0
 * with percentage fees applied at the EV/paper layer).
 */
import type { AssetClass, ForexSession } from './constants';

export interface AssetSessionInfo {
  /** UTC hour ranges (0-23, end exclusive) when the pair is most liquid. */
  sessions: Partial<Record<ForexSession, { start: number; end: number }>>;
  /** Typical session where this pair sees the highest volume. */
  primary: ForexSession;
}

export interface ForexAsset {
  symbol: string;
  baseCurrency: string;
  quoteCurrency: string;
  pipSize: number; // e.g. 0.0001 for most, 0.01 for JPY pairs
  pointSize: number; // smallest price increment (typically pipSize/10)
  pricePrecision: number;
  quantityPrecision: number; // decimals for lot size
  contractSize: number; // units of base currency per standard lot
  minimumLot: number;
  maximumLot: number;
  lotStep: number;
  leverage: number; // default account leverage for this pair
  marginRequirement: number; // fraction of notional required as margin (1/leverage)
  commissionPerLot: number; // USD per standard lot (round turn)
  swapLong: number; // swap points per lot per day (positive = earn, negative = cost)
  swapShort: number;
  sessionInformation: AssetSessionInfo;
  enabled: boolean;
}

const SESSION_WINDOWS: Record<ForexSession, { start: number; end: number }> = {
  SYDNEY: { start: 21, end: 6 }, // 21:00-06:00 UTC (wraps)
  TOKYO: { start: 0, end: 9 },
  LONDON: { start: 7, end: 16 },
  NEW_YORK: { start: 12, end: 21 },
  LONDON_NEW_YORK_OVERLAP: { start: 12, end: 16 },
  OFF_HOURS: { start: 0, end: 24 },
};

function sessionInfo(primary: ForexSession, extra?: Partial<Record<ForexSession, { start: number; end: number }>>): AssetSessionInfo {
  const sessions: AssetSessionInfo['sessions'] = { ...SESSION_WINDOWS };
  if (extra) Object.assign(sessions, extra);
  return { sessions, primary };
}

// ---------------------------------------------------------------------------
// Crypto assets (Binance spot, USDT-quoted, free public data)
// ---------------------------------------------------------------------------

export interface CryptoAsset {
  symbol: string;
  assetClass: 'CRYPTO';
  baseAsset: string;
  quoteAsset: string;
  /** Venue that supplies this instrument (Binance spot). */
  exchange: string;
  /** Smallest price increment (Binance tick size). */
  tickSize: number;
  pricePrecision: number;
  /** Smallest tradable quantity (Binance step size). */
  quantityStep: number;
  quantityPrecision: number;
  minQuantity: number;
  maxQuantity: number;
  /** Percentage fee per side (0.001 = 0.1%). */
  makerFee: number;
  takerFee: number;
  /** Funding rate per funding interval (fraction, signed; 0 for spot). */
  fundingRate: number;
  fundingIntervalHours: number;
  /** Platform-level leverage limit for this instrument (spot = 1). */
  leverage: number;
  marginMode: 'ISOLATED' | 'CROSS';
  /** Spread cap in ticks (data quality + uncertainty gates). */
  maxSpreadTicks: number;
  /** Entry-zone width bounds in ticks (ATR-scaled inside). */
  entryZoneMinTicks: number;
  entryZoneMaxTicks: number;
  /** SL buffer / minimum distance in ticks. */
  slBufferTicks: number;
  slMinTicks: number;
  enabled: boolean;
}

function crypto(
  symbol: string,
  base: string,
  tickSize: number,
  pricePrecision: number,
  quantityStep: number,
  quantityPrecision: number,
  minQuantity: number,
  maxQuantity: number,
  maxSpreadTicks: number,
  entryZoneMinTicks: number,
  entryZoneMaxTicks: number,
  slBufferTicks: number,
  slMinTicks: number,
): CryptoAsset {
  return {
    symbol,
    assetClass: 'CRYPTO',
    baseAsset: base,
    quoteAsset: 'USDT',
    exchange: 'BINANCE',
    tickSize,
    pricePrecision,
    quantityStep,
    quantityPrecision,
    minQuantity,
    maxQuantity,
    makerFee: 0.001, // Binance spot standard: 0.1% / 0.1%
    takerFee: 0.001,
    fundingRate: 0, // spot has no funding; kept for futures-compatible metadata
    fundingIntervalHours: 8,
    leverage: 1, // spot is fully collateralized
    marginMode: 'CROSS',
    maxSpreadTicks,
    entryZoneMinTicks,
    entryZoneMaxTicks,
    slBufferTicks,
    slMinTicks,
    enabled: true,
  };
}

/** Binance spot USDT-pair metadata (tick/step/min sizes mirror the exchange). */
export const CRYPTO_ASSETS: Record<string, CryptoAsset> = {
  'BTC/USDT': crypto('BTC/USDT', 'BTC', 0.01, 2, 0.00001, 5, 0.00001, 9000, 25, 30, 200, 10, 30),
  'ETH/USDT': crypto('ETH/USDT', 'ETH', 0.01, 2, 0.00001, 5, 0.00001, 100000, 25, 30, 200, 10, 30),
  'BNB/USDT': crypto('BNB/USDT', 'BNB', 0.01, 2, 0.001, 3, 0.001, 100000, 50, 40, 300, 20, 50),
  'SOL/USDT': crypto('SOL/USDT', 'SOL', 0.01, 2, 0.01, 2, 0.01, 1000000, 100, 100, 500, 50, 100),
  'XRP/USDT': crypto('XRP/USDT', 'XRP', 0.0001, 4, 0.1, 1, 0.1, 1000000000, 100, 100, 1000, 50, 100),
  'ADA/USDT': crypto('ADA/USDT', 'ADA', 0.0001, 4, 0.1, 1, 0.1, 1000000000, 100, 100, 1000, 50, 100),
  'DOGE/USDT': crypto('DOGE/USDT', 'DOGE', 0.00001, 5, 1, 0, 1, 9000000000, 200, 500, 2000, 100, 200),
};

/**
 * Unified asset spec. Every field the engines read exists on both asset
 * classes; crypto-specific fields (fees, funding, margin mode, per-asset
 * threshold overrides) are optional and only present for CRYPTO.
 */
export interface AssetSpec {
  symbol: string;
  assetClass: AssetClass;
  baseCurrency: string;
  quoteCurrency: string;
  pipSize: number; // forex: pip size; crypto: tick size
  pointSize: number;
  pricePrecision: number;
  quantityPrecision: number;
  contractSize: number; // forex: base units per lot; crypto: 1
  minimumLot: number; // forex: min lots; crypto: min quantity
  maximumLot: number;
  lotStep: number;
  leverage: number;
  marginRequirement: number;
  commissionPerLot: number; // forex: USD/lot; crypto: 0 (percentage fees)
  swapLong: number; // forex: swap points/lot/day; crypto: 0 (funding handled separately)
  swapShort: number;
  sessionInformation?: AssetSessionInfo;
  /** Crypto: percentage fee per side. */
  makerFee?: number;
  takerFee?: number;
  fundingRate?: number;
  fundingIntervalHours?: number;
  marginMode?: 'ISOLATED' | 'CROSS';
  exchange?: string;
  /** Spread cap in pips (crypto: ticks) for data quality / uncertainty. */
  maxSpreadPips?: number;
  /** Entry-zone width bounds in pips (crypto: ticks). */
  entryZoneMinPips?: number;
  entryZoneMaxPips?: number;
  slBufferPips?: number;
  slMinPips?: number;
  enabled: boolean;
}

export const FOREX_ASSETS: Record<string, ForexAsset> = {
  'EUR/USD': {
    symbol: 'EUR/USD', baseCurrency: 'EUR', quoteCurrency: 'USD',
    pipSize: 0.0001, pointSize: 0.00001, pricePrecision: 5, quantityPrecision: 2,
    contractSize: 100000, minimumLot: 0.01, maximumLot: 100, lotStep: 0.01,
    leverage: 100, marginRequirement: 0.01, commissionPerLot: 7, swapLong: -5.2, swapShort: 0.5,
    sessionInformation: sessionInfo('LONDON'), enabled: true,
  },
  'GBP/USD': {
    symbol: 'GBP/USD', baseCurrency: 'GBP', quoteCurrency: 'USD',
    pipSize: 0.0001, pointSize: 0.00001, pricePrecision: 5, quantityPrecision: 2,
    contractSize: 100000, minimumLot: 0.01, maximumLot: 100, lotStep: 0.01,
    leverage: 100, marginRequirement: 0.01, commissionPerLot: 7, swapLong: -6.4, swapShort: 1.1,
    sessionInformation: sessionInfo('LONDON'), enabled: true,
  },
  'USD/JPY': {
    symbol: 'USD/JPY', baseCurrency: 'USD', quoteCurrency: 'JPY',
    pipSize: 0.01, pointSize: 0.001, pricePrecision: 3, quantityPrecision: 2,
    contractSize: 100000, minimumLot: 0.01, maximumLot: 100, lotStep: 0.01,
    leverage: 100, marginRequirement: 0.01, commissionPerLot: 7, swapLong: 4.8, swapShort: -12.5,
    sessionInformation: sessionInfo('TOKYO'), enabled: true,
  },
  'USD/CHF': {
    symbol: 'USD/CHF', baseCurrency: 'USD', quoteCurrency: 'CHF',
    pipSize: 0.0001, pointSize: 0.00001, pricePrecision: 5, quantityPrecision: 2,
    contractSize: 100000, minimumLot: 0.01, maximumLot: 100, lotStep: 0.01,
    leverage: 100, marginRequirement: 0.01, commissionPerLot: 7, swapLong: 2.9, swapShort: -6.8,
    sessionInformation: sessionInfo('LONDON'), enabled: true,
  },
  'AUD/USD': {
    symbol: 'AUD/USD', baseCurrency: 'AUD', quoteCurrency: 'USD',
    pipSize: 0.0001, pointSize: 0.00001, pricePrecision: 5, quantityPrecision: 2,
    contractSize: 100000, minimumLot: 0.01, maximumLot: 100, lotStep: 0.01,
    leverage: 100, marginRequirement: 0.01, commissionPerLot: 7, swapLong: 0.4, swapShort: -3.6,
    sessionInformation: sessionInfo('SYDNEY'), enabled: true,
  },
  'USD/CAD': {
    symbol: 'USD/CAD', baseCurrency: 'USD', quoteCurrency: 'CAD',
    pipSize: 0.0001, pointSize: 0.00001, pricePrecision: 5, quantityPrecision: 2,
    contractSize: 100000, minimumLot: 0.01, maximumLot: 100, lotStep: 0.01,
    leverage: 100, marginRequirement: 0.01, commissionPerLot: 7, swapLong: 1.2, swapShort: -4.1,
    sessionInformation: sessionInfo('NEW_YORK'), enabled: true,
  },
  'NZD/USD': {
    symbol: 'NZD/USD', baseCurrency: 'NZD', quoteCurrency: 'USD',
    pipSize: 0.0001, pointSize: 0.00001, pricePrecision: 5, quantityPrecision: 2,
    contractSize: 100000, minimumLot: 0.01, maximumLot: 100, lotStep: 0.01,
    leverage: 100, marginRequirement: 0.01, commissionPerLot: 7, swapLong: 0.9, swapShort: -3.2,
    sessionInformation: sessionInfo('SYDNEY'), enabled: true,
  },
  'EUR/GBP': {
    symbol: 'EUR/GBP', baseCurrency: 'EUR', quoteCurrency: 'GBP',
    pipSize: 0.0001, pointSize: 0.00001, pricePrecision: 5, quantityPrecision: 2,
    contractSize: 100000, minimumLot: 0.01, maximumLot: 100, lotStep: 0.01,
    leverage: 100, marginRequirement: 0.01, commissionPerLot: 7, swapLong: -3.4, swapShort: 0.7,
    sessionInformation: sessionInfo('LONDON'), enabled: true,
  },
  'EUR/JPY': {
    symbol: 'EUR/JPY', baseCurrency: 'EUR', quoteCurrency: 'JPY',
    pipSize: 0.01, pointSize: 0.001, pricePrecision: 3, quantityPrecision: 2,
    contractSize: 100000, minimumLot: 0.01, maximumLot: 100, lotStep: 0.01,
    leverage: 100, marginRequirement: 0.01, commissionPerLot: 7, swapLong: 2.2, swapShort: -9.4,
    sessionInformation: sessionInfo('TOKYO'), enabled: true,
  },
  'GBP/JPY': {
    symbol: 'GBP/JPY', baseCurrency: 'GBP', quoteCurrency: 'JPY',
    pipSize: 0.01, pointSize: 0.001, pricePrecision: 3, quantityPrecision: 2,
    contractSize: 100000, minimumLot: 0.01, maximumLot: 100, lotStep: 0.01,
    leverage: 100, marginRequirement: 0.01, commissionPerLot: 7, swapLong: 3.5, swapShort: -10.8,
    sessionInformation: sessionInfo('TOKYO'), enabled: true,
  },
  'XAU/USD': {
    symbol: 'XAU/USD', baseCurrency: 'XAU', quoteCurrency: 'USD',
    pipSize: 0.1, pointSize: 0.01, pricePrecision: 2, quantityPrecision: 2,
    contractSize: 100, minimumLot: 0.01, maximumLot: 100, lotStep: 0.01,
    // 100:1 (marginRequirement 0.01): standard retail gold CFD terms. At 2%
    // the SMALLEST tradable position (0.01 lot = 1 oz) needed more margin
    // than an entire ₹5,000 wallet — every XAU signal died at
    // "margin 179% exceeds max" before any other gate could speak.
    leverage: 100, marginRequirement: 0.01, commissionPerLot: 7, swapLong: -4.5, swapShort: -2.2,
    sessionInformation: sessionInfo('LONDON'), enabled: true,
  },
  // Rate-only asset: USD/INR is a live CONVERSION rate (Yahoo USDINR=X feed),
  // never a tradable symbol. It exists so getAsset()/sizing work and the
  // account currency can be INR while every pair's P&L converts in real time.
  'USD/INR': {
    symbol: 'USD/INR', baseCurrency: 'USD', quoteCurrency: 'INR',
    pipSize: 0.01, pointSize: 0.001, pricePrecision: 2, quantityPrecision: 2,
    contractSize: 1, minimumLot: 0, maximumLot: 0, lotStep: 0,
    leverage: 1, marginRequirement: 1, commissionPerLot: 0, swapLong: 0, swapShort: 0,
    sessionInformation: sessionInfo('LONDON'), enabled: false,
  },
};

/**
 * Unified lookup: returns forex or crypto metadata for any supported symbol.
 * Crypto assets map onto the forex field names (pipSize = tickSize,
 * contractSize = 1, commissionPerLot = 0 with percentage fees applied
 * downstream) so every engine works unchanged for both asset classes.
 */
export function getAsset(symbol: string): AssetSpec {
  const f = FOREX_ASSETS[symbol];
  if (f) return f as AssetSpec;
  const c = CRYPTO_ASSETS[symbol];
  if (!c) throw new Error(`Unsupported asset: ${symbol}`);
  return {
    symbol: c.symbol,
    assetClass: 'CRYPTO',
    baseCurrency: c.baseAsset,
    quoteCurrency: c.quoteAsset,
    pipSize: c.tickSize,
    pointSize: c.tickSize / 10,
    pricePrecision: c.pricePrecision,
    quantityPrecision: c.quantityPrecision,
    contractSize: 1,
    minimumLot: c.minQuantity,
    maximumLot: c.maxQuantity,
    lotStep: c.quantityStep,
    leverage: c.leverage,
    marginRequirement: 1 / c.leverage,
    commissionPerLot: 0,
    swapLong: 0,
    swapShort: 0,
    makerFee: c.makerFee,
    takerFee: c.takerFee,
    fundingRate: c.fundingRate,
    fundingIntervalHours: c.fundingIntervalHours,
    marginMode: c.marginMode,
    exchange: c.exchange,
    maxSpreadPips: c.maxSpreadTicks,
    entryZoneMinPips: c.entryZoneMinTicks,
    entryZoneMaxPips: c.entryZoneMaxTicks,
    slBufferPips: c.slBufferTicks,
    slMinPips: c.slMinTicks,
    enabled: c.enabled,
  };
}

/** Asset class of any supported symbol ('FOREX' | 'CRYPTO'). */
export function assetClassFor(symbol: string): AssetClass {
  if (CRYPTO_ASSETS[symbol]) return 'CRYPTO';
  if (FOREX_ASSETS[symbol]) return 'FOREX';
  throw new Error(`Unsupported asset: ${symbol}`);
}

/** Crypto metadata for a crypto symbol (throws for forex). */
export function getCryptoAsset(symbol: string): CryptoAsset {
  const c = CRYPTO_ASSETS[symbol];
  if (!c) throw new Error(`Not a crypto asset: ${symbol}`);
  return c;
}

/** Round a crypto quantity down to the exchange step, respecting min/max. */
export function roundQuantity(symbol: string, quantity: number): number {
  const c = CRYPTO_ASSETS[symbol];
  if (!c) return roundLot(symbol, quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) return 0;
  const stepped = Math.floor(quantity / c.quantityStep + 1e-9) * c.quantityStep;
  const clamped = Math.min(Math.max(stepped, c.minQuantity), c.maxQuantity);
  return Number(clamped.toFixed(c.quantityPrecision));
}

export function pipsToPrice(symbol: string, pips: number): number {
  return pips * getAsset(symbol).pipSize;
}

export function priceToPips(symbol: string, priceDiff: number): number {
  return priceDiff / getAsset(symbol).pipSize;
}

/** Pip value in quote currency per standard lot (crypto: per unit). */
export function pipValueInQuote(symbol: string): number {
  const a = getAsset(symbol);
  return a.pipSize * a.contractSize;
}

/**
 * Crypto fee for one side in quote currency (taker or maker).
 * fee = price * quantity * feeRate.
 */
export function cryptoFee(symbol: string, price: number, quantity: number, side: 'maker' | 'taker'): number {
  const c = CRYPTO_ASSETS[symbol];
  if (!c) return 0;
  const rate = side === 'maker' ? c.makerFee : c.takerFee;
  return price * quantity * rate;
}

/**
 * Crypto funding cost per day in quote currency. Positive funding means longs
 * pay shorts: BUY pays, SELL receives. 0 for spot (all current assets).
 */
export function cryptoFundingPerDay(symbol: string, price: number, quantity: number, direction: 'BUY' | 'SELL'): number {
  const c = CRYPTO_ASSETS[symbol];
  if (!c || c.fundingRate === 0) return 0;
  const intervalsPerDay = 24 / c.fundingIntervalHours;
  const notional = price * quantity;
  const raw = notional * c.fundingRate * intervalsPerDay;
  return direction === 'BUY' ? -raw : raw;
}

/** Pip value converted to USD (approximation for non-USD quote pairs). */
export function pipValueInUsd(symbol: string, usdQuote: number): number {
  const a = getAsset(symbol);
  const perLot = pipValueInQuote(symbol);
  if (a.quoteCurrency === 'USD' || a.quoteCurrency === 'USDT') return perLot;
  if (a.baseCurrency === 'USD') return perLot / usdQuote; // e.g. USD/JPY
  // cross pairs: approximate through both legs
  return perLot / usdQuote;
}

export function lotToUnits(symbol: string, lots: number): number {
  return lots * getAsset(symbol).contractSize;
}

export function unitsToLots(symbol: string, units: number): number {
  return units / getAsset(symbol).contractSize;
}

/** Round lot size down to the lot step, respecting min/max. */
export function roundLot(symbol: string, lots: number): number {
  const a = getAsset(symbol);
  if (!Number.isFinite(lots) || lots <= 0) return 0;
  const stepped = Math.floor(lots / a.lotStep + 1e-9) * a.lotStep;
  const clamped = Math.min(Math.max(stepped, a.minimumLot), a.maximumLot);
  return Number(clamped.toFixed(a.quantityPrecision));
}

/** Round lot size UP to the lot step (never below the minimum), so the position covers at least the requested size. Max is NOT clamped here — callers decide what to do above maximumLot. */
export function roundLotUp(symbol: string, lots: number): number {
  const a = getAsset(symbol);
  if (!Number.isFinite(lots) || lots <= 0) return 0;
  const stepped = Math.ceil(lots / a.lotStep - 1e-9) * a.lotStep;
  const clamped = Math.max(stepped, a.minimumLot);
  return Number(clamped.toFixed(a.quantityPrecision));
}
