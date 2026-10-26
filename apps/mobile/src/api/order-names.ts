/**
 * Nombres de los productos de un pedido en el idioma de quien lo ve.
 *
 * El pedido guarda una copia del nombre al momento de pedir
 * (`name_snapshot`, en inglés, el texto base del menú). Para enseñarlo en
 * español se busca la traducción actual por `clover_item_id` /
 * `clover_modifier_id`. Si algo falla (base sin la 0029, producto borrado),
 * se queda la copia: nunca se pierde el nombre.
 */

import { localized, type Lang } from '../i18n';
import { getSupabase } from '../supabase';
import type { OrderWithItems } from './orders';

interface Names {
  readonly items: ReadonlyMap<string, unknown>;
  readonly modifiers: ReadonlyMap<string, unknown>;
}

const cache = new Map<string, { at: number; names: Promise<Names | null> }>();
const TTL_MS = 5 * 60 * 1000;

async function load(storeId: string): Promise<Names | null> {
  const supabase = getSupabase();
  const [items, modifiers] = await Promise.all([
    supabase.from('catalog_items').select('clover_item_id, i18n').eq('store_id', storeId)
      .returns<{ clover_item_id: string; i18n: unknown }[]>(),
    supabase.from('catalog_modifiers').select('clover_modifier_id, i18n').eq('store_id', storeId)
      .returns<{ clover_modifier_id: string; i18n: unknown }[]>(),
  ]);
  if (items.error !== null || modifiers.error !== null) return null;
  return {
    items: new Map((items.data ?? []).map((r) => [r.clover_item_id, r.i18n])),
    modifiers: new Map((modifiers.data ?? []).map((r) => [r.clover_modifier_id, r.i18n])),
  };
}

function namesFor(storeId: string): Promise<Names | null> {
  const hit = cache.get(storeId);
  if (hit !== undefined && Date.now() - hit.at < TTL_MS) return hit.names;
  const names = load(storeId).catch(() => null);
  cache.set(storeId, { at: Date.now(), names });
  return names;
}

/** Los mismos pedidos, con los nombres traducidos a `lang` (si hay traducción). */
export async function localizeOrders<T extends OrderWithItems>(orders: T[], lang?: Lang): Promise<T[]> {
  const stores = [...new Set(orders.map((o) => o.store_id))];
  const byStore = new Map(await Promise.all(stores.map(async (id) => [id, await namesFor(id)] as const)));
  return orders.map((order) => {
    const names = byStore.get(order.store_id) ?? null;
    if (names === null) return order;
    return {
      ...order,
      order_items: order.order_items.map((item) => ({
        ...item,
        name_snapshot: localized(item.name_snapshot, names.items.get(item.clover_item_id), 'name', lang),
        order_item_modifiers: (item.order_item_modifiers ?? []).map((m) => ({
          ...m,
          name_snapshot: localized(m.name_snapshot, names.modifiers.get(m.clover_modifier_id), 'name', lang),
        })),
      })),
    };
  });
}
