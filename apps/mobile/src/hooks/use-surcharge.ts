/**
 * El recargo por tarjeta de la sucursal que corresponde a esta pantalla.
 *
 * Por que un hook y no leer `selectedStore` en cada sitio: la pantalla de
 * pago no habla de la sucursal ELEGIDA, sino de la sucursal DEL PEDIDO,
 * que puede no ser la misma si el cliente cambio de local con un pedido a
 * medias. Cobrar el recargo de una sucursal y anunciar el de otra seria
 * peor que no anunciarlo: seria anunciar una cifra falsa.
 *
 * La decision de que se ensena vive entera en `domain/surcharge.ts`, que
 * es puro y esta probado. Aqui solo se resuelve de que fila hablamos.
 */

import { useMemo } from 'react';

import { surchargeDisclosure, type SurchargeDisclosure } from '../domain/surcharge';
import { useStores } from '../state/store-context';

/**
 * @param storeId sucursal concreta (la del pedido). Si se omite, la
 *   elegida. Si se pasa una que no esta en la lista publica, no se
 *   inventa nada: sale un resultado que no divulga y que marca
 *   `unknownRate`, porque no sabemos su tasa.
 */
export function useSurcharge(storeId?: string | null): SurchargeDisclosure {
  const { stores, selectedStore } = useStores();

  return useMemo(() => {
    if (storeId === undefined || storeId === null) return surchargeDisclosure(selectedStore);
    const store = stores.find((candidate) => candidate.id === storeId) ?? null;
    // `{}` y no `null`: una sucursal que no encontramos NO es una
    // sucursal sin recargo. `surchargeDisclosure({})` lo dice asi,
    // marcando `unknownRate`.
    return surchargeDisclosure(store ?? {});
  }, [selectedStore, storeId, stores]);
}
