/**
 * Carrito en memoria, con copia en AsyncStorage para que sobreviva a un
 * cierre de la app. Nada de esto llega al servidor todavia: el pedido se
 * crea en Clover en la fase 5, al pagar.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import {
  cartItemCount,
  cartReducer,
  cartSubtotalCents,
  emptyCart,
  isCartEmpty,
  type AddLineInput,
  type CartLine,
  type CartState,
} from '../domain/cart';
import type { Cents } from '../domain/money';
import { useStores } from './store-context';

const STORAGE_KEY = 'juicebar.cart.v1';

interface CartContextValue {
  readonly cart: CartState;
  readonly lines: readonly CartLine[];
  readonly itemCount: number;
  readonly subtotalCents: Cents;
  readonly isEmpty: boolean;
  readonly addLine: (line: AddLineInput) => void;
  readonly setQuantity: (lineId: string, quantity: number) => void;
  readonly removeLine: (lineId: string) => void;
  readonly clear: () => void;
  /** Sustituye el carrito entero. Lo usa el cambio de sucursal. */
  readonly replaceCart: (next: CartState) => void;
  /** `true` mientras no se ha leido lo guardado en el telefono. */
  readonly hydrated: boolean;
}

const CartContext = createContext<CartContextValue | null>(null);

function isCartState(value: unknown): value is CartState {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as CartState).storeId === 'string' &&
    Array.isArray((value as CartState).lines)
  );
}

export function CartProvider({ children }: { children: ReactNode }): ReactNode {
  const { selectedStoreId, selectStore } = useStores();
  const [cart, dispatch] = useReducer(cartReducer, '', emptyCart);
  const hydratedRef = useRef(false);
  const [hydrated, setHydrated] = useState(false);

  // Rehidratar una sola vez al arrancar.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (cancelled || raw === null) return;

        const parsed: unknown = JSON.parse(raw);
        if (isCartState(parsed) && parsed.lines.length > 0) {
          dispatch({ type: 'replace', cart: parsed });
        }
      } catch {
        // Un carrito corrupto no puede impedir que la app arranque.
      } finally {
        if (!cancelled) {
          hydratedRef.current = true;
          setHydrated(true);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // Solo al montar: el carrito guardado se lee una vez.
  }, []);

  // Reconciliacion carrito <-> sucursal elegida.
  //
  // Si lo guardado pertenece a otra sucursal, manda el CARRITO: se cambia
  // la sucursal elegida para que coincida. Descartar el carrito seria
  // perder la compra del cliente sin avisarle, que es exactamente lo que
  // esta prohibido. Para cambiar de sucursal de verdad esta el selector,
  // que re-valida precios y ensena las diferencias.
  useEffect(() => {
    if (!hydrated) return;
    if (cart.lines.length === 0 || cart.storeId === '') return;
    if (selectedStoreId === null || selectedStoreId === cart.storeId) return;
    selectStore(cart.storeId);
  }, [hydrated, cart.lines.length, cart.storeId, selectedStoreId, selectStore]);

  // Un carrito vacio simplemente sigue a la sucursal elegida.
  useEffect(() => {
    if (!hydrated) return;
    if (selectedStoreId === null || selectedStoreId === cart.storeId) return;
    if (cart.lines.length > 0) return;
    dispatch({ type: 'replace', cart: emptyCart(selectedStoreId) });
  }, [hydrated, selectedStoreId, cart.storeId, cart.lines.length]);

  // Persistir despues de cada cambio, sin pisar el estado guardado antes
  // de haber terminado de leerlo.
  useEffect(() => {
    if (!hydratedRef.current) return;
    void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(cart)).catch(() => undefined);
  }, [cart]);

  const addLine = useCallback((line: AddLineInput) => {
    dispatch({ type: 'add', line });
  }, []);

  const setQuantity = useCallback((lineId: string, quantity: number) => {
    dispatch({ type: 'setQuantity', lineId, quantity });
  }, []);

  const removeLine = useCallback((lineId: string) => {
    dispatch({ type: 'remove', lineId });
  }, []);

  const clear = useCallback(() => {
    dispatch({ type: 'clear' });
  }, []);

  const replaceCart = useCallback((next: CartState) => {
    dispatch({ type: 'replace', cart: next });
  }, []);

  const value = useMemo<CartContextValue>(
    () => ({
      cart,
      lines: cart.lines,
      itemCount: cartItemCount(cart),
      subtotalCents: cartSubtotalCents(cart),
      isEmpty: isCartEmpty(cart),
      addLine,
      setQuantity,
      removeLine,
      clear,
      replaceCart,
      hydrated,
    }),
    [cart, addLine, setQuantity, removeLine, clear, replaceCart, hydrated],
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartContextValue {
  const value = useContext(CartContext);
  if (value === null) throw new Error('useCart() necesita estar dentro de <CartProvider>');
  return value;
}
