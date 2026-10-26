/**
 * Notificaciones: la parte que se puede razonar sin tocar el sistema.
 *
 * Modulo puro. Lo nativo vive en `src/push/notifications.ts`; aqui solo
 * hay decisiones, para poder probarlas.
 */

export type PushPermission = 'granted' | 'denied' | 'undetermined';

/** Por que este dispositivo no puede registrarse. */
export type PushUnsupported =
  /** Un emulador no tiene servicios de Google: no hay token que pedir. */
  | 'no-device'
  /** El build no lleva `google-services.json`, asi que no hay FCM. */
  | 'no-fcm'
  /** Falta el projectId de EAS, sin el no se puede pedir token a Expo. */
  | 'no-project'
  /** La app web: el navegador no recibe el push de Expo. */
  | 'web';

export type PushState =
  | { readonly kind: 'unsupported'; readonly reason: PushUnsupported }
  | { readonly kind: 'idle'; readonly permission: PushPermission }
  | { readonly kind: 'working' }
  | { readonly kind: 'ready'; readonly token: string }
  | { readonly kind: 'error'; readonly message: string };

/**
 * ¿Hay que pedir el token ahora?
 *
 * Solo con permiso concedido y sesion iniciada: el token se guarda contra
 * un usuario, y sin usuario no hay donde guardarlo. Si ya se registro este
 * mismo token para este mismo usuario, no se repite.
 */
export function shouldRegister(
  permission: PushPermission,
  userId: string | null,
  registered: { readonly token: string; readonly userId: string } | null,
  token: string | null,
): boolean {
  if (permission !== 'granted' || userId === null) return false;
  if (token === null) return true;
  return registered === null || registered.token !== token || registered.userId !== userId;
}

// ---------------------------------------------------------------------
// A DONDE LLEVA UNA NOTIFICACION
// ---------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PushTarget {
  readonly pathname: '/order/[id]';
  readonly params: { readonly id: string };
}

/**
 * Traduce el payload de una notificacion en una ruta.
 *
 * El payload lo manda un servidor y llega por la red: es entrada externa.
 * Por eso NO se acepta una ruta dentro del mensaje —seria dejar que quien
 * mande una notificacion abra cualquier pantalla con cualquier
 * parametro—, sino un tipo conocido y un id que tiene que ser un uuid.
 * Todo lo demas no lleva a ninguna parte, y eso es lo correcto.
 */
export function pushTargetFromData(data: unknown): PushTarget | null {
  if (typeof data !== 'object' || data === null) return null;

  const record = data as Record<string, unknown>;
  if (record['type'] !== 'order') return null;

  const orderId = record['orderId'];
  if (typeof orderId !== 'string' || !UUID.test(orderId)) return null;

  return { pathname: '/order/[id]', params: { id: orderId } };
}
