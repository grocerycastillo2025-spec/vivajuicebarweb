import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildVisitUrl,
  normalizeRedemptionCode,
  parseRedeemError,
  parseUseRedemptionError,
  parseVisitError,
  parseVisitPayload,
  pointsMissing,
} from '../domain/visit.ts';

const STORE = '33333333-3333-4333-8333-333333333333';

describe('QR de visita', () => {
  it('el enlace del QR se puede volver a leer', () => {
    const url = buildVisitUrl('https://viva.mx/app/', { storeId: STORE, code: 'a1b2c3d4e5f6' });
    assert.equal(url, `https://viva.mx/app/visita?s=${STORE}&c=a1b2c3d4e5f6`);
    assert.deepEqual(parseVisitPayload(url), { storeId: STORE, code: 'a1b2c3d4e5f6' });
  });

  it('acepta la ruta sola', () => {
    assert.deepEqual(parseVisitPayload(`/visita?c=abcdef123456&s=${STORE}`), {
      storeId: STORE,
      code: 'abcdef123456',
    });
  });

  it('ignora QRs que no son de visita', () => {
    for (const text of [
      '',
      'WIFI:S:VIVA;T:WPA;P:12345678;;',
      'https://otro.com/menu',
      `https://viva.mx/visita?s=no-es-uuid&c=abcdef`,
      `https://viva.mx/visita?s=${STORE}&c=<script>`,
      `https://viva.mx/visita?s=${STORE}`,
    ]) {
      assert.equal(parseVisitPayload(text), null, text);
    }
  });
});

describe('errores', () => {
  it('lee la hora de la siguiente visita', () => {
    const failure = parseVisitError('too_soon:2026-10-26T15:00:00Z');
    assert.equal(failure.kind, 'too_soon');
    assert.equal(
      failure.kind === 'too_soon' ? failure.nextAt?.toISOString() : null,
      '2026-10-26T15:00:00.000Z',
    );
    assert.equal(parseVisitError('invalid_code').kind, 'invalid_code');
    assert.equal(parseVisitError('loyalty_disabled').kind, 'loyalty_disabled');
    assert.equal(parseVisitError('fetch failed').kind, 'unknown');
  });

  it('canjes', () => {
    assert.equal(parseRedeemError('not_enough_points'), 'not_enough_points');
    assert.equal(parseUseRedemptionError('redemption_not_found').kind, 'not_found');
    assert.equal(parseUseRedemptionError('redemption_already_used:2026-10-25T16:00:00Z').kind, 'already_used');
    assert.equal(parseUseRedemptionError('redemption_canceled').kind, 'canceled');
  });

  it('normaliza el codigo que teclea el cajero', () => {
    assert.equal(normalizeRedemptionCode(' abc-234 '), 'ABC234');
  });

  it('puntos que faltan', () => {
    assert.equal(pointsMissing(30, 100), 70);
    assert.equal(pointsMissing(150, 100), 0);
  });
});
