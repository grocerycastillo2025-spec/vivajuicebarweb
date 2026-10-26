/**
 * El "+" de las tarjetas, en un solo sitio.
 *
 * Lo usan la lista del menu y los destacados de la Home, y tiene que
 * decidir igual en las dos: un cafe que necesita leche abre el detalle en
 * cualquiera de las dos pantallas, no solo en una.
 *
 * La regla de que hace el boton es pura y esta en `domain/quick-add.ts`;
 * aqui solo se conecta con el carrito, el enrutador y el vibrador.
 */

import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useCallback } from 'react';

import type { MenuItemRow } from '../api/types';
import { buildLine } from '../domain/cart';
import { quickAddAction } from '../domain/quick-add';
import { useCart } from '../state/cart-context';

/**
 * `requiresChoice` es `null` cuando no se pudo averiguar. En ese caso se
 * asume que TODO pide eleccion y el "+" lleva al detalle: es el camino
 * seguro. Lo contrario seria meter en el carrito un cafe sin decir la
 * leche, y eso llega a la cocina como un pedido a medias.
 */
export function useQuickAdd(
  requiresChoice: ReadonlySet<string> | null | undefined,
): (item: MenuItemRow) => void {
  const { addLine } = useCart();
  const router = useRouter();

  return useCallback(
    (item: MenuItemRow) => {
      const known = requiresChoice ?? null;
      const action = quickAddAction(item, known === null || known.has(item.id));

      if (action === 'blocked') return;

      if (action === 'choose') {
        router.push({ pathname: '/item/[id]', params: { id: item.id } });
        return;
      }

      // Un producto que entra al carrito sin abrir nada necesita alguna
      // senal de que paso: el contador del carrito esta abajo y se puede
      // no mirar. Que el telefono no tenga vibrador no puede romper nada.
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);

      addLine(
        buildLine(
          {
            id: item.id,
            cloverItemId: item.clover_item_id,
            name: item.name,
            imageUrl: item.image_url,
            priceCents: item.price_cents,
          },
          [],
          1,
          '',
        ),
      );
    },
    [addLine, requiresChoice, router],
  );
}

/** Si la tarjeta de este producto debe llevar al detalle en vez de anadir. */
export function needsChoice(
  requiresChoice: ReadonlySet<string> | null | undefined,
  itemId: string,
): boolean {
  const known = requiresChoice ?? null;
  return known === null || known.has(itemId);
}
