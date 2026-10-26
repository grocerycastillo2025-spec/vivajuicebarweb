/**
 * La lógica de dinero del cobro en línea, sin red ni base.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { centsToDecimal, decidePayment, decimalToCents, summarizeItems, type ProviderPayment } from '../cobro.ts';
import {
  approveUrl,
  captureIdFromEvent,
  orderBody,
  paymentFromCapture,
  paymentFromOrder,
} from '../paypal.ts';
import {
  formEncode,
  isStripeTestKey,
  paymentFromCharge,
  paymentFromSession,
  sessionParams,
  signStripePayload,
  verifyStripeSignature,
} from '../stripe.ts';

const ORDER_ID = '0b9f2c1e-1111-4a5b-9c3d-123456789abc';
const ORDER = { id: ORDER_ID, payWith: 'stripe', currency: 'USD', amountCents: 1275 };
const CHECKOUT = {
  id: ORDER_ID,
  orderNumber: 42,
  amountCents: 1275,
  currency: 'USD',
  storeName: 'Freehold',
  itemsSummary: '1× Green Juice, 1× Latte',
  payerEmail: 'cliente@example.com',
  returnUrl: `https://x.test/order/${ORDER_ID}?pago=ok`,
  cancelUrl: `https://x.test/order/${ORDER_ID}?pago=cancelado`,
};

function pago(over: Partial<ProviderPayment> = {}): ProviderPayment {
  return { id: 'pi_1', orderRef: ORDER_ID, status: 'paid', rawStatus: 'paid', amountCents: 1275, currency: 'USD', ...over };
}

describe('montos', () => {
  it('centavos <-> texto con 2 decimales, sin coma flotante', () => {
    assert.equal(centsToDecimal(1275), '12.75');
    assert.equal(centsToDecimal(850), '8.50');
    assert.equal(centsToDecimal(5), '0.05');
    assert.equal(centsToDecimal(0), '0.00');
    assert.equal(decimalToCents('12.75'), 1275);
    assert.equal(decimalToCents('8.5'), 850);
    assert.equal(decimalToCents('8'), 800);
    assert.equal(decimalToCents(0.29), 29); // 0.29 * 100 = 28.999…
    assert.equal(decimalToCents('12.755'), null);
    assert.equal(decimalToCents('-1.00'), null);
    assert.equal(decimalToCents('abc'), null);
    assert.equal(decimalToCents(undefined), null);
  });

  it('resumen del pedido', () => {
    assert.equal(summarizeItems([{ name: 'Green Juice', quantity: 2 }, { name: 'Latte', quantity: 1 }]), '2× Green Juice, 1× Latte');
  });
});

describe('qué hacer con un pago consultado al proveedor', () => {
  it('pagado, del pedido, en dólares y completo: se marca pagado', () => {
    assert.deepEqual(decidePayment('stripe', pago(), ORDER), { kind: 'mark_paid' });
    // Pagar de más (propina, redondeo) también cubre.
    assert.deepEqual(decidePayment('stripe', pago({ amountCents: 1300 }), ORDER), { kind: 'mark_paid' });
  });

  it('cualquier cosa que no cuadre se rechaza', () => {
    assert.equal(decidePayment('stripe', pago({ amountCents: 1274 }), ORDER).kind, 'reject');
    assert.equal(decidePayment('stripe', pago({ currency: 'MXN' }), ORDER).kind, 'reject');
    assert.equal(decidePayment('stripe', pago({ orderRef: 'otro' }), ORDER).kind, 'reject');
    assert.equal(decidePayment('stripe', pago({ orderRef: null }), ORDER).kind, 'reject');
    assert.equal(decidePayment('stripe', pago(), null).kind, 'reject');
    // Un pago de Stripe no paga un pedido de PayPal o Zelle.
    assert.equal(decidePayment('stripe', pago(), { ...ORDER, payWith: 'zelle' }).kind, 'reject');
    assert.equal(decidePayment('paypal', pago(), ORDER).kind, 'reject');
  });

  it('la moneda se compara sin importar mayúsculas', () => {
    assert.equal(decidePayment('stripe', pago({ currency: 'usd' }), ORDER).kind, 'mark_paid');
  });

  it('devolución total lo desmarca; parcial o pendiente solo se anota', () => {
    assert.equal(decidePayment('stripe', pago({ status: 'refunded', rawStatus: 'refunded' }), ORDER).kind, 'mark_unpaid');
    assert.equal(decidePayment('stripe', pago({ status: 'partially_refunded' }), ORDER).kind, 'record_only');
    assert.equal(decidePayment('stripe', pago({ status: 'pending' }), ORDER).kind, 'record_only');
    assert.equal(decidePayment('stripe', pago({ status: 'failed' }), ORDER).kind, 'record_only');
  });
});

describe('Stripe', () => {
  it('la sesión lleva una sola línea con el total exacto de la base', () => {
    const params = sessionParams(CHECKOUT);
    assert.equal(params['client_reference_id'], ORDER_ID);
    const body = formEncode(params);
    assert.match(body, /line_items%5B0%5D%5Bprice_data%5D%5Bunit_amount%5D=1275/);
    assert.match(body, /line_items%5B0%5D%5Bprice_data%5D%5Bcurrency%5D=usd/);
    assert.match(body, /line_items%5B0%5D%5Bquantity%5D=1/);
    assert.match(body, /success_url=https%3A%2F%2Fx\.test%2Forder%2F/);
    assert.doesNotMatch(body, /line_items%5B1%5D/);
  });

  it('lee la sesión: pagada, abierta o expirada', () => {
    const paid = paymentFromSession({
      id: 'cs_1', payment_status: 'paid', status: 'complete', amount_total: 1275, currency: 'usd',
      client_reference_id: ORDER_ID, payment_intent: 'pi_9',
    });
    assert.deepEqual(paid, { id: 'pi_9', orderRef: ORDER_ID, status: 'paid', rawStatus: 'paid', amountCents: 1275, currency: 'USD' });
    assert.equal(paymentFromSession({ id: 'cs_1', payment_status: 'unpaid', status: 'open' })?.status, 'pending');
    assert.equal(paymentFromSession({ id: 'cs_1', payment_status: 'unpaid', status: 'expired' })?.status, 'failed');
    assert.equal(paymentFromSession({ nada: true }), null);
  });

  it('cargo devuelto completo o en parte', () => {
    const full = paymentFromCharge({ payment_intent: 'pi_9', amount: 1275, amount_refunded: 1275, refunded: true, currency: 'usd' }, ORDER_ID);
    assert.equal(full?.status, 'refunded');
    const partial = paymentFromCharge({ payment_intent: 'pi_9', amount: 1275, amount_refunded: 500, refunded: false, currency: 'usd' }, ORDER_ID);
    assert.equal(partial?.status, 'partially_refunded');
  });

  it('firma del webhook: buena, alterada, vieja o sin secreto', async () => {
    const secret = 'whsec_prueba';
    const body = '{"type":"checkout.session.completed"}';
    const now = 1_800_000_000;
    const header = await signStripePayload(body, secret, now);
    assert.equal(await verifyStripeSignature(body, header, secret, now), true);
    assert.equal(await verifyStripeSignature(body + ' ', header, secret, now), false);
    assert.equal(await verifyStripeSignature(body, header, 'otro', now), false);
    assert.equal(await verifyStripeSignature(body, header, secret, now + 301), false);
    assert.equal(await verifyStripeSignature(body, null, secret, now), false);
    assert.equal(await verifyStripeSignature(body, 't=abc,v1=00', secret, now), false);
  });

  it('llaves de prueba', () => {
    assert.equal(isStripeTestKey('sk_test_123'), true);
    assert.equal(isStripeTestKey('rk_test_123'), true);
    assert.equal(isStripeTestKey('sk_live_123'), false);
  });
});

describe('PayPal', () => {
  it('la orden lleva el total como texto y el pedido en custom_id', () => {
    const body = orderBody(CHECKOUT) as { purchase_units: { amount: { value: string; currency_code: string }; custom_id: string }[] };
    assert.equal(body.purchase_units.length, 1);
    assert.deepEqual(body.purchase_units[0]?.amount, { currency_code: 'USD', value: '12.75' });
    assert.equal(body.purchase_units[0]?.custom_id, ORDER_ID);
  });

  it('liga para aprobar', () => {
    assert.equal(approveUrl({ links: [{ rel: 'self', href: 'https://a' }, { rel: 'payer-action', href: 'https://paypal/x' }] }), 'https://paypal/x');
    assert.equal(approveUrl({ links: [{ rel: 'approve', href: 'https://paypal/y' }] }), 'https://paypal/y');
    assert.equal(approveUrl({ links: [{ rel: 'approve', href: 'javascript:alert(1)' }] }), null);
    assert.equal(approveUrl(null), null);
  });

  it('captura y orden', () => {
    const capture = { id: 'CAP1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '12.75' }, custom_id: ORDER_ID };
    assert.deepEqual(paymentFromCapture(capture), {
      id: 'CAP1', orderRef: ORDER_ID, status: 'paid', rawStatus: 'completed', amountCents: 1275, currency: 'USD',
    });
    assert.equal(paymentFromCapture({ ...capture, status: 'REFUNDED' })?.status, 'refunded');
    const order = { id: 'ORD1', status: 'COMPLETED', purchase_units: [{ custom_id: ORDER_ID, payments: { captures: [capture] } }] };
    assert.equal(paymentFromOrder(order)?.id, 'CAP1');
    const approved = paymentFromOrder({ id: 'ORD1', status: 'APPROVED', purchase_units: [{ custom_id: ORDER_ID }] });
    assert.equal(approved?.status, 'pending');
    assert.equal(approved?.rawStatus, 'approved');
  });

  it('id de la captura en los avisos', () => {
    assert.equal(captureIdFromEvent({ event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'CAP1' } }), 'CAP1');
    assert.equal(
      captureIdFromEvent({
        event_type: 'PAYMENT.CAPTURE.REFUNDED',
        resource: { id: 'REF1', links: [{ rel: 'up', href: 'https://api-m.paypal.com/v2/payments/captures/CAP1' }] },
      }),
      'CAP1',
    );
    assert.equal(captureIdFromEvent({ event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: 'ORD1' } }), null);
    assert.equal(captureIdFromEvent({ event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: '../x' } }), null);
  });
});
