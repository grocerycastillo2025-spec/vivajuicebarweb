import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_ALARM, parseAlarmSettings, shouldRing, statusNotice, waitingOrders } from '../domain/alerts.ts';

const base = { now: 100_000, arrived: 0, waiting: 0, lastRingAt: null, repeatSeconds: 15, snoozedUntil: null };

describe('Alarma de pedidos', () => {
  it('suena al llegar uno nuevo', () => {
    assert.equal(shouldRing({ ...base, arrived: 1, waiting: 1, lastRingAt: 99_000 }), true);
  });
  it('se repite cada N segundos mientras nadie lo atienda', () => {
    assert.equal(shouldRing({ ...base, waiting: 1, lastRingAt: 90_000 }), false);
    assert.equal(shouldRing({ ...base, waiting: 1, lastRingAt: 85_000 }), true);
  });
  it('se calla cuando ya se atendió o está en silencio', () => {
    assert.equal(shouldRing({ ...base, waiting: 0, lastRingAt: 0 }), false);
    assert.equal(shouldRing({ ...base, waiting: 2, arrived: 1, snoozedUntil: 200_000 }), false);
    assert.equal(shouldRing({ ...base, waiting: 1, lastRingAt: 0, repeatSeconds: 0 }), false);
  });
  it('solo cuenta los nuevos sin atender', () => {
    assert.equal(waitingOrders([{ status: 'confirmed' }, { status: 'preparing' }, { status: 'confirmed' }]).length, 2);
  });
  it('lee la configuración guardada con valores seguros', () => {
    assert.deepEqual(parseAlarmSettings(null), DEFAULT_ALARM);
    assert.equal(parseAlarmSettings({ repeatSeconds: 7, sound: 'timbre' }).repeatSeconds, 15);
    assert.equal(parseAlarmSettings({ sound: 'timbre' }).sound, 'timbre');
  });
});

describe('Avisos al cliente', () => {
  it('avisa solo los cambios que importan', () => {
    assert.equal(statusNotice('confirmed', 'preparing'), 'preparing');
    assert.equal(statusNotice('preparing', 'ready'), 'ready');
    assert.equal(statusNotice('ready', 'ready'), null);
    assert.equal(statusNotice(undefined, 'ready'), null);
    assert.equal(statusNotice('ready', 'completed'), null);
  });
});
