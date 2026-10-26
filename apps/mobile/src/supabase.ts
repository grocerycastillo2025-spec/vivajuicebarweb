/**
 * Cliente de Supabase.
 *
 * Reglas de arquitectura que se ven aqui:
 *  - la app SOLO conoce la clave publicable; la secret vive en el backend
 *    (`readEnv()` corta el arranque si le llega una secret);
 *  - la app NUNCA toca credenciales de Clover: no hay ni una variable de
 *    Clover en este paquete, ni la habra. El cobro pasa por el iframe
 *    alojado en la fase 5.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import 'react-native-url-polyfill/auto';

import { readEnv } from './env';

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (client !== null) return client;

  const env = readEnv();

  client = createClient(env.supabaseUrl, env.supabaseKey, {
    auth: {
      storage: AsyncStorage,
      persistSession: true,
      autoRefreshToken: true,
      // En movil no hay callback por URL: el enlace lo maneja expo-linking.
      detectSessionInUrl: false,
    },
  });

  return client;
}
