/**
 * Estado de las notificaciones.
 *
 * Aqui NO se pide permiso al arrancar. En Android 13+ el dialogo sale una
 * sola vez: si el cliente dice que no antes de entender para que sirve, la
 * unica via de vuelta son los Ajustes del sistema. Asi que se pide en
 * contexto —cuando ya hay un pedido que seguir— o desde el perfil.
 *
 * El token se guarda contra el usuario, asi que solo se registra con
 * sesion iniciada, y se da de baja al cerrarla: si no, el aviso del pedido
 * de una persona acabaria en el telefono de otra.
 */

import { useRouter } from 'expo-router';
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

import { registerPushToken, unregisterPushToken } from '../api/push';
import { pushTargetFromData, shouldRegister, type PushState } from '../domain/push';
import {
  addResponseListener,
  ensureAndroidChannel,
  fetchDeviceToken,
  getInitialData,
  getPermission,
  installForegroundHandler,
  requestPermission,
  unsupportedReason,
} from '../push/notifications';
import { useSession } from './session-context';

interface PushContextValue {
  readonly state: PushState;
  /** Pide permiso si hace falta y registra el token. */
  readonly enable: () => Promise<void>;
}

const PushContext = createContext<PushContextValue | null>(null);

// El manejador de primer plano es global y se instala una sola vez.
installForegroundHandler();

export function PushProvider({ children }: { children: ReactNode }): ReactNode {
  const router = useRouter();
  const { user } = useSession();
  const userId = user?.id ?? null;

  const [state, setState] = useState<PushState>({ kind: 'idle', permission: 'undetermined' });
  const registered = useRef<{ token: string; userId: string } | null>(null);
  const lastToken = useRef<string | null>(null);

  // --- Abrir el pedido al tocar la notificacion --------------------------
  const openTarget = useCallback(
    (data: unknown) => {
      const target = pushTargetFromData(data);
      if (target === null) return;
      router.push({ pathname: target.pathname, params: target.params });
    },
    [router],
  );

  useEffect(() => {
    const subscription = addResponseListener(openTarget);
    // La notificacion que abrio la app con la app cerrada del todo no
    // dispara el listener: hay que preguntarla.
    void getInitialData().then(openTarget);
    return () => subscription.remove();
  }, [openTarget]);

  // --- Estado inicial ---------------------------------------------------
  useEffect(() => {
    let alive = true;

    void (async () => {
      const reason = unsupportedReason();
      if (reason !== null) {
        if (alive) setState({ kind: 'unsupported', reason });
        return;
      }
      await ensureAndroidChannel().catch(() => undefined);
      const permission = await getPermission();
      if (alive) setState({ kind: 'idle', permission });
    })();

    return () => {
      alive = false;
    };
  }, []);

  // --- Registro y baja --------------------------------------------------
  const register = useCallback(async () => {
    if (userId === null) return;

    setState({ kind: 'working' });
    const result = await fetchDeviceToken();

    if (!result.ok) {
      setState(
        result.reason === 'unknown'
          ? { kind: 'error', message: result.detail }
          : { kind: 'unsupported', reason: result.reason },
      );
      return;
    }

    try {
      await registerPushToken(result.value);
      registered.current = { token: result.value.token, userId };
      lastToken.current = result.value.token;
      setState({ kind: 'ready', token: result.value.token });
    } catch (cause) {
      setState({ kind: 'error', message: cause instanceof Error ? cause.message : String(cause) });
    }
  }, [userId]);

  useEffect(() => {
    if (state.kind !== 'idle') return;
    if (!shouldRegister(state.permission, userId, registered.current, lastToken.current)) return;
    void register();
  }, [register, state, userId]);

  // Cerrar sesion da de baja el token de ESTE aparato.
  useEffect(() => {
    if (userId !== null) return;
    const token = lastToken.current;
    registered.current = null;
    if (token === null) return;
    lastToken.current = null;
    // Si falla, no se le cuenta al cliente: no puede hacer nada al
    // respecto y no le impide nada.
    void unregisterPushToken(token).catch(() => undefined);
  }, [userId]);

  const enable = useCallback(async () => {
    if (state.kind === 'unsupported') return;

    const current = await getPermission();
    const permission = current === 'undetermined' ? await requestPermission() : current;

    if (permission !== 'granted') {
      setState({ kind: 'idle', permission });
      return;
    }
    setState({ kind: 'idle', permission });
    await register();
  }, [register, state.kind]);

  const value = useMemo<PushContextValue>(() => ({ state, enable }), [enable, state]);

  return <PushContext.Provider value={value}>{children}</PushContext.Provider>;
}

export function usePush(): PushContextValue {
  const context = useContext(PushContext);
  if (context === null) throw new Error('usePush fuera de <PushProvider>');
  return context;
}
