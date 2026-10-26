/**
 * Que hace el boton "+" de una tarjeta del menu.
 *
 * TRES CAMINOS, NO UNO
 * El "+" promete anadir sin entrar al detalle, y para la mayoria de los
 * productos eso es exacto. Pero hay productos que NO se pueden pedir sin
 * elegir: un cafe sin decir que leche no es un pedido, es un pedido a
 * medias que reventaria en la cocina. En el seed hay tres grupos con
 * `min_required = 1` (Milk, Bread) donde eso pasa.
 *
 * Para esos, el "+" no anade: abre el detalle con las opciones. Es lo que
 * hace Uber Eats, y es lo unico honesto — el alternativo seria elegir por
 * el cliente, que es como se acaba sirviendo un latte de avena a quien
 * pidio uno normal.
 *
 * Y un producto agotado no se anade por ningun camino, aunque el boton se
 * pinte: la disponibilidad la manda la base.
 *
 * Modulo puro.
 */

export type QuickAddAction =
  /** Directo al carrito, cantidad 1, sin modificadores. */
  | 'add'
  /** Al detalle: hay algo que el cliente tiene que elegir. */
  | 'choose'
  /** Nada: el producto no esta disponible. */
  | 'blocked';

export function quickAddAction(
  item: { readonly is_available: boolean },
  requiresChoice: boolean,
): QuickAddAction {
  if (!item.is_available) return 'blocked';
  return requiresChoice ? 'choose' : 'add';
}
