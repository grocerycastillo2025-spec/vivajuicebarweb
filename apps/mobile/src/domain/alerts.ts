/**
 * Alarma de pedidos del panel y avisos de estado para el cliente.
 * Módulo puro: decide CUÁNDO sonar; el sonido lo pone src/admin/alarm.ts.
 */

export type AlarmSound = 'campana' | 'timbre' | 'alarma' | 'propio';
export type AlarmVolume = 'medio' | 'alto' | 'maximo';

export interface AlarmSettings {
  readonly sound: AlarmSound;
  readonly volume: AlarmVolume;
  /** Cada cuántos segundos se repite mientras haya pedidos sin atender (0 = no se repite). */
  readonly repeatSeconds: 0 | 15 | 30 | 60;
  readonly vibrate: boolean;
  readonly notify: boolean;
  readonly keepAwake: boolean;
}

export const DEFAULT_ALARM: AlarmSettings = {
  sound: 'alarma',
  volume: 'maximo',
  repeatSeconds: 15,
  vibrate: true,
  notify: true,
  keepAwake: true,
};

export function parseAlarmSettings(raw: unknown): AlarmSettings {
  const r = (raw ?? {}) as Partial<Record<keyof AlarmSettings, unknown>>;
  const pick = <T,>(value: unknown, allowed: readonly T[], fallback: T): T =>
    allowed.includes(value as T) ? (value as T) : fallback;
  return {
    sound: pick(r.sound, ['campana', 'timbre', 'alarma', 'propio'] as const, DEFAULT_ALARM.sound),
    volume: pick(r.volume, ['medio', 'alto', 'maximo'] as const, DEFAULT_ALARM.volume),
    repeatSeconds: pick(r.repeatSeconds, [0, 15, 30, 60] as const, DEFAULT_ALARM.repeatSeconds),
    vibrate: typeof r.vibrate === 'boolean' ? r.vibrate : DEFAULT_ALARM.vibrate,
    notify: typeof r.notify === 'boolean' ? r.notify : DEFAULT_ALARM.notify,
    keepAwake: typeof r.keepAwake === 'boolean' ? r.keepAwake : DEFAULT_ALARM.keepAwake,
  };
}

export function volumeGain(volume: AlarmVolume): number {
  return volume === 'medio' ? 0.4 : volume === 'alto' ? 0.7 : 1;
}

/** Pedidos que nadie ha empezado a atender (la alarma suena por ellos). */
export function waitingOrders<T extends { readonly status: string }>(orders: readonly T[]): T[] {
  return orders.filter((o) => o.status === 'confirmed');
}

/**
 * ¿Toca sonar ahora? Suena enseguida si llegó uno nuevo; si no, se repite
 * cada `repeatSeconds` mientras haya pedidos esperando y no esté en silencio.
 */
export function shouldRing(input: {
  readonly now: number;
  readonly arrived: number;
  readonly waiting: number;
  readonly lastRingAt: number | null;
  readonly repeatSeconds: number;
  readonly snoozedUntil: number | null;
}): boolean {
  if (input.waiting === 0 && input.arrived === 0) return false;
  if (input.snoozedUntil !== null && input.now < input.snoozedUntil) return false;
  if (input.arrived > 0) return true;
  if (input.repeatSeconds <= 0) return false;
  return input.lastRingAt === null || input.now - input.lastRingAt >= input.repeatSeconds * 1000;
}

/** Vibración fuerte: tres golpes largos. */
export const STRONG_VIBRATION: readonly number[] = [600, 150, 600, 150, 1000];

/** Cambios de estado que se le avisan al cliente. */
export type CustomerNotice = 'preparing' | 'ready' | 'canceled';

export function statusNotice(before: string | undefined, after: string): CustomerNotice | null {
  if (before === undefined || before === after) return null;
  if (after === 'preparing' || after === 'ready' || after === 'canceled') return after;
  return null;
}
