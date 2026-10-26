/**
 * Lectura del catalogo. Todo sale de la base: precios, disponibilidad,
 * destacados y limites de los grupos de modificadores. En este archivo no
 * hay ni un producto ni un precio escrito a mano.
 */

import { dataError } from '../domain/errors';
import type { ModifierGroup, ModifierOption } from '../domain/modifiers';
import type { SnapshotItem, SnapshotModifier, StoreCatalogSnapshot } from '../domain/cart';
import { localized, localizedOptional } from '../i18n';
import { strings } from '../strings';
import { getSupabase } from '../supabase';
import type { MenuCategory, MenuItemRow } from './types';

const MENU_COLUMNS =
  'id, store_id, clover_item_id, name, description, price_cents, category_id, ' +
  'category_name, category_sort, image_url, featured, sort_order, badge, ' +
  'is_available, unavailable_reason';

/** Traducciones del menú (0029). Sin la migración, el menú sale en inglés. */
const MENU_COLUMNS_0029 = ', i18n, category_i18n';
const GROUP_COLUMNS_0029 = ', i18n';
let menuHas0029 = true;

interface QueryResult<T> {
  readonly data: T | null;
  readonly error: { message: string; code?: string } | null;
}

/** Pide con las columnas de traducción y, si la base no las tiene, sin ellas. */
async function withI18n<T>(run: (withNew: boolean) => PromiseLike<QueryResult<T>>): Promise<QueryResult<T>> {
  if (!menuHas0029) return run(false);
  const first = await run(true);
  if (first.error?.code === '42703' || first.error?.code === 'PGRST204' || first.error?.code === 'PGRST200') {
    menuHas0029 = false;
    console.warn('[VIVA] El menú no tiene traducciones: corre entregas/01-base-viva-juice.sql en Supabase.');
    return run(false);
  }
  return first;
}

/** Nombre, descripción y categoría en el idioma de la app. */
function localizeRow(row: MenuItemRow & { i18n?: unknown; category_i18n?: unknown }): MenuItemRow {
  return {
    ...row,
    name: localized(row.name, row.i18n, 'name'),
    description: localizedOptional(row.description, row.i18n, 'description'),
    category_name:
      row.category_name === null ? null : localized(row.category_name, row.category_i18n, 'name'),
  };
}

const UNCATEGORIZED_ID = '__uncategorized__';

/**
 * El orden del menu lo manda la base y solo la base:
 * `catalog_categories.sort_order` entre categorias y
 * `app_item_overrides.sort_order` dentro de cada una.
 *
 * NO se ordena alfabeticamente. Un menu ordenado por la primera letra no
 * es el menu que el restaurante decidio; es el que salio.
 *
 * Tampoco se sube lo disponible por encima de lo agotado, aunque antes se
 * hiciera: eso reordena el menu por un dato que cambia durante el dia, y
 * el cliente que ya sabe donde esta su bebida deja de encontrarla. Un
 * producto agotado se queda en su sitio, atenuado.
 *
 * El desempate por `clover_item_id` no ordena nada: solo evita que dos
 * productos con el mismo `sort_order` bailen entre una carga y otra. Si se
 * nota, es que falta ponerles orden en la base.
 */
function compareItems(a: MenuItemRow, b: MenuItemRow): number {
  if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
  return a.clover_item_id < b.clover_item_id ? -1 : a.clover_item_id > b.clover_item_id ? 1 : 0;
}

/** Destacados de la Home (`app_item_overrides.featured`). */
export async function fetchFeaturedItems(storeId: string, limit = 6): Promise<MenuItemRow[]> {
  const { data, error } = await withI18n((withNew) =>
    getSupabase()
      .from('menu_items')
      .select(MENU_COLUMNS + (withNew ? MENU_COLUMNS_0029 : ''))
      .eq('store_id', storeId)
      .eq('featured', true)
      .eq('is_available', true)
      .order('sort_order', { ascending: true })
      .limit(limit)
      .returns<MenuItemRow[]>(),
  );

  if (error) throw dataError(error.message, error.code);
  return (data ?? []).map(localizeRow);
}

/** Menu completo, ya agrupado por categoria en el orden del catalogo. */
export async function fetchMenu(storeId: string): Promise<MenuCategory[]> {
  const { data, error } = await withI18n((withNew) =>
    getSupabase()
      .from('menu_items')
      .select(MENU_COLUMNS + (withNew ? MENU_COLUMNS_0029 : ''))
      .eq('store_id', storeId)
      .order('category_sort', { ascending: true, nullsFirst: false })
      .order('sort_order', { ascending: true })
      .order('clover_item_id', { ascending: true })
      .returns<MenuItemRow[]>(),
  );

  if (error) throw dataError(error.message, error.code);

  const byCategory = new Map<string, { name: string; sort: number; items: MenuItemRow[] }>();

  for (const item of (data ?? []).map(localizeRow)) {
    const id = item.category_id ?? UNCATEGORIZED_ID;
    let bucket = byCategory.get(id);
    if (bucket === undefined) {
      bucket = {
        name: item.category_name ?? strings.menu.uncategorized,
        sort: item.category_sort ?? Number.MAX_SAFE_INTEGER,
        items: [],
      };
      byCategory.set(id, bucket);
    }
    bucket.items.push(item);
  }

  return [...byCategory.entries()]
    .map(([id, bucket]) => ({
      id,
      name: bucket.name,
      sort: bucket.sort,
      items: bucket.items.slice().sort(compareItems),
    }))
    .filter((category) => category.items.length > 0)
    .sort((a, b) => a.sort - b.sort);
}

/**
 * Que productos NO se pueden pedir sin elegir algo.
 *
 * El "+" de la lista promete anadir al carrito de un toque, y para un
 * producto con un grupo obligatorio (`min_required > 0`: la leche de un
 * cafe, el pan de un sandwich) esa promesa es falsa. Con este conjunto la
 * tarjeta sabe, antes de que nadie toque nada, si su "+" anade o lleva a
 * elegir.
 *
 * Se filtra por tienda subiendo por `catalog_items`, y no con la lista de
 * ids del menu, para que pueda pedirse EN PARALELO con `fetchMenu` en vez
 * de despues: si no, el menu tardaria dos viajes en aparecer.
 *
 * La lectura publica de estas tablas la da RLS en la migracion 0004.
 */
export async function fetchItemsRequiringChoice(
  storeId: string,
): Promise<ReadonlySet<string> | null> {
  const { data, error } = await getSupabase()
    .from('catalog_item_modifier_groups')
    .select('item_id, catalog_items!inner(store_id), catalog_modifier_groups!inner(min_required)')
    .eq('catalog_items.store_id', storeId)
    .is('catalog_items.deleted_at', null)
    .gt('catalog_modifier_groups.min_required', 0)
    .is('catalog_modifier_groups.deleted_at', null)
    .returns<{ item_id: string }[]>();

  // Que esto falle no puede tumbar el menu, asi que no se lanza: se
  // devuelve `null`, que la pantalla lee como "no se sabe" y trata como
  // si todo necesitara eleccion. El "+" lleva al detalle, que es el
  // camino seguro; lo contrario seria anadir un cafe sin decir la leche.
  if (error) return null;
  return new Set((data ?? []).map((row) => row.item_id));
}

export async function fetchMenuItem(itemId: string): Promise<MenuItemRow | null> {
  const { data, error } = await withI18n((withNew) =>
    getSupabase()
      .from('menu_items')
      .select(MENU_COLUMNS + (withNew ? MENU_COLUMNS_0029 : ''))
      .eq('id', itemId)
      .maybeSingle<MenuItemRow>(),
  );

  if (error) throw dataError(error.message, error.code);
  return data === null ? null : localizeRow(data);
}

/** Forma anidada que devuelve el embedding de PostgREST. */
interface ItemGroupJoinRow {
  sort_order: number;
  catalog_modifier_groups: {
    id: string;
    clover_group_id: string;
    name: string;
    i18n?: unknown;
    min_required: number;
    max_allowed: number | null;
    sort_order: number;
    deleted_at: string | null;
    catalog_modifiers: {
      id: string;
      clover_modifier_id: string;
      name: string;
      i18n?: unknown;
      price_cents: number;
      available: boolean;
      sort_order: number;
      deleted_at: string | null;
    }[];
  } | null;
}

/**
 * Grupos de modificadores de un producto.
 *
 * La vista `menu_items` no los trae, asi que se leen de las tablas del
 * espejo, que tienen lectura publica en RLS (migracion 0004).
 */
export async function fetchItemModifierGroups(itemId: string): Promise<ModifierGroup[]> {
  const { data, error } = await withI18n((withNew) => {
    const extra = withNew ? GROUP_COLUMNS_0029 : '';
    return getSupabase()
      .from('catalog_item_modifier_groups')
      .select(
        'sort_order, catalog_modifier_groups!inner(' +
          `id, clover_group_id, name, min_required, max_allowed, sort_order, deleted_at${extra}, ` +
          `catalog_modifiers(id, clover_modifier_id, name, price_cents, available, sort_order, deleted_at${extra})` +
          ')',
      )
      .eq('item_id', itemId)
      .order('sort_order', { ascending: true })
      .returns<ItemGroupJoinRow[]>();
  });

  if (error) throw dataError(error.message, error.code);

  const groups: ModifierGroup[] = [];

  for (const row of data ?? []) {
    const group = row.catalog_modifier_groups;
    if (group === null || group.deleted_at !== null) continue;

    const modifiers: ModifierOption[] = group.catalog_modifiers
      .filter((modifier) => modifier.deleted_at === null)
      .map((modifier) => ({
        id: modifier.id,
        cloverModifierId: modifier.clover_modifier_id,
        name: localized(modifier.name, modifier.i18n, 'name'),
        priceCents: modifier.price_cents,
        available: modifier.available,
        sortOrder: modifier.sort_order,
      }));

    // Un grupo sin ninguna opcion viva no se pinta.
    if (modifiers.length === 0) continue;

    groups.push({
      id: group.id,
      cloverGroupId: group.clover_group_id,
      name: localized(group.name, group.i18n, 'name'),
      minRequired: group.min_required,
      maxAllowed: group.max_allowed,
      // El orden del producto manda sobre el orden global del grupo.
      sortOrder: row.sort_order,
      modifiers,
    });
  }

  return groups;
}

// ---------------------------------------------------------------------
// SNAPSHOT PARA CAMBIAR DE SUCURSAL
// ---------------------------------------------------------------------

interface SnapshotItemRow {
  id: string;
  clover_item_id: string;
  name: string;
  price_cents: number;
  is_available: boolean;
}

interface SnapshotModifierRow {
  id: string;
  clover_modifier_id: string;
  name: string;
  price_cents: number;
  available: boolean;
}

/**
 * Lee de la sucursal destino solo lo que hay en el carrito.
 *
 * Se consulta por `clover_item_id` y `clover_modifier_id` porque son lo
 * unico estable entre dos merchants: los uuid de nuestras tablas son por
 * sucursal. Lo que no vuelva es lo que esa sucursal no tiene, y eso es
 * justo lo que hay que ensenarle al cliente.
 */
export async function fetchCatalogSnapshot(
  storeId: string,
  cloverItemIds: readonly string[],
  cloverModifierIds: readonly string[],
): Promise<StoreCatalogSnapshot> {
  const supabase = getSupabase();

  const [itemsResult, modifiersResult] = await Promise.all([
    cloverItemIds.length === 0
      ? Promise.resolve({ data: [] as SnapshotItemRow[], error: null })
      : supabase
          .from('menu_items')
          .select('id, clover_item_id, name, price_cents, is_available')
          .eq('store_id', storeId)
          .in('clover_item_id', [...cloverItemIds])
          .returns<SnapshotItemRow[]>(),
    cloverModifierIds.length === 0
      ? Promise.resolve({ data: [] as SnapshotModifierRow[], error: null })
      : supabase
          .from('catalog_modifiers')
          .select('id, clover_modifier_id, name, price_cents, available')
          .eq('store_id', storeId)
          .is('deleted_at', null)
          .in('clover_modifier_id', [...cloverModifierIds])
          .returns<SnapshotModifierRow[]>(),
  ]);

  if (itemsResult.error) throw dataError(itemsResult.error.message, itemsResult.error.code);
  if (modifiersResult.error) {
    throw dataError(modifiersResult.error.message, modifiersResult.error.code);
  }

  const items: Record<string, SnapshotItem> = {};
  for (const row of itemsResult.data ?? []) {
    items[row.clover_item_id] = {
      id: row.id,
      name: row.name,
      priceCents: row.price_cents,
      isAvailable: row.is_available,
    };
  }

  const modifiers: Record<string, SnapshotModifier> = {};
  for (const row of modifiersResult.data ?? []) {
    modifiers[row.clover_modifier_id] = {
      id: row.id,
      name: row.name,
      priceCents: row.price_cents,
      available: row.available,
    };
  }

  return { storeId, items, modifiers };
}
