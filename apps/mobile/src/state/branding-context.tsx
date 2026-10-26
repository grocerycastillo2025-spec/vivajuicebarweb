/**
 * Branding de la marca, leido de `app_settings`.
 *
 * §19: "El branding llega del backend, no del build: colores, logo,
 * banners, features. Un cambio de color no requiere release."
 *
 * SOBRE EL PARPADEO DE COLORES
 * Si se arrancara siempre con la paleta por defecto, cada apertura de la
 * app mostraria un instante de colores ajenos antes de que llegue la fila
 * real. Por eso el ultimo branding conocido se guarda en el telefono y se
 * aplica de inmediato: a partir del segundo arranque no hay salto.
 *
 * En la primera instalacion no hay nada guardado y se pinta con los
 * valores por defecto durante la primera consulta. Es el unico momento en
 * que puede verse un cambio de color, y solo si la marca no usa la paleta
 * por defecto.
 *
 * Si `app_settings` no tiene fila, o la consulta falla, la app se queda
 * con lo ultimo que supo (o con los valores por defecto) y sigue
 * funcionando: un branding que no carga no puede dejar a nadie sin menu.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { fetchBranding } from '../api/store';
import {
  defaultBranding,
  normalizeBranding,
  type AppSettingsInput,
  type Branding,
} from '../domain/branding';
import { readEnv } from '../env';

const STORAGE_KEY = 'juicebar.branding.v1';

interface BrandingContextValue extends Branding {
  /** `true` mientras no se sabe si hay branding propio. */
  readonly loading: boolean;
  /** No bloquea la app: si falla, se sigue con lo ultimo conocido. */
  readonly error: Error | null;
  /** `true` si lo que se pinta viene de la base y no de los valores por defecto. */
  readonly resolved: boolean;
  readonly reload: () => void;
}

const BrandingContext = createContext<BrandingContextValue | null>(null);

function isSettingsRow(value: unknown): value is AppSettingsInput {
  return typeof value === 'object' && value !== null;
}

export function BrandingProvider({ children }: { children: ReactNode }): ReactNode {
  const [branding, setBranding] = useState<Branding>(defaultBranding);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [resolved, setResolved] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // La respuesta de red siempre gana sobre la cache, aunque llegue antes.
  const fresh = useRef(false);

  // 1. Pintar de inmediato lo ultimo que se supo de esta marca.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (cancelled || raw === null || fresh.current) return;

        const parsed: unknown = JSON.parse(raw);
        if (isSettingsRow(parsed)) {
          setBranding(normalizeBranding(parsed));
          setResolved(true);
        }
      } catch {
        // Cache corrupta: se sigue con los valores por defecto.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // 2. Traer la fila real y guardarla para el proximo arranque.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      setLoading(true);
      try {
        const row = await fetchBranding(readEnv().restaurantId);
        if (cancelled) return;

        fresh.current = true;
        setBranding(normalizeBranding(row));
        setResolved(true);
        setError(null);

        if (row === null) {
          // Sin fila: se limpia la cache para no revivir un branding que
          // ya no existe en la base.
          void AsyncStorage.removeItem(STORAGE_KEY).catch(() => undefined);
        } else {
          void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(row)).catch(() => undefined);
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

  const reload = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);

  const value = useMemo<BrandingContextValue>(
    () => ({ ...branding, loading, error, resolved, reload }),
    [branding, loading, error, resolved, reload],
  );

  return <BrandingContext.Provider value={value}>{children}</BrandingContext.Provider>;
}

export function useBranding(): BrandingContextValue {
  const value = useContext(BrandingContext);
  if (value === null) throw new Error('useBranding() necesita estar dentro de <BrandingProvider>');
  return value;
}

/** Atajo, que es lo que necesitan casi todas las pantallas. */
export function useColors(): Branding['colors'] {
  return useBranding().colors;
}
