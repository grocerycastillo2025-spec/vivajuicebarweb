import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { classifyError, dataError } from '../domain/errors.ts';
import { strings } from '../strings.ts';

describe('dataError', () => {
  it('conserva el codigo de PostgREST al propagar', () => {
    const error = dataError('permission denied for table stores', '42501', 403);
    assert.equal(error.message, 'permission denied for table stores');
    assert.equal((error as Error & { code: string }).code, '42501');
    assert.equal((error as Error & { status: number }).status, 403);
  });
});

describe('classifyError', () => {
  it('distingue falta de configuracion', () => {
    const error = new Error('Faltan las credenciales de Supabase.');
    error.name = 'MissingConfigError';
    const result = classifyError(error);
    assert.equal(result.kind, 'config');
    assert.equal(result.retryable, false);
  });

  it('distingue una clave secreta pegada por error', () => {
    const result = classifyError(new Error('INCIDENTE DE SEGURIDAD: ... service_role ...'));
    assert.equal(result.kind, 'config');
    assert.equal(result.retryable, false);
  });

  it('distingue falta de red', () => {
    for (const message of ['Network request failed', 'fetch failed', 'ETIMEDOUT timeout']) {
      assert.equal(classifyError(new Error(message)).kind, 'offline');
    }
    assert.equal(classifyError(new Error('Network request failed')).retryable, true);
  });

  it('distingue falta de permisos por codigo', () => {
    const result = classifyError(dataError('permission denied for table stores', '42501'));
    assert.equal(result.kind, 'permission');
    assert.equal(result.code, '42501');
  });

  it('distingue falta de permisos por mensaje', () => {
    assert.equal(
      classifyError(new Error('permission denied for view menu_items')).kind,
      'permission',
    );
    assert.equal(
      classifyError(new Error('new row violates row-level security policy')).kind,
      'permission',
    );
  });

  it('distingue una migracion sin aplicar', () => {
    assert.equal(
      classifyError(dataError('relation "menu_items" does not exist', '42P01')).kind,
      'not-found',
    );
  });

  it('distingue una clave rechazada', () => {
    assert.equal(classifyError(dataError('Invalid API key', null, 401)).kind, 'auth');
    assert.equal(classifyError(dataError('JWT expired', 'PGRST301')).kind, 'auth');
  });

  it('distingue un fallo del servidor', () => {
    assert.equal(classifyError(dataError('upstream error', null, 503)).kind, 'server');
  });

  it('cae en unknown sin perder el mensaje original', () => {
    const result = classifyError(new Error('algo rarisimo'));
    assert.equal(result.kind, 'unknown');
    assert.equal(result.detail, 'algo rarisimo');
    // Un mensaje concreto se ensena tal cual: es mas util que un generico.
    assert.equal(result.useDetailAsMessage, true);
  });

  it('aguanta que le pasen algo que no es un Error', () => {
    const result = classifyError('texto suelto');
    assert.equal(result.kind, 'unknown');
    assert.equal(result.detail, 'texto suelto');
    assert.equal(result.code, null);
  });

  it('todo tipo clasificado tiene copia en strings', () => {
    const inputs: unknown[] = [
      new Error('Network request failed'),
      dataError('permission denied', '42501'),
      dataError('boom', null, 500),
      dataError('relation "x" does not exist', '42P01'),
      dataError('Invalid API key', null, 401),
      'raro',
      null,
    ];

    // La copia vive en strings.dataError; el dominio solo clasifica. Este
    // test es el que impide que un tipo nuevo se quede sin texto.
    const copyKeys: Record<string, keyof typeof strings.dataError> = {
      config: 'config',
      auth: 'auth',
      permission: 'permission',
      offline: 'offline',
      'not-found': 'notFound',
      server: 'server',
      unknown: 'unknown',
    };

    for (const input of inputs) {
      const result = classifyError(input);
      const key = copyKeys[result.kind];
      assert.ok(key !== undefined, `sin copia para el tipo ${result.kind}`);
      const copy = strings.dataError[key];
      assert.ok(copy.title.length > 0, 'titulo vacio');
      assert.ok(copy.hint.length > 0, 'pista vacia');
    }
  });
});
