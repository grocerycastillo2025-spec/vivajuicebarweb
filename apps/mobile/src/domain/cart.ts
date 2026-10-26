/**
 * Carrito. Estado 100% local en esta fase: el checkout (y con el, el
 * calculo real de impuestos y total, que hace Clover) llega en la fase 5.
 * Por eso aqui solo se calcula el SUBTOTAL. No inventamos impuestos.
 *
 * Modulo puro: solo imports de tipo.
 */

import type { Cents } from './money';
import type { ModifierGroup, Selection } from './modifiers';

export interface CartLineModifier {
  readonly groupId: string;
  readonly groupName: string;
  readonly modifierId: string;
  readonly cloverModifierId: string;
  readonly name: string;
  readonly priceCents: Cents;
}

export interface CartLine {
  /** Firma estable: dos lineas iguales se apilan en vez de duplicarse. */
  readonly id: string;
  readonly itemId: string;
  readonly cloverItemId: string;
  readonly name: string;
  readonly imageUrl: string | null;
  readonly unitBasePriceCents: Cents;
  readonly modifiers: readonly CartLineModifier[];
  readonly quantity: number;
  readonly note: string;
}

export interface CartState {
  readonly storeId: string;
  readonly lines: readonly CartLine[];
}

export const MAX_LINE_QUANTITY = 99;

export function emptyCart(storeId: string): CartState {
  return { storeId, lines: [] };
}

/**
 * Identidad de una linea: mismo producto + mismos modificadores + misma
 * nota. El orden en que se marcaron las opciones no debe importar, asi
 * que los ids se ordenan antes de firmar.
 */
export function lineSignature(
  itemId: string,
  modifiers: readonly CartLineModifier[],
  note: string,
): string {
  const ids = modifiers.map((modifier) => modifier.modifierId).sort();
  return `${itemId}#${ids.join(',')}#${note.trim()}`;
}

export function lineUnitPriceCents(line: CartLine): Cents {
  let total = line.unitBasePriceCents;
  for (const modifier of line.modifiers) total += modifier.priceCents;
  return total;
}

export function lineTotalCents(line: CartLine): Cents {
  return lineUnitPriceCents(line) * line.quantity;
}

export function cartSubtotalCents(cart: CartState): Cents {
  let total = 0;
  for (const line of cart.lines) total += lineTotalCents(line);
  return total;
}

/** Numero de unidades, no de lineas: es lo que va en el badge del carrito. */
export function cartItemCount(cart: CartState): number {
  let count = 0;
  for (const line of cart.lines) count += line.quantity;
  return count;
}

export function isCartEmpty(cart: CartState): boolean {
  return cart.lines.length === 0;
}

export interface AddLineInput {
  readonly itemId: string;
  readonly cloverItemId: string;
  readonly name: string;
  readonly imageUrl: string | null;
  readonly unitBasePriceCents: Cents;
  readonly modifiers: readonly CartLineModifier[];
  readonly quantity: number;
  readonly note: string;
}

export type CartAction =
  | { readonly type: 'add'; readonly line: AddLineInput }
  | { readonly type: 'setQuantity'; readonly lineId: string; readonly quantity: number }
  | { readonly type: 'remove'; readonly lineId: string }
  | { readonly type: 'clear' }
  | { readonly type: 'replace'; readonly cart: CartState };

function clampQuantity(quantity: number): number {
  if (!Number.isFinite(quantity)) return 0;
  return Math.max(0, Math.min(MAX_LINE_QUANTITY, Math.trunc(quantity)));
}

export function cartReducer(state: CartState, action: CartAction): CartState {
  switch (action.type) {
    case 'add': {
      const quantity = clampQuantity(action.line.quantity);
      if (quantity === 0) return state;

      const note = action.line.note.trim();
      const id = lineSignature(action.line.itemId, action.line.modifiers, note);
      const existing = state.lines.find((line) => line.id === id);

      if (existing !== undefined) {
        return {
          ...state,
          lines: state.lines.map((line) =>
            line.id === id ? { ...line, quantity: clampQuantity(line.quantity + quantity) } : line,
          ),
        };
      }

      return {
        ...state,
        lines: [...state.lines, { ...action.line, id, note, quantity }],
      };
    }

    case 'setQuantity': {
      const quantity = clampQuantity(action.quantity);
      if (quantity === 0) {
        return { ...state, lines: state.lines.filter((line) => line.id !== action.lineId) };
      }
      return {
        ...state,
        lines: state.lines.map((line) =>
          line.id === action.lineId ? { ...line, quantity } : line,
        ),
      };
    }

    case 'remove':
      return { ...state, lines: state.lines.filter((line) => line.id !== action.lineId) };

    case 'clear':
      return emptyCart(state.storeId);

    case 'replace':
      return action.cart;
  }
}

/**
 * Construye la linea a partir de lo que muestra la pantalla de detalle.
 * Los precios llegan tal cual del catalogo; esta funcion no los toca.
 */
export function buildLine(
  item: {
    readonly id: string;
    readonly cloverItemId: string;
    readonly name: string;
    readonly imageUrl: string | null;
    readonly priceCents: Cents;
  },
  modifiers: readonly CartLineModifier[],
  quantity: number,
  note: string,
): AddLineInput {
  return {
    itemId: item.id,
    cloverItemId: item.cloverItemId,
    name: item.name,
    imageUrl: item.imageUrl,
    unitBasePriceCents: item.priceCents,
    modifiers,
    quantity,
    note,
  };
}

/**
 * Precio unitario que se muestra en la pantalla de detalle mientras el
 * cliente va marcando opciones, sin construir la linea todavia.
 */
export function previewUnitPriceCents(
  basePriceCents: Cents,
  groups: readonly ModifierGroup[],
  selection: Selection,
): Cents {
  let total = basePriceCents;
  for (const group of groups) {
    const chosen = selection[group.id] ?? [];
    for (const modifier of group.modifiers) {
      if (chosen.includes(modifier.id)) total += modifier.priceCents;
    }
  }
  return total;
}

// ---------------------------------------------------------------------
// RE-VALIDACION AL CAMBIAR DE SUCURSAL
//
// Cada sucursal es un merchant distinto de Clover, con su propio catalogo
// y sus propios precios (Variable 6 del addendum). Arrastrar el precio de
// la sucursal vieja produce un cobro que no cuadra con el ticket, asi que
// al cambiar hay que releer TODO: el precio del producto y el recargo de
// cada modificador.
//
// Regla de producto: nada se descarta en silencio. Lo que no sobrevive
// sale en `removed` con su motivo, para ensenarselo al cliente ANTES de
// que siga comprando.
//
// El puente entre sucursales son los identificadores de Clover
// (`clover_item_id`, `clover_modifier_id`), que es lo unico estable entre
// dos catalogos distintos: los uuid de nuestras tablas no lo son.
// ---------------------------------------------------------------------

export interface SnapshotItem {
  readonly id: string;
  readonly name: string;
  readonly priceCents: Cents;
  readonly isAvailable: boolean;
}

export interface SnapshotModifier {
  readonly id: string;
  readonly name: string;
  readonly priceCents: Cents;
  readonly available: boolean;
}

/** Catalogo de la sucursal destino, indexado por identificadores de Clover. */
export interface StoreCatalogSnapshot {
  readonly storeId: string;
  readonly items: Readonly<Record<string, SnapshotItem>>;
  readonly modifiers: Readonly<Record<string, SnapshotModifier>>;
}

export type LineIssueKind =
  | 'item-missing'
  | 'item-unavailable'
  | 'item-price-changed'
  | 'modifier-missing'
  | 'modifier-unavailable'
  | 'modifier-price-changed';

export interface LineIssue {
  readonly kind: LineIssueKind;
  readonly lineId: string;
  readonly itemName: string;
  readonly modifierName: string | null;
  readonly beforeCents: Cents | null;
  readonly afterCents: Cents | null;
  /** `true` = la linea no puede continuar y se retira del carrito. */
  readonly blocking: boolean;
}

export interface RevalidationResult {
  /** Lineas que siguen, ya con los precios y los ids de la sucursal nueva. */
  readonly cart: CartState;
  /** Lineas que no pueden continuar, con su motivo en `issues`. */
  readonly removed: readonly CartLine[];
  readonly issues: readonly LineIssue[];
  readonly subtotalBeforeCents: Cents;
  readonly subtotalAfterCents: Cents;
  /** ¿Hay algo que ensenarle al cliente antes de seguir? */
  readonly needsReview: boolean;
}

/**
 * Recalcula el carrito contra el catalogo de otra sucursal.
 *
 * No muta nada ni decide por el cliente: devuelve el resultado para que la
 * pantalla lo muestre y sea el quien confirme.
 */
export function revalidateCart(
  cart: CartState,
  snapshot: StoreCatalogSnapshot,
): RevalidationResult {
  const issues: LineIssue[] = [];
  const removed: CartLine[] = [];
  const survivors: CartLine[] = [];

  for (const line of cart.lines) {
    const item = snapshot.items[line.cloverItemId];

    if (item === undefined) {
      issues.push({
        kind: 'item-missing',
        lineId: line.id,
        itemName: line.name,
        modifierName: null,
        beforeCents: lineUnitPriceCents(line),
        afterCents: null,
        blocking: true,
      });
      removed.push(line);
      continue;
    }

    if (!item.isAvailable) {
      issues.push({
        kind: 'item-unavailable',
        lineId: line.id,
        itemName: item.name,
        modifierName: null,
        beforeCents: lineUnitPriceCents(line),
        afterCents: null,
        blocking: true,
      });
      removed.push(line);
      continue;
    }

    // Los modificadores se resuelven antes de dar la linea por buena: si
    // uno no existe en la sucursal nueva, la configuracion del producto ya
    // no es servible y la linea entera se retira, dicho en voz alta.
    const nextModifiers: CartLineModifier[] = [];
    const lineIssues: LineIssue[] = [];
    let modifierBlocked = false;

    for (const modifier of line.modifiers) {
      const found = snapshot.modifiers[modifier.cloverModifierId];

      if (found === undefined) {
        lineIssues.push({
          kind: 'modifier-missing',
          lineId: line.id,
          itemName: item.name,
          modifierName: modifier.name,
          beforeCents: modifier.priceCents,
          afterCents: null,
          blocking: true,
        });
        modifierBlocked = true;
        continue;
      }

      if (!found.available) {
        lineIssues.push({
          kind: 'modifier-unavailable',
          lineId: line.id,
          itemName: item.name,
          modifierName: found.name,
          beforeCents: modifier.priceCents,
          afterCents: null,
          blocking: true,
        });
        modifierBlocked = true;
        continue;
      }

      if (found.priceCents !== modifier.priceCents) {
        lineIssues.push({
          kind: 'modifier-price-changed',
          lineId: line.id,
          itemName: item.name,
          modifierName: found.name,
          beforeCents: modifier.priceCents,
          afterCents: found.priceCents,
          blocking: false,
        });
      }

      nextModifiers.push({
        ...modifier,
        modifierId: found.id,
        name: found.name,
        priceCents: found.priceCents,
      });
    }

    issues.push(...lineIssues);

    if (modifierBlocked) {
      removed.push(line);
      continue;
    }

    if (item.priceCents !== line.unitBasePriceCents) {
      issues.push({
        kind: 'item-price-changed',
        lineId: line.id,
        itemName: item.name,
        modifierName: null,
        beforeCents: line.unitBasePriceCents,
        afterCents: item.priceCents,
        blocking: false,
      });
    }

    survivors.push({
      ...line,
      // Los uuid son por sucursal: hay que reapuntarlos.
      id: lineSignature(item.id, nextModifiers, line.note),
      itemId: item.id,
      name: item.name,
      unitBasePriceCents: item.priceCents,
      modifiers: nextModifiers,
    });
  }

  // Dos configuraciones distintas en la sucursal vieja pueden colapsar en
  // una sola aqui (por ejemplo si un modificador cambio de nombre y de id).
  // Se apilan en vez de duplicarse, igual que al anadir desde el detalle.
  const merged = new Map<string, CartLine>();
  for (const line of survivors) {
    const existing = merged.get(line.id);
    merged.set(
      line.id,
      existing === undefined
        ? line
        : { ...existing, quantity: Math.min(MAX_LINE_QUANTITY, existing.quantity + line.quantity) },
    );
  }

  const nextCart: CartState = { storeId: snapshot.storeId, lines: [...merged.values()] };

  return {
    cart: nextCart,
    removed,
    issues,
    subtotalBeforeCents: cartSubtotalCents(cart),
    subtotalAfterCents: cartSubtotalCents(nextCart),
    needsReview: issues.length > 0,
  };
}

/** Agrupa los avisos por linea, que es como los pinta la pantalla. */
export function groupIssuesByLine(issues: readonly LineIssue[]): readonly {
  readonly lineId: string;
  readonly itemName: string;
  readonly issues: readonly LineIssue[];
}[] {
  const order: string[] = [];
  const byLine = new Map<string, LineIssue[]>();

  for (const issue of issues) {
    let bucket = byLine.get(issue.lineId);
    if (bucket === undefined) {
      bucket = [];
      byLine.set(issue.lineId, bucket);
      order.push(issue.lineId);
    }
    bucket.push(issue);
  }

  return order.map((lineId) => {
    const bucket = byLine.get(lineId) ?? [];
    return {
      lineId,
      itemName: bucket[0]?.itemName ?? '',
      issues: bucket,
    };
  });
}

// ---------------------------------------------------------------------
// VOLVER A PEDIR
// ---------------------------------------------------------------------

export interface PastOrderModifier {
  readonly clover_modifier_id: string;
  readonly name_snapshot: string;
  readonly price_snapshot_cents: Cents;
}

export interface PastOrderItem {
  readonly clover_item_id: string;
  readonly name_snapshot: string;
  readonly unit_price_snapshot_cents: Cents;
  readonly quantity: number;
  readonly note: string | null;
  readonly sort_order: number;
  readonly order_item_modifiers: readonly PastOrderModifier[];
}

/**
 * Convierte un pedido pasado en un carrito.
 *
 * Los ids que quedan son los de CLOVER, porque son lo unico que sobrevive
 * al paso del tiempo: los uuid de `catalog_items` pueden haber cambiado
 * con una re-sincronizacion. Los precios son los que se pagaron aquel
 * dia, asi que este carrito NO se puede usar tal cual: hay que pasarlo
 * por `revalidateCart` contra el catalogo de hoy, exactamente igual que
 * al cambiar de sucursal. Asi el cliente ve que subio de precio o que ya
 * no existe, en vez de encontrarse una sorpresa en la caja.
 */
export function pastOrderToCart(storeId: string, items: readonly PastOrderItem[]): CartState {
  const lines: CartLine[] = [];

  for (const item of [...items].sort((a, b) => a.sort_order - b.sort_order)) {
    const note = (item.note ?? '').trim();

    const modifiers: CartLineModifier[] = item.order_item_modifiers.map((modifier) => ({
      groupId: '',
      groupName: '',
      // Se rellenan al revalidar contra el catalogo actual.
      modifierId: modifier.clover_modifier_id,
      cloverModifierId: modifier.clover_modifier_id,
      name: modifier.name_snapshot,
      priceCents: modifier.price_snapshot_cents,
    }));

    // El precio base se reconstruye quitando los recargos del unitario:
    // order_items guarda el unitario YA con modificadores.
    let base = item.unit_price_snapshot_cents;
    for (const modifier of modifiers) base -= modifier.priceCents;

    lines.push({
      id: lineSignature(item.clover_item_id, modifiers, note),
      itemId: item.clover_item_id,
      cloverItemId: item.clover_item_id,
      name: item.name_snapshot,
      imageUrl: null,
      unitBasePriceCents: Math.max(0, base),
      modifiers,
      quantity: Math.max(1, Math.min(MAX_LINE_QUANTITY, item.quantity)),
      note,
    });
  }

  return { storeId, lines };
}
