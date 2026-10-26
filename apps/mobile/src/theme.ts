/**
 * Escalas de diseno. Los COLORES ya no viven aqui: vienen de
 * `app_settings` en la base, via `useBranding()`, porque la plataforma es
 * multi-marca y un cambio de color no puede exigir una release (§19).
 *
 * Lo que si es fijo son los espacios, los radios y la tipografia: eso es
 * el sistema de diseno, no la marca.
 */

export type { BrandColors } from './domain/branding';
export { defaultBranding } from './domain/branding';

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 18,
  pill: 999,
} as const;

export const type = {
  display: { fontSize: 28, fontWeight: '800' },
  title: { fontSize: 22, fontWeight: '700' },
  section: { fontSize: 17, fontWeight: '700' },
  body: { fontSize: 15, fontWeight: '400' },
  label: { fontSize: 13, fontWeight: '600' },
  caption: { fontSize: 12, fontWeight: '400' },
} as const;

/**
 * Ancho de columna para la rejilla del menu. Sin bloqueo de orientacion
 * (regla 1 de ANDROID-COMPATIBILIDAD.md), asi que el numero de columnas
 * se calcula del ancho real, no de "es telefono o no".
 */
export function gridColumns(width: number): number {
  if (width >= 1100) return 4;
  if (width >= 760) return 3;
  if (width >= 500) return 2;
  return 1;
}
