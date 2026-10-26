/**
 * Formas de fila que devuelve PostgREST. Se escriben a mano porque
 * `packages/shared-types/src/database.ts` lo genera `pnpm db:types` contra
 * el proyecto enlazado y no esta versionado.
 *
 * Los `bigint` de Postgres (todos los `*_cents`) llegan como number.
 */

import type { Cents } from '../domain/money';

/** Fila de la vista `public.menu_items` (migracion 0002). */
export interface MenuItemRow {
  id: string;
  store_id: string;
  clover_item_id: string;
  name: string;
  description: string | null;
  price_cents: Cents;
  category_id: string | null;
  category_name: string | null;
  category_sort: number | null;
  image_url: string | null;
  featured: boolean;
  sort_order: number;
  badge: string | null;
  is_available: boolean;
  unavailable_reason: string | null;
}

export interface StoreRow {
  id: string;
  restaurant_id: string;
  name: string;
  slug: string;
  status: string;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  latitude: number | null;
  longitude: number | null;
  phone: string | null;
  timezone: string;
  pickup_enabled: boolean;
  delivery_enabled: boolean;
  // Recargo por tarjeta (migracion 0011). `surcharge_rate` es una
  // FRACCION (0.03 = 3 %), como la da Clover, y `null` significa "sin
  // consultar todavia", que NO es lo mismo que "sin recargo". Ojo con
  // `catalog_tax_rates.rate`, que va en milesimas de porcentaje: mezclar
  // las dos escalas da un numero cien veces mayor.
  surcharge_policy: string;
  surcharge_rate: number | null;
  // Migracion 0020. `counter` = se paga en el mostrador al recoger.
  payments_mode?: 'simulated' | 'live' | 'counter';
  catalog_source?: 'clover' | 'own';
  currency?: string;
  // Migracion 0024.
  payment_options?: Partial<Record<string, boolean>>;
  transfer_info?: string | null;
  // Migracion 0026.
  transfer_bank?: string | null;
  transfer_holder?: string | null;
  transfer_clabe?: string | null;
  mercadopago_link?: string | null;
  // Migracion 0029: Zelle.
  zelle_recipient?: string | null;
  zelle_name?: string | null;
  // Migracion 0030: impuesto de la sucursal (fraccion) y recargo por forma de pago.
  tax_rate?: number | string | null;
  payment_surcharges?: Record<string, number> | null;
}

export interface StoreHoursRow {
  weekday: number;
  opens_at: string;
  closes_at: string;
}

export interface AppSettingsRow {
  restaurant_id: string;
  app_display_name: string;
  logo_url: string | null;
  primary_color: string;
  secondary_color: string;
  accent_color: string;
  features: Record<string, boolean>;
}

export interface LoyaltyProgramRow {
  restaurant_id: string;
  enabled: boolean;
  points_per_dollar: number;
  min_points_to_redeem: number;
  // Migracion 0021: puntos por visita (QR del local).
  points_per_visit?: number;
  visit_cooldown_hours?: number;
  // 0032: el cliente también puede escanear el QR del local.
  self_checkin?: boolean;
}

export interface LoyaltyAccountRow {
  points_balance: number;
  lifetime_points: number;
  tier: string;
}

export interface RewardRow {
  id: string;
  name: string;
  description: string | null;
  image_url: string | null;
  cost_points: number;
  // 0032: {"es": {"name", "description"}}
  i18n?: unknown;
}

export interface ProfileRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  marketing_opt_in: boolean;
  default_store_id: string | null;
}

/** Agrupacion que consume la pantalla de menu. */
export interface MenuCategory {
  readonly id: string;
  readonly name: string;
  readonly sort: number;
  readonly items: readonly MenuItemRow[];
}
