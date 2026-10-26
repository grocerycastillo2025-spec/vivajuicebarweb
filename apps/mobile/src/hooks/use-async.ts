import { useCallback, useEffect, useRef, useState } from 'react';

export interface AsyncState<T> {
  readonly data: T | null;
  readonly error: Error | null;
  readonly loading: boolean;
  readonly refreshing: boolean;
  readonly reload: () => void;
  readonly refresh: () => void;
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

/**
 * Carga asincrona con recarga y "pull to refresh". Sin libreria de datos:
 * en esta fase hay cinco pantallas y cuatro consultas; meter un cliente de
 * cache seria una dependencia mas que mantener sin ganar nada.
 */
export function useAsync<T>(load: () => Promise<T>, deps: readonly unknown[] = []): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const mounted = useRef(true);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(async (isRefresh: boolean) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);

    try {
      const result = await loadRef.current();
      if (!mounted.current) return;
      setData(result);
      setError(null);
    } catch (cause) {
      if (!mounted.current) return;
      setError(toError(cause));
    } finally {
      if (mounted.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    void run(false);
    // Las dependencias las decide quien llama al hook.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  const reload = useCallback(() => {
    void run(false);
  }, [run]);

  const refresh = useCallback(() => {
    void run(true);
  }, [run]);

  return { data, error, loading, refreshing, reload, refresh };
}
