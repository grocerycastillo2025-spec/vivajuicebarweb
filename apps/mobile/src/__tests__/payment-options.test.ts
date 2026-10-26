import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  blocksSaving,
  customerMethods,
  formatZelleRecipient,
  isOnlineProvider,
  needsPaymentConfirmation,
  normalizeZelleRecipient,
  paymentSetupProblems,
} from '../domain/payment-options.ts';

const ALL_ON = { cash: true, card_counter: true, zelle: true, stripe: true, paypal: true };
const NONE = new Set<'stripe' | 'paypal'>();
const BOTH = new Set<'stripe' | 'paypal'>(['stripe', 'paypal']);

describe('Zelle', () => {
  it('acepta correo o teléfono de EE. UU. y los deja como los guarda la base', () => {
    assert.equal(normalizeZelleRecipient(' Pagos@VivaJuice.com '), 'pagos@vivajuice.com');
    assert.equal(normalizeZelleRecipient('(732) 496-8863'), '+17324968863');
    assert.equal(normalizeZelleRecipient('1-732-496-8863'), '+17324968863');
    assert.equal(normalizeZelleRecipient('+1 732 496 8863'), '+17324968863');
    assert.equal(normalizeZelleRecipient('732.496.8863'), '+17324968863');
  });

  it('rechaza lo que no es correo ni teléfono de EE. UU.', () => {
    assert.equal(normalizeZelleRecipient(''), null);
    assert.equal(normalizeZelleRecipient('pagos@viva'), null);
    assert.equal(normalizeZelleRecipient('123-456-7890'), null); // código de área con 1
    assert.equal(normalizeZelleRecipient('+52 55 1234 5678'), null); // México
    assert.equal(normalizeZelleRecipient('732-496-886'), null);
  });

  it('enseña el teléfono como se dicta', () => {
    assert.equal(formatZelleRecipient('+17324968863'), '(732) 496-8863');
    assert.equal(formatZelleRecipient('pagos@vivajuice.com'), 'pagos@vivajuice.com');
  });
});

describe('qué ve el cliente', () => {
  it('Stripe y PayPal solo con la cuenta conectada; Zelle solo con datos', () => {
    assert.deepEqual(customerMethods({ payment_options: ALL_ON, connected: NONE }), ['cash', 'card_counter']);
    assert.deepEqual(
      customerMethods({ payment_options: ALL_ON, zelle_recipient: '+17324968863', connected: BOTH }),
      ['cash', 'card_counter', 'zelle', 'stripe', 'paypal'],
    );
    assert.deepEqual(
      customerMethods({ payment_options: { cash: true, paypal: true }, connected: new Set(['paypal'] as const) }),
      ['cash', 'paypal'],
    );
  });

  it('apagado es apagado aunque haya cuenta y datos', () => {
    assert.deepEqual(
      customerMethods({ payment_options: { cash: true }, zelle_recipient: 'a@b.co', connected: BOTH }),
      ['cash'],
    );
  });

  it('base sin configuración: lo de mostrador', () => {
    assert.deepEqual(customerMethods({}), ['cash', 'card_counter']);
    assert.deepEqual(customerMethods(null), ['cash', 'card_counter']);
  });

  it('pago por confirmar y pago en línea', () => {
    assert.equal(needsPaymentConfirmation('zelle'), true);
    assert.equal(needsPaymentConfirmation('stripe'), true);
    assert.equal(needsPaymentConfirmation('paypal'), true);
    assert.equal(needsPaymentConfirmation('cash'), false);
    assert.equal(needsPaymentConfirmation('card_counter'), false);
    assert.equal(needsPaymentConfirmation(null), false);
    assert.equal(isOnlineProvider('stripe'), true);
    assert.equal(isOnlineProvider('zelle'), false);
  });
});

describe('panel: antes de guardar', () => {
  it('Zelle prendido sin datos o con datos malos no se guarda', () => {
    assert.deepEqual(paymentSetupProblems({ options: { zelle: true }, zelle: '', connected: NONE }), ['zelle_without_data']);
    assert.deepEqual(paymentSetupProblems({ options: { cash: true }, zelle: 'hola', connected: NONE }), ['zelle_invalid']);
  });

  it('Stripe o PayPal sin conectar: aviso, pero se puede guardar', () => {
    const problems = paymentSetupProblems({ options: { cash: true, stripe: true, paypal: true }, zelle: '', connected: NONE });
    assert.deepEqual(problems, ['stripe_not_connected', 'paypal_not_connected']);
    assert.equal(problems.some(blocksSaving), false);
  });

  it('todo apagado no se guarda', () => {
    const problems = paymentSetupProblems({ options: { cash: false }, zelle: '', connected: BOTH });
    assert.deepEqual(problems, ['none_on']);
    assert.equal(problems.some(blocksSaving), true);
  });

  it('bien configurado', () => {
    assert.deepEqual(
      paymentSetupProblems({ options: ALL_ON, zelle: '(732) 496-8863', connected: BOTH }),
      [],
    );
  });
});
