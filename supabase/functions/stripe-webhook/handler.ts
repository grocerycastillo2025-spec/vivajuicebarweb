/**
 * Edge Function `stripe-webhook`: Stripe avisa de un pago o una devolución.
 *
 * Dos candados:
 *  1. La firma (Stripe-Signature) se verifica con STRIPE_WEBHOOK_SECRET.
 *  2. Aun con firma buena, la sesión o el cargo se le vuelven a pedir a la
 *     API con nuestra llave, y se decide con eso.
 *
 * Eventos que importan (configurarlos en el endpoint de Stripe):
 *   checkout.session.completed, checkout.session.async_payment_succeeded,
 *   checkout.session.async_payment_failed, charge.refunded
 *
 * Respuestas: 200 para lo resuelto (incluido "no es nuestro"), para que
 * Stripe no reintente; 400 firma mala; 500 si vale la pena reintentar.
 */

import {
  applyDecision,
  decidePayment,
  orderToCheck,
  ProviderError,
  text,
  type ProviderPayment,
  type Sql,
} from '../_shared/cobro.ts';
import { paymentFromCharge, stripeAdapter, verifyStripeSignature } from '../_shared/stripe.ts';

export interface StripeWebhookDeps {
  readonly sql: Sql;
  readonly fetch: typeof fetch;
  readonly secretKey: string | null;
  readonly webhookSecret: string | null;
  readonly api?: string;
  readonly now?: () => number;
  readonly log?: (event: string, data?: Record<string, unknown>) => void;
}

const SESSION_EVENTS = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
]);

export function createStripeWebhookHandler(deps: StripeWebhookDeps): (req: Request) => Promise<Response> {
  const log = deps.log ?? (() => undefined);
  const stripe = stripeAdapter({ secretKey: deps.secretKey, webhookSecret: deps.webhookSecret, fetch: deps.fetch, api: deps.api });

  return async (req) => {
    if (req.method !== 'POST') return text(405, 'solo POST');
    if ((deps.webhookSecret ?? '') === '' || (deps.secretKey ?? '') === '') {
      log('sin_llaves');
      return text(500, 'faltan llaves');
    }
    const raw = await req.text();
    const nowSeconds = Math.floor((deps.now?.() ?? Date.now()) / 1000);
    if (!(await verifyStripeSignature(raw, req.headers.get('stripe-signature'), deps.webhookSecret ?? '', nowSeconds))) {
      log('firma_invalida');
      return text(400, 'firma inválida');
    }

    let event: { type?: unknown; data?: { object?: { id?: unknown } } };
    try {
      event = JSON.parse(raw) as typeof event;
    } catch {
      return text(400, 'cuerpo ilegible');
    }
    const type = typeof event.type === 'string' ? event.type : '';
    const objectId = typeof event.data?.object?.id === 'string' ? event.data.object.id : '';

    let payment: ProviderPayment | null;
    try {
      if (SESSION_EVENTS.has(type)) {
        payment = await stripe.retrieveSession(objectId);
      } else if (type === 'charge.refunded') {
        const charge = await stripe.retrieveCharge(objectId);
        const intent = (charge as { payment_intent?: unknown } | null)?.payment_intent;
        if (typeof intent !== 'string') return text(200, 'cargo sin pago');
        const rows = await deps.sql(`select id from public.orders where online_payment_id = $1 and pay_with = 'stripe'`, [intent]);
        const orderId = rows[0] === undefined ? null : String(rows[0]['id']);
        payment = paymentFromCharge(charge, orderId);
      } else {
        return text(200, 'ignorado');
      }
    } catch (cause) {
      if (cause instanceof ProviderError) return text(500, cause.message);
      throw cause;
    }
    if (payment === null || payment.orderRef === null) return text(200, 'sin pedido');

    const decision = decidePayment('stripe', payment, await orderToCheck(deps.sql, payment.orderRef));
    log('decision', { evento: type, pago: payment.id, estado: payment.rawStatus, pedido: payment.orderRef, decision: decision.kind });
    await applyDecision(deps.sql, payment, decision);
    return text(200, decision.kind === 'reject' ? decision.reason : decision.kind);
  };
}
