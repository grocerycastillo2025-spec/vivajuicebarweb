/**
 * Alta y baja del token de notificaciones.
 *
 * El alta pasa por el RPC `register_push_token` y no por un insert: la
 * columna `token` es unica global y un telefono puede cambiar de dueno,
 * asi que hace falta poder reasignar la fila. Ver 0010_push_tokens.sql.
 *
 * La baja si es un delete normal: la policy solo deja borrar lo propio.
 */

import { dataError } from '../domain/errors';
import { getSupabase } from '../supabase';

export async function registerPushToken(input: {
  readonly token: string;
  readonly platform: 'android' | 'ios' | 'web';
  readonly deviceModel: string | null;
}): Promise<void> {
  const { error } = await getSupabase().rpc('register_push_token', {
    p_token: input.token,
    p_platform: input.platform,
    p_device_model: input.deviceModel,
  });

  if (error) throw dataError(error.message, error.code);
}

/**
 * Se llama al cerrar sesion. Si no, el siguiente aviso de ese pedido
 * llegaria al telefono de quien ya no es su dueno.
 */
export async function unregisterPushToken(token: string): Promise<void> {
  const { error } = await getSupabase().from('push_tokens').delete().eq('token', token);
  if (error) throw dataError(error.message, error.code);
}
