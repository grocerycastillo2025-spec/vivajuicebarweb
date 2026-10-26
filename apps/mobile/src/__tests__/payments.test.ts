import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MockPaymentService } from '../payments/mock-payment-service.ts';
import { PaymentError, type PaymentService } from '../payments/payment-service.ts';

function pay(key: string, amount = 2400) {
  return {
    orderId: 'order-1',
    sessionId: 'sess-1',
    sourceToken: 'tok_test',
    amountCents: amount,
    tipCents: 0,
    idempotencyKey: key,
  };
}

describe('MockPaymentService cumple el contrato', () => {
  it('implementa la interfaz completa, getPayment incluido', () => {
    const service: PaymentService = new MockPaymentService();
    assert.equal(typeof service.createSession, 'function');
    assert.equal(typeof service.payOrder, 'function');
    // Sin getPayment no hay reconciliacion posible (§9).
    assert.equal(typeof service.getPayment, 'function');
    assert.equal(typeof service.refund, 'function');
  });
});

describe('idempotencia del cobro', () => {
  it('la misma clave no cobra dos veces', async () => {
    const service = new MockPaymentService();
    const first = await service.payOrder(pay('co_abc'));
    const second = await service.payOrder(pay('co_abc'));

    assert.equal(first.providerPaymentId, second.providerPaymentId);
    // Esta es la defensa contra R10: dinero cobrado dos veces.
    assert.equal(service.countPayments(), 1);
    assert.equal(service.totalChargedCents(), 2400);
  });

  it('claves distintas si crean pagos distintos', async () => {
    const service = new MockPaymentService();
    await service.payOrder(pay('co_uno'));
    await service.payOrder(pay('co_dos'));
    assert.equal(service.countPayments(), 2);
  });

  it('un rechazo se devuelve como resultado, no como excepcion', async () => {
    // Una tarjeta rechazada es un resultado del negocio. Si la primera
    // llamada lanzase y el reintento devolviese un objeto, la misma
    // operacion tendria dos formas y seria facil leer un rechazo como
    // un cobro bueno.
    const service = new MockPaymentService({ failWith: 'card_declined' });
    const first = await service.payOrder(pay('co_rechazo'));
    assert.equal(first.status, 'failed');
    assert.equal(first.failureCode, 'card_declined');
  });

  it('un reintento con la misma clave no convierte un rechazo en cobro', async () => {
    const service = new MockPaymentService({ failWith: 'card_declined' });
    const first = await service.payOrder(pay('co_rechazo'));
    const second = await service.payOrder(pay('co_rechazo'));

    assert.equal(second.status, 'failed');
    assert.equal(second.providerPaymentId, first.providerPaymentId);
    assert.equal(service.totalChargedCents(), 0);
  });

  it('un importe distinto con la misma clave NO cobra de mas', async () => {
    const service = new MockPaymentService();
    await service.payOrder(pay('co_mismo', 2400));
    const second = await service.payOrder(pay('co_mismo', 999999));
    assert.equal(second.amountCents, 2400);
    assert.equal(service.totalChargedCents(), 2400);
  });
});

describe('sesiones', () => {
  it('la misma clave reutiliza la sesion', async () => {
    const service = new MockPaymentService();
    const input = {
      orderId: 'order-1',
      storeId: 'store-1',
      amountCents: 2400,
      currency: 'USD',
      idempotencyKey: 'co_sesion',
    };
    const a = await service.createSession(input);
    const b = await service.createSession(input);
    assert.equal(a.sessionId, b.sessionId);
  });

  it('la sesion caduca, como el hosted checkout de Clover', async () => {
    const now = new Date('2026-09-02T14:00:00Z');
    const service = new MockPaymentService({ now: () => now });
    const session = await service.createSession({
      orderId: 'o',
      storeId: 's',
      amountCents: 100,
      currency: 'USD',
      idempotencyKey: 'co_ttl',
    });
    assert.equal(session.expiresAt, '2026-09-02T14:15:00.000Z');
  });
});

describe('getPayment', () => {
  it('devuelve el pago por su referencia del proveedor', async () => {
    const service = new MockPaymentService();
    const created = await service.payOrder(pay('co_get'));
    const found = await service.getPayment({
      provider: 'mock',
      providerPaymentId: created.providerPaymentId,
    });
    assert.equal(found.status, 'succeeded');
    assert.equal(found.amountCents, 2400);
  });

  it('un pago inexistente da error, no silencio', async () => {
    const service = new MockPaymentService();
    await assert.rejects(
      () => service.getPayment({ provider: 'mock', providerPaymentId: 'pay_nope' }),
      PaymentError,
    );
  });
});

describe('reembolsos', () => {
  it('reembolsa un pago exitoso', async () => {
    const service = new MockPaymentService();
    const payment = await service.payOrder(pay('co_ref'));
    const refund = await service.refund({
      paymentRef: { provider: 'mock', providerPaymentId: payment.providerPaymentId },
      amountCents: 2400,
      reason: 'cliente',
      idempotencyKey: 'co_ref_1',
    });
    assert.equal(refund.status, 'succeeded');
  });

  it('no reembolsa dos veces con la misma clave', async () => {
    const service = new MockPaymentService();
    const payment = await service.payOrder(pay('co_ref2'));
    const input = {
      paymentRef: { provider: 'mock', providerPaymentId: payment.providerPaymentId },
      amountCents: 2400,
      reason: 'cliente',
      idempotencyKey: 'co_ref2_1',
    };
    const a = await service.refund(input);
    const b = await service.refund(input);
    assert.equal(a.providerRefundId, b.providerRefundId);
  });

  it('no reembolsa mas de lo cobrado', async () => {
    const service = new MockPaymentService();
    const payment = await service.payOrder(pay('co_ref3'));
    await assert.rejects(
      () =>
        service.refund({
          paymentRef: { provider: 'mock', providerPaymentId: payment.providerPaymentId },
          amountCents: 999999,
          reason: 'error',
          idempotencyKey: 'co_ref3_1',
        }),
      PaymentError,
    );
  });
});
