import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assertPublishableKey, classifySupabaseKey, isPublishableKey } from '../domain/keys.ts';

/** Arma un JWT de mentira con el rol pedido. La firma no importa aqui. */
function fakeJwt(role: string): string {
  const encode = (value: object): string =>
    Buffer.from(JSON.stringify(value))
      .toString('base64')
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ role, iss: 'supabase' })}.firma`;
}

describe('classifySupabaseKey', () => {
  it('reconoce la clave publicable nueva', () => {
    assert.equal(classifySupabaseKey('sb_publishable_abc123'), 'publishable');
  });

  it('reconoce la anon legacy', () => {
    assert.equal(classifySupabaseKey(fakeJwt('anon')), 'legacy-anon');
  });

  it('reconoce la secret nueva', () => {
    assert.equal(classifySupabaseKey('sb_secret_abc123'), 'secret');
  });

  it('reconoce la service_role legacy', () => {
    assert.equal(classifySupabaseKey(fakeJwt('service_role')), 'secret');
  });

  it('no se traga cualquier cosa', () => {
    assert.equal(classifySupabaseKey(''), 'unknown');
    assert.equal(classifySupabaseKey('   '), 'unknown');
    assert.equal(classifySupabaseKey('hola'), 'unknown');
    assert.equal(classifySupabaseKey('a.b.c'), 'unknown');
  });
});

describe('isPublishableKey', () => {
  it('acepta los dos formatos publicos', () => {
    assert.equal(isPublishableKey('sb_publishable_abc'), true);
    assert.equal(isPublishableKey(fakeJwt('anon')), true);
  });

  it('rechaza los secretos', () => {
    assert.equal(isPublishableKey('sb_secret_abc'), false);
    assert.equal(isPublishableKey(fakeJwt('service_role')), false);
  });
});

describe('assertPublishableKey', () => {
  it('devuelve la clave sin espacios', () => {
    assert.equal(assertPublishableKey('  sb_publishable_abc  '), 'sb_publishable_abc');
  });

  it('grita fuerte si le llega una service_role', () => {
    assert.throws(() => assertPublishableKey(fakeJwt('service_role')), /INCIDENTE DE SEGURIDAD/);
    assert.throws(() => assertPublishableKey('sb_secret_abc'), /INCIDENTE DE SEGURIDAD/);
  });

  it('avisa cuando la clave no se parece a ninguna de Supabase', () => {
    assert.throws(() => assertPublishableKey('nada'), /no parece una clave de Supabase valida/);
  });
});
