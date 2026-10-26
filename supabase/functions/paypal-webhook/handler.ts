/**
 * Edge Function `paypal-webhook`: PayPal avisa de una orden aprobada, un
 * cobro o una devolución.
 *
 * NO SE CREE EL AVISO. Del aviso solo se toma el id; el estado, el monto y
 * a qué pedido pertenece se le preguntan a la API de PayPal con nuestras
 * llaves. Quien mande un aviso falso solo consigue que consultemos algo
 * que no existe o no es de esta cuenta.
 *
 * Eventos que importan (configurarlos en la app REST de PayPal):
 *   CHECKOUT.ORDER.APPROVED   el cliente aprobó y cerró la ventana sin
 *                             volver: se cobra aquí.
 *   PAYMENT.CAPTURE.COMPLETED, PAYMENT.CAPTURE.DENIED,
 *   PAYMENT.CAPTURE.REFUNDED, PAYMENT.CAPTURE.REVERSED
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
import { approvedOrderIdFromEvent, captureIdFromEvent, paypalAdapter } from '../_shared/paypal.ts';

export interface PayPalWebhookDeps {
  readonly sql: Sql;
  readonly fetch: typeof fetch;
  readonly clientId: string | null;
  readonly clientSecret: string | null;
  readonly env: string | null;
  readonly liveApi?: string;
  readonly sandboxApi?: string;
  readonly log?: (event: string, data?: Record<string, unknown>) => void;
}

export function createPayPalWebhookHandler(deps: PayPalWebhookDeps): (req: Request) => Promise<Response> {
  const log = deps.log ?? (() => undefined);
  const paypal = paypalAdapter({
    clientId: deps.clientId,
    clientSecret: deps.clientSecret,
    env: deps.env,
    fetch: deps.fetch,
    liveApi: deps.liveApi,
    sandboxApi: deps.sandboxApi,
  });

  return async (req) => {
    if (req.method !== 'POST') return text(405, 'solo POST');
    if (!paypal.configured()) {
      log('sin_llaves');
      return text(500, 'faltan llaves');
    }
    const event = (await req.json().catch(() => null)) as { event_type?: unknown } | null;
    const type = typeof event?.event_type === 'string' ? event.event_type : '';

    let payment: ProviderPayment | null;
    try {
      const approved = approvedOrderIdFromEvent(event);
      const capture = captureIdFromEvent(event);
      if (approved !== null) {
        // Solo si la orden es de un pedido nuestro (la creó paypal-pago).
        const rows = await deps.sql(
          `select id from public.orders where online_checkout_id = $1 and pay_with = 'paypal'`,
          [approved],
        );
        if (rows.length === 0) return text(200, 'orden desconocida');
        payment = await paypal.captureOrder(approved);
      } else if (capture !== null) {
        payment = await paypal.retrieveCapture(capture);
      } else {
        return text(200, 'ignorado');
      }
    } catch (cause) {
      if (cause instanceof ProviderError) return text(500, cause.message);
      throw cause;
    }
    if (payment === null || payment.orderRef === null) return text(200, 'sin pedido');

    const decision = decidePayment('paypal', payment, await orderToCheck(deps.sql, payment.orderRef));
    log('decision', { evento: type, pago: payment.id, estado: payment.rawStatus, pedido: payment.orderRef, decision: decision.kind });
    await applyDecision(deps.sql, payment, decision);
    return text(200, decision.kind === 'reject' ? decision.reason : decision.kind);
  };
}
