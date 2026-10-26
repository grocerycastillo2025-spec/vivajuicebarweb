/**
 * Registro de consultas y vistas (migracion 0023).
 *
 * Nunca bloquea ni falla en voz alta: si no se puede registrar, el
 * cliente sigue viendo su producto o su historia igual. La base cuenta
 * una vez por visitante, cosa y dia, asi que repetir la llamada no infla
 * los numeros.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';

import { getSupabase } from '../supabase';

const KEY = 'viva.visitor.v1';
let visitor: Promise<string> | null = null;

/** Identificador anonimo de este telefono o navegador. */
function visitorId(): Promise<string> {
  visitor ??= (async () => {
    try {
      const saved = await AsyncStorage.getItem(KEY);
      if (saved !== null && saved.length >= 8) return saved;
    } catch {
      // Sin almacenamiento (modo privado): un id por sesion.
    }
    const fresh = Crypto.randomUUID();
    void AsyncStorage.setItem(KEY, fresh).catch(() => undefined);
    return fresh;
  })();
  return visitor;
}

export function trackEvent(kind: 'item_view' | 'story_view', refId: string): void {
  void (async () => {
    try {
      const id = await visitorId();
      await getSupabase().rpc('track_event', { p_kind: kind, p_ref: refId, p_visitor: id });
    } catch {
      // Silencio a proposito: una estadistica no vale un error en pantalla.
    }
  })();
}
