import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildCardUrl,
  formatCard,
  normalizeCard,
  parseCardError,
  parseCardPayload,
  progressTo,
  visitsMissing,
} from '../domain/loyalty-card.ts';

describe('Tarjeta de lealtad', () => {
  it('el enlace del QR se vuelve a leer', () => {
    const url = buildCardUrl('https://x.github.io/vivajuicebarweb/', 'ABCDE23456');
    assert.equal(url, 'https://x.github.io/vivajuicebarweb/admin/cliente?c=ABCDE23456');
    assert.equal(parseCardPayload(url), 'ABCDE23456');
  });

  it('acepta el código tecleado con guion, espacios o minúsculas', () => {
    assert.equal(parseCardPayload('abcde-23456'), 'ABCDE23456');
    assert.equal(parseCardPayload(' ABCDE 23456 '), 'ABCDE23456');
    assert.equal(formatCard('ABCDE23456'), 'ABCDE-23456');
  });

  it('rechaza lo que no es una tarjeta', () => {
    assert.equal(parseCardPayload(''), null);
    assert.equal(parseCardPayload('https://otro.com/menu'), null);
    assert.equal(parseCardPayload('https://x/visita?s=1&c=ABCDE23456'), null);
    assert.equal(parseCardPayload('ABCDE2345'), null); // 9
    assert.equal(normalizeCard('ABCDE2345O'), null); // O no existe
    assert.equal(normalizeCard('ABCDE23451'), null); // 1 no existe
  });

  it('traduce los errores de la base', () => {
    assert.deepEqual(parseCardError('card_not_found'), { kind: 'not_found' });
    const soon = parseCardError('too_soon:2026-10-26T15:00:00Z');
    assert.equal(soon.kind, 'too_soon');
    assert.equal(soon.kind === 'too_soon' && soon.nextAt?.toISOString(), '2026-10-26T15:00:00.000Z');
    assert.deepEqual(parseCardError('not_enough_points'), { kind: 'not_enough' });
    assert.deepEqual(parseCardError('Could not find the function public.loyalty_lookup'), { kind: 'missing_sql' });
  });

  it('progreso y visitas que faltan', () => {
    assert.equal(progressTo(20, 40), 0.5);
    assert.equal(progressTo(50, 40), 1);
    assert.equal(visitsMissing(20, 45, 10), 3);
    assert.equal(visitsMissing(50, 40, 10), 0);
  });
});

describe('Nombre de la recompensa', () => {
  it('usa la traducción si existe', async () => {
    const { rewardLabel } = await import('../domain/loyalty-card.ts');
    assert.equal(rewardLabel({ name: 'Free shot', i18n: { es: { name: 'Shot gratis' } } }, 'es'), 'Shot gratis');
    assert.equal(rewardLabel({ name: 'Free shot', i18n: {} }, 'es'), 'Free shot');
    assert.equal(rewardLabel({ name: 'Free shot', i18n: { es: { name: 'Shot gratis' } } }, 'en'), 'Free shot');
  });
});
