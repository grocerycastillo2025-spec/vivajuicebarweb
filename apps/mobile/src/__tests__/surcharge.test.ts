/**
 * Recargo por tarjeta. Lo que se prueba aqui no es formato: es la regla
 * de Nueva Jersey de que un aviso SIN CIFRA no vale (P.L. 2023, c.146).
 * Cada `disclose: false` de abajo tiene que venir acompanado de que
 * tampoco se cobra un recargo al cliente en ese caso.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_SURCHARGE_POLICY,
  formatRatePercent,
  surchargeDisclosure,
  surchargeOnCents,
  toSurchargePolicy,
} from '../domain/surcharge.ts';

describe('toSurchargePolicy', () => {
  it('acepta los tres valores del enum', () => {
    assert.equal(toSurchargePolicy('show'), 'show');
    // Un `absorb` de una fila vieja cae en `show`, que es lo mismo que
    // hace la 0019 al migrar: la politica se quito porque prometia
    // absorber un recargo que Clover cobra igual al cliente.
    assert.equal(toSurchargePolicy('absorb'), 'show');
    assert.equal(toSurchargePolicy('block'), 'block');
  });

  it('cae en show ante cualquier cosa rara', () => {
    // Callarse mientras se cobra de mas es el unico fallo caro.
    assert.equal(toSurchargePolicy('SHOW'), 'show');
    assert.equal(toSurchargePolicy(null), 'show');
    assert.equal(toSurchargePolicy(undefined), 'show');
    assert.equal(toSurchargePolicy(7), 'show');
    assert.equal(DEFAULT_SURCHARGE_POLICY, 'show');
  });
});

describe('formatRatePercent', () => {
  it('ensena el importe, no un maximo redondeado', () => {
    // El caso de Viva: 3 %, no "hasta un 3 %" ni "3.0%".
    assert.equal(formatRatePercent(0.03), '3%');
    assert.equal(formatRatePercent(0.035), '3.5%');
    assert.equal(formatRatePercent(0.0325), '3.25%');
  });

  it('no deja escapar el ruido de la coma flotante', () => {
    // 0.03 * 100 === 3.0000000000000004 en IEEE 754. Sin normalizar, el
    // redondeo hacia arriba lo convertiria en "3.01%".
    assert.equal(formatRatePercent(0.03), '3%');
    assert.equal(formatRatePercent(0.07), '7%');
    assert.equal(formatRatePercent(0.029), '2.9%');
  });

  it('redondea hacia arriba: nunca anuncia menos de lo que se cobra', () => {
    // 3.456 % cobrado tiene que anunciarse como 3.46 %, no como 3.45 %.
    assert.equal(formatRatePercent(0.03456), '3.46%');
    assert.equal(formatRatePercent(0.030001), '3.01%');
  });

  it('respeta el locale que se le pase', () => {
    // El espacio de es-ES es duro (U+00A0), no uno normal. Se escribe
    // escapado para que no parezca un fallo de copia el dia que falle.
    assert.equal(formatRatePercent(0.035, 'es-ES'), '3,5\u00a0%');
  });
});

describe('surchargeDisclosure', () => {
  it('divulga con cifra cuando hay recargo y la politica es show', () => {
    const result = surchargeDisclosure({ surcharge_policy: 'show', surcharge_rate: 0.03 });
    assert.equal(result.disclose, true);
    assert.equal(result.percentLabel, '3%');
    assert.equal(result.rate, 0.03);
    assert.equal(result.unknownRate, false);
  });

  it('calla cuando Clover dice que no hay recargo', () => {
    const result = surchargeDisclosure({ surcharge_policy: 'show', surcharge_rate: 0 });
    assert.equal(result.disclose, false);
    assert.equal(result.percentLabel, null);
    // Consultado y sin recargo: no hay nada pendiente de averiguar.
    assert.equal(result.unknownRate, false);
  });

  it('NO pinta un aviso generico cuando no se sabe la tasa', () => {
    // Este es el cartel que la FAQ pone de ejemplo de incumplimiento:
    // "imponemos un recargo" sin decir cuanto. Preferimos no pintar nada
    // y marcar el hueco, que pintar el aviso que la ley rechaza.
    for (const rate of [null, undefined, Number.NaN, -1]) {
      const result = surchargeDisclosure({ surcharge_policy: 'show', surcharge_rate: rate });
      assert.equal(result.disclose, false, `rate ${String(rate)}`);
      assert.equal(result.percentLabel, null, `rate ${String(rate)}`);
      assert.equal(result.unknownRate, true, `rate ${String(rate)}`);
    }
  });

  it('no marca unknownRate si la politica no ensenaba nada de todas formas', () => {
    const bloqueada = surchargeDisclosure({ surcharge_policy: 'block', surcharge_rate: null });
    assert.equal(bloqueada.unknownRate, false);
    assert.equal(bloqueada.disclose, false);
  });

  it('YA NO HAY UNA POLITICA QUE CALLE MIENTRAS SE COBRA', () => {
    // `absorb` callaba porque "lo pagaba el restaurante", y no lo pagaba:
    // el recargo lo aplica Clover y el endpoint de cobro no tiene campo
    // para renunciar a el. Se quito en la 0019, y un `absorb` de una fila
    // vieja cae en `show`, que SI divulga.
    const result = surchargeDisclosure({ surcharge_policy: 'absorb', surcharge_rate: 0.035 });
    assert.equal(result.policy, 'show');
    assert.equal(result.disclose, true, 'una fila vieja con absorb seguiria callando');
    assert.equal(result.percentLabel, '3.5%');
    assert.equal(result.rate, 0.035);
  });

  it('con block tampoco: esa sucursal no toma pedidos', () => {
    const result = surchargeDisclosure({ surcharge_policy: 'block', surcharge_rate: 0.035 });
    assert.equal(result.disclose, false);
    assert.equal(result.policy, 'block');
  });

  it('una sucursal sin columnas de recargo no rompe nada', () => {
    assert.equal(surchargeDisclosure(null).disclose, false);
    assert.equal(surchargeDisclosure(undefined).disclose, false);
    assert.equal(surchargeDisclosure({}).disclose, false);
    // `{}` es una fila sin consultar con politica por defecto `show`.
    assert.equal(surchargeDisclosure({}).unknownRate, true);
  });

  it('una politica invalida en la base se divulga igual', () => {
    const result = surchargeDisclosure({ surcharge_policy: 'mostrar', surcharge_rate: 0.03 });
    assert.equal(result.disclose, true);
    assert.equal(result.percentLabel, '3%');
  });
});

describe('surchargeOnCents', () => {
  it('redondea el centavo hacia arriba', () => {
    assert.equal(surchargeOnCents(1000, 0.03), 30);
    // 1234 * 0.035 = 43.19 -> 44, no 43.
    assert.equal(surchargeOnCents(1234, 0.035), 44);
  });

  it('devuelve 0 ante entradas que no son un cobro', () => {
    assert.equal(surchargeOnCents(1000, 0), 0);
    assert.equal(surchargeOnCents(1000, -0.03), 0);
    assert.equal(surchargeOnCents(Number.NaN, 0.03), 0);
  });
});
