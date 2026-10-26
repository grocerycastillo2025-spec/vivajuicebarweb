/**
 * Configuracion que llega por variables de entorno EXPO_PUBLIC_*.
 *
 * `process.env.EXPO_PUBLIC_X` lo sustituye el bundler en tiempo de
 * compilacion, asi que hay que escribirlo literal: una lectura dinamica
 * (`process.env[nombre]`) se queda vacia en release.
 *
 * Lo que se fija en el build es la MARCA, no la sucursal (§19 del
 * documento de arquitectura: una app por marca). Las sucursales salen de
 * la base y las elige el cliente en tiempo de ejecucion, porque cada una
 * es un merchant distinto de Clover con su propio catalogo.
 */

import Constants from 'expo-constants';

import { assertPublishableKey } from './domain/keys';

/** Marca por defecto: VIVA Juice and Coffee, la del seed (supabase/seed/viva_juice_us.sql). */
const FALLBACK_RESTAURANT_ID = '11111111-1111-4111-8111-111111111111';

function extraString(key: string): string | undefined {
  const extra = Constants.expoConfig?.extra;
  if (extra === undefined || extra === null) return undefined;
  const value = (extra as Record<string, unknown>)[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export interface AppEnv {
  readonly supabaseUrl: string;
  readonly supabaseKey: string;
  readonly restaurantId: string;
  readonly appEnv: string;
}

/**
 * Moneda e idioma del negocio. No dependen de Supabase, asi que no pasan
 * por `readEnv()` (que lanza si faltan credenciales): se leen siempre.
 */
export function readLocaleConfig(): { currency: string; locale: string } {
  const currency =
    (process.env.EXPO_PUBLIC_CURRENCY ?? '').trim().toUpperCase() ||
    extraString('currency') ||
    'USD';
  const locale = (process.env.EXPO_PUBLIC_LOCALE ?? '').trim() || extraString('locale') || 'en-US';
  return { currency, locale };
}

export class MissingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingConfigError';
  }
}

let cached: AppEnv | null = null;

export function readEnv(): AppEnv {
  if (cached !== null) return cached;

  const supabaseUrl = (
    process.env.EXPO_PUBLIC_SUPABASE_URL ??
    extraString('supabaseUrl') ??
    ''
  ).trim();

  // Se acepta el nombre nuevo y el que ya usaba `.env.example` de la fase 1.
  const rawKey = (
    process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ??
    extraString('supabaseKey') ??
    ''
  ).trim();

  if (supabaseUrl === '' || rawKey === '') {
    throw new MissingConfigError(
      'Faltan las credenciales de Supabase. Copia apps/mobile/.env.example a ' +
        '.env.local (aqui o en la raiz del repo) y rellena ' +
        'EXPO_PUBLIC_SUPABASE_URL y EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY.',
    );
  }

  cached = {
    supabaseUrl,
    // Corta el arranque si alguien pego la service_role.
    supabaseKey: assertPublishableKey(rawKey),
    restaurantId:
      (process.env.EXPO_PUBLIC_RESTAURANT_ID ?? '').trim() ||
      extraString('restaurantId') ||
      FALLBACK_RESTAURANT_ID,
    appEnv: (process.env.EXPO_PUBLIC_APP_ENV ?? '').trim() || 'development',
  };

  return cached;
}

/** Solo para tests y para la pantalla de error, que reintenta la lectura. */
export function resetEnvCache(): void {
  cached = null;
}
