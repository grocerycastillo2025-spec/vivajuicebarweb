import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatMoney, formatSurcharge, sumCents } from '../domain/money.ts';

describe('formatMoney', () => {
  it('formatea centavos como dolares', () => {
    assert.equal(formatMoney(850), '$8.50');
    assert.equal(formatMoney(1250), '$12.50');
    assert.equal(formatMoney(0), '$0.00');
  });

  it('no pierde precision en los precios del catalogo', () => {
    assert.equal(formatMoney(475), '$4.75');
    assert.equal(formatMoney(599), '$5.99');
    assert.equal(formatMoney(999), '$9.99');
  });
});

describe('formatSurcharge', () => {
  it('deja en blanco los modificadores sin costo', () => {
    assert.equal(formatSurcharge(0), '');
  });

  it('marca el recargo con signo', () => {
    assert.equal(formatSurcharge(100), '+$1.00');
    assert.equal(formatSurcharge(-50), '-$0.50');
  });
});

describe('sumCents', () => {
  it('suma en enteros', () => {
    assert.equal(sumCents([850, 100, 25]), 975);
    assert.equal(sumCents([]), 0);
  });

  it('ignora valores no finitos en vez de propagar NaN', () => {
    assert.equal(sumCents([100, Number.NaN, 50]), 150);
  });
});
