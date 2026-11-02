/**
 * Upstox orders/positions/margins (spec §50 reconciliation). Official REST APIs.
 */
import { upstoxHeaders } from './upstox-auth';
import { BrokerOrder, BrokerOrderRequest, BrokerPosition } from '../types';

const API = 'https://api.upstox.com/v2';

/**
 * Upstox V2 returns LOWERCASE statuses in documented examples ('complete',
 * 'open', 'trigger pending') while the canonical BrokerOrder contract is
 * uppercase — normalize before the lookup so fills are actually recognized
 * by reconciliation/duplicate-order guards downstream.
 */
const STATUS_MAP: Record<string, string> = {
  PENDING: 'PENDING',
  OPEN: 'OPEN',
  COMPLETE: 'FILLED',
  COMPLETED: 'FILLED',
  FILLED: 'FILLED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
  CANCELLED_EXIT_PENDING: 'CANCELLED',
  'TRIGGER PENDING': 'PENDING',
};

function mapStatus(raw: string | undefined): string {
  if (!raw) return 'UNKNOWN';
  const key = raw.toUpperCase();
  return STATUS_MAP[key] ?? key;
}

export async function upstoxPlaceOrder(accessToken: string, req: BrokerOrderRequest): Promise<BrokerOrder> {
  // LIMIT/SL orders REQUIRE a price and SL orders a trigger — sending price=0
  // guarantees a broker-side rejection instead of an honest client error.
  if ((req.orderType === 'LIMIT' || req.orderType === 'SL') && !(req.price && req.price > 0)) {
    throw new Error(`upstox order rejected: ${req.orderType} order requires a positive price`);
  }
  if ((req.orderType === 'SL' || req.orderType === 'SL-M') && !(req.triggerPrice && req.triggerPrice > 0)) {
    throw new Error(`upstox order rejected: ${req.orderType} order requires a positive trigger price`);
  }
  const body: Record<string, string | number> = {
    // Upstox V2 expects the BROKER instrument key ('NSE_FO|45071'), not the
    // platform's numeric token. Callers pass the key via `instrumentToken`
    // when placing live orders (the adapter resolves it).
    instrument_token: req.instrumentToken,
    trading_symbol: req.tradingSymbol,
    transaction_type: req.side,
    quantity: req.quantity,
    order_type: req.orderType,
    product: req.product,
    validity: req.validity,
    client_order_id: req.clientOrderId,
  };
  if (req.orderType === 'LIMIT' || req.orderType === 'SL') body.price = req.price as number;
  if (req.orderType === 'SL' || req.orderType === 'SL-M') body.trigger_price = req.triggerPrice as number;
  if (req.tag) body.order_tag = req.tag;
  const res = await fetch(`${API}/order/place`, {
    method: 'POST',
    headers: { ...upstoxHeaders(accessToken), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { data?: { order_id: string }; errors?: Array<{ message: string }>; error?: string };
  if (!res.ok || !json.data?.order_id) {
    const msg = json.errors?.[0]?.message ?? json.error ?? `HTTP ${res.status}`;
    throw new Error(`upstox order rejected: ${msg}`);
  }
  const status = await upstoxOrderStatus(accessToken, json.data.order_id);
  return {
    orderId: json.data.order_id,
    clientOrderId: req.clientOrderId,
    status: status.status,
    averagePrice: status.averagePrice,
    filledQuantity: status.filledQuantity,
    remainingQuantity: status.remainingQuantity,
    rejectionReason: status.rejectionReason,
  };
}

async function upstoxOrderStatus(
  accessToken: string,
  orderId: string,
): Promise<{ status: string; averagePrice: number | null; filledQuantity: number; remainingQuantity: number; rejectionReason?: string }> {
  const res = await fetch(`${API}/order/details?order_id=${orderId}`, { headers: upstoxHeaders(accessToken) });
  if (!res.ok) return { status: 'UNKNOWN', averagePrice: null, filledQuantity: 0, remainingQuantity: 0 };
  const json = (await res.json()) as {
    data?: Array<{ status: string; average_price: number; filled_quantity: number; pending_quantity: number; status_message?: string }>;
  };
  const d = json.data?.[0];
  if (!d) return { status: 'UNKNOWN', averagePrice: null, filledQuantity: 0, remainingQuantity: 0 };
  return {
    status: mapStatus(d.status),
    averagePrice: d.average_price,
    filledQuantity: d.filled_quantity,
    remainingQuantity: d.pending_quantity,
    rejectionReason: d.status === 'REJECTED' ? d.status_message : undefined,
  };
}

export async function upstoxModifyOrder(
  accessToken: string,
  orderId: string,
  req: Partial<BrokerOrderRequest>,
): Promise<BrokerOrder> {
  const body: Record<string, string | number> = {};
  if (req.quantity) body.quantity = req.quantity;
  if (req.orderType) body.order_type = req.orderType;
  if (req.price) body.price = req.price;
  if (req.triggerPrice) body.trigger_price = req.triggerPrice;
  const res = await fetch(`${API}/order/modify/${orderId}`, {
    method: 'PUT',
    headers: { ...upstoxHeaders(accessToken), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { data?: { order_id: string }; errors?: Array<{ message: string }> };
  if (!res.ok && !json.data?.order_id) throw new Error(`upstox modify failed: ${json.errors?.[0]?.message ?? res.status}`);
  const status = await upstoxOrderStatus(accessToken, orderId);
  return {
    orderId,
    clientOrderId: req.clientOrderId ?? '',
    status: status.status,
    averagePrice: status.averagePrice,
    filledQuantity: status.filledQuantity,
    remainingQuantity: status.remainingQuantity,
    rejectionReason: status.rejectionReason,
  };
}

export async function upstoxCancelOrder(accessToken: string, orderId: string): Promise<BrokerOrder> {
  const res = await fetch(`${API}/order/cancel/${orderId}`, { method: 'DELETE', headers: upstoxHeaders(accessToken) });
  const json = (await res.json()) as { data?: { order_id: string }; errors?: Array<{ message: string }> };
  if (!res.ok && !json.data?.order_id) throw new Error(`upstox cancel failed: ${json.errors?.[0]?.message ?? res.status}`);
  const status = await upstoxOrderStatus(accessToken, orderId);
  return {
    orderId,
    clientOrderId: '',
    status: status.status,
    averagePrice: status.averagePrice,
    filledQuantity: status.filledQuantity,
    remainingQuantity: status.remainingQuantity,
    rejectionReason: status.rejectionReason,
  };
}

export async function upstoxGetOrders(accessToken: string): Promise<BrokerOrder[]> {
  const res = await fetch(`${API}/order/retrieve-all`, { headers: upstoxHeaders(accessToken) });
  if (!res.ok) return [];
  const json = (await res.json()) as {
    data?: Array<{ order_id: string; client_order_id?: string; status: string; average_price: number; filled_quantity: number; pending_quantity: number; status_message?: string }>;
  };
  return (json.data ?? []).map((d) => ({
    orderId: d.order_id,
    clientOrderId: d.client_order_id ?? '',
    status: mapStatus(d.status),
    averagePrice: d.average_price,
    filledQuantity: d.filled_quantity,
    remainingQuantity: d.pending_quantity,
    rejectionReason: d.status === 'REJECTED' ? d.status_message : undefined,
  }));
}

export async function upstoxGetPositions(accessToken: string): Promise<BrokerPosition[]> {
  const res = await fetch(`${API}/positions`, { headers: upstoxHeaders(accessToken) });
  if (!res.ok) return [];
  const json = (await res.json()) as {
    data?: Array<{ tradingsymbol: string; instrument_token: string; exchange: string; quantity: number; average_price: number; unrealised: number; pnl: number }>;
  };
  return (json.data ?? [])
    .filter((p) => p.quantity !== 0)
    .map((p) => ({
      tradingSymbol: p.tradingsymbol,
      instrumentToken: String(p.instrument_token),
      exchange: p.exchange,
      segment: p.exchange === 'BSE' ? 'BSE_FUT' : 'NSE_FUT',
      side: p.quantity > 0 ? 'BUY' as const : 'SELL' as const,
      quantity: Math.abs(p.quantity),
      averagePrice: p.average_price,
      unrealizedPnl: p.unrealised ?? null,
      realizedPnl: p.pnl ?? null,
    }));
}

export async function upstoxGetAccount(accessToken: string): Promise<{ availableCash: number | null; availableMargin: number | null } | null> {
  const res = await fetch(`${API}/user/get-funds-and-margin`, { headers: upstoxHeaders(accessToken) });
  if (!res.ok) return null;
  const json = (await res.json()) as { data?: { equity?: { available_margin: number; used_margin: number; payin_amount: number; payout_amount: number; ad_hoc_margin: number } } };
  const d = json.data?.equity;
  if (!d) return null;
  return { availableCash: d.available_margin, availableMargin: d.available_margin };
}
