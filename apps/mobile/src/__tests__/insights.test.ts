import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  bestIndex,
  hourLabel,
  hourWindow,
  ordersByHour,
  peakHour,
  peakWeekday,
  percentChange,
  shares,
} from '../domain/insights.ts';

describe('Estadísticas', () => {
  it('cambio contra el periodo anterior', () => {
    assert.deepEqual(percentChange(112, 100), { pct: 12, dir: 'up' });
    assert.deepEqual(percentChange(80, 100), { pct: -20, dir: 'down' });
    assert.deepEqual(percentChange(100, 100), { pct: 0, dir: 'same' });
    assert.equal(percentChange(50, 0), null);
  });

  it('horas pico y día pico', () => {
    const heat = [
      { dow: 7, hour: 8, orders: 3 },
      { dow: 6, hour: 8, orders: 1 },
      { dow: 6, hour: 13, orders: 1 },
    ];
    assert.equal(ordersByHour(heat)[8], 4);
    assert.equal(peakHour(heat), 8);
    assert.equal(peakWeekday(heat), 7);
    assert.equal(peakHour([]), null);
    assert.deepEqual(hourWindow(heat), { from: 7, to: 19 });
    assert.deepEqual(hourWindow([{ dow: 1, hour: 6, orders: 1 }, { dow: 1, hour: 21, orders: 1 }]), { from: 6, to: 21 });
  });

  it('etiquetas de hora', () => {
    assert.equal(hourLabel(8, 'es'), '8 a. m.');
    assert.equal(hourLabel(15, 'en'), '3 PM');
    assert.equal(hourLabel(0, 'en'), '12 AM');
    assert.equal(hourLabel(12, 'es'), '12 p. m.');
  });

  it('porcentajes que suman 100', () => {
    const s = shares([
      { key: 'a', value: 1 },
      { key: 'b', value: 1 },
      { key: 'c', value: 1 },
    ]);
    assert.equal(s.reduce((t, x) => t + x.pct, 0), 100);
    assert.deepEqual(shares([{ key: 'a', value: 0 }]).map((x) => x.pct), [0]);
  });

  it('mejor día', () => {
    assert.equal(bestIndex([0, 5, 3]), 1);
    assert.equal(bestIndex([0, 0]), null);
  });
});
