/**
 * El camino del cobro, incluido el que sale mal.
 *
 * `FakeLedger` imita a `record_simulated_payment` (0009_payments.sql):
 * idempotencia por clave de intento, importe comparado con el subtotal y
 * el pedido moviendose solo desde payment_pending / payment_failed. Los
 * mismos casos se corrieron ademas contra Postgres 16 de verdad.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isPayable, makePaymentAttemptKey, type OrderStatus } from '../domain/order.ts';
import {
  PermanentRecordError,
  resumeUnrecordedAttempt,
  runPaymentAttempt,
  type PaymentRecorder,
  type RecordedPayment,
  type RecordPaymentInput,
} from '../payments/checkout-flow.ts';
import { MockPaymentService } from '../payments/mock-payment-service.ts';
import { declineCodeForToken, TEST_TOKENS } from '../payments/payment-service.ts';
import { strings } from '../strings.ts';

const ORDER_KEY = 'co_abc123_0123456789abcdef0123456789abcdef';
const SUBTOTAL = 2400;

class FakeLedger implements PaymentRecorder {
  status: OrderStatus = 'payment_pending';
  readonly recorded: RecordPaymentInput[] = [];
  private readonly byKey = new Map<string, RecordedPayment>();
  /** Cuantas escrituras seguidas se pierden por red. */
  failNextWrites = 0;

  async record(input: RecordPaymentInput): Promise<RecordedPayment> {
    if (this.failNextWrites > 0) {
      this.failNextWrites -= 1;
      throw new Error('network down');
    }

    const previous = this.byKey.get(input.attemptKey);
    if (previous !== undefined) {
      return { ...previous, orderStatus: this.status, replayed: true };
    }

    if (!isPayable(this.status)) {
      throw new PermanentRecordError('order_not_payable', `order_not_payable:${this.status}`);
    }
    if (input.amountCents !== SUBTOTAL) {
      throw new PermanentRecordError(
        'amount_mismatch',
        `amount_mismatch:${input.amountCents} vs ${SUBTOTAL}`,
      );
    }

    this.status = input.status === 'succeeded' ? 'confirmed' : 'payment_failed';
    const result: RecordedPayment = {
      paymentId: `pmt_${this.recorded.length + 1}`,
      status: input.status,
      orderStatus: this.status,
      replayed: false,
    };
    this.recorded.push(input);
    this.byKey.set(input.attemptKey, result);
    return result;
  }
}

function attempt(n: number, token: string = TEST_TOKENS.approve) {
  return {
    orderId: 'order-1',
    storeId: 'store-1',
    orderKey: ORDER_KEY,
    attempt: n,
    amountCents: SUBTOTAL,
    currency: 'USD',
    sourceToken: token,
  };
}

describe('cobro de punta a punta', () => {
  it('cobra una vez y deja el pedido confirmado', async () => {
    const payments = new MockPaymentService();
    const recorder = new FakeLedger();

    const outcome = await runPaymentAttempt({ payments, recorder }, attempt(1));

    assert.equal(outcome.kind, 'paid');
    assert.equal(recorder.status, 'confirmed');
    assert.equal(payments.countPayments(), 1);
    assert.equal(payments.totalChargedCents(), SUBTOTAL);
  });

  it('un rechazo deja el pedido en payment_failed, nunca en confirmed', async () => {
    const payments = new MockPaymentService();
    const recorder = new FakeLedger();

    const outcome = await runPaymentAttempt(
      { payments, recorder },
      attempt(1, TEST_TOKENS.declineCard),
    );

    assert.equal(outcome.kind, 'declined');
    assert.equal(recorder.status, 'payment_failed');
    // Un rechazo no mueve dinero.
    assert.equal(payments.totalChargedCents(), 0);
  });

  it('tras un rechazo, el intento siguiente puede pagar', async () => {
    const payments = new MockPaymentService();
    const recorder = new FakeLedger();

    await runPaymentAttempt({ payments, recorder }, attempt(1, TEST_TOKENS.declineCard));
    const second = await runPaymentAttempt({ payments, recorder }, attempt(2));

    assert.equal(second.kind, 'paid');
    assert.equal(recorder.status, 'confirmed');
    // Un solo cobro bueno, aunque haya dos intentos.
    assert.equal(payments.totalChargedCents(), SUBTOTAL);
    assert.equal(recorder.recorded.length, 2);
  });

  it('reintentar el MISMO intento no cobra dos veces', async () => {
    const payments = new MockPaymentService();
    const recorder = new FakeLedger();

    await runPaymentAttempt({ payments, recorder }, attempt(1));
    // El cliente vuelve a la pantalla y pulsa otra vez sin que se haya
    // recontado el intento: misma clave, mismo resultado.
    const again = await runPaymentAttempt({ payments, recorder }, attempt(1));

    assert.equal(again.kind, 'paid');
    assert.equal(payments.countPayments(), 1);
    assert.equal(payments.totalChargedCents(), SUBTOTAL);
    assert.equal(recorder.recorded.length, 1);
  });

  it('claves distintas por intento: el rechazo no se queda cacheado', () => {
    assert.notEqual(makePaymentAttemptKey(ORDER_KEY, 1), makePaymentAttemptKey(ORDER_KEY, 2));
    assert.ok(makePaymentAttemptKey(ORDER_KEY, 1).startsWith(ORDER_KEY));
  });
});

describe('el hueco entre cobrar y guardar (R10)', () => {
  it('un cobro que no se pudo guardar se devuelve como unrecorded, no como fallo', async () => {
    const payments = new MockPaymentService();
    const recorder = new FakeLedger();
    recorder.failNextWrites = 1;

    const outcome = await runPaymentAttempt({ payments, recorder }, attempt(1));

    assert.equal(outcome.kind, 'unrecorded');
    // El dinero se movio: eso es un hecho, aunque no lo hayamos escrito.
    assert.equal(payments.totalChargedCents(), SUBTOTAL);
    // Y el pedido NO se da por confirmado.
    assert.equal(recorder.status, 'payment_pending');
  });

  it('se cierra preguntando al proveedor, sin volver a cobrar', async () => {
    const payments = new MockPaymentService();
    const recorder = new FakeLedger();
    recorder.failNextWrites = 1;

    const first = await runPaymentAttempt({ payments, recorder }, attempt(1));
    assert.equal(first.kind, 'unrecorded');
    if (first.kind !== 'unrecorded') return;

    const closed = await resumeUnrecordedAttempt(
      { payments, recorder },
      {
        orderId: 'order-1',
        attemptKey: first.attemptKey,
        providerPaymentId: first.providerPaymentId,
      },
    );

    assert.equal(closed.kind, 'paid');
    assert.equal(recorder.status, 'confirmed');
    // Esta es la garantia: un solo cobro, un solo apunte.
    assert.equal(payments.countPayments(), 1);
    assert.equal(payments.totalChargedCents(), SUBTOTAL);
    assert.equal(recorder.recorded.length, 1);
  });

  it('cerrar el hueco dos veces sigue sin cobrar de mas', async () => {
    const payments = new MockPaymentService();
    const recorder = new FakeLedger();
    recorder.failNextWrites = 1;

    const first = await runPaymentAttempt({ payments, recorder }, attempt(1));
    if (first.kind !== 'unrecorded') throw new Error('se esperaba unrecorded');

    const pending = {
      orderId: 'order-1',
      attemptKey: first.attemptKey,
      providerPaymentId: first.providerPaymentId,
    };
    await resumeUnrecordedAttempt({ payments, recorder }, pending);
    const twice = await resumeUnrecordedAttempt({ payments, recorder }, pending);

    assert.equal(twice.kind, 'paid');
    assert.equal(payments.totalChargedCents(), SUBTOTAL);
    assert.equal(recorder.recorded.length, 1);
  });

  it('si el rechazo no se pudo guardar, el error sube: no hay dinero que reconciliar', async () => {
    const payments = new MockPaymentService();
    const recorder = new FakeLedger();
    recorder.failNextWrites = 1;

    await assert.rejects(
      () => runPaymentAttempt({ payments, recorder }, attempt(1, TEST_TOKENS.declineFunds)),
      /network down/,
    );
    assert.equal(payments.totalChargedCents(), 0);
  });
});

describe('lo que la base no se cree del telefono', () => {
  it('un importe que no es el subtotal se rechaza, y el cobro queda huerfano', async () => {
    const payments = new MockPaymentService();
    const recorder = new FakeLedger();

    const outcome = await runPaymentAttempt(
      { payments, recorder },
      { ...attempt(1), amountCents: 1 },
    );

    // El pedido NO se mueve: la base no acepto ese importe.
    assert.equal(recorder.status, 'payment_pending');
    assert.equal(outcome.kind, 'orphaned');
    if (outcome.kind !== 'orphaned') return;
    assert.equal(outcome.code, 'amount_mismatch');
    // Y sin embargo el proveedor ya habia cobrado: eso es justo lo que
    // hay que ensenar, en vez de fingir que no paso nada.
    assert.equal(payments.totalChargedCents(), 1);
  });

  it('un pedido ya confirmado no se vuelve a pagar', async () => {
    const payments = new MockPaymentService();
    const recorder = new FakeLedger();

    await runPaymentAttempt({ payments, recorder }, attempt(1));
    const second = await runPaymentAttempt({ payments, recorder }, attempt(2));

    assert.equal(second.kind, 'orphaned');
    if (second.kind !== 'orphaned') return;
    assert.equal(second.code, 'order_not_payable');
    assert.equal(recorder.status, 'confirmed');
    // Un solo apunte en nuestra base, aunque el proveedor tenga dos.
    assert.equal(recorder.recorded.length, 1);
  });

  it('un rechazo permanente no se confunde con una escritura perdida', async () => {
    const payments = new MockPaymentService();
    const recorder = new FakeLedger();
    recorder.failNextWrites = 1;

    // Mismo sintoma —el registro falla— y dos salidas distintas, porque
    // una se puede reintentar y la otra no.
    const transient = await runPaymentAttempt({ payments, recorder }, attempt(1));
    assert.equal(transient.kind, 'unrecorded');

    const permanent = await runPaymentAttempt(
      { payments, recorder },
      { ...attempt(2), amountCents: 7 },
    );
    assert.equal(permanent.kind, 'orphaned');
  });
});

describe('copia de los rechazos', () => {
  it('cada token de prueba que rechaza tiene texto propio', () => {
    const codes = [TEST_TOKENS.declineCard, TEST_TOKENS.declineFunds]
      .map((token) => declineCodeForToken(token))
      .filter((code): code is string => code !== null);

    assert.equal(codes.length, 2);
    for (const code of codes) {
      const copy = (strings.payment.declined as Record<string, string | undefined>)[code];
      assert.ok(copy !== undefined && copy.length > 0, `sin texto para ${code}`);
    }
  });

  it('el token que aprueba no produce ningun rechazo', () => {
    assert.equal(declineCodeForToken(TEST_TOKENS.approve), null);
  });
});
