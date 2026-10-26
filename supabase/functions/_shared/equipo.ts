/**
 * Crear la cuenta de alguien del equipo desde el panel (Negocio → Equipo).
 *
 * Por qué una función y no la app: crear un usuario de Auth pide la llave
 * de servicio de Supabase, que NUNCA va en la app. Aquí la pone Supabase
 * sola (SUPABASE_SERVICE_ROLE_KEY) y nadie la escribe.
 *
 * Reglas:
 *   1. Quien llama tiene que ser DUEÑO de ese negocio. Se revisa ANTES de
 *      crear nada, con su propio token (la RLS decide).
 *   2. Se crea la cuenta con el correo y una contraseña temporal, ya
 *      confirmada (no depende de que llegue un correo).
 *   3. Si el correo ya tenía cuenta, no se toca su contraseña: solo se le
 *      da el rol.
 *   4. El rol se da con `add_team_member` usando el token del dueño, así
 *      que valen las mismas comprobaciones que en el panel.
 *
 * Escrito con dependencias inyectadas para probarlo en Node sin Supabase.
 */

export interface EquipoDeps {
  readonly fetch: typeof fetch;
  readonly supabaseUrl: string;
  readonly anonKey: string;
  readonly serviceKey: string | null;
  readonly log: (event: string, data: Record<string, unknown>) => void;
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
};

function json(status: number, body: Record<string, unknown> | null): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { ...CORS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface NuevaCuenta {
  readonly restaurantId: string;
  readonly email: string;
  readonly password: string;
  readonly role: 'owner' | 'staff';
  readonly firstName: string | null;
}

/** Valida lo que manda el panel. Devuelve el código de error o la cuenta. */
export function leerNuevaCuenta(body: unknown): NuevaCuenta | { readonly error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const restaurantId = typeof b['restaurant_id'] === 'string' ? b['restaurant_id'] : '';
  const email = typeof b['email'] === 'string' ? b['email'].trim().toLowerCase() : '';
  const password = typeof b['password'] === 'string' ? b['password'] : '';
  const role = b['role'];
  const first = typeof b['first_name'] === 'string' ? b['first_name'].trim().slice(0, 60) : '';
  if (!UUID.test(restaurantId)) return { error: 'negocio_invalido' };
  if (!EMAIL.test(email) || email.length > 200) return { error: 'correo_invalido' };
  if (password.length < 8 || password.length > 72) return { error: 'contrasena_corta' };
  if (role !== 'owner' && role !== 'staff') return { error: 'rol_invalido' };
  return { restaurantId, email, password, role, firstName: first === '' ? null : first };
}

function bearer(header: string | null): string | null {
  const m = /^Bearer\s+(.+)$/i.exec((header ?? '').trim());
  return m?.[1]?.trim() || null;
}

export function createEquipoHandler(deps: EquipoDeps): (req: Request) => Promise<Response> {
  const rest = (path: string, token: string, init: RequestInit = {}): Promise<Response> =>
    deps.fetch(`${deps.supabaseUrl}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: deps.anonKey,
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(init.headers as Record<string, string> | undefined),
      },
    });

  return async (req) => {
    if (req.method === 'OPTIONS') return json(204, null);
    if (req.method !== 'POST') return json(405, { error: 'metodo' });
    if (deps.serviceKey === null) return json(503, { error: 'sin_llave_servicio' });

    const token = bearer(req.headers.get('authorization'));
    if (token === null) return json(401, { error: 'sin_sesion' });

    // ¿Quién llama?
    const who = await deps.fetch(`${deps.supabaseUrl}/auth/v1/user`, {
      headers: { authorization: `Bearer ${token}`, apikey: deps.anonKey },
    }).catch(() => null);
    const me = who !== null && who.ok ? ((await who.json().catch(() => null)) as { id?: unknown } | null) : null;
    const callerId = typeof me?.id === 'string' ? me.id : null;
    if (callerId === null) return json(401, { error: 'sin_sesion' });

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json(400, { error: 'cuerpo_invalido' });
    }
    const input = leerNuevaCuenta(body);
    if ('error' in input) return json(400, { error: input.error });

    // 1. ¿Es dueño de ese negocio? (con SU token: la RLS solo le deja ver
    //    su propia fila de miembro).
    const mine = await rest(
      `restaurant_members?select=role&restaurant_id=eq.${input.restaurantId}&user_id=eq.${callerId}`,
      token,
    );
    const rows = mine.ok ? ((await mine.json()) as { role?: string }[]) : [];
    if (rows[0]?.role !== 'owner') {
      deps.log('no_es_dueno', { callerId, restaurantId: input.restaurantId });
      return json(403, { error: 'solo_dueno' });
    }

    // 2. Crear la cuenta (ya confirmada).
    const created = await deps.fetch(`${deps.supabaseUrl}/auth/v1/admin/users`, {
      method: 'POST',
      headers: {
        apikey: deps.serviceKey,
        authorization: `Bearer ${deps.serviceKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        email: input.email,
        password: input.password,
        email_confirm: true,
        user_metadata: input.firstName === null ? {} : { first_name: input.firstName },
      }),
    });
    let newId: string | null = null;
    let existed = false;
    if (created.ok) {
      const user = (await created.json()) as { id?: unknown };
      newId = typeof user.id === 'string' ? user.id : null;
    } else {
      const err = (await created.json().catch(() => ({}))) as { error_code?: string; code?: string | number; msg?: string; message?: string };
      const text = `${err.error_code ?? ''} ${err.msg ?? ''} ${err.message ?? ''}`;
      if (created.status === 422 && /exists|already|registered/i.test(text)) {
        existed = true;
      } else if (/password/i.test(text) && created.status === 422) {
        return json(400, { error: 'contrasena_debil' });
      } else {
        deps.log('crear_fallo', { status: created.status, text });
        return json(502, { error: 'auth_fallo' });
      }
    }

    // 3. Darle el rol con el token del dueño (mismas reglas que el panel).
    const grant = await rest('rpc/add_team_member', token, {
      method: 'POST',
      body: JSON.stringify({ p_restaurant_id: input.restaurantId, p_email: input.email, p_role: input.role }),
    });
    if (!grant.ok) {
      deps.log('rol_fallo', { status: grant.status, body: await grant.text().catch(() => '') });
      return json(502, { error: 'rol_fallo' });
    }

    // 4. Nombre en el perfil (solo cuentas nuevas; no se pisa el de nadie).
    if (newId !== null && input.firstName !== null) {
      await rest(`profiles?id=eq.${newId}`, deps.serviceKey, {
        method: 'PATCH',
        headers: { apikey: deps.serviceKey, prefer: 'return=minimal' },
        body: JSON.stringify({ first_name: input.firstName }),
      }).catch(() => null);
    }

    deps.log('cuenta_lista', { restaurantId: input.restaurantId, role: input.role, existed });
    return json(200, { ok: true, created: !existed, role: input.role });
  };
}
