/**
 * Zerodha Kite Connect orders/positions/account (spec §50 reconciliation).
 * Official REST APIs only. Order status is always confirmed from the broker —
 * never assumed from a successful HTTP response.
 */
import type { IndiaPosition } from '@fx/shared';
import { authHeaders } from './zerodha-auth';
import { BrokerOrder, BrokerOrderRequest, BrokerPosition } from '../types';

const API = 'https://api.kite.trade';

const STATUS_MAP: Record<string, string> = {
  PENDING: 'PENDING',
  OPEN: 'OPEN',
  COMPLETE: 'FILLED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
  'TRIGGER PENDING': 'PENDING',
};

export async function kitePlaceOrder(
  apiKey: string,
  accessToken: string,
  req: BrokerOrderRequest,
): Promise<BrokerOrder> {
  const body: Record<string, string | number> = {
    exchange: req.exchange,
    tradingsymbol: req.tradingSymbol,
    transaction_type: req.side,
    quantity: req.quantity,
    order_type: req.orderType,
    product: req.product,
    validity: req.validity,
    variety: 'regular',
  };
  if (req.orderType === 'LIMIT' || req.orderType === 'SL') body.price = req.price ?? 0;
  if (req.orderType === 'SL' || req.orderType === 'SL-M') body.trigger_price = req.triggerPrice ?? 0;
  if (req.tag) body.tag = req.tag;
  const res = await fetch(`${API}/orders/regular`, {
    method: 'POST',
    headers: { ...authHeaders(apiKey, accessToken), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body as Record<string, string>).toString(),
  });
  const json = (await res.json()) as { data?: { order_id: string }; error_type?: string; message?: string };
  if (!res.ok || !json.data?.order_id) {
    throw new Error(`kite order rejected: ${json.error_type ?? ''} ${json.message ?? res.status}`);
  }
  // Never assume the order succeeded: re-fetch its status from the broker.
  const status = await kiteOrderStatus(apiKey, accessToken, json.data.order_id);
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

async function kiteOrderStatus(
  apiKey: string,
  accessToken: string,
  orderId: string,
): Promise<{ status: string; averagePrice: number | null; filledQuantity: number; remainingQuantity: number; rejectionReason?: string }> {
  const res = await fetch(`${API}/orders/${orderId}`, { headers: authHeaders(apiKey, accessToken) });
  if (!res.ok) return { status: 'UNKNOWN', averagePrice: null, filledQuantity: 0, remainingQuantity: 0 };
  const json = (await res.json()) as { data?: { status: string; average_price: number; filled_quantity: number; remaining_quantity: number; status_message?: string } };
  const d = json.data;
  if (!d) return { status: 'UNKNOWN', averagePrice: null, filledQuantity: 0, remainingQuantity: 0 };
  return {
    status: STATUS_MAP[d.status] ?? d.status,
    averagePrice: d.average_price,
    filledQuantity: d.filled_quantity,
    remainingQuantity: d.remaining_quantity,
    rejectionReason: d.status === 'REJECTED' ? d.status_message : undefined,
  };
}

export async function kiteModifyOrder(
  apiKey: string,
  accessToken: string,
  orderId: string,
  req: Partial<BrokerOrderRequest>,
): Promise<BrokerOrder> {
  const body: Record<string, string | number> = {};
  if (req.quantity) body.quantity = req.quantity;
  if (req.orderType) body.order_type = req.orderType;
  if (req.price) body.price = req.price;
  if (req.triggerPrice) body.trigger_price = req.triggerPrice;
  const res = await fetch(`${API}/orders/regular/${orderId}`, {
    method: 'PUT',
    headers: { ...authHeaders(apiKey, accessToken), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body as Record<string, string>).toString(),
  });
  const json = (await res.json()) as { data?: { order_id: string }; error_type?: string; message?: string };
  if (!res.ok || !json.data?.order_id) throw new Error(`kite modify failed: ${json.message ?? res.status}`);
  const status = await kiteOrderStatus(apiKey, accessToken, orderId);
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

export async function kiteCancelOrder(apiKey: string, accessToken: string, orderId: string): Promise<BrokerOrder> {
  const res = await fetch(`${API}/orders/regular/${orderId}`, {
    method: 'DELETE',
    headers: authHeaders(apiKey, accessToken),
  });
  const json = (await res.json()) as { data?: { order_id: string }; error_type?: string; message?: string };
  if (!res.ok && !json.data?.order_id) throw new Error(`kite cancel failed: ${json.message ?? res.status}`);
  const status = await kiteOrderStatus(apiKey, accessToken, orderId);
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

export async function kiteGetOrders(apiKey: string, accessToken: string): Promise<BrokerOrder[]> {
  const res = await fetch(`${API}/orders`, { headers: authHeaders(apiKey, accessToken) });
  if (!res.ok) return [];
  const json = (await res.json()) as { data?: Array<{ order_id: string; status: string; average_price: number; filled_quantity: number; pending_quantity: number; status_message?: string }> };
  return (json.data ?? []).map((d) => ({
    orderId: d.order_id,
    clientOrderId: '',
    status: STATUS_MAP[d.status] ?? d.status,
    averagePrice: d.average_price,
    filledQuantity: d.filled_quantity,
    remainingQuantity: d.pending_quantity,
    rejectionReason: d.status === 'REJECTED' ? d.status_message : undefined,
  }));
}

export async function kiteGetPositions(apiKey: string, accessToken: string): Promise<BrokerPosition[]> {
  const res = await fetch(`${API}/portfolio/positions`, { headers: authHeaders(apiKey, accessToken) });
  if (!res.ok) return [];
  const json = (await res.json()) as {
    data?: { net?: Array<{ tradingsymbol: string; instrument_token: string; exchange: string; quantity: number; average_price: number; unrealised: number; pnl: number }> };
  };
  return (json.data?.net ?? [])
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

export async function kiteGetAccount(apiKey: string, accessToken: string): Promise<{ availableCash: number | null; availableMargin: number | null } | null> {
  const res = await fetch(`${API}/user/margins`, { headers: authHeaders(apiKey, accessToken) });
  if (!res.ok) return null;
  const json = (await res.json()) as { data?: { equity?: { available?: { cash: number; intraday_margin: number } } } };
  const d = json.data;
  if (!d?.equity?.available) return null;
  return {
    availableCash: d.equity.available.cash,
    availableMargin: d.equity.available.intraday_margin,
  };
}

export async function kiteGetPositionsRaw(apiKey: string, accessToken: string): Promise<IndiaPosition[]> {
  const broker = await kiteGetPositions(apiKey, accessToken);
  return broker.map((p) => ({
    positionId: `kite:${p.instrumentToken}`,
    strategyOwner: 'NONE',
    executionMode: 'OFF',
    goalId: null,
    signalId: null,
    instrumentToken: p.instrumentToken,
    tradingSymbol: p.tradingSymbol,
    underlying: p.tradingSymbol,
    exchange: p.exchange === 'BSE' ? 'BSE' : 'NSE',
    segment: p.exchange === 'BSE' ? 'BSE_FUT' : 'NSE_FUT',
    contractType: 'FUT',
    side: p.side,
    quantity: p.quantity,
    entry: p.averagePrice,
    stopLoss: 0,
    target: 0,
    openedAt: Date.now(),
    closedAt: null,
    currentPrice: null,
    unrealizedPnl: p.unrealizedPnl ?? 0,
    realizedPnl: p.realizedPnl ?? 0,
    status: 'OPEN',
    exitReason: null,
    trailingStop: null,
    breakevenApplied: false,
    audit: [],
  }));
}