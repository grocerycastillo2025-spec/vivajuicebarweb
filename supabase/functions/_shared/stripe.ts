/**
 * Stripe Checkout para VIVA Juice and Coffee.
 *
 *   stripe-pago     crea la Checkout Session con el total del pedido (de la
 *                   base) y devuelve su URL. Ahí el cliente paga con
 *                   tarjeta, Apple Pay o Google Pay.
 *   stripe-webhook  Stripe avisa (firma verificada con STRIPE_WEBHOOK_SECRET)
 *                   y, aun así, la sesión o el cargo se vuelven a pedir a la
 *                   API antes de marcar nada.
 *
 * Secretos (Supabase → Edge Functions → Secrets):
 *   STRIPE_SECRET_KEY       sk_live_… (o sk_test_… / rk_… para probar)
 *   STRIPE_WEBHOOK_SECRET   whsec_… del endpoint del webhook
 */

import {
  ProviderError,
  type CheckoutOrder,
  type CheckStatus,
  type ProviderAdapter,
  type ProviderPayment,
} from './cobro.ts';

export const STRIPE_API = 'https://api.stripe.com';

/** Llaves de prueba: sk_test_… o rk_test_…. */
export function isStripeTestKey(key: string): boolean {
  return /^(sk|rk)_test_/.test(key);
}

/** Cuerpo form-urlencoded con la notación de corchetes de Stripe. */
export function formEncode(data: Record<string, unknown>, prefix = ''): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue;
    const name = prefix === '' ? key : `${prefix}[${key}]`;
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (typeof item === 'object' && item !== null) parts.push(formEncode(item as Record<string, unknown>, `${name}[${i}]`));
        else parts.push(`${encodeURIComponent(`${name}[${i}]`)}=${encodeURIComponent(String(item))}`);
      });
    } else if (typeof value === 'object') {
      parts.push(formEncode(value as Record<string, unknown>, name));
    } else {
      parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
    }
  }
  return parts.filter((p) => p !== '').join('&');
}

/** La Checkout Session de un pedido. Una sola línea con el total exacto. */
export function sessionParams(order: CheckoutOrder): Record<string, unknown> {
  return {
    mode: 'payment',
    client_reference_id: order.id,
    metadata: { order_id: order.id, order_number: order.orderNumber },
    payment_intent_data: {
      metadata: { order_id: order.id, order_number: order.orderNumber },
      description: `Order #${order.orderNumber} · ${order.storeName}`.slice(0, 200),
    },
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: order.currency.toLowerCase(),
          unit_amount: order.amountCents,
          product_data: {
            name: `Order #${order.orderNumber} · ${order.storeName}`.slice(0, 200),
            ...(order.itemsSummary === '' ? {} : { description: order.itemsSummary.slice(0, 450) }),
          },
        },
      },
    ],
    ...(order.payerEmail === null ? {} : { customer_email: order.payerEmail }),
    success_url: order.returnUrl,
    cancel_url: order.cancelUrl,
    locale: 'auto',
  };
}

interface StripeSession {
  readonly id?: unknown;
  readonly url?: unknown;
  readonly status?: unknown;
  readonly payment_status?: unknown;
  readonly amount_total?: unknown;
  readonly currency?: unknown;
  readonly client_reference_id?: unknown;
  readonly metadata?: { order_id?: unknown } | null;
  readonly payment_intent?: unknown;
}

/** Lo que importa de una Checkout Session. */
export function paymentFromSession(json: unknown): ProviderPayment | null {
  const s = json as StripeSession | null;
  if (s === null || typeof s !== 'object' || typeof s.id !== 'string') return null;
  const ref =
    typeof s.client_reference_id === 'string'
      ? s.client_reference_id
      : typeof s.metadata?.order_id === 'string'
        ? s.metadata.order_id
        : null;
  const intent =
    typeof s.payment_intent === 'string'
      ? s.payment_intent
      : typeof (s.payment_intent as { id?: unknown } | null)?.id === 'string'
        ? String((s.payment_intent as { id: string }).id)
        : s.id;
  const paymentStatus = String(s.payment_status ?? '');
  const sessionStatus = String(s.status ?? '');
  const status: ProviderPayment['status'] =
    paymentStatus === 'paid'
      ? 'paid'
      : sessionStatus === 'expired'
        ? 'failed'
        : 'pending';
  return {
    id: intent,
    orderRef: ref,
    status,
    rawStatus: paymentStatus === '' ? sessionStatus : paymentStatus,
    amountCents: typeof s.amount_total === 'number' ? s.amount_total : 0,
    currency: typeof s.currency === 'string' ? s.currency.toUpperCase() : '',
  };
}

interface StripeCharge {
  readonly id?: unknown;
  readonly payment_intent?: unknown;
  readonly amount?: unknown;
  readonly amount_refunded?: unknown;
  readonly refunded?: unknown;
  readonly currency?: unknown;
  readonly status?: unknown;
}

/** Un cargo devuelto (charge.refunded), visto como pago del pedido. */
export function paymentFromCharge(json: unknown, orderRef: string | null): ProviderPayment | null {
  const c = json as StripeCharge | null;
  if (c === null || typeof c !== 'object' || typeof c.payment_intent !== 'string') return null;
  const amount = typeof c.amount === 'number' ? c.amount : 0;
  const refunded = typeof c.amount_refunded === 'number' ? c.amount_refunded : 0;
  const full = c.refunded === true || (amount > 0 && refunded >= amount);
  return {
    id: c.payment_intent,
    orderRef,
    status: full ? 'refunded' : refunded > 0 ? 'partially_refunded' : c.status === 'succeeded' ? 'paid' : 'pending',
    rawStatus: full ? 'refunded' : refunded > 0 ? 'partially_refunded' : String(c.status ?? ''),
    amountCents: amount,
    currency: typeof c.currency === 'string' ? c.currency.toUpperCase() : '',
  };
}

// ---------------------------------------------------------------------
// Firma del webhook (Stripe-Signature: t=…,v1=…)
// ---------------------------------------------------------------------

const encoder = new TextEncoder();

async function hmacHex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * ¿La firma es de Stripe? Mismo algoritmo que su SDK: HMAC-SHA256 de
 * "<t>.<cuerpo crudo>" con el secreto del webhook, y el `t` no puede tener
 * más de 5 minutos (contra repeticiones).
 */
export async function verifyStripeSignature(
  rawBody: string,
  header: string | null,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  toleranceSeconds = 300,
): Promise<boolean> {
  if (header === null || secret === '') return false;
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const [k, v] = part.split('=', 2).map((x) => x.trim());
    if (k === 't' && v !== undefined && /^\d+$/.test(v)) timestamp = Number(v);
    if (k === 'v1' && v !== undefined) signatures.push(v);
  }
  if (timestamp === null || signatures.length === 0) return false;
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false;
  const expected = await hmacHex(secret, `${timestamp}.${rawBody}`);
  return signatures.some((s) => safeEqual(s, expected));
}

/** Firma un cuerpo como lo haría Stripe (para las pruebas). */
export async function signStripePayload(rawBody: string, secret: string, timestamp: number): Promise<string> {
  return `t=${timestamp},v1=${await hmacHex(secret, `${timestamp}.${rawBody}`)}`;
}

// ---------------------------------------------------------------------
// El adaptador que usa stripe-pago
// ---------------------------------------------------------------------

export interface StripeConfig {
  readonly secretKey: string | null;
  readonly webhookSecret: string | null;
  readonly fetch: typeof fetch;
  readonly api?: string | undefined;
}

export function stripeAdapter(config: StripeConfig): ProviderAdapter & {
  retrieveSession(id: string): Promise<ProviderPayment | null>;
  retrieveCharge(id: string): Promise<unknown>;
} {
  const api = config.api ?? STRIPE_API;
  const key = config.secretKey ?? '';

  async function call(method: 'GET' | 'POST', path: string, body?: string, idempotencyKey?: string): Promise<Response> {
    try {
      return await config.fetch(`${api}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${key}`,
          'stripe-version': '2024-06-20',
          ...(body === undefined ? {} : { 'content-type': 'application/x-www-form-urlencoded' }),
          ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }),
        },
        ...(body === undefined ? {} : { body }),
      });
    } catch {
      throw new ProviderError('proveedor_inalcanzable');
    }
  }

  async function retrieveSession(id: string): Promise<ProviderPayment | null> {
    if (!/^cs_[A-Za-z0-9_]+$/.test(id)) return null;
    const res = await call('GET', `/v1/checkout/sessions/${id}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new ProviderError(`stripe_${res.status}`);
    return paymentFromSession(await res.json().catch(() => null));
  }

  return {
    provider: 'stripe',
    configured: () => key !== '',

    async check(): Promise<CheckStatus> {
      let res: Response;
      try {
        res = await call('GET', '/v1/account');
      } catch {
        return { ok: false, reason: 'proveedor_inalcanzable' };
      }
      if (res.status === 401) return { ok: false, reason: 'llave_rechazada' };
      // Una llave restringida puede no leer la cuenta: si no es 401, la llave vale.
      const account = (await res.json().catch(() => ({}))) as {
        id?: unknown;
        email?: unknown;
        business_profile?: { name?: unknown } | null;
        settings?: { dashboard?: { display_name?: unknown } } | null;
      };
      const label =
        [account.settings?.dashboard?.display_name, account.business_profile?.name, account.email, account.id].find(
          (v): v is string => typeof v === 'string' && v !== '',
        ) ?? null;
      return { ok: true, test: isStripeTestKey(key), account: label, webhook: (config.webhookSecret ?? '') !== '' };
    },

    async createCheckout(order: CheckoutOrder) {
      const res = await call(
        'POST',
        '/v1/checkout/sessions',
        formEncode(sessionParams(order)),
        // Mismo pedido y mismo monto = misma sesión (si el cliente toca dos veces).
        `viva-${order.id}-${order.amountCents}`,
      );
      const session = (await res.json().catch(() => null)) as StripeSession | null;
      if (!res.ok || typeof session?.url !== 'string' || typeof session.id !== 'string') {
        throw new ProviderError('pago_rechazado');
      }
      return { checkoutId: session.id, url: session.url };
    },

    paymentForCheckout: retrieveSession,
    retrieveSession,

    async retrieveCharge(id: string): Promise<unknown> {
      if (!/^(ch|py)_[A-Za-z0-9_]+$/.test(id)) return null;
      const res = await call('GET', `/v1/charges/${id}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new ProviderError(`stripe_${res.status}`);
      return res.json().catch(() => null);
    },
  };
}
