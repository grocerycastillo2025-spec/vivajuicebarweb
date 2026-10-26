import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { shouldShowPhoto } from '../domain/photo.ts';
import { pushTargetFromData, shouldRegister } from '../domain/push.ts';

const ORDER = '3f1a2b4c-5d6e-4f70-8901-abcdefabcdef';

describe('a donde lleva una notificacion', () => {
  it('un pedido conocido abre su pantalla', () => {
    assert.deepEqual(pushTargetFromData({ type: 'order', orderId: ORDER }), {
      pathname: '/order/[id]',
      params: { id: ORDER },
    });
  });

  it('un payload sin tipo conocido no lleva a ninguna parte', () => {
    assert.equal(pushTargetFromData({ type: 'promo', orderId: ORDER }), null);
    assert.equal(pushTargetFromData({}), null);
    assert.equal(pushTargetFromData(null), null);
    assert.equal(pushTargetFromData('order'), null);
  });

  it('un id que no es un uuid se descarta', () => {
    assert.equal(pushTargetFromData({ type: 'order', orderId: '../../admin' }), null);
    assert.equal(pushTargetFromData({ type: 'order', orderId: 12345 }), null);
    assert.equal(pushTargetFromData({ type: 'order', orderId: '' }), null);
  });

  it('una ruta dentro del payload se ignora: la manda un servidor, no nosotros', () => {
    // Si esto llevara a `pathname`, quien pueda enviar una notificacion
    // podria abrir cualquier pantalla con cualquier parametro.
    const target = pushTargetFromData({
      type: 'order',
      orderId: ORDER,
      pathname: '/store-picker',
      params: { id: 'otro' },
    });
    assert.deepEqual(target, { pathname: '/order/[id]', params: { id: ORDER } });
  });
});

describe('cuando registrar el token', () => {
  it('no se registra sin permiso', () => {
    assert.equal(shouldRegister('denied', 'user-1', null, null), false);
    assert.equal(shouldRegister('undetermined', 'user-1', null, null), false);
  });

  it('no se registra sin sesion: el token se guarda contra un usuario', () => {
    assert.equal(shouldRegister('granted', null, null, null), false);
  });

  it('se registra con permiso y sesion', () => {
    assert.equal(shouldRegister('granted', 'user-1', null, null), true);
  });

  it('no se repite si ya esta registrado ese token para ese usuario', () => {
    const done = { token: 'ExponentPushToken[a]', userId: 'user-1' };
    assert.equal(shouldRegister('granted', 'user-1', done, 'ExponentPushToken[a]'), false);
  });

  it('se vuelve a registrar si cambia el usuario en el mismo aparato', () => {
    const done = { token: 'ExponentPushToken[a]', userId: 'user-1' };
    assert.equal(shouldRegister('granted', 'user-2', done, 'ExponentPushToken[a]'), true);
  });

  it('se vuelve a registrar si el sistema emite otro token', () => {
    const done = { token: 'ExponentPushToken[a]', userId: 'user-1' };
    assert.equal(shouldRegister('granted', 'user-1', done, 'ExponentPushToken[b]'), true);
  });
});

describe('foto de producto: los tres estados', () => {
  it('sin url se ensena el bloque de marca', () => {
    assert.equal(shouldShowPhoto(null, false), false);
    assert.equal(shouldShowPhoto(undefined, false), false);
  });

  it('una url vacia cuenta como sin foto', () => {
    // El SQL que conecta las imagenes puede dejarla asi.
    assert.equal(shouldShowPhoto('', false), false);
    assert.equal(shouldShowPhoto('   ', false), false);
  });

  it('con url se ensena la foto', () => {
    assert.equal(shouldShowPhoto('https://x.supabase.co/a.jpg', false), true);
  });

  it('una url rota vuelve al bloque de marca', () => {
    // Pasa de verdad: el SQL de las fotos escribe la url de los 50
    // productos aunque solo se hayan subido 30 archivos.
    assert.equal(shouldShowPhoto('https://x.supabase.co/falta.jpg', true), false);
  });
});
