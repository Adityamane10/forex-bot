/**
 * On-chain data provider (spec §17-18). Crypto on-chain features are OPTIONAL:
 * when no source is configured the system continues WITHOUT on-chain data and
 * honestly reports UNAVAILABLE — it never fabricates whale/liquidation/flow
 * numbers. Plug a real provider behind this interface when a free/legitimate
 * source becomes available.
 */

export interface OnChainSnapshot {
  symbol: string;
  available: boolean;
  reason?: string;
  timestamp: number;
  /** ONCHAIN_EVENT types observed (spec §18): WHALE_ACTIVITY,
   *  EXCHANGE_INFLOW_SPIKE, EXCHANGE_OUTFLOW_SPIKE, LIQUIDATION_SPIKE,
   *  STABLECOIN_FLOW_SPIKE, NETWORK_ACTIVITY_SPIKE, DEX_VOLUME_SPIKE,
   *  LIQUIDITY_CHANGE. Empty when no source is configured. */
  events: string[];
}

export interface OnChainProvider {
  readonly name: string;
  readonly description: string;
  connect(): Promise<void>;
  getSnapshot(symbol: string): Promise<OnChainSnapshot>;
  health(): Promise<{ ok: boolean; detail: string }>;
}

/**
 * Honest no-op provider. Free keyless on-chain APIs are not currently
 * configured, so crypto analysis runs without on-chain features and the
 * system health panel reports the source as UNAVAILABLE (never fake data).
 */
export class NoneOnChainProvider implements OnChainProvider {
  readonly name = 'NONE';
  readonly description =
    'No on-chain data source configured. Free keyless on-chain APIs are not available in this build; ' +
    'crypto analysis continues WITHOUT on-chain features, marked UNAVAILABLE rather than fabricated.';

  async connect(): Promise<void> {
    /* nothing to connect */
  }

  async getSnapshot(symbol: string): Promise<OnChainSnapshot> {
    return {
      symbol,
      available: false,
      reason: 'no on-chain provider configured — on-chain features unavailable (never fabricated)',
      timestamp: Date.now(),
      events: [],
    };
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    return {
      ok: false,
      detail: 'no on-chain data source — crypto analysis runs without on-chain features (UNAVAILABLE)',
    };
  }
}
