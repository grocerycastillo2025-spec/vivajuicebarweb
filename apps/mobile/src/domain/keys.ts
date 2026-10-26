/**
 * Guardia de arquitectura: la app movil solo puede usar la clave PUBLICA
 * de Supabase. Si alguna vez alguien pega la `service_role` en un
 * `.env.local`, esto revienta al arrancar en vez de subir a produccion
 * una app con permisos de administrador dentro del bundle.
 *
 * Se admiten dos formatos:
 *   - nuevo:   sb_publishable_...   (secreto: sb_secret_...)
 *   - legacy:  JWT con "role":"anon" (secreto: "role":"service_role")
 */

export type SupabaseKeyKind = 'publishable' | 'legacy-anon' | 'secret' | 'unknown';

function decodeJwtRole(key: string): string | null {
  const parts = key.split('.');
  if (parts.length !== 3) return null;

  const payload = parts[1];
  if (payload === undefined || payload === '') return null;

  try {
    const base64 = payload.replaceAll('-', '+').replaceAll('_', '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    const json: unknown = JSON.parse(globalThis.atob(padded));

    if (typeof json === 'object' && json !== null && 'role' in json) {
      const role = (json as { role: unknown }).role;
      return typeof role === 'string' ? role : null;
    }
    return null;
  } catch {
    return null;
  }
}

export function classifySupabaseKey(key: string): SupabaseKeyKind {
  const trimmed = key.trim();
  if (trimmed === '') return 'unknown';

  if (trimmed.startsWith('sb_publishable_')) return 'publishable';
  if (trimmed.startsWith('sb_secret_')) return 'secret';

  const role = decodeJwtRole(trimmed);
  if (role === 'anon') return 'legacy-anon';
  if (role === 'service_role') return 'secret';

  return 'unknown';
}

export function isPublishableKey(key: string): boolean {
  const kind = classifySupabaseKey(key);
  return kind === 'publishable' || kind === 'legacy-anon';
}

/**
 * Lanza si la clave no es publicable. El mensaje distingue los tres casos
 * porque los tres se arreglan de forma distinta.
 */
export function assertPublishableKey(key: string): string {
  switch (classifySupabaseKey(key)) {
    case 'publishable':
    case 'legacy-anon':
      return key.trim();

    case 'secret':
      throw new Error(
        'INCIDENTE DE SEGURIDAD: EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY contiene una clave ' +
          'SECRETA (service_role). Esa clave da acceso total a la base y jamas puede viajar ' +
          'en el bundle de la app. Rotala en el dashboard de Supabase y usa la publishable ' +
          '(sb_publishable_...).',
      );

    case 'unknown':
      throw new Error(
        'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY no parece una clave de Supabase valida. ' +
          'Se espera sb_publishable_... o la anon legacy (eyJ...). ' +
          'Copiala de Project Settings -> API en el dashboard de juicebar-dev.',
      );
  }
}
