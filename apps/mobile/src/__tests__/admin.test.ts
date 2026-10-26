import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  canCancel,
  newArrivals,
  normalizeHex,
  orderActions,
  orderColumn,
  parseClockInput,
  parsePriceInput,
  priceToInput,
  validateWeek,
} from '../domain/admin.ts';
import type { OrderStatus } from '../domain/order.ts';

describe('parsePriceInput', () => {
  it('lee pesos y centavos sin pasar por float', () => {
    assert.equal(parsePriceInput('65'), 6500);
    assert.equal(parsePriceInput('65.5'), 6550);
    assert.equal(parsePriceInput('65.50'), 6550);
    assert.equal(parsePriceInput('$ 89.90'), 8990);
    assert.equal(parsePriceInput('0.10'), 10);
  });

  it('entiende coma decimal y separador de miles', () => {
    assert.equal(parsePriceInput('65,50'), 6550);
    assert.equal(parsePriceInput('1,250'), 125000);
    assert.equal(parsePriceInput('1,250.00'), 125000);
  });

  it('rechaza lo que no es un precio', () => {
    for (const bad of ['', 'abc', '-5', '1.234', '12.3.4', '$']) {
      assert.equal(parsePriceInput(bad), null, bad);
    }
  });

  it('va y vuelve', () => {
    for (const cents of [0, 5, 650, 6550, 125000]) {
      assert.equal(parsePriceInput(priceToInput(cents)), cents);
    }
  });
});

describe('acciones sobre pedidos', () => {
  it('cada estado ofrece el siguiente paso', () => {
    assert.deepEqual(
      orderActions('confirmed').map((a) => a.to),
      ['preparing', 'ready'],
    );
    assert.deepEqual(
      orderActions('preparing').map((a) => a.to),
      ['ready'],
    );
    assert.deepEqual(
      orderActions('ready').map((a) => a.to),
      ['completed'],
    );
    assert.deepEqual(orderActions('completed'), []);
    assert.deepEqual(orderActions('canceled'), []);
  });

  it('no se cancela un pedido cerrado', () => {
    assert.equal(canCancel('confirmed'), true);
    assert.equal(canCancel('ready'), true);
    assert.equal(canCancel('completed'), false);
    assert.equal(canCancel('canceled'), false);
  });

  it('coincide con la funcion de la base (0020)', () => {
    // Si alguien cambia las transiciones en un lado y no en el otro, el
    // panel ofreceria botones que la base rechaza.
    const sql = readFileSync(
      new URL('../../../../supabase/migrations/0020_negocio_sin_clover.sql', import.meta.url),
      'utf8',
    );
    assert.match(sql, /when p_from = 'confirmed' then p_to in \('preparing', 'ready', 'completed'\)/);
    assert.match(sql, /when p_from = 'preparing' then p_to in \('ready', 'completed'\)/);
    assert.match(sql, /when p_from = 'ready'\s+then p_to = 'completed'/);
    const all: OrderStatus[] = ['confirmed', 'preparing', 'ready'];
    for (const from of all) {
      for (const action of orderActions(from)) {
        assert.ok(
          sql.includes(`'${action.to}'`),
          `la base no conoce la transicion ${from} -> ${action.to}`,
        );
      }
    }
  });

  it('agrupa en columnas', () => {
    assert.equal(orderColumn('confirmed'), 'new');
    assert.equal(orderColumn('preparing'), 'preparing');
    assert.equal(orderColumn('ready'), 'ready');
    assert.equal(orderColumn('completed'), 'done');
    assert.equal(orderColumn('canceled'), 'done');
  });

  it('detecta pedidos nuevos solo despues de la primera carga', () => {
    const now = [
      { id: 'a', status: 'confirmed' as const },
      { id: 'b', status: 'confirmed' as const },
      { id: 'c', status: 'preparing' as const },
    ];
    assert.deepEqual(newArrivals(null, now), []);
    assert.deepEqual(newArrivals(new Set(['a']), now), ['b']);
  });
});

describe('horarios', () => {
  it('lee horas como las escribe la gente', () => {
    assert.equal(parseClockInput('8'), '08:00');
    assert.equal(parseClockInput('8:30'), '08:30');
    assert.equal(parseClockInput('20:00'), '20:00');
    assert.equal(parseClockInput('8 pm'), '20:00');
    assert.equal(parseClockInput('8:30 p.m.'), '20:30');
    assert.equal(parseClockInput('12 am'), '00:00');
    assert.equal(parseClockInput('12 pm'), '12:00');
    assert.equal(parseClockInput('25:00'), null);
    assert.equal(parseClockInput('8:75'), null);
    assert.equal(parseClockInput('13 pm'), null);
  });

  it('marca dias que cierran antes de abrir', () => {
    const problems = validateWeek([
      { weekday: 1, open: true, opensAt: '08:00', closesAt: '20:00' },
      { weekday: 2, open: true, opensAt: '20:00', closesAt: '08:00' },
      { weekday: 3, open: true, opensAt: 'mañana', closesAt: '20:00' },
      { weekday: 0, open: false, opensAt: '', closesAt: '' },
    ]);
    assert.deepEqual(problems, [
      { weekday: 2, reason: 'closes_before_opens' },
      { weekday: 3, reason: 'bad_time' },
    ]);
  });
});

describe('colores', () => {
  it('normaliza hex', () => {
    assert.equal(normalizeHex('0e4a2b'), '#0E4A2B');
    assert.equal(normalizeHex('#E87722'), '#E87722');
    assert.equal(normalizeHex('verde'), null);
    assert.equal(normalizeHex('#fff'), null);
  });
});
