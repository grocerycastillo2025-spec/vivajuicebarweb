/**
 * Cobro en línea (Stripe y PayPal): lo que comparten los dos proveedores.
 *
 * REGLAS QUE NO SE NEGOCIAN
 *  - El monto sale de la base, nunca del teléfono.
 *  - Ni el teléfono ni un aviso (webhook) marcan nada pagado: con el id que
 *    traen se le PREGUNTA al proveedor, con nuestras llaves. Un aviso falso
 *    solo consigue que consultemos un pago que no existe o no es nuestro.
 *  - Un pedido se marca pagado solo si el pago está completo, es en la
 *    moneda del pedido, apunta a ESE pedido y cubre el monto.
 *  - Una devolución total lo desmarca.
 *
 * Este archivo no toca la red ni Deno: recibe sus dependencias para poder
 * probarlo en Node con un proveedor falso.
 */

import { identificar, leerBearer } from './auth.ts';

export type Provider = 'stripe' | 'paypal';

export type Sql = (text: string, params?: readonly unknown[]) => Promise<Record<string, unknown>[]>;

// ---------------------------------------------------------------------
// Dinero
// ---------------------------------------------------------------------

/** 1250 -> "12.50" (PayPal pide el monto como texto con 2 decimales). */
export function centsToDecimal(cents: number): string {
  const whole = Math.trunc(Math.round(cents));
  const sign = whole < 0 ? '-' : '';
  const abs = Math.abs(whole);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** "12.50" o 12.5 -> 1250, sin errores de coma flotante. null si no es un monto. */
export function decimalToCents(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value * 100) : null;
  if (typeof value !== 'string') return null;
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (m === null) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

/** "2× Green Juice, 1× Latte" para la descripción del cobro. */
export function summarizeItems(items: readonly { readonly name: string; readonly quantity: number }[]): string {
  return items.map((i) => `${i.quantity}× ${i.name}`).join(', ');
}

// ---------------------------------------------------------------------
// Decidir qué hacer con un pago consultado al proveedor
// ---------------------------------------------------------------------

/** El pago tal como lo devolvió el proveedor, ya traducido. */
export interface ProviderPayment {
  /** Id del pago (PaymentIntent de Stripe / captura de PayPal). */
  readonly id: string;
  /** Pedido al que dice pertenecer (client_reference_id / custom_id). */
  readonly orderRef: string | null;
  readonly status: 'paid' | 'refunded' | 'partially_refunded' | 'pending' | 'failed';
  /** Estado original del proveedor, para guardarlo tal cual. */
  readonly rawStatus: string;
  readonly amountCents: number;
  /** En mayúsculas: "USD". */
  readonly currency: string;
}

export interface OrderToCheck {
  readonly id: string;
  readonly payWith: string | null;
  readonly currency: string;
  readonly amountCents: number;
}

export type PaymentDecision =
  | { readonly kind: 'mark_paid' }
  | { readonly kind: 'mark_unpaid'; readonly reason: string }
  | { readonly kind: 'record_only'; readonly reason: string }
  | { readonly kind: 'reject'; readonly reason: string };

export function decidePayment(provider: Provider, payment: ProviderPayment, order: OrderToCheck | null): PaymentDecision {
  if (order === null || payment.orderRef !== order.id) return { kind: 'reject', reason: 'pedido_desconocido' };
  if (order.payWith !== provider) return { kind: 'reject', reason: `pedido_no_es_${provider}` };
  if (payment.currency.toUpperCase() !== order.currency.toUpperCase()) return { kind: 'reject', reason: 'moneda_distinta' };
  switch (payment.status) {
    case 'paid':
      if (payment.amountCents < order.amountCents) return { kind: 'reject', reason: 'monto_insuficiente' };
      return { kind: 'mark_paid' };
    case 'refunded':
      return { kind: 'mark_unpaid', reason: payment.rawStatus };
    default:
      return { kind: 'record_only', reason: payment.rawStatus };
  }
}

/** Lee el pedido para comparar con el pago. */
export async function orderToCheck(sql: Sql, orderId: string): Promise<OrderToCheck | null> {
  if (!isUuid(orderId)) return null;
  const rows = await sql(
    `select id, pay_with, currency, app.order_amount_cents(id) as amount_cents
       from public.orders where id = $1`,
    [orderId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return {
    id: String(row['id']),
    payWith: row['pay_with'] === null ? null : String(row['pay_with']),
    currency: String(row['currency'] ?? '').trim(),
    amountCents: Number(row['amount_cents']),
  };
}

/** Guarda lo decidido. Devuelve true si el pedido quedó pagado. */
export async function applyDecision(
  sql: Sql,
  payment: ProviderPayment,
  decision: PaymentDecision,
): Promise<boolean> {
  switch (decision.kind) {
    case 'reject':
      return false;
    case 'mark_paid':
      await sql(
        `update public.orders
            set paid_confirmed_at = coalesce(paid_confirmed_at, now()),
                online_payment_id = $2, online_status = $3, online_paid_cents = $4
          where id = $1`,
        [payment.orderRef, payment.id, payment.rawStatus, payment.amountCents],
      );
      return true;
    case 'mark_unpaid':
      // Devolución del MISMO pago que lo había pagado.
      await sql(
        `update public.orders
            set paid_confirmed_at = null, paid_confirmed_by = null, online_status = $3
          where id = $1 and (online_payment_id = $2 or online_payment_id is null)`,
        [payment.orderRef, payment.id, payment.rawStatus],
      );
      return false;
    case 'record_only':
      await sql(
        `update public.orders set online_status = $2
          where id = $1 and paid_confirmed_at is null`,
        [payment.orderRef, payment.rawStatus],
      );
      return false;
  }
}

// ---------------------------------------------------------------------
// La función que llama la app: pagar, confirmar al volver, probar conexión
// ---------------------------------------------------------------------

export interface CheckoutOrder {
  readonly id: string;
  readonly orderNumber: number;
  readonly amountCents: number;
  readonly currency: string;
  readonly storeName: string;
  readonly itemsSummary: string;
  readonly payerEmail: string | null;
  /** A dónde vuelve el cliente: .../order/<id>?pago=ok|cancelado */
  readonly returnUrl: string;
  readonly cancelUrl: string;
}

export type CheckStatus =
  | { readonly ok: true; readonly test: boolean; readonly account: string | null; readonly webhook?: boolean }
  | { readonly ok: false; readonly reason: 'falta_llave' | 'llave_rechazada' | 'proveedor_inalcanzable' };

/** Lo que cada proveedor tiene que saber hacer. */
export interface ProviderAdapter {
  readonly provider: Provider;
  /** ¿Están las llaves en los secretos? */
  configured(): boolean;
  check(): Promise<CheckStatus>;
  /** Crea el cobro. Lanza ProviderError si el proveedor lo rechaza. */
  createCheckout(order: CheckoutOrder): Promise<{ readonly checkoutId: string; readonly url: string }>;
  /**
   * El pago de un cobro creado antes, consultado al proveedor (PayPal lo
   * captura aquí si el cliente ya lo aprobó). null = todavía no hay pago.
   */
  paymentForCheckout(checkoutId: string): Promise<ProviderPayment | null>;
}

export class ProviderError extends Error {
  readonly status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
  }
}

export interface PagoDeps {
  readonly sql: Sql;
  readonly fetch: typeof fetch;
  readonly supabaseUrl: string;
  readonly anonKey: string;
  readonly adapter: ProviderAdapter;
  /** Base pública de la app web, con "/" final. */
  readonly appUrl: string;
  readonly log?: (event: string, data?: Record<string, unknown>) => void;
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
  'access-control-allow-methods': 'POST, OPTIONS',
};

export function createPagoHandler(deps: PagoDeps): (req: Request) => Promise<Response> {
  const { adapter, sql } = deps;
  const provider = adapter.provider;
  const log = deps.log ?? (() => undefined);

  return async (req) => {
    if (req.method === 'OPTIONS') return json(204, null);
    if (req.method !== 'POST') return json(405, { error: 'solo POST' });

    const token = leerBearer(req.headers.get('authorization'));
    if (token === null) return json(401, { error: 'no autorizado' });
    const who = await identificar(deps.fetch, { supabaseUrl: deps.supabaseUrl, anonKey: deps.anonKey, token });
    if (!who.ok) return json(401, { error: 'no autorizado' });

    let body: Record<string, unknown>;
    try {
      body = ((await req.json()) ?? {}) as Record<string, unknown>;
    } catch {
      return json(400, { error: 'cuerpo inválido' });
    }

    try {
      if (body['action'] === 'estado') return await estado(String(body['store_id'] ?? ''), who.userId);
      if (body['action'] === 'confirmar') return await confirmar(String(body['order_id'] ?? ''), who.userId);
      return await pagar(String(body['order_id'] ?? ''), who.userId);
    } catch (cause) {
      if (cause instanceof ProviderError) {
        log('proveedor_rechazo', { motivo: cause.message });
        return json(cause.status, { error: cause.message });
      }
      throw cause;
    }
  };

  // ── El dueño prueba la conexión ──────────────────────────────────────
  async function estado(storeId: string, userId: string): Promise<Response> {
    if (!isUuid(storeId)) return json(400, { error: 'store_id inválido' });
    const owner = await sql(
      `select 1 from public.stores s
         join public.restaurant_members m on m.restaurant_id = s.restaurant_id
        where s.id = $1 and m.user_id = $2 and m.role = 'owner'`,
      [storeId, userId],
    );
    if (owner.length === 0) return json(403, { error: 'solo el dueño' });

    if (!adapter.configured()) {
      await setAccount(storeId, 'pending', null, null);
      return json(200, { connected: false, reason: 'falta_llave' });
    }
    const status = await adapter.check();
    if (!status.ok) {
      if (status.reason === 'llave_rechazada') await setAccount(storeId, 'disabled', null, null);
      return json(200, { connected: false, reason: status.reason });
    }
    await setAccount(storeId, 'active', !status.test, status.account);
    return json(200, { connected: true, test: status.test, account: status.account, webhook: status.webhook ?? null });
  }

  async function setAccount(storeId: string, status: string, live: boolean | null, label: string | null): Promise<void> {
    await sql(
      `insert into public.payment_provider_accounts (store_id, provider, status, live_mode, account_label, updated_at)
       values ($1, $2, $3, $4, $5, now())
       on conflict (store_id, provider) do update
         set status = excluded.status, live_mode = excluded.live_mode,
             account_label = excluded.account_label, updated_at = now()`,
      [storeId, provider, status, live, label === null ? null : label.slice(0, 120)],
    );
  }

  // ── El pedido del cliente ────────────────────────────────────────────
  async function loadOrder(orderId: string, userId: string): Promise<Record<string, unknown> | null> {
    if (!isUuid(orderId)) return null;
    const rows = await sql(
      `select o.id, o.order_number, o.user_id, o.status, o.pay_with, o.currency,
              o.paid_confirmed_at, o.online_checkout_id,
              app.order_amount_cents(o.id) as amount_cents,
              s.name as store_name, s.id as store_id,
              app.provider_connected(s.id, $2) as connected,
              coalesce((s.payment_options ->> $2)::boolean, false) as enabled,
              u.email
         from public.orders o
         join public.stores s on s.id = o.store_id
         left join auth.users u on u.id = o.user_id
        where o.id = $1`,
      [orderId, provider],
    );
    const o = rows[0];
    // El pedido de otro usuario se contesta igual que uno que no existe.
    if (o === undefined || o['user_id'] !== userId) return null;
    return o;
  }

  async function pagar(orderId: string, userId: string): Promise<Response> {
    if (!isUuid(orderId)) return json(400, { error: 'order_id inválido' });
    if (!adapter.configured()) return json(503, { error: 'no_conectado' });
    const o = await loadOrder(orderId, userId);
    if (o === null) return json(404, { error: 'pedido_no_encontrado' });
    if (o['pay_with'] !== provider) return json(409, { error: `pedido_no_es_${provider}` });
    if (o['paid_confirmed_at'] !== null) return json(409, { error: 'ya_pagado' });
    if (o['status'] === 'canceled' || o['status'] === 'completed') return json(409, { error: 'pedido_cerrado' });
    if (o['connected'] !== true || o['enabled'] !== true) return json(503, { error: 'no_conectado' });

    const amountCents = Number(o['amount_cents']);
    if (!Number.isInteger(amountCents) || amountCents <= 0) return json(409, { error: 'monto_invalido' });

    const items = await sql(
      `select name_snapshot as name, quantity from public.order_items where order_id = $1 order by sort_order`,
      [orderId],
    );
    const back = `${deps.appUrl}order/${orderId}`;
    const checkout = await adapter.createCheckout({
      id: orderId,
      orderNumber: Number(o['order_number']),
      amountCents,
      currency: String(o['currency'] ?? 'USD').trim(),
      storeName: String(o['store_name'] ?? ''),
      itemsSummary: summarizeItems(items.map((i) => ({ name: String(i['name']), quantity: Number(i['quantity']) }))),
      payerEmail: typeof o['email'] === 'string' ? o['email'] : null,
      returnUrl: `${back}?pago=ok`,
      cancelUrl: `${back}?pago=cancelado`,
    });

    await sql(`update public.orders set online_checkout_id = $2, online_status = 'created' where id = $1`, [
      orderId,
      checkout.checkoutId,
    ]);
    return json(200, { url: checkout.url, amount_cents: amountCents });
  }

  // ── El cliente vuelve del proveedor ──────────────────────────────────
  async function confirmar(orderId: string, userId: string): Promise<Response> {
    const o = await loadOrder(orderId, userId);
    if (o === null) return json(404, { error: 'pedido_no_encontrado' });
    if (o['paid_confirmed_at'] !== null) return json(200, { paid: true });
    if (o['pay_with'] !== provider) return json(409, { error: `pedido_no_es_${provider}` });
    const checkoutId = o['online_checkout_id'];
    if (typeof checkoutId !== 'string' || checkoutId === '' || !adapter.configured()) return json(200, { paid: false });

    const payment = await adapter.paymentForCheckout(checkoutId);
    if (payment === null) return json(200, { paid: false });
    const decision = decidePayment(provider, payment, await orderToCheck(sql, orderId));
    log('confirmar', { pedido: orderId, pago: payment.id, estado: payment.rawStatus, decision: decision.kind });
    const paid = await applyDecision(sql, payment, decision);
    if (!paid && payment.status === 'failed') return json(409, { error: 'pago_no_aprobado' });
    return json(200, { paid });
  }
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function json(status: number, body: Record<string, unknown> | null): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { ...CORS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export function text(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
