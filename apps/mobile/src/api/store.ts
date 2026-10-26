/** Sucursales, horarios y branding de la marca. */

import { dataError } from '../domain/errors';
import { STORE_COLUMNS_0026, with0026 } from './new-columns';
import { getSupabase } from '../supabase';
import type { AppSettingsRow, StoreHoursRow, StoreRow } from './types';

// `latitude`/`longitude` se leen para poder abrir la sucursal en el mapa.
// Son nulables: sin ellas se busca por direccion (`src/domain/maps.ts`).
//
// `surcharge_policy` y `surcharge_rate` no son opcionales aunque hoy
// esten vacias: sin ellas la app no puede divulgar el recargo por tarjeta
// antes de cobrar, y en Nueva Jersey eso es obligatorio (P.L. 2023,
// c.146). La policy `stores_public_read` ya devuelve la fila entera, asi
// que pedirlas no necesita ningun grant nuevo (0011).
const STORE_COLUMNS =
  'id, restaurant_id, name, slug, status, address_line1, address_line2, city, state, ' +
  'postal_code, latitude, longitude, phone, timezone, pickup_enabled, delivery_enabled, ' +
  'surcharge_policy, surcharge_rate, payments_mode, catalog_source, currency, payment_options, transfer_info';

export interface StoreInfo {
  readonly store: StoreRow;
  readonly hours: readonly StoreHoursRow[];
}

/**
 * Sucursales visibles de la marca.
 *
 * RLS ya filtra a las activas o en pausa de un restaurante activo, asi que
 * lo que vuelva es exactamente lo que el cliente puede elegir.
 */
export async function fetchStores(restaurantId: string): Promise<StoreRow[]> {
  const { data, error } = await with0026((withNew) =>
    getSupabase()
      .from('stores')
      .select(STORE_COLUMNS + (withNew ? STORE_COLUMNS_0026 : ''))
      .eq('restaurant_id', restaurantId)
      .order('name', { ascending: true })
      .returns<StoreRow[]>(),
  );

  if (error) throw dataError(error.message, error.code);
  return data ?? [];
}

export async function fetchStore(storeId: string): Promise<StoreInfo> {
  const supabase = getSupabase();

  const [storeResult, hoursResult] = await Promise.all([
    with0026((withNew) =>
      supabase
        .from('stores')
        .select(STORE_COLUMNS + (withNew ? STORE_COLUMNS_0026 : ''))
        .eq('id', storeId)
        .maybeSingle<StoreRow>(),
    ),
    supabase
      .from('store_hours')
      .select('weekday, opens_at, closes_at')
      .eq('store_id', storeId)
      .order('weekday', { ascending: true })
      .returns<StoreHoursRow[]>(),
  ]);

  if (storeResult.error) throw dataError(storeResult.error.message, storeResult.error.code);
  if (storeResult.data === null) {
    throw dataError(
      `La sucursal ${storeId} no existe o no es publica. ` +
        'Revisa que el seed se aplico y que la tienda esta en estado active.',
    );
  }
  if (hoursResult.error) throw dataError(hoursResult.error.message, hoursResult.error.code);

  return { store: storeResult.data, hours: hoursResult.data ?? [] };
}

export async function fetchStoreHours(storeId: string): Promise<StoreHoursRow[]> {
  const { data, error } = await getSupabase()
    .from('store_hours')
    .select('weekday, opens_at, closes_at')
    .eq('store_id', storeId)
    .order('weekday', { ascending: true })
    .returns<StoreHoursRow[]>();

  if (error) throw dataError(error.message, error.code);
  return data ?? [];
}

export interface PickupConfigRow {
  slot_minutes: number;
  lead_time_minutes: number;
  max_orders_per_slot: number;
  max_days_ahead: number;
  asap_enabled: boolean;
}

export interface ClosureRow {
  starts_at: string;
  ends_at: string;
  reason: string | null;
}

/** Todo lo que hace falta para calcular las franjas de recogida. */
export async function fetchPickupSetup(
  storeId: string,
): Promise<{ config: PickupConfigRow | null; hours: StoreHoursRow[]; closures: ClosureRow[] }> {
  const supabase = getSupabase();
  const horizon = new Date(Date.now() + 21 * 24 * 3600 * 1000).toISOString();

  const [configResult, hoursResult, closuresResult] = await Promise.all([
    supabase
      .from('store_pickup_config')
      .select('slot_minutes, lead_time_minutes, max_orders_per_slot, max_days_ahead, asap_enabled')
      .eq('store_id', storeId)
      .maybeSingle<PickupConfigRow>(),
    supabase
      .from('store_hours')
      .select('weekday, opens_at, closes_at')
      .eq('store_id', storeId)
      .order('weekday', { ascending: true })
      .returns<StoreHoursRow[]>(),
    supabase
      .from('store_closures')
      .select('starts_at, ends_at, reason')
      .eq('store_id', storeId)
      .lt('starts_at', horizon)
      .gt('ends_at', new Date().toISOString())
      .returns<ClosureRow[]>(),
  ]);

  if (configResult.error) throw dataError(configResult.error.message, configResult.error.code);
  if (hoursResult.error) throw dataError(hoursResult.error.message, hoursResult.error.code);
  if (closuresResult.error)
    throw dataError(closuresResult.error.message, closuresResult.error.code);

  return {
    config: configResult.data,
    hours: hoursResult.data ?? [],
    closures: closuresResult.data ?? [],
  };
}

export async function fetchBranding(restaurantId: string): Promise<AppSettingsRow | null> {
  const { data, error } = await getSupabase()
    .from('app_settings')
    .select(
      'restaurant_id, app_display_name, logo_url, primary_color, secondary_color, accent_color, features',
    )
    .eq('restaurant_id', restaurantId)
    .maybeSingle<AppSettingsRow>();

  if (error) throw dataError(error.message, error.code);
  return data;
}

const WEEKDAYS = [
  'Domingo',
  'Lunes',
  'Martes',
  'Miercoles',
  'Jueves',
  'Viernes',
  'Sabado',
] as const;

export function weekdayName(weekday: number): string {
  return WEEKDAYS[weekday] ?? '';
}

/** "06:00:00" -> "6:00 AM". Sin dependencias de fecha. */
export function formatClock(value: string): string {
  const [rawHour = '0', rawMinute = '00'] = value.split(':');
  const hour = Number.parseInt(rawHour, 10);
  if (!Number.isFinite(hour)) return value;

  const suffix = hour >= 12 ? 'PM' : 'AM';
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return `${display}:${rawMinute.padStart(2, '0')} ${suffix}`;
}

/** Horario de hoy en la zona de la sucursal. */
export function todayHours(
  hours: readonly StoreHoursRow[],
  timeZone: string,
  now: Date = new Date(),
): StoreHoursRow | null {
  let weekday: number;
  try {
    const label = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(now);
    const index = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(label);
    weekday = index === -1 ? now.getDay() : index;
  } catch {
    weekday = now.getDay();
  }

  return hours.find((entry) => entry.weekday === weekday) ?? null;
}

/** Direccion en una linea, para las tarjetas de sucursal. */
export function formatAddress(store: StoreRow): string {
  return [store.address_line1, store.city, store.state, store.postal_code]
    .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
    .join(', ');
}

export interface ItemTax {
  readonly taxable: boolean;
  readonly taxRateOverride: number | null;
}

/**
 * Qué productos del carrito cobran impuesto (0030), para el estimado del
 * checkout. Si la base aún no tiene la 0030, todos "cobran" pero la tasa de
 * la sucursal tampoco existe: el estimado queda sin impuesto, igual que lo
 * que calcularía la base.
 */
export async function fetchItemTax(storeId: string, cloverItemIds: readonly string[]): Promise<Map<string, ItemTax>> {
  const out = new Map<string, ItemTax>();
  if (cloverItemIds.length === 0) return out;
  const { data, error } = await getSupabase()
    .from('catalog_items')
    .select('clover_item_id, taxable, tax_rate_override')
    .eq('store_id', storeId)
    .in('clover_item_id', [...new Set(cloverItemIds)])
    .returns<{ clover_item_id: string; taxable: boolean; tax_rate_override: number | string | null }[]>();
  if (error !== null) return out;
  for (const row of data ?? []) {
    out.set(row.clover_item_id, {
      taxable: row.taxable !== false,
      taxRateOverride: row.tax_rate_override === null ? null : Number(row.tax_rate_override),
    });
  }
  return out;
}
