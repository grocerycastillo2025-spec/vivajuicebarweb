/**
 * Datos del Panel del negocio (migracion 0020).
 *
 * Todo pasa por la RLS: estas funciones no deciden quien puede que. Si el
 * usuario no es dueño, la base devuelve cero filas o rechaza la escritura;
 * el panel solo traduce eso a un mensaje. Los cambios de estado de un
 * pedido van por `set_order_status`, que valida la transicion en el
 * servidor.
 */

import { dataError } from '../domain/errors';
import type { Cents } from '../domain/money';
import type { OrderStatus } from '../domain/order';
import { getSupabase } from '../supabase';
import { localizeOrders } from './order-names';
import { MISSING_SQL_FILE, ORDER_COLUMNS_0026, STORE_COLUMNS_0026, with0026 } from './new-columns';
import { ITEM_COLUMNS, ORDER_COLUMNS, type OrderWithItems } from './orders';
import type { AppSettingsRow, StoreHoursRow, StoreRow } from './types';

export type MemberRole = 'owner' | 'staff';

export interface Membership {
  readonly restaurantId: string;
  readonly role: MemberRole;
}

function fail(error: { message: string; code?: string } | null): void {
  if (error) throw dataError(error.message, error.code);
}

// ---------------------------------------------------------------------
// QUIEN SOY EN ESTE NEGOCIO
// ---------------------------------------------------------------------

export async function fetchMembership(
  userId: string,
  restaurantId: string,
): Promise<Membership | null> {
  const { data, error } = await getSupabase()
    .from('restaurant_members')
    .select('restaurant_id, role')
    .eq('user_id', userId)
    .eq('restaurant_id', restaurantId)
    .maybeSingle<{ restaurant_id: string; role: MemberRole }>();

  // Una base sin la 0020 no tiene la tabla: no es un error del usuario,
  // es que el panel no existe todavia en ese proyecto.
  if (error?.code === '42P01' || error?.code === 'PGRST205') return null;
  fail(error);
  return data === null ? null : { restaurantId: data.restaurant_id, role: data.role };
}

const ADMIN_STORE_COLUMNS =
  'id, restaurant_id, name, slug, status, address_line1, address_line2, city, state, ' +
  'postal_code, latitude, longitude, phone, timezone, pickup_enabled, delivery_enabled, ' +
  'surcharge_policy, surcharge_rate, payments_mode, catalog_source, currency, payment_options, transfer_info';

export async function fetchAdminStores(restaurantId: string): Promise<StoreRow[]> {
  const { data, error } = await with0026((withNew) =>
    getSupabase()
      .from('stores')
      .select(ADMIN_STORE_COLUMNS + (withNew ? STORE_COLUMNS_0026 : ''))
      .eq('restaurant_id', restaurantId)
      .is('deleted_at', null)
      .order('name')
      .returns<StoreRow[]>(),
  );
  fail(error);
  return data ?? [];
}

// ---------------------------------------------------------------------
// PEDIDOS
// ---------------------------------------------------------------------

/**
 * Pedidos en curso de cualquier dia, mas los cerrados de hoy (en la zona
 * de la sucursal). Lo que el mostrador necesita ver en un turno.
 */
export async function fetchStoreOrders(storeId: string, businessDay: string): Promise<OrderWithItems[]> {
  const columns = (withNew: boolean): string =>
    `${ORDER_COLUMNS}${withNew ? ORDER_COLUMNS_0026 : ''}, ${ITEM_COLUMNS}`;
  const supabase = getSupabase();

  const [active, today] = await Promise.all([
    with0026((withNew) =>
      supabase
        .from('orders')
        .select(columns(withNew))
        .eq('store_id', storeId)
        .in('status', ['confirmed', 'preparing', 'ready'])
        .order('pickup_at', { ascending: true })
        .limit(200)
        .returns<OrderWithItems[]>(),
    ),
    with0026((withNew) =>
      supabase
        .from('orders')
        .select(columns(withNew))
        .eq('store_id', storeId)
        .eq('business_day', businessDay)
        .in('status', ['completed', 'canceled'])
        .order('created_at', { ascending: false })
        .limit(100)
        .returns<OrderWithItems[]>(),
    ),
  ]);

  fail(active.error);
  fail(today.error);
  // El panel va en español: los productos también.
  return localizeOrders([...(active.data ?? []), ...(today.data ?? [])], 'es');
}

export async function setOrderStatus(
  orderId: string,
  status: OrderStatus,
  reason: string | null = null,
): Promise<void> {
  const { error } = await getSupabase().rpc('set_order_status', {
    p_order_id: orderId,
    p_status: status,
    p_reason: reason,
  });
  fail(error);
}

// ---------------------------------------------------------------------
// MENU
// ---------------------------------------------------------------------

export interface AdminCategory {
  readonly id: string;
  readonly name: string;
  readonly sort_order: number;
  /** Nombre en español (0029); vacío = se muestra el inglés. */
  readonly name_es?: string;
}

export interface AdminProduct {
  readonly id: string;
  readonly clover_item_id: string;
  readonly category_id: string | null;
  readonly name: string;
  readonly price_cents: Cents;
  readonly available: boolean;
  /** Traducción al español (0029). */
  readonly name_es: string;
  readonly description_es: string;
  /** Impuesto (0030): si lo cobra y su tasa propia (null = la de la sucursal). */
  readonly taxable: boolean;
  readonly tax_rate_override: number | null;
  // De `app_item_overrides`
  readonly description: string | null;
  readonly image_url: string | null;
  readonly featured: boolean;
  readonly badge: string | null;
  readonly sort_order: number;
}

export interface AdminCatalog {
  readonly categories: AdminCategory[];
  readonly products: AdminProduct[];
}

interface ItemRow {
  id: string;
  clover_item_id: string;
  category_id: string | null;
  name: string;
  alternate_name: string | null;
  price_cents: Cents;
  available: boolean;
  i18n?: unknown;
  taxable?: boolean;
  tax_rate_override?: number | string | null;
}

interface OverrideRow {
  clover_item_id: string;
  marketing_copy: string | null;
  image_url: string | null;
  featured: boolean;
  badge: string | null;
  sort_order: number;
}

/** Texto en español guardado en `i18n` (0029), o ''. */
function spanish(i18n: unknown, field: string): string {
  if (i18n === null || typeof i18n !== 'object') return '';
  const es = (i18n as Record<string, unknown>)['es'];
  if (es === null || typeof es !== 'object') return '';
  const value = (es as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : '';
}

/** {"es": {...}} sin campos vacíos. */
function spanishI18n(fields: Record<string, string>): Record<string, Record<string, string>> {
  const es: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) if (value.trim() !== '') es[key] = value.trim();
  return Object.keys(es).length === 0 ? {} : { es };
}

const isMissingColumn = (error: { code?: string } | null): boolean =>
  error?.code === '42703' || error?.code === 'PGRST204';

/** El producto sin las columnas de 0029/0030, para una base que aún no las tiene. */
function withoutNewColumns(item: Record<string, unknown>): Record<string, unknown> {
  const { i18n: _i18n, taxable: _taxable, tax_rate_override: _rate, ...rest } = item;
  return rest;
}

export interface TaxSettings {
  /** Fracción: 0.06625 = 6.625%. */
  readonly taxRate: number;
  /** Fracción por forma de pago: {"stripe": 0.03}. Sin entrada = sin recargo. */
  readonly surcharges: Record<string, number>;
}

/** Impuesto de la sucursal y recargo por forma de pago (0030). */
export async function updateTaxSettings(storeId: string, settings: TaxSettings): Promise<void> {
  const surcharges: Record<string, number> = {};
  for (const [key, value] of Object.entries(settings.surcharges)) if (value > 0) surcharges[key] = value;
  const { error } = await getSupabase()
    .from('stores')
    .update({ tax_rate: settings.taxRate, payment_surcharges: surcharges })
    .eq('id', storeId);
  if (isMissingColumn(error)) {
    throw dataError(`Falta correr ${MISSING_SQL_FILE} en Supabase (SQL Editor → Run).`, error?.code);
  }
  fail(error);
}

export async function fetchAdminCatalog(storeId: string): Promise<AdminCatalog> {
  const supabase = getSupabase();
  const categoriesQuery = (withI18n: boolean) =>
    supabase
      .from('catalog_categories')
      .select(withI18n ? 'id, name, sort_order, i18n' : 'id, name, sort_order')
      .eq('store_id', storeId)
      .is('deleted_at', null)
      .order('sort_order')
      .order('name')
      .returns<(AdminCategory & { i18n?: unknown })[]>();
  // Columnas nuevas por nivel: 2 = traducción + impuesto (0029, 0030),
  // 1 = solo traducción, 0 = ninguna.
  const itemsQuery = (level: number) =>
    supabase
      .from('catalog_items')
      .select(
        'id, clover_item_id, category_id, name, alternate_name, price_cents, available' +
          (level >= 1 ? ', i18n' : '') +
          (level >= 2 ? ', taxable, tax_rate_override' : ''),
      )
      .eq('store_id', storeId)
      .is('deleted_at', null)
      .returns<ItemRow[]>();
  const [firstCategories, firstItems, overrides] = await Promise.all([
    categoriesQuery(true),
    itemsQuery(2),
    supabase
      .from('app_item_overrides')
      .select('clover_item_id, marketing_copy, image_url, featured, badge, sort_order')
      .eq('store_id', storeId)
      .returns<OverrideRow[]>(),
  ]);
  // Base sin la 0029: se edita solo en inglés.
  const categories = isMissingColumn(firstCategories.error) ? await categoriesQuery(false) : firstCategories;
  let items = firstItems;
  if (isMissingColumn(items.error)) items = await itemsQuery(1);
  if (isMissingColumn(items.error)) items = await itemsQuery(0);

  fail(categories.error);
  fail(items.error);
  fail(overrides.error);

  const byItem = new Map((overrides.data ?? []).map((o) => [o.clover_item_id, o]));
  const products = (items.data ?? [])
    .map((item): AdminProduct => {
      const o = byItem.get(item.clover_item_id);
      return {
        id: item.id,
        clover_item_id: item.clover_item_id,
        category_id: item.category_id,
        name: item.name,
        price_cents: item.price_cents,
        available: item.available,
        name_es: spanish(item.i18n, 'name'),
        taxable: item.taxable !== false,
        tax_rate_override:
          item.tax_rate_override === null || item.tax_rate_override === undefined ? null : Number(item.tax_rate_override),
        description_es: spanish(item.i18n, 'description'),
        description: o?.marketing_copy ?? item.alternate_name,
        image_url: o?.image_url ?? null,
        featured: o?.featured ?? false,
        badge: o?.badge ?? null,
        sort_order: o?.sort_order ?? 0,
      };
    })
    .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, 'es'));

  return {
    categories: (categories.data ?? []).map(({ i18n, ...c }) => ({ ...c, name_es: spanish(i18n, 'name') })),
    products,
  };
}

export async function saveCategory(
  storeId: string,
  category: { id?: string; name: string; sort_order: number; name_es?: string },
): Promise<void> {
  const supabase = getSupabase();
  const row: Record<string, unknown> = { name: category.name.trim(), sort_order: category.sort_order };
  // Solo se toca la traducción si la pantalla la mandó (al reordenar no).
  if (category.name_es !== undefined) row['i18n'] = spanishI18n({ name: category.name_es });
  const write = (values: Record<string, unknown>) =>
    category.id === undefined
      ? supabase.from('catalog_categories').insert({ store_id: storeId, ...values })
      : supabase.from('catalog_categories').update(values).eq('id', category.id);
  let { error } = await write(row);
  if (isMissingColumn(error) && 'i18n' in row) {
    const { i18n: _sinTraduccion, ...sinI18n } = row;
    ({ error } = await write(sinI18n));
  }
  fail(error);
}

/**
 * Borrado suave: los pedidos viejos guardan su propia copia del nombre,
 * asi que no se pierde historial. Los productos de la categoria quedan
 * "sin categoria" (salen al final del menu, en "Más").
 */
export async function deleteCategory(categoryId: string): Promise<void> {
  const supabase = getSupabase();
  const detach = await supabase
    .from('catalog_items')
    .update({ category_id: null })
    .eq('category_id', categoryId);
  fail(detach.error);
  const { error } = await supabase
    .from('catalog_categories')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', categoryId);
  fail(error);
}

export interface ProductInput {
  readonly id?: string;
  readonly clover_item_id?: string;
  readonly category_id: string | null;
  readonly name: string;
  readonly price_cents: Cents;
  readonly available: boolean;
  readonly description: string;
  readonly name_es: string;
  readonly description_es: string;
  readonly taxable: boolean;
  readonly tax_rate_override: number | null;
  readonly image_url: string | null;
  readonly featured: boolean;
  readonly badge: string;
  readonly sort_order: number;
}

/** Guarda el producto (catalogo) y su presentacion (override). */
export async function saveProduct(storeId: string, input: ProductInput): Promise<string> {
  const supabase = getSupabase();
  const item: Record<string, unknown> = {
    store_id: storeId,
    category_id: input.category_id,
    name: input.name.trim(),
    price_cents: input.price_cents,
    available: input.available,
    i18n: spanishI18n({ name: input.name_es, description: input.description_es }),
    taxable: input.taxable,
    tax_rate_override: input.tax_rate_override,
  };

  let cloverItemId = input.clover_item_id;
  let id = input.id;

  if (id === undefined) {
    const insert = (values: Record<string, unknown>) =>
      supabase
        .from('catalog_items')
        .insert(values)
        .select('id, clover_item_id')
        .single<{ id: string; clover_item_id: string }>();
    let { data, error } = await insert(item);
    if (isMissingColumn(error)) ({ data, error } = await insert(withoutNewColumns(item)));
    fail(error);
    id = data?.id;
    cloverItemId = data?.clover_item_id;
  } else {
    const productId = id;
    const update = (values: Record<string, unknown>) =>
      supabase.from('catalog_items').update(values).eq('id', productId);
    let { error } = await update(item);
    if (isMissingColumn(error)) ({ error } = await update(withoutNewColumns(item)));
    fail(error);
  }

  if (id === undefined || cloverItemId === undefined) {
    throw dataError('La base no devolvio el producto guardado');
  }

  const { error } = await supabase.from('app_item_overrides').upsert(
    {
      store_id: storeId,
      clover_item_id: cloverItemId,
      marketing_copy: input.description.trim() === '' ? null : input.description.trim(),
      image_url: input.image_url,
      featured: input.featured,
      badge: input.badge.trim() === '' ? null : input.badge.trim(),
      sort_order: input.sort_order,
    },
    { onConflict: 'store_id,clover_item_id' },
  );
  fail(error);
  return id;
}

export async function setProductAvailable(productId: string, available: boolean): Promise<void> {
  const { error } = await getSupabase()
    .from('catalog_items')
    .update({ available })
    .eq('id', productId);
  fail(error);
}

export async function deleteProduct(productId: string): Promise<void> {
  const { error } = await getSupabase()
    .from('catalog_items')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', productId);
  fail(error);
}

// ---------------------------------------------------------------------
// FOTOS
// ---------------------------------------------------------------------

/**
 * Sube una imagen y devuelve su URL publica. La carpeta es la de la
 * sucursal o la del negocio: la policy de storage de la 0020 solo deja
 * escribir en las propias.
 */
export async function uploadImage(
  bucket: 'menu-images' | 'branding' | 'stories',
  folder: string,
  blob: Blob,
  extension: string,
): Promise<string> {
  const supabase = getSupabase();
  const random = Math.random().toString(36).slice(2, 10);
  const path = `${folder}/${Date.now().toString(36)}-${random}.${extension}`;

  const { error } = await supabase.storage.from(bucket).upload(path, blob, {
    contentType: blob.type || `image/${extension}`,
    cacheControl: '31536000',
    upsert: false,
  });
  fail(error);

  return supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl;
}

// ---------------------------------------------------------------------
// NEGOCIO
// ---------------------------------------------------------------------

export interface StoreInput {
  readonly name: string;
  readonly phone: string | null;
  readonly address_line1: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly postal_code: string | null;
  readonly pickup_enabled: boolean;
}

export async function updateStore(storeId: string, input: StoreInput): Promise<void> {
  const { error } = await getSupabase().from('stores').update(input).eq('id', storeId);
  fail(error);
}

export async function fetchAdminHours(storeId: string): Promise<StoreHoursRow[]> {
  const { data, error } = await getSupabase()
    .from('store_hours')
    .select('weekday, opens_at, closes_at')
    .eq('store_id', storeId)
    .order('weekday')
    .order('opens_at')
    .returns<StoreHoursRow[]>();
  fail(error);
  return data ?? [];
}

/** Reemplaza la semana entera: un tramo por dia abierto. */
export async function replaceHours(
  storeId: string,
  days: readonly { weekday: number; opens_at: string; closes_at: string }[],
): Promise<void> {
  const supabase = getSupabase();
  const removed = await supabase.from('store_hours').delete().eq('store_id', storeId);
  fail(removed.error);
  if (days.length === 0) return;
  const { error } = await supabase
    .from('store_hours')
    .insert(days.map((day) => ({ store_id: storeId, ...day })));
  fail(error);
}

export async function fetchAdminSettings(restaurantId: string): Promise<AppSettingsRow | null> {
  const { data, error } = await getSupabase()
    .from('app_settings')
    .select(
      'restaurant_id, app_display_name, logo_url, primary_color, secondary_color, accent_color, features',
    )
    .eq('restaurant_id', restaurantId)
    .maybeSingle<AppSettingsRow>();
  fail(error);
  return data;
}

export async function updateSettings(
  restaurantId: string,
  input: {
    app_display_name: string;
    logo_url: string | null;
    primary_color: string;
    secondary_color: string;
    accent_color: string;
  },
): Promise<void> {
  const { error } = await getSupabase()
    .from('app_settings')
    .update(input)
    .eq('restaurant_id', restaurantId);
  fail(error);
}

// ---------------------------------------------------------------------
// FORMAS DE PAGO (0024)
// ---------------------------------------------------------------------

export interface PaymentSettings {
  readonly options: Record<string, boolean>;
  /** Ya normalizado (correo en minúsculas o +1XXXXXXXXXX), o null. */
  readonly zelleRecipient: string | null;
  readonly zelleName: string;
}

const blankToNull = (value: string): string | null => (value.trim() === '' ? null : value.trim());

export async function updatePaymentOptions(storeId: string, settings: PaymentSettings): Promise<void> {
  const { error } = await getSupabase()
    .from('stores')
    .update({
      payment_options: settings.options,
      zelle_recipient: settings.zelleRecipient,
      zelle_name: blankToNull(settings.zelleName),
    })
    .eq('id', storeId);
  // La app ya se publicó pero la base aún no tiene la 0029.
  if (error?.code === 'PGRST204' || error?.code === '42703') {
    throw dataError(
      `Falta correr ${MISSING_SQL_FILE} en Supabase (SQL Editor → Run).`,
      error.code,
    );
  }
  fail(error);
}

/** El cajero o el dueño marca que llegó el pago (0026). */
export async function setOrderPaid(orderId: string, paid: boolean): Promise<void> {
  const { error } = await getSupabase().rpc('set_order_paid', { p_order_id: orderId, p_paid: paid });
  fail(error);
}

/** Proveedores en linea con cuenta activa (los conecta la plataforma). */
export async function fetchConnectedProviders(storeId: string): Promise<Set<string>> {
  const { data, error } = await getSupabase()
    .from('payment_provider_accounts')
    .select('provider, status')
    .eq('store_id', storeId)
    .returns<{ provider: string; status: string }[]>();
  if (error?.code === '42P01' || error?.code === 'PGRST205') return new Set();
  fail(error);
  return new Set((data ?? []).filter((row) => row.status === 'active').map((row) => row.provider));
}

// ---------------------------------------------------------------------
// EQUIPO (0025)
// ---------------------------------------------------------------------

export interface TeamMember {
  readonly user_id: string;
  readonly email: string;
  readonly name: string | null;
  readonly role: MemberRole;
}

export async function fetchTeam(restaurantId: string): Promise<TeamMember[]> {
  const { data, error } = await getSupabase().rpc('list_team', { p_restaurant_id: restaurantId });
  fail(error);
  return (data ?? []) as TeamMember[];
}

export async function addTeamMember(restaurantId: string, email: string, role: MemberRole): Promise<void> {
  const { error } = await getSupabase().rpc('add_team_member', {
    p_restaurant_id: restaurantId,
    p_email: email.trim(),
    p_role: role,
  });
  fail(error);
}

export async function removeTeamMember(restaurantId: string, userId: string): Promise<void> {
  const { error } = await getSupabase().rpc('remove_team_member', {
    p_restaurant_id: restaurantId,
    p_user_id: userId,
  });
  fail(error);
}
