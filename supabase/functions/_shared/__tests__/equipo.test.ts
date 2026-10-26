/**
 * Crear cuentas del equipo: solo el dueño, sin pisar contraseñas ajenas.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createEquipoHandler, leerNuevaCuenta } from '../equipo.ts';

const R = '11111111-1111-4111-8111-111111111111';
const OWNER = 'aaaaaaaa-0000-4000-8000-000000000001';

interface Call {
  url: string;
  method: string;
  auth: string;
  body: unknown;
}

function fakeSupabase(opts: { role?: string | null; exists?: boolean; grantOk?: boolean } = {}) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call = {
      url,
      method: init?.method ?? 'GET',
      auth: headers['authorization'] ?? '',
      body: init?.body ? JSON.parse(String(init.body)) : null,
    };
    calls.push(call);
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    if (url.endsWith('/auth/v1/user')) {
      return call.auth === 'Bearer owner-token' ? reply(200, { id: OWNER }) : reply(401, {});
    }
    if (url.includes('/rest/v1/restaurant_members')) {
      return reply(200, opts.role === null ? [] : [{ role: opts.role ?? 'owner' }]);
    }
    if (url.endsWith('/auth/v1/admin/users')) {
      return opts.exists
        ? reply(422, { error_code: 'email_exists', msg: 'A user with this email address has already been registered' })
        : reply(200, { id: 'bbbbbbbb-0000-4000-8000-000000000002' });
    }
    if (url.endsWith('/rest/v1/rpc/add_team_member')) return reply(opts.grantOk === false ? 403 : 200, {});
    if (url.includes('/rest/v1/profiles')) return new Response(null, { status: 204 });
    return reply(404, {});
  }) as typeof fetch;
  const handler = createEquipoHandler({
    fetch: fetchImpl,
    supabaseUrl: 'https://x.supabase.co',
    anonKey: 'anon',
    serviceKey: 'service-key',
    log: () => undefined,
  });
  return { calls, handler };
}

function post(body: unknown, token = 'owner-token'): Request {
  return new Request('https://x/functions/v1/equipo', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const VALID = { restaurant_id: R, email: 'Caja@Viva.test ', password: 'temporal-123', role: 'staff', first_name: 'Luis' };

describe('equipo: crear cuenta', () => {
  it('valida los datos', () => {
    assert.deepEqual(leerNuevaCuenta({ ...VALID, email: 'no-es-correo' }), { error: 'correo_invalido' });
    assert.deepEqual(leerNuevaCuenta({ ...VALID, password: 'corta' }), { error: 'contrasena_corta' });
    assert.deepEqual(leerNuevaCuenta({ ...VALID, role: 'admin' }), { error: 'rol_invalido' });
    const ok = leerNuevaCuenta(VALID);
    assert.ok(!('error' in ok) && ok.email === 'caja@viva.test');
  });

  it('el dueño crea la cuenta y le da el rol con SU token', async () => {
    const { calls, handler } = fakeSupabase();
    const res = await handler(post(VALID));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, created: true, role: 'staff' });
    const create = calls.find((c) => c.url.endsWith('/admin/users'));
    assert.equal(create?.auth, 'Bearer service-key');
    assert.deepEqual((create?.body as { email_confirm: boolean }).email_confirm, true);
    const grant = calls.find((c) => c.url.endsWith('/rpc/add_team_member'));
    assert.equal(grant?.auth, 'Bearer owner-token');
    assert.deepEqual(grant?.body, { p_restaurant_id: R, p_email: 'caja@viva.test', p_role: 'staff' });
  });

  it('quien no es dueño no crea nada', async () => {
    const { calls, handler } = fakeSupabase({ role: 'staff' });
    const res = await handler(post(VALID));
    assert.equal(res.status, 403);
    assert.equal(calls.some((c) => c.url.endsWith('/admin/users')), false);
  });

  it('sin sesión no entra', async () => {
    const { calls, handler } = fakeSupabase();
    const res = await handler(post(VALID, 'otro'));
    assert.equal(res.status, 401);
    assert.equal(calls.some((c) => c.url.endsWith('/admin/users')), false);
  });

  it('si el correo ya existe, solo da el rol (no toca su contraseña ni su nombre)', async () => {
    const { calls, handler } = fakeSupabase({ exists: true });
    const res = await handler(post(VALID));
    assert.deepEqual(await res.json(), { ok: true, created: false, role: 'staff' });
    assert.equal(calls.some((c) => c.url.includes('/rest/v1/profiles')), false);
  });

  it('sin llave de servicio responde claro', async () => {
    const handler = createEquipoHandler({
      fetch: fetch, supabaseUrl: 'https://x', anonKey: 'a', serviceKey: null, log: () => undefined,
    });
    assert.equal((await handler(post(VALID))).status, 503);
  });
});
