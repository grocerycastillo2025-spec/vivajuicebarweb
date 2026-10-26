/**
 * PayPal Checkout (Orders v2) para VIVA Juice and Coffee.
 *
 *   paypal-pago     crea la orden de PayPal con el total del pedido (de la
 *                   base) y devuelve la liga para aprobarla. Al volver el
 *                   cliente (?pago=ok), la cobra (capture) y la verifica.
 *   paypal-webhook  PayPal avisa (orden aprobada, cobro hecho, devolución).
 *                   No se cree el aviso: se consulta a la API con nuestras
 *                   llaves y se decide con lo que diga PayPal.
 *
 * Secretos (Supabase → Edge Functions → Secrets):
 *   PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET   de la app REST de PayPal
 *   PAYPAL_ENV (opcional)                    "live" o "sandbox"; sin él se
 *                                            prueba live y luego sandbox.
 */

import {
  centsToDecimal,
  decimalToCents,
  ProviderError,
  type CheckoutOrder,
  type CheckStatus,
  type ProviderAdapter,
  type ProviderPayment,
} from './cobro.ts';

export const PAYPAL_LIVE = 'https://api-m.paypal.com';
export const PAYPAL_SANDBOX = 'https://api-m.sandbox.paypal.com';

/** Cuerpo de POST /v2/checkout/orders para un pedido. */
export function orderBody(order: CheckoutOrder): Record<string, unknown> {
  return {
    intent: 'CAPTURE',
    purchase_units: [
      {
        reference_id: order.id,
        custom_id: order.id,
        description: `Order #${order.orderNumber} · ${order.storeName}`.slice(0, 127),
        amount: { currency_code: order.currency.toUpperCase(), value: centsToDecimal(order.amountCents) },
      },
    ],
    payment_source: {
      paypal: {
        experience_context: {
          brand_name: order.storeName.slice(0, 127) || 'VIVA Juice and Coffee',
          shipping_preference: 'NO_SHIPPING',
          user_action: 'PAY_NOW',
          return_url: order.returnUrl,
          cancel_url: order.cancelUrl,
        },
      },
    },
  };
}

/** La liga para que el cliente apruebe la orden. */
export function approveUrl(json: unknown): string | null {
  const links = (json as { links?: unknown } | null)?.links;
  if (!Array.isArray(links)) return null;
  for (const rel of ['payer-action', 'approve']) {
    const link = links.find((l) => (l as { rel?: unknown }).rel === rel) as { href?: unknown } | undefined;
    // Solo https (http://localhost lo usa la prueba en navegador).
    if (typeof link?.href === 'string' && /^(https:\/\/|http:\/\/localhost[:/])/.test(link.href)) return link.href;
  }
  return null;
}

interface PayPalCapture {
  readonly id?: unknown;
  readonly status?: unknown;
  readonly amount?: { currency_code?: unknown; value?: unknown } | null;
  readonly custom_id?: unknown;
}

const CAPTURE_STATUS: Record<string, ProviderPayment['status']> = {
  COMPLETED: 'paid',
  REFUNDED: 'refunded',
  PARTIALLY_REFUNDED: 'partially_refunded',
  PENDING: 'pending',
  DECLINED: 'failed',
  FAILED: 'failed',
};

/** Una captura de PayPal (GET /v2/payments/captures/{id} o dentro de una orden). */
export function paymentFromCapture(json: unknown, fallbackRef: string | null = null): ProviderPayment | null {
  const c = json as PayPalCapture | null;
  if (c === null || typeof c !== 'object' || typeof c.id !== 'string' || typeof c.status !== 'string') return null;
  const cents = decimalToCents(c.amount?.value);
  return {
    id: c.id,
    orderRef: typeof c.custom_id === 'string' ? c.custom_id : fallbackRef,
    status: CAPTURE_STATUS[c.status] ?? 'pending',
    rawStatus: c.status.toLowerCase(),
    amountCents: cents ?? 0,
    currency: typeof c.amount?.currency_code === 'string' ? c.amount.currency_code.toUpperCase() : '',
  };
}

interface PayPalOrder {
  readonly id?: unknown;
  readonly status?: unknown;
  readonly purchase_units?: {
    custom_id?: unknown;
    reference_id?: unknown;
    payments?: { captures?: PayPalCapture[] } | null;
  }[];
}

/**
 * El pago de una orden de PayPal: la captura más reciente, o el estado de
 * la orden si todavía no se cobra (CREATED, APPROVED…).
 */
export function paymentFromOrder(json: unknown): ProviderPayment | null {
  const o = json as PayPalOrder | null;
  if (o === null || typeof o !== 'object' || typeof o.id !== 'string') return null;
  const unit = o.purchase_units?.[0];
  const ref = typeof unit?.custom_id === 'string' ? unit.custom_id : typeof unit?.reference_id === 'string' ? unit.reference_id : null;
  const captures = unit?.payments?.captures ?? [];
  const last = captures[captures.length - 1];
  if (last !== undefined) return paymentFromCapture(last, ref);
  const status = String(o.status ?? '');
  return {
    id: o.id,
    orderRef: ref,
    status: status === 'VOIDED' ? 'failed' : 'pending',
    rawStatus: status.toLowerCase(),
    amountCents: 0,
    currency: '',
  };
}

/** Id de la captura a la que se refiere un aviso de PayPal, o null. */
export function captureIdFromEvent(event: unknown): string | null {
  const e = event as { event_type?: unknown; resource?: { id?: unknown; links?: unknown } } | null;
  const type = typeof e?.event_type === 'string' ? e.event_type : '';
  if (!type.startsWith('PAYMENT.CAPTURE.')) return null;
  const resource = e?.resource;
  // En una devolución el recurso es el reembolso; la captura es el "up".
  if (type === 'PAYMENT.CAPTURE.REFUNDED' && Array.isArray(resource?.links)) {
    const up = resource.links.find((l) => (l as { rel?: unknown }).rel === 'up') as { href?: unknown } | undefined;
    const m = typeof up?.href === 'string' ? /\/v2\/payments\/captures\/([A-Z0-9]+)$/.exec(up.href) : null;
    if (m !== null && m[1] !== undefined) return m[1];
  }
  return typeof resource?.id === 'string' && /^[A-Z0-9]+$/.test(resource.id) ? resource.id : null;
}

/** Id de la orden aprobada (CHECKOUT.ORDER.APPROVED), para cobrarla. */
export function approvedOrderIdFromEvent(event: unknown): string | null {
  const e = event as { event_type?: unknown; resource?: { id?: unknown } } | null;
  if (e?.event_type !== 'CHECKOUT.ORDER.APPROVED') return null;
  const id = e.resource?.id;
  return typeof id === 'string' && /^[A-Z0-9]+$/.test(id) ? id : null;
}

// ---------------------------------------------------------------------
// El adaptador
// ---------------------------------------------------------------------

export interface PayPalConfig {
  readonly clientId: string | null;
  readonly clientSecret: string | null;
  /** "live" | "sandbox" | null (se detecta). */
  readonly env: string | null;
  readonly fetch: typeof fetch;
  /** Para pruebas. */
  readonly liveApi?: string | undefined;
  readonly sandboxApi?: string | undefined;
}

export function paypalAdapter(config: PayPalConfig): ProviderAdapter & {
  captureOrder(paypalOrderId: string): Promise<ProviderPayment | null>;
  retrieveCapture(captureId: string): Promise<ProviderPayment | null>;
} {
  const live = config.liveApi ?? PAYPAL_LIVE;
  const sandbox = config.sandboxApi ?? PAYPAL_SANDBOX;
  const id = config.clientId ?? '';
  const secret = config.clientSecret ?? '';
  let session: { api: string; token: string; until: number } | null = null;

  async function tokenFor(api: string): Promise<string | null> {
    let res: Response;
    try {
      res = await config.fetch(`${api}/v1/oauth2/token`, {
        method: 'POST',
        headers: {
          authorization: `Basic ${btoa(`${id}:${secret}`)}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
      });
    } catch {
      throw new ProviderError('proveedor_inalcanzable');
    }
    if (res.status === 401 || res.status === 403) return null;
    if (!res.ok) throw new ProviderError(`paypal_${res.status}`);
    const body = (await res.json().catch(() => ({}))) as { access_token?: unknown };
    return typeof body.access_token === 'string' ? body.access_token : null;
  }

  /** Token y entorno (live o sandbox). Las llaves solo valen en uno de los dos. */
  async function auth(): Promise<{ api: string; token: string } | null> {
    if (session !== null && session.until > Date.now()) return session;
    const order = config.env === 'live' ? [live] : config.env === 'sandbox' ? [sandbox] : [live, sandbox];
    for (const api of order) {
      const token = await tokenFor(api);
      if (token !== null) {
        session = { api, token, until: Date.now() + 8 * 60 * 1000 };
        return session;
      }
    }
    return null;
  }

  async function call(method: 'GET' | 'POST', path: string, body?: unknown, requestId?: string): Promise<Response> {
    const a = await auth();
    if (a === null) throw new ProviderError('llave_rechazada', 503);
    try {
      return await config.fetch(`${a.api}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${a.token}`,
          'content-type': 'application/json',
          prefer: 'return=representation',
          ...(requestId === undefined ? {} : { 'paypal-request-id': requestId }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new ProviderError('proveedor_inalcanzable');
    }
  }

  async function getOrder(paypalOrderId: string): Promise<unknown> {
    const res = await call('GET', `/v2/checkout/orders/${paypalOrderId}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new ProviderError(`paypal_${res.status}`);
    return res.json().catch(() => null);
  }

  /** Cobra una orden aprobada. Si ya estaba cobrada, devuelve su captura. */
  async function captureOrder(paypalOrderId: string): Promise<ProviderPayment | null> {
    if (!/^[A-Z0-9]+$/.test(paypalOrderId)) return null;
    const current = paymentFromOrder(await getOrder(paypalOrderId));
    if (current === null) return null;
    const status = current.rawStatus;
    // Solo se cobra lo que el cliente aprobó; lo demás se informa tal cual.
    if (status !== 'approved') return current;
    const res = await call('POST', `/v2/checkout/orders/${paypalOrderId}/capture`, {}, `capture-${paypalOrderId}`);
    if (res.ok) return paymentFromOrder(await res.json().catch(() => null));
    // 422: ya cobrada o rechazada. Se vuelve a leer la orden.
    if (res.status === 422) return paymentFromOrder(await getOrder(paypalOrderId));
    throw new ProviderError(`paypal_${res.status}`);
  }

  return {
    provider: 'paypal',
    configured: () => id !== '' && secret !== '',

    async check(): Promise<CheckStatus> {
      let a: { api: string; token: string } | null;
      try {
        session = null;
        a = await auth();
      } catch {
        return { ok: false, reason: 'proveedor_inalcanzable' };
      }
      if (a === null) return { ok: false, reason: 'llave_rechazada' };
      // Las llaves de sandbox solo funcionan en sandbox: eso las delata.
      return { ok: true, test: a.api === sandbox, account: `${id.slice(0, 6)}…` };
    },

    async createCheckout(order: CheckoutOrder) {
      const res = await call(
        'POST',
        '/v2/checkout/orders',
        orderBody(order),
        // Mismo pedido y mismo monto = misma orden de PayPal.
        `viva-${order.id}-${order.amountCents}`,
      );
      const json = await res.json().catch(() => null);
      const url = approveUrl(json);
      const checkoutId = (json as { id?: unknown } | null)?.id;
      if (!res.ok || url === null || typeof checkoutId !== 'string') throw new ProviderError('pago_rechazado');
      return { checkoutId, url };
    },

    paymentForCheckout: captureOrder,
    captureOrder,

    async retrieveCapture(captureId: string): Promise<ProviderPayment | null> {
      if (!/^[A-Z0-9]+$/.test(captureId)) return null;
      const res = await call('GET', `/v2/payments/captures/${captureId}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new ProviderError(`paypal_${res.status}`);
      return paymentFromCapture(await res.json().catch(() => null));
    },
  };
}
