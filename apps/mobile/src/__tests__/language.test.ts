import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { detectLanguage, localizedText } from '../domain/language.ts';
import { es } from '../strings.ts';
import { en } from '../strings.en.ts';

describe('idioma', () => {
  it('lo elegido manda; si no, el del teléfono; si no, inglés', () => {
    assert.equal(detectLanguage('es', ['en-US']), 'es');
    assert.equal(detectLanguage(null, ['es-MX', 'en-US']), 'es');
    assert.equal(detectLanguage(null, ['fr-FR', 'en-GB']), 'en');
    assert.equal(detectLanguage(null, ['pt-BR']), 'en');
    assert.equal(detectLanguage('xx', []), 'en');
  });

  it('menú: traducción al español con respaldo en inglés', () => {
    const i18n = { es: { name: 'Jugo Verde', description: '' } };
    assert.equal(localizedText('Green Juice', i18n, 'name', 'es'), 'Jugo Verde');
    assert.equal(localizedText('Green Juice', i18n, 'name', 'en'), 'Green Juice');
    // Vacío o ausente: el inglés.
    assert.equal(localizedText('Cucumber, celery', i18n, 'description', 'es'), 'Cucumber, celery');
    assert.equal(localizedText('Latte', {}, 'name', 'es'), 'Latte');
    assert.equal(localizedText('Latte', null, 'name', 'es'), 'Latte');
    assert.equal(localizedText('Latte', 'basura', 'name', 'es'), 'Latte');
  });

  it('los dos idiomas tienen exactamente las mismas claves', () => {
    const keys = (o: unknown, prefix = ''): string[] =>
      typeof o === 'object' && o !== null && !Array.isArray(o)
        ? Object.entries(o).flatMap(([k, v]) => keys(v, `${prefix}${k}.`))
        : [prefix.slice(0, -1)];
    assert.deepEqual(keys(en).sort(), keys(es).sort());
  });

  it('las funciones de texto devuelven texto en los dos idiomas', () => {
    assert.equal(es.order.number(7), 'Pedido #7');
    assert.equal(en.order.number(7), 'Order #7');
    assert.equal(es.payments.memoValue('#7'), 'Pedido #7');
    assert.equal(en.payments.memoValue('#7'), 'Order #7');
  });
});
