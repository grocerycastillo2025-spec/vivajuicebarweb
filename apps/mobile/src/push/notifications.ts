/**
 * Frontera con el sistema de notificaciones.
 *
 * Esto es la parte NATIVA de la fase 12, adelantada a este build: pedir
 * permiso, conseguir el token y recibir avisos. Cuando enviar cada aviso
 * es logica de servidor y puede llegar despues sin recompilar.
 *
 * Todo lo de aqui falla de forma blanda: un telefono sin servicios de
 * Google, un build sin `google-services.json` o un permiso denegado
 * devuelven un estado, nunca revientan la app. Una tienda de zumos no
 * puede dejar de vender porque el push no se registre.
 */

import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import type { PushPermission, PushUnsupported } from '../domain/push';

/**
 * En el navegador no hay push de Expo: `expo-notifications` no implementa
 * en web el token ni la respuesta inicial (lanza "not available on web").
 * Todo lo de abajo se vuelve un no-op y la pantalla de perfil lo explica.
 */
const IS_WEB = Platform.OS === 'web';

/** Canal de Android. Se crea en tiempo de ejecucion: es JS, viaja por OTA. */
export const ORDERS_CHANNEL = 'orders';

/**
 * Con la app abierta, Android no ensena nada por su cuenta. Un aviso de
 * "tu pedido esta en preparacion" que solo aparece si la app esta cerrada
 * no sirve de nada, asi que se muestra tambien en primer plano.
 */
export function installForegroundHandler(): void {
  if (IS_WEB) return;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });
}

export async function ensureAndroidChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(ORDERS_CHANNEL, {
    name: 'Order updates',
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 200, 100, 200],
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
  });
}

function toPermission(status: Notifications.PermissionStatus): PushPermission {
  if (status === 'granted') return 'granted';
  if (status === 'denied') return 'denied';
  return 'undetermined';
}

export async function getPermission(): Promise<PushPermission> {
  if (IS_WEB) return 'denied';
  const { status } = await Notifications.getPermissionsAsync();
  return toPermission(status);
}

/**
 * Pide el permiso. En Android 13+ esto abre el dialogo del sistema una
 * sola vez: si el cliente dice que no, la unica via es Ajustes, y por eso
 * la interfaz no lo pide al arrancar sino cuando ya hay un pedido que
 * seguir.
 */
export async function requestPermission(): Promise<PushPermission> {
  if (IS_WEB) return 'denied';
  const { status } = await Notifications.requestPermissionsAsync();
  return toPermission(status);
}

/** El projectId sale de app.json; sin el, Expo no puede emitir token. */
function projectId(): string | null {
  const eas = Constants.expoConfig?.extra?.['eas'] as { projectId?: string } | undefined;
  return eas?.projectId ?? null;
}

export function unsupportedReason(): PushUnsupported | null {
  if (IS_WEB) return 'web';
  // Un emulador no tiene Google Play Services: pedir token ahi solo
  // produce un error confuso.
  if (!Device.isDevice) return 'no-device';
  if (projectId() === null) return 'no-project';
  return null;
}

export interface DeviceToken {
  readonly token: string;
  readonly platform: 'android' | 'ios' | 'web';
  readonly deviceModel: string | null;
}

export type TokenResult =
  | { readonly ok: true; readonly value: DeviceToken }
  | { readonly ok: false; readonly reason: PushUnsupported | 'unknown'; readonly detail: string };

/**
 * Token de Expo, no el de FCM: el envio ira por el servicio de Expo, que
 * es lo que evita manejar credenciales de Google en nuestro backend.
 *
 * Si el build no lleva `google-services.json`, aqui es donde se nota: la
 * llamada falla y se devuelve 'no-fcm', que la pantalla de perfil traduce
 * a algo que se entiende.
 */
export async function fetchDeviceToken(): Promise<TokenResult> {
  if (IS_WEB) return { ok: false, reason: 'web', detail: 'Sin push en el navegador' };
  const id = projectId();
  if (id === null) return { ok: false, reason: 'no-project', detail: 'Sin projectId de EAS' };

  try {
    const result = await Notifications.getExpoPushTokenAsync({ projectId: id });
    const platform = Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web';
    return {
      ok: true,
      value: { token: result.data, platform, deviceModel: Device.modelName },
    };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    // El mensaje de Expo cuando falta la configuracion de Firebase habla
    // de FirebaseApp o de google-services; se reconoce para no ensenar un
    // error crudo que nadie sabe interpretar.
    const missingFirebase = /firebase|google-services/i.test(detail);
    return { ok: false, reason: missingFirebase ? 'no-fcm' : 'unknown', detail };
  }
}

export function addResponseListener(onResponse: (data: unknown) => void): { remove: () => void } {
  if (IS_WEB) return { remove: () => undefined };
  return Notifications.addNotificationResponseReceivedListener((response) => {
    onResponse(response.notification.request.content.data);
  });
}

/** La notificacion que abrio la app estando cerrada del todo. */
export async function getInitialData(): Promise<unknown> {
  if (IS_WEB) return null;
  const response = await Notifications.getLastNotificationResponseAsync();
  return response?.notification.request.content.data ?? null;
}
