/**
 * Branding por marca, leido de `app_settings`.
 *
 * §19 del documento de arquitectura: "el branding llega del backend, no
 * del build: colores, logo, banners, features. Un cambio de color no
 * requiere release". Este modulo convierte la fila cruda en una paleta
 * usable, con validacion: un color mal escrito en la base no puede dejar
 * la app ilegible.
 *
 * Modulo puro, sin imports.
 */

export interface BrandColors {
  readonly background: string;
  readonly surface: string;
  readonly primary: string;
  readonly onPrimary: string;
  readonly accent: string;
  readonly onAccent: string;
  readonly text: string;
  readonly textMuted: string;
  readonly textFaint: string;
  readonly border: string;
  readonly danger: string;
  readonly success: string;
}

export interface BrandFeatures {
  readonly loyalty: boolean;
  readonly promotions: boolean;
  readonly tips: boolean;
  readonly favorites: boolean;
  readonly scheduling: boolean;
}

export interface Branding {
  readonly displayName: string;
  readonly logoUrl: string | null;
  readonly colors: BrandColors;
  readonly features: BrandFeatures;
}

export interface AppSettingsInput {
  readonly app_display_name?: string | null;
  readonly logo_url?: string | null;
  readonly primary_color?: string | null;
  readonly secondary_color?: string | null;
  readonly accent_color?: string | null;
  readonly features?: unknown;
}

const HEX = /^#[0-9A-Fa-f]{6}$/;

/**
 * Valores de VIVA Juice and Coffee, que son tambien los del seed: verde
 * del logotipo (texto blanco encima: 10:1), crema de fondo y el naranja de
 * "JUICE" como acento. Sirven de red de seguridad si la base no responde.
 */
const FALLBACK = {
  primary: '#0E4A2B',
  secondary: '#F5F0E6',
  accent: '#E87722',
} as const;

const NEUTRALS = {
  surface: '#FFFFFF',
  text: '#1A1A18',
  textMuted: '#6B6B63',
  textFaint: '#9A9A90',
  border: '#E2DACB',
  danger: '#B3261E',
  success: '#1B6B41',
} as const;

export const defaultFeatures: BrandFeatures = {
  loyalty: true,
  promotions: true,
  tips: true,
  favorites: true,
  scheduling: true,
};

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX.test(value);
}

function pickColor(value: unknown, fallback: string): string {
  return isHexColor(value) ? value.toUpperCase() : fallback;
}

/** Luminancia relativa segun WCAG. */
export function relativeLuminance(hex: string): number {
  const value = isHexColor(hex) ? hex : '#000000';
  const channel = (start: number): number => {
    const raw = Number.parseInt(value.slice(start, start + 2), 16) / 255;
    return raw <= 0.03928 ? raw / 12.92 : ((raw + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const light = Math.max(la, lb);
  const dark = Math.min(la, lb);
  return (light + 0.05) / (dark + 0.05);
}

/** Minimo AA de WCAG para texto normal. */
export const AA_CONTRAST = 4.5;

/**
 * Elige el color de texto sobre un fondo dado.
 *
 * Se prefiere el color de marca (el crema, en el caso de Viva) porque es
 * lo que hace que la app se vea suya. Si no llega a AA se pasa al gris
 * tinta, y despues al blanco.
 *
 * El ultimo recurso es blanco o negro PUROS, y no es adorno: con un fondo
 * gris medio (#7A7A7A) ni el blanco (4.29) ni el gris tinta (4.06) llegan
 * a 4.5, y solo el negro puro (4.89) lo consigue. Sin ese escalon, una
 * marca con un primario a media luz tendria botones ilegibles.
 */
export function readableOn(background: string, preferred?: string): string {
  const candidates = [preferred, NEUTRALS.text, '#FFFFFF'];

  for (const candidate of candidates) {
    if (
      candidate !== undefined &&
      isHexColor(candidate) &&
      contrastRatio(background, candidate) >= AA_CONTRAST
    ) {
      return candidate.toUpperCase();
    }
  }

  // Nada de la paleta llega: se coge el extremo que mas contraste da.
  return contrastRatio(background, '#000000') >= contrastRatio(background, '#FFFFFF')
    ? '#000000'
    : '#FFFFFF';
}

function parseFeatures(raw: unknown): BrandFeatures {
  if (typeof raw !== 'object' || raw === null) return defaultFeatures;
  const source = raw as Record<string, unknown>;

  const read = (key: keyof BrandFeatures): boolean => {
    const value = source[key];
    // Solo un `false` explicito apaga una feature. Un valor ausente o raro
    // no debe esconder media app por accidente.
    return value === false ? false : defaultFeatures[key];
  };

  return {
    loyalty: read('loyalty'),
    promotions: read('promotions'),
    tips: read('tips'),
    favorites: read('favorites'),
    scheduling: read('scheduling'),
  };
}

export function buildColors(
  primaryInput: unknown,
  secondaryInput: unknown,
  accentInput: unknown,
): BrandColors {
  const primary = pickColor(primaryInput, FALLBACK.primary);
  const secondary = pickColor(secondaryInput, FALLBACK.secondary);
  const accent = pickColor(accentInput, FALLBACK.accent);

  return {
    background: secondary,
    surface: NEUTRALS.surface,
    primary,
    onPrimary: readableOn(primary, secondary),
    accent,
    onAccent: readableOn(accent),
    text: NEUTRALS.text,
    textMuted: NEUTRALS.textMuted,
    textFaint: NEUTRALS.textFaint,
    border: NEUTRALS.border,
    danger: NEUTRALS.danger,
    success: NEUTRALS.success,
  };
}

export const defaultBranding: Branding = {
  displayName: 'VIVA Juice and Coffee',
  logoUrl: null,
  colors: buildColors(FALLBACK.primary, FALLBACK.secondary, FALLBACK.accent),
  features: defaultFeatures,
};

/** Convierte la fila de `app_settings` en branding usable. */
export function normalizeBranding(row: AppSettingsInput | null | undefined): Branding {
  if (row === null || row === undefined) return defaultBranding;

  const displayName =
    typeof row.app_display_name === 'string' && row.app_display_name.trim() !== ''
      ? row.app_display_name.trim()
      : defaultBranding.displayName;

  const logoUrl =
    typeof row.logo_url === 'string' && row.logo_url.trim() !== '' ? row.logo_url.trim() : null;

  return {
    displayName,
    logoUrl,
    colors: buildColors(row.primary_color, row.secondary_color, row.accent_color),
    features: parseFeatures(row.features),
  };
}
