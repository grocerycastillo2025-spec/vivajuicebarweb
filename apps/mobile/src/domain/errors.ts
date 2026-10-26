/**
 * Clasificacion de fallos de datos.
 *
 * Motivo: una pantalla en blanco no distingue "no hay productos" de "no
 * hay conexion" de "faltan permisos". Los tres se arreglan de forma
 * distinta y el usuario merece saber cual le toco.
 *
 * Modulo puro, sin imports: corre bajo `node --test`.
 */

export type DataErrorKind =
  | 'config' // faltan credenciales en el .env
  | 'auth' // la clave de Supabase no vale
  | 'permission' // falta GRANT o lo bloquea RLS
  | 'offline' // no hay red
  | 'not-found' // la tabla o la vista no existe: migracion sin aplicar
  | 'server' // 5xx del lado de Supabase
  | 'unknown';

export interface ClassifiedError {
  readonly kind: DataErrorKind;
  /** ¿Tiene sentido ofrecer "Reintentar"? */
  readonly retryable: boolean;
  /** Codigo original de PostgREST, si lo habia. Para el detalle tecnico. */
  readonly code: string | null;
  /** Mensaje original, para poder copiarlo en un reporte. */
  readonly detail: string;
  /**
   * `true` cuando el mensaje original ya explica el problema en terminos
   * utiles y merece ensenarse tal cual (por ejemplo el de la clave
   * secreta). En el resto de casos la pantalla usa la copia de
   * `strings.dataError`.
   */
  readonly useDetailAsMessage: boolean;
}

/** Error con el codigo de PostgREST pegado, para no perderlo al propagar. */
export function dataError(message: string, code?: string | null, status?: number): Error {
  const error = new Error(message);
  return Object.assign(error, {
    code: code ?? null,
    status: status ?? null,
  });
}

function readString(source: unknown, key: string): string | null {
  if (typeof source !== 'object' || source === null) return null;
  const value = (source as Record<string, unknown>)[key];
  if (typeof value === 'string' && value !== '') return value;
  if (typeof value === 'number') return String(value);
  return null;
}

function readNumber(source: unknown, key: string): number | null {
  if (typeof source !== 'object' || source === null) return null;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === 'number' ? value : null;
}

/**
 * Codigos de PostgreSQL que nos importan:
 *   42501 -> permission denied (falta GRANT)
 *   42P01 -> undefined_table (migracion sin aplicar)
 *   PGRST116 -> la fila no existe
 *   PGRST301 -> JWT invalido
 */
export function classifyError(input: unknown): ClassifiedError {
  const detail = input instanceof Error ? input.message : String(input);
  const code = readString(input, 'code');
  const status = readNumber(input, 'status');
  const name = readString(input, 'name');
  const lower = detail.toLowerCase();

  const build = (
    kind: DataErrorKind,
    retryable: boolean,
    useDetailAsMessage = false,
  ): ClassifiedError => ({ kind, retryable, code, detail, useDetailAsMessage });

  // 1. Configuracion: lo lanza readEnv() antes de tocar la red.
  if (name === 'MissingConfigError' || lower.includes('faltan las credenciales')) {
    return build('config', false);
  }

  // La clave secreta trae su propio mensaje, que dice exactamente que pasa.
  if (
    lower.includes('incidente de seguridad') ||
    lower.includes('no parece una clave de supabase')
  ) {
    return build('config', false, true);
  }

  // 2. Red. React Native lanza TypeError con estos mensajes.
  if (
    lower.includes('network request failed') ||
    lower.includes('fetch failed') ||
    lower.includes('failed to fetch') ||
    lower.includes('econnrefused') ||
    lower.includes('enotfound') ||
    lower.includes('timeout') ||
    lower.includes('abort')
  ) {
    return build('offline', true);
  }

  // 3. Autenticacion.
  if (
    status === 401 ||
    code === 'PGRST301' ||
    lower.includes('invalid api key') ||
    lower.includes('jwt')
  ) {
    return build('auth', false);
  }

  // 4. Permisos: GRANT que falta o RLS que bloquea.
  if (
    code === '42501' ||
    status === 403 ||
    lower.includes('permission denied') ||
    lower.includes('row-level security') ||
    lower.includes('row level security')
  ) {
    return build('permission', true);
  }

  // 5. La tabla, la vista o la funcion no existe.
  if (
    code === '42P01' ||
    code === '42883' ||
    lower.includes('does not exist') ||
    lower.includes('undefined_table')
  ) {
    return build('not-found', true);
  }

  // 6. Servidor.
  if (status !== null && status >= 500) {
    return build('server', true);
  }

  // Un mensaje desconocido es mas util que un texto generico.
  return build('unknown', true, detail !== '');
}
