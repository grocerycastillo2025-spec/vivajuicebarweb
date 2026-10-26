/**
 * Quién está pidiendo. Y por qué aquí sí hace falta saberlo.
 *
 * ─────────────────────────────────────────────────────────────────────
 * ESTA FUNCIÓN ES DISTINTA A LAS OTRAS TRES
 * ─────────────────────────────────────────────────────────────────────
 *
 *   oauth          la llama un NAVEGADOR que Clover redirige;
 *   token-refresh  la llama pg_net desde nuestra propia base;
 *   catalog-sync   la llama una persona con curl;
 *   checkout       LA LLAMA UN CLIENTE, y el pedido es SUYO.
 *
 * Las tres primeras autorizan con un secreto compartido y no necesitan
 * saber quién llama. Aquí hace falta la identidad: el pedido se guarda
 * con `user_id`, el cliente lo ve luego en su historial, y la clave de
 * idempotencia se comprueba contra su dueño.
 *
 * POR QUÉ NO BASTA `verify_jwt = true`
 * Porque la clave anónima ES un JWT válido del proyecto, y viaja dentro
 * del APK. Con la verificación del gateway puesta, cualquiera con la app
 * instalada pasa — y pasa SIN SER NADIE, sin `sub` de usuario. El gateway
 * contesta "este token es del proyecto", que no es la pregunta.
 *
 * Así que el token se cambia por un usuario contra el propio Auth de
 * Supabase. Si no sale un usuario, no hay pedido. Un token anónimo llega
 * hasta aquí y se queda fuera.
 */

/** El id del usuario, o por qué no. `motivo` va al log, NUNCA al cuerpo. */
export type Identidad =
  { readonly ok: true; readonly userId: string } | { readonly ok: false; readonly motivo: string };

export function leerBearer(cabecera: string | null): string | null {
  if (cabecera === null) return null;
  const m = /^Bearer\s+(.+)$/i.exec(cabecera.trim());
  const token = m?.[1]?.trim();
  return token === undefined || token === '' ? null : token;
}

/**
 * Cambia el token por un usuario contra `/auth/v1/user`.
 *
 * Se llama a Supabase en vez de verificar la firma aquí a propósito: un
 * token REVOCADO —sesión cerrada, cuenta borrada— sigue teniendo la firma
 * buena hasta que caduca. Validar la firma en local dejaría pedir a quien
 * acaba de cerrar sesión. Cuesta una llamada por pedido, en un camino
 * donde ya hay cuatro a Clover.
 */
export async function identificar(
  fetchImpl: typeof fetch,
  input: {
    readonly supabaseUrl: string;
    readonly anonKey: string;
    readonly token: string;
  },
): Promise<Identidad> {
  let respuesta: Response;
  try {
    respuesta = await fetchImpl(`${input.supabaseUrl}/auth/v1/user`, {
      headers: {
        authorization: `Bearer ${input.token}`,
        apikey: input.anonKey,
      },
    });
  } catch (err) {
    return { ok: false, motivo: `auth_inalcanzable: ${err instanceof Error ? err.message : ''}` };
  }

  if (!respuesta.ok) {
    return { ok: false, motivo: `auth_${respuesta.status}` };
  }

  let cuerpo: unknown;
  try {
    cuerpo = await respuesta.json();
  } catch {
    return { ok: false, motivo: 'auth_respuesta_ilegible' };
  }

  const id = (cuerpo as { id?: unknown } | null)?.id;
  if (typeof id !== 'string' || id === '') {
    // Es lo que devuelve la clave anónima: un 200 sin usuario. No es un
    // fallo de red ni un token caducado — es alguien que no es nadie.
    return { ok: false, motivo: 'token_sin_usuario' };
  }
  return { ok: true, userId: id };
}
