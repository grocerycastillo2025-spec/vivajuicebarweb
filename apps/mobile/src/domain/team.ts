/**
 * Equipo: contraseña temporal y motivos de error de la función `equipo`.
 * Módulo puro.
 */

const LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ';
const DIGITS = '23456789';

/** Contraseña temporal fácil de dictar: "Viva-KMPX-4827". */
export function tempPassword(random: () => number = Math.random): string {
  const pick = (set: string, n: number): string =>
    Array.from({ length: n }, () => set[Math.floor(random() * set.length) % set.length]).join('');
  return `Viva-${pick(LETTERS, 4)}-${pick(DIGITS, 4)}`;
}

export const TEAM_ERRORS = [
  'solo_dueno',
  'correo_invalido',
  'contrasena_corta',
  'contrasena_debil',
  'rol_invalido',
  'rol_fallo',
  'auth_fallo',
  'sin_llave_servicio',
  'sin_sesion',
  'funcion_no_publicada',
] as const;
export type TeamError = (typeof TEAM_ERRORS)[number];

/** El código que devolvió la función, o `null` si es otro error. */
export function teamErrorCode(message: string): TeamError | null {
  return TEAM_ERRORS.find((code) => message.includes(code)) ?? null;
}
