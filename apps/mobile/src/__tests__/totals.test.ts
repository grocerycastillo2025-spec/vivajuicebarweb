import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { computeTotals, formatRate, parseRateInput, rateUnits, surchargeRateFor } from '../domain/totals.ts';

const green = (n = 1) => ({ lineTotalCents: 850 * n, taxable: true, taxRateOverride: null });
const agua = { lineTotalCents: 450, taxable: false, taxRateOverride: null };
const acai = { lineTotalCents: 1250, taxable: true, taxRateOverride: 0.1 };

// Los mismos casos que supabase/tests/0030_impuestos_recargos.test.sql: si
// uno cambia, el otro tiene que cambiar igual.
describe('impuesto y recargo, igual que la base', () => {
  it('sin configurar: total = subtotal', () => {
    assert.deepEqual(computeTotals({ lines: [green()], storeTaxRate: 0, surchargeRate: 0 }), {
      subtotalCents: 850, taxCents: 0, surchargeCents: 0, totalCents: 850,
    });
  });

  it('impuesto por producto: exento y tasa propia', () => {
    const t = computeTotals({ lines: [green(2), agua, acai], storeTaxRate: 0.06625, surchargeRate: 0 });
    assert.deepEqual(t, { subtotalCents: 3400, taxCents: 238, surchargeCents: 0, totalCents: 3638 });
  });

  it('recargo de la forma de pago sobre subtotal + impuesto', () => {
    const t = computeTotals({ lines: [green(2), agua, acai], storeTaxRate: 0.06625, surchargeRate: 0.03 });
    assert.deepEqual(t, { subtotalCents: 3400, taxCents: 238, surchargeCents: 109, totalCents: 3747 });
  });

  it('redondeo mitad hacia arriba y sin errores de coma flotante', () => {
    assert.equal(computeTotals({ lines: [green()], storeTaxRate: 0.06625, surchargeRate: 0 }).taxCents, 56); // 56.3125
    assert.equal(computeTotals({ lines: [{ lineTotalCents: 575, taxable: true, taxRateOverride: null }], storeTaxRate: 0.06625, surchargeRate: 0 }).taxCents, 38);
    // 200 × 0.0625 = 12.5 -> 13 (mitad hacia arriba)
    assert.equal(computeTotals({ lines: [{ lineTotalCents: 200, taxable: true, taxRateOverride: null }], storeTaxRate: 0.0625, surchargeRate: 0 }).taxCents, 13);
    assert.equal(rateUnits(0.07), 7000);
    assert.equal(rateUnits('0.06625'), 6625);
    assert.equal(rateUnits(-1), 0);
  });

  it('recargo por forma de pago desde la configuración', () => {
    const s = { stripe: 0.03, card_counter: 0.03 };
    assert.equal(surchargeRateFor(s, 'stripe'), 0.03);
    assert.equal(surchargeRateFor(s, 'cash'), 0);
    assert.equal(surchargeRateFor(null, 'stripe'), 0);
    assert.equal(surchargeRateFor(s, null), 0);
  });

  it('el panel lee y escribe porcentajes', () => {
    assert.equal(parseRateInput('6.625', 0.25), 0.06625);
    assert.equal(parseRateInput('6.625%', 0.25), 0.06625);
    assert.equal(parseRateInput('3', 0.1), 0.03);
    assert.equal(parseRateInput('', 0.1), 0);
    assert.equal(parseRateInput('11', 0.1), null);
    assert.equal(parseRateInput('abc', 0.1), null);
    assert.equal(formatRate(0.06625), '6.625%');
    assert.equal(formatRate(0.03), '3%');
  });
});
