/**
 * Sesion de Supabase Auth (correo y contrasena, que es lo que activa el
 * ver docs/PUESTA-EN-MARCHA.md). La app solo guarda el token de sesion del
 * cliente; ninguna credencial de Clover ni clave secreta pasa por aqui.
 */

import type { Session, User } from '@supabase/supabase-js';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { getSupabase } from '../supabase';

interface SessionContextValue {
  readonly session: Session | null;
  readonly user: User | null;
  readonly loading: boolean;
  readonly signIn: (email: string, password: string) => Promise<void>;
  /** `true` si hay que confirmar el correo antes de entrar. */
  readonly signUp: (email: string, password: string, firstName: string) => Promise<boolean>;
  readonly signInWithGoogle: () => Promise<void>;
  /**
   * Google solo se ofrece si esta configurado en el dashboard de
   * Supabase. Sin el flag, el boton no aparece: mas vale no ensenarlo
   * que ensenar uno que falla.
   */
  readonly googleEnabled: boolean;
  readonly signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }): ReactNode {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const supabase = getSupabase();
    let cancelled = false;

    void supabase.auth
      .getSession()
      .then(({ data }) => {
        if (!cancelled) setSession(data.session);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
    });

    return () => {
      cancelled = true;
      subscription.subscription.unsubscribe();
    };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const { error } = await getSupabase().auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    if (error) throw new Error(error.message);
  }, []);

  const signUp = useCallback(async (email: string, password: string, firstName: string) => {
    const { data, error } = await getSupabase().auth.signUp({
      email: email.trim(),
      password,
      options: {
        data: { first_name: firstName.trim() },
        // El enlace de confirmación vuelve a la app (y no a localhost).
        ...(typeof window !== 'undefined' && window.location?.origin
          ? { emailRedirectTo: `${window.location.origin}${window.location.pathname.replace(/[^/]*$/, '')}` }
          : {}),
      },
    });
    if (error) throw new Error(error.message);
    // Con "Confirm email" activo no hay sesion hasta que el usuario abre
    // el enlace del correo. La pantalla necesita saberlo para no quedarse
    // esperando una sesion que no va a llegar.
    return data.session === null;
  }, []);

  /**
   * OAuth con Google.
   *
   * Supabase devuelve la url del proveedor; se abre en la pestana segura
   * del sistema (no un WebView propio, que Google rechaza) y al volver se
   * canjea el codigo por la sesion.
   */
  const signInWithGoogle = useCallback(async () => {
    const redirectTo = Linking.createURL('/auth-callback');
    const supabase = getSupabase();

    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo, skipBrowserRedirect: true },
    });
    if (error) throw new Error(error.message);
    if (data.url === null || data.url === undefined) {
      throw new Error('Supabase no devolvio la url de Google');
    }

    const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
    if (result.type !== 'success') return; // el usuario cerro la pestana

    const returned = Linking.parse(result.url);
    const code = typeof returned.queryParams?.code === 'string' ? returned.queryParams.code : null;
    if (code === null) throw new Error('Google no devolvio el codigo de autorizacion');

    const exchange = await supabase.auth.exchangeCodeForSession(code);
    if (exchange.error) throw new Error(exchange.error.message);
  }, []);

  const signOut = useCallback(async () => {
    const { error } = await getSupabase().auth.signOut();
    if (error) throw new Error(error.message);
  }, []);

  const value = useMemo<SessionContextValue>(
    () => ({
      session,
      user: session?.user ?? null,
      loading,
      signIn,
      signUp,
      signInWithGoogle,
      googleEnabled: (process.env.EXPO_PUBLIC_GOOGLE_AUTH_ENABLED ?? '') === 'true',
      signOut,
    }),
    [session, loading, signIn, signUp, signInWithGoogle, signOut],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (value === null) throw new Error('useSession() necesita estar dentro de <SessionProvider>');
  return value;
}
