import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  displayAmountCents,
  hasAuthoritativeTotal,
  isActiveOrder,
  isFinishedOrder,
  isValidIdempotencyKey,
  makeIdempotencyKey,
  progressStep,
  showsPickupCode,
  type OrderStatus,
} from '../domain/order.ts';
import { strings } from '../strings.ts';

const ALL: readonly OrderStatus[] = [
  'draft',
  'payment_pending',
  'payment_failed',
  'confirmed',
  'preparing',
  'ready',
  'completed',
  'canceled',
  'refunded',
];

describe('estados del pedido', () => {
  it('todo estado tiene etiqueta y explicacion', () => {
    for (const status of ALL) {
      assert.ok(strings.order.status[status].length > 0, `sin etiqueta: ${status}`);
      assert.ok(strings.order.statusHint[status].length > 0, `sin explicacion: ${status}`);
    }
  });

  it('nunca se promete "listo" antes de tiempo', () => {
    // Variable 1 del addendum: Clover no modela el fin de la preparacion.
    // Hasta `ready` (que hoy viene del reloj), la copia no puede afirmarlo.
    for (const status of ['payment_pending', 'confirmed', 'preparing'] as const) {
      const text =
        `${strings.order.status[status]} ${strings.order.statusHint[status]}`.toLowerCase();
      assert.ok(!text.includes('ready'), `"${status}" promete que esta listo`);
      assert.ok(!/\blisto\b|recoger(lo|la)\b/.test(text), `"${status}" promete que esta listo`);
    }
  });

  it('payment_pending no dice "confirmado"', () => {
    const text = strings.order.status.payment_pending.toLowerCase();
    assert.ok(!text.includes('confirmed'), 'un pedido sin pagar no puede leerse como confirmado');
    assert.ok(!/confirmad|recibido/.test(text), 'un pedido sin pagar no puede leerse como confirmado');
  });

  it('separa los activos de los terminados', () => {
    assert.equal(isActiveOrder('preparing'), true);
    assert.equal(isActiveOrder('payment_pending'), true);
    assert.equal(isActiveOrder('completed'), false);
    assert.equal(isFinishedOrder('completed'), true);
    assert.equal(isFinishedOrder('canceled'), true);
    assert.equal(isFinishedOrder('preparing'), false);
    // Un pago fallido no esta activo ni terminado: pide accion.
    assert.equal(isActiveOrder('payment_failed'), false);
    assert.equal(isFinishedOrder('payment_failed'), false);
  });

  it('el codigo de recogida no se ensena mientras el pago esta pendiente', () => {
    // Un codigo visible invita a ir al mostrador por un pedido que la
    // cocina todavia no tiene.
    assert.equal(showsPickupCode('payment_pending'), false);
    assert.equal(showsPickupCode('confirmed'), true);
    assert.equal(showsPickupCode('preparing'), true);
    assert.equal(showsPickupCode('canceled'), false);
  });

  it('el progreso ordena el camino feliz y saca al resto', () => {
    assert.ok(progressStep('payment_pending') < progressStep('confirmed'));
    assert.ok(progressStep('confirmed') < progressStep('preparing'));
    assert.ok(progressStep('preparing') < progressStep('ready'));
    assert.equal(progressStep('canceled'), -1);
    assert.equal(progressStep('payment_failed'), -1);
  });
});

describe('idempotencia', () => {
  it('genera una clave con la forma esperada', () => {
    const key = makeIdempotencyKey('a1b2c3d4e5f60718293a4b5c6d7e8f90', new Date(1000000));
    assert.equal(isValidIdempotencyKey(key), true);
    assert.ok(key.startsWith('co_'));
  });

  it('limpia lo que no sea hexadecimal y rellena', () => {
    const key = makeIdempotencyKey('a1b2-c3d4-XYZ');
    assert.equal(isValidIdempotencyKey(key), true);
    assert.equal(key.split('_')[2]?.length, 32);
  });

  it('aguanta una fuente de aleatoriedad vacia', () => {
    assert.equal(isValidIdempotencyKey(makeIdempotencyKey('')), true);
  });

  it('dos llamadas con distinta aleatoriedad dan claves distintas', () => {
    const now = new Date(1000000);
    assert.notEqual(makeIdempotencyKey('aaaa', now), makeIdempotencyKey('bbbb', now));
  });

  it('rechaza claves con forma incorrecta', () => {
    assert.equal(isValidIdempotencyKey('co_abc'), false);
    assert.equal(isValidIdempotencyKey(''), false);
    assert.equal(isValidIdempotencyKey('otra_cosa'), false);
  });
});

describe('totales', () => {
  const subtotalOnly = {
    subtotalCents: 2400,
    discountCents: 0,
    taxCents: 0,
    tipCents: 0,
    totalCents: 0,
  };

  it('sin total de Clover se ensena el subtotal', () => {
    // Inventar impuestos daria una cifra que no cuadraria con el ticket.
    assert.equal(hasAuthoritativeTotal(subtotalOnly), false);
    assert.equal(displayAmountCents(subtotalOnly), 2400);
  });

  it('con total de Clover se ensena el total', () => {
    const withTotal = { ...subtotalOnly, taxCents: 156, totalCents: 2556 };
    assert.equal(hasAuthoritativeTotal(withTotal), true);
    assert.equal(displayAmountCents(withTotal), 2556);
  });

  it('un total menor que el subtotal no se cree', () => {
    const bogus = { ...subtotalOnly, totalCents: 10 };
    assert.equal(hasAuthoritativeTotal(bogus), false);
    assert.equal(displayAmountCents(bogus), 2400);
  });
});
