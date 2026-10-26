/**
 * Sucursal seleccionada.
 *
 * Cada sucursal es un merchant distinto de Clover, con su propio catalogo
 * y sus propios precios (Variable 6 del addendum). Por eso la sucursal no
 * se fija en el build: se elige en tiempo de ejecucion y se recuerda.
 *
 * Este contexto solo gestiona CUAL esta elegida. El cambio con carrito
 * lleno lo orquesta `app/store-picker.tsx`, porque hay que re-validar
 * precios y ensenar las diferencias antes de aplicar nada.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { fetchStores } from '../api/store';
import type { StoreRow } from '../api/types';
import { readEnv } from '../env';

const STORAGE_KEY = 'juicebar.store.v1';

interface StoreContextValue {
  readonly stores: readonly StoreRow[];
  readonly selectedStoreId: string | null;
  readonly selectedStore: StoreRow | null;
  readonly loading: boolean;
  readonly error: Error | null;
  readonly reload: () => void;
  readonly selectStore: (storeId: string) => void;
  /** ¿Hay mas de una sucursal donde elegir? */
  readonly hasChoice: boolean;
}

const StoreContext = createContext<StoreContextValue | null>(null);

export function StoreProvider({ children }: { children: ReactNode }): ReactNode {
  const [stores, setStores] = useState<readonly StoreRow[]>([]);
  const [selectedStoreId, setSelectedStoreId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      setLoading(true);
      try {
        const [remembered, list] = await Promise.all([
          AsyncStorage.getItem(STORAGE_KEY).catch(() => null),
          fetchStores(readEnv().restaurantId),
        ]);
        if (cancelled) return;

        setStores(list);
        setError(null);

        // La recordada solo vale si sigue existiendo y siendo publica:
        // una sucursal que cerro no puede quedarse pegada en el telefono.
        const stillThere = list.some((store) => store.id === remembered);
        const next = stillThere ? remembered : (list[0]?.id ?? null);

        setSelectedStoreId(next);
        if (next !== null && next !== remembered) {
          void AsyncStorage.setItem(STORAGE_KEY, next).catch(() => undefined);
        }
      } catch (cause) {
        if (cancelled) return;
        setError(cause instanceof Error ? cause : new Error(String(cause)));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [attempt]);

  // Refresco silencioso (sin "cargando"): si la tienda pausa los pedidos o
  // los reanuda, el cliente lo ve sin recargar la página.
  useEffect(() => {
    let cancelled = false;
    const refresh = (): void => {
      void fetchStores(readEnv().restaurantId)
        .then((list) => {
          if (!cancelled && list.length > 0) setStores(list);
        })
        .catch(() => undefined);
    };
    const timer = setInterval(refresh, 60_000);
    const doc = (globalThis as { document?: Document }).document;
    const onVisible = (): void => {
      if (doc?.visibilityState === 'visible') refresh();
    };
    doc?.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      doc?.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  const selectStore = useCallback((storeId: string) => {
    setSelectedStoreId(storeId);
    void AsyncStorage.setItem(STORAGE_KEY, storeId).catch(() => undefined);
  }, []);

  const reload = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);

  const value = useMemo<StoreContextValue>(() => {
    const selectedStore = stores.find((store) => store.id === selectedStoreId) ?? null;
    return {
      stores,
      selectedStoreId,
      selectedStore,
      loading,
      error,
      reload,
      selectStore,
      hasChoice: stores.length > 1,
    };
  }, [stores, selectedStoreId, loading, error, reload, selectStore]);

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStores(): StoreContextValue {
  const value = useContext(StoreContext);
  if (value === null) throw new Error('useStores() necesita estar dentro de <StoreProvider>');
  return value;
}
