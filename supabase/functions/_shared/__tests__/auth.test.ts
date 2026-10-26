/**
 * Quien esta pidiendo.
 *
 * La asercion que importa: que la clave ANONIMA no valga. Es un JWT
 * valido del proyecto y viaja dentro del APK, asi que si valiera,
 * cualquiera con la app instalada podria crear pedidos sin ser nadie.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { identificar, leerBearer } from '../auth.ts';

const BASE = { supabaseUrl: 'https://proyecto.supabase.co', anonKey: 'anon', token: 'jwt' };

function respuesta(status: number, cuerpo: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(cuerpo), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

test('un token de usuario da su id', async () => {
  const r = await identificar(respuesta(200, { id: 'usuario-1', email: 'a@b.c' }), BASE);
  assert.ok(r.ok);
  assert.equal(r.userId, 'usuario-1');
});

test('LA CLAVE ANONIMA NO VALE: 200 sin usuario es alguien que no es nadie', async () => {
  // Es lo que devuelve Auth con la clave anonima. El gateway de Supabase
  // la daria por buena, que es justo por que no se confia en el gateway.
  const r = await identificar(respuesta(200, {}), BASE);
  assert.ok(!r.ok);
  assert.equal(r.motivo, 'token_sin_usuario');
});

test('un token caducado o revocado no pasa', async () => {
  // Se pregunta a Auth en vez de verificar la firma en local justamente
  // por esto: un token revocado tiene la firma buena hasta que caduca.
  const r = await identificar(respuesta(401, { message: 'invalid JWT' }), BASE);
  assert.ok(!r.ok);
  assert.equal(r.motivo, 'auth_401');
});

test('si Auth no contesta, no se inventa un usuario', async () => {
  const caida = (async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof fetch;
  const r = await identificar(caida, BASE);
  assert.ok(!r.ok);
  assert.match(r.motivo, /auth_inalcanzable/);
});

test('leerBearer acepta el formato y nada mas', () => {
  assert.equal(leerBearer('Bearer abc.def.ghi'), 'abc.def.ghi');
  assert.equal(leerBearer('bearer abc'), 'abc');
  assert.equal(leerBearer('  Bearer   abc  '), 'abc');
  for (const malo of [null, '', 'abc', 'Basic abc', 'Bearer', 'Bearer   ']) {
    assert.equal(leerBearer(malo), null, String(malo));
  }
});
