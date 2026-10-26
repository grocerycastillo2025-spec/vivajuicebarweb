/**
 * Pedidos.
 *
 * La creacion NO es un insert: el cliente no tiene permiso de escritura
 * sobre `orders` (regla critica de 0004_rls.sql). Se llama al RPC
 * `create_pickup_order`, que es SECURITY DEFINER y valida en el servidor
 * precios, disponibilidad, horario y capacidad. Ver 0008_checkout.sql.
 */

import { dataError } from '../domain/errors';
import type { Cents } from '../domain/money';
import type { OrderStatus } from '../domain/order';
import type { SlotOccupancy } from '../domain/pickup';
import { ORDER_COLUMNS_0026, with0026 } from './new-columns';
import { localizeOrders } from './order-names';
import { getSupabase } from '../supabase';

export interface OrderItemModifierRow {
  clover_modifier_id: string;
  name_snapshot: string;
  price_snapshot_cents: Cents;
}

export interface OrderItemRow {
  id: string;
  clover_item_id: string;
  name_snapshot: string;
  unit_price_snapshot_cents: Cents;
  quantity: number;
  line_total_cents: Cents;
  note: string | null;
  sort_order: number;
  order_item_modifiers: OrderItemModifierRow[];
}

export interface OrderRow {
  id: string;
  store_id: string;
  order_number: number;
  business_day: string;
  pickup_code: string;
  status: OrderStatus;
  fulfillment: string;
  pickup_at: string | null;
  is_asap: boolean;
  customer_note: string | null;
  currency: string;
  // La clave del pedido: de ella se derivan las de cada intento de pago.
  idempotency_key: string | null;
  subtotal_cents: Cents;
  discount_cents: Cents;
  tax_cents: Cents;
  tip_cents: Cents;
  total_cents: Cents;
  created_at: string;
  ready_at: string | null;
  completed_at: string | null;
  canceled_at: string | null;
  // Migracion 0020. `counter` = se paga en el mostrador al recoger.
  payment_method: 'counter' | 'online' | null;
  customer_name: string | null;
  cancel_reason: string | null;
  // Migracion 0024: como dijo el cliente que pagaria.
  pay_with: string | null;
  // Migracion 0026: el negocio confirmo que llego el pago.
  paid_confirmed_at?: string | null;
  // Migracion 0029: estado del cobro en linea (Stripe / PayPal).
  online_status?: string | null;
}

export interface OrderWithItems extends OrderRow {
  order_items: OrderItemRow[];
}

export const ORDER_COLUMNS =
  'id, store_id, order_number, business_day, pickup_code, status, fulfillment, ' +
  'pickup_at, is_asap, customer_note, currency, idempotency_key, subtotal_cents, discount_cents, ' +
  'tax_cents, tip_cents, total_cents, created_at, ready_at, completed_at, canceled_at, ' +
  'payment_method, customer_name, cancel_reason, pay_with';

export const ITEM_COLUMNS =
  'order_items(id, clover_item_id, name_snapshot, unit_price_snapshot_cents, quantity, ' +
  'line_total_cents, note, sort_order, ' +
  'order_item_modifiers(clover_modifier_id, name_snapshot, price_snapshot_cents))';

/** Ocupacion de franjas. Solo recuentos: RLS no deja ver pedidos ajenos. */
export async function fetchSlotOccupancy(
  storeId: string,
  from: Date,
  to: Date,
): Promise<SlotOccupancy[]> {
  const { data, error } = await getSupabase().rpc('pickup_slot_counts', {
    p_store_id: storeId,
    p_from: from.toISOString(),
    p_to: to.toISOString(),
  });

  if (error) throw dataError(error.message, error.code);

  const rows = (data ?? []) as { slot_start: string; order_count: number }[];
  return rows.map((row) => ({
    startsAt: new Date(row.slot_start).toISOString(),
    count: Number(row.order_count),
  }));
}

export interface CreateOrderItem {
  readonly clover_item_id: string;
  readonly quantity: number;
  readonly note: string | null;
  readonly modifiers: readonly string[];
}

export interface CreateOrderInput {
  readonly storeId: string;
  readonly idempotencyKey: string;
  readonly pickupAt: string;
  readonly isAsap: boolean;
  readonly customerNote: string;
  readonly items: readonly CreateOrderItem[];
}

export interface CreatedOrder {
  readonly order_id: string;
  readonly order_number: number;
  readonly pickup_code: string;
  readonly status: OrderStatus;
  readonly pickup_at: string;
  readonly business_day: string;
  readonly subtotal_cents: Cents;
}

/**
 * Errores de negocio que devuelve el RPC. Se traducen a copia en la
 * pantalla; aqui solo se reconocen.
 */
export type CreateOrderFailure =
  | 'auth_required'
  | 'store_not_available'
  | 'pickup_disabled'
  | 'pickup_not_configured'
  | 'pickup_at_required'
  | 'pickup_too_soon'
  | 'pickup_too_far'
  | 'store_closed_at_pickup'
  | 'slot_full'
  | 'empty_cart'
  | 'item_not_found'
  | 'item_unavailable'
  | 'modifier_not_for_item'
  | 'modifier_unavailable'
  | 'idempotency_key_conflict'
  | 'checkout_in_progress'
  | 'invalid_idempotency_key'
  | 'unknown';

/** El RPC lanza `item_unavailable:Acai Bowl`: se parte en codigo y detalle. */
export function parseCreateOrderError(message: string): {
  failure: CreateOrderFailure;
  subject: string | null;
} {
  const known: CreateOrderFailure[] = [
    'auth_required',
    'store_not_available',
    'pickup_disabled',
    'pickup_not_configured',
    'pickup_at_required',
    'pickup_too_soon',
    'pickup_too_far',
    'store_closed_at_pickup',
    'slot_full',
    'empty_cart',
    'item_not_found',
    'item_unavailable',
    'modifier_not_for_item',
    'modifier_unavailable',
    'idempotency_key_conflict',
    'checkout_in_progress',
    'invalid_idempotency_key',
  ];

  for (const code of known) {
    if (message.includes(code)) {
      const marker = `${code}:`;
      const at = message.indexOf(marker);
      const subject = at === -1 ? null : message.slice(at + marker.length).trim() || null;
      return { failure: code, subject };
    }
  }
  return { failure: 'unknown', subject: null };
}

export async function createPickupOrder(input: CreateOrderInput): Promise<CreatedOrder> {
  const { data, error } = await getSupabase().rpc('create_pickup_order', {
    p_store_id: input.storeId,
    p_idempotency_key: input.idempotencyKey,
    p_pickup_at: input.pickupAt,
    p_is_asap: input.isAsap,
    p_customer_note: input.customerNote,
    // Solo identificadores y cantidades. Ni un precio: los pone la base.
    p_items: input.items.map((item) => ({
      clover_item_id: item.clover_item_id,
      quantity: item.quantity,
      note: item.note,
      modifiers: [...item.modifiers],
    })),
  });

  if (error) throw dataError(error.message, error.code);
  if (data === null || data === undefined) {
    throw dataError('El servidor no devolvio el pedido creado');
  }
  return data as CreatedOrder;
}

/**
 * Pedido que se paga en el mostrador (migracion 0020). Mismo contrato que
 * `createPickupOrder`: solo ids y cantidades, los precios los pone la
 * base. El servidor solo lo acepta en sucursales sin Clover que cobran en
 * mostrador, y lo deja directamente `confirmed`.
 */
export async function placeCounterOrder(
  input: CreateOrderInput,
  payWith: string | null = null,
): Promise<CreatedOrder> {
  const { data, error } = await getSupabase().rpc('place_counter_order', {
    ...(payWith === null ? {} : { p_pay_with: payWith }),
    p_store_id: input.storeId,
    p_idempotency_key: input.idempotencyKey,
    p_pickup_at: input.pickupAt,
    p_is_asap: input.isAsap,
    p_customer_note: input.customerNote,
    p_items: input.items.map((item) => ({
      clover_item_id: item.clover_item_id,
      quantity: item.quantity,
      note: item.note,
      modifiers: [...item.modifiers],
    })),
  });

  if (error) throw dataError(error.message, error.code);
  if (data === null || data === undefined) {
    throw dataError('El servidor no devolvio el pedido creado');
  }
  return data as CreatedOrder;
}

export async function fetchMyOrders(limit = 30): Promise<OrderWithItems[]> {
  const supabase = getSupabase();
  // Filtro EXPLICITO por usuario. Antes bastaba la RLS (`orders_self_read`),
  // pero desde la 0020 el dueño y los empleados tambien ven por RLS todos
  // los pedidos del negocio, y su pestaña "Pedidos" tiene que seguir
  // ensenando solo los suyos como cliente.
  const { data: auth } = await supabase.auth.getSession();
  const userId = auth.session?.user.id;
  if (userId === undefined) return [];

  const { data, error } = await with0026((withNew) =>
    supabase
      .from('orders')
      .select(`${ORDER_COLUMNS}${withNew ? ORDER_COLUMNS_0026 : ''}, ${ITEM_COLUMNS}`)
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit)
      .returns<OrderWithItems[]>(),
  );

  if (error) throw dataError(error.message, error.code);
  return localizeOrders(data ?? []);
}

export async function fetchOrder(orderId: string): Promise<OrderWithItems | null> {
  const { data, error } = await with0026((withNew) =>
    getSupabase()
      .from('orders')
      .select(`${ORDER_COLUMNS}${withNew ? ORDER_COLUMNS_0026 : ''}, ${ITEM_COLUMNS}`)
      .eq('id', orderId)
      .maybeSingle<OrderWithItems>(),
  );

  if (error) throw dataError(error.message, error.code);
  if (data === null) return null;
  const [localizedOrder] = await localizeOrders([data]);
  return localizedOrder ?? data;
}
