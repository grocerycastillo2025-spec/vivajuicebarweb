/**
 * Franjas de recogida.
 *
 * Clover no agenda: la hora de pickup es dato NUESTRO (§6 del documento de
 * arquitectura). Aqui viven las reglas que deciden a que hora se puede
 * recoger, y son cuatro que se combinan:
 *
 *   1. `store_hours`        -> a que hora abre y cierra ese dia
 *   2. `store_closures`     -> feriados y cierres puntuales
 *   3. `store_pickup_config`-> tamano de franja, antelacion, tope por
 *                              franja y cuantos dias adelante
 *   4. pedidos ya aceptados -> la capacidad que queda en cada franja
 *
 * Modulo puro y sin imports de runtime: corre bajo `node --test`.
 *
 * SOBRE LAS ZONAS HORARIAS
 * Las horas de `store_hours` son horas LOCALES de la sucursal ("06:00"),
 * no instantes. El telefono del cliente puede estar en otro huso. Para no
 * arrastrar una libreria de fechas, la conversion se hace con
 * `Intl.DateTimeFormat`, que Hermes soporta y que ya conoce las reglas de
 * horario de verano.
 */

export interface DayHours {
  readonly weekday: number; // 0 = domingo
  readonly opens_at: string; // "06:00:00", hora local de la sucursal
  readonly closes_at: string;
}

export interface Closure {
  /** ISO. Cierre puntual: feriado, mantenimiento. */
  readonly starts_at: string;
  readonly ends_at: string;
  readonly reason?: string | null;
}

export interface PickupConfig {
  readonly slot_minutes: number;
  readonly lead_time_minutes: number;
  readonly max_orders_per_slot: number;
  readonly max_days_ahead: number;
  readonly asap_enabled: boolean;
}

export interface PickupSlot {
  /** Instante exacto de inicio, en ISO con zona. */
  readonly startsAt: string;
  /** Etiqueta ya formateada en hora de la sucursal: "4:30 PM". */
  readonly label: string;
  /** Dia local de la sucursal, "2026-08-30". Para agrupar. */
  readonly day: string;
  /** Cuantos pedidos caben todavia. */
  readonly remaining: number;
  readonly isFull: boolean;
}

export interface PickupDay {
  readonly day: string;
  /** "Today", "Tomorrow" o la fecha; la etiqueta la pone la pantalla. */
  readonly offsetDays: number;
  readonly slots: readonly PickupSlot[];
}

export interface SlotOccupancy {
  /** ISO del inicio de franja. */
  readonly startsAt: string;
  readonly count: number;
}

// ---------------------------------------------------------------------
// Utilidades de zona horaria, sin dependencias
// ---------------------------------------------------------------------

/** Partes de un instante en la zona de la sucursal. */
export function partsInZone(
  instant: Date,
  timeZone: string,
): { year: number; month: number; day: number; hour: number; minute: number; weekday: number } {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hour12: false,
    });
  } catch {
    // Zona invalida en la base: se cae a la del dispositivo antes que
    // dejar al cliente sin poder pedir.
    return {
      year: instant.getFullYear(),
      month: instant.getMonth() + 1,
      day: instant.getDate(),
      hour: instant.getHours(),
      minute: instant.getMinutes(),
      weekday: instant.getDay(),
    };
  }

  const found: Record<string, string> = {};
  for (const part of formatter.formatToParts(instant)) {
    if (part.type !== 'literal') found[part.type] = part.value;
  }

  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const weekdayIndex = weekdays.indexOf(found.weekday ?? '');

  return {
    year: Number.parseInt(found.year ?? '1970', 10),
    month: Number.parseInt(found.month ?? '01', 10),
    day: Number.parseInt(found.day ?? '01', 10),
    // "24" es medianoche en hour12:false.
    hour: Number.parseInt(found.hour ?? '00', 10) % 24,
    minute: Number.parseInt(found.minute ?? '00', 10),
    weekday: weekdayIndex === -1 ? instant.getDay() : weekdayIndex,
  };
}

/** Desfase de la zona respecto a UTC, en minutos, para ese instante. */
function zoneOffsetMinutes(instant: Date, timeZone: string): number {
  const parts = partsInZone(instant, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    instant.getUTCSeconds(),
  );
  return (
    (asUtc -
      instant.getTime() -
      (instant.getUTCSeconds() * 1000 - instant.getUTCSeconds() * 1000)) /
    60000
  );
}

/**
 * Convierte una hora LOCAL de la sucursal en un instante real.
 *
 * Se resuelve en dos pasadas porque el desfase depende del propio
 * instante: en el cambio de horario de verano, la primera estimacion
 * puede caer con el desfase equivocado.
 */
export function zonedTimeToInstant(
  day: { year: number; month: number; day: number },
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const naive = Date.UTC(day.year, day.month - 1, day.day, hour, minute, 0, 0);
  const first = new Date(naive - zoneOffsetMinutes(new Date(naive), timeZone) * 60000);
  const second = new Date(naive - zoneOffsetMinutes(first, timeZone) * 60000);
  return second;
}

/** "2026-08-30" en la zona de la sucursal. */
export function dayKey(instant: Date, timeZone: string): string {
  const p = partsInZone(instant, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** "16:30" -> 990 minutos desde medianoche. */
export function minutesFromClock(value: string): number {
  const [h = '0', m = '0'] = value.split(':');
  const hour = Number.parseInt(h, 10);
  const minute = Number.parseInt(m, 10);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return 0;
  return hour * 60 + minute;
}

/** 990 -> "4:30 PM". */
export function formatSlotLabel(totalMinutes: number): string {
  const hour24 = Math.floor(totalMinutes / 60) % 24;
  const minute = totalMinutes % 60;
  const suffix = hour24 >= 12 ? 'PM' : 'AM';
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:${String(minute).padStart(2, '0')} ${suffix}`;
}

// ---------------------------------------------------------------------
// Cierres
// ---------------------------------------------------------------------

export function isClosedAt(instant: Date, closures: readonly Closure[]): boolean {
  const t = instant.getTime();
  return closures.some((closure) => {
    const from = Date.parse(closure.starts_at);
    const to = Date.parse(closure.ends_at);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return false;
    return t >= from && t < to;
  });
}

// ---------------------------------------------------------------------
// Generacion de franjas
// ---------------------------------------------------------------------

export interface SlotInput {
  readonly hours: readonly DayHours[];
  readonly closures: readonly Closure[];
  readonly config: PickupConfig;
  readonly timeZone: string;
  readonly occupancy: readonly SlotOccupancy[];
  readonly now: Date;
}

function normalizeConfig(config: PickupConfig): PickupConfig {
  return {
    slot_minutes: Math.max(5, Math.min(60, Math.trunc(config.slot_minutes) || 15)),
    lead_time_minutes: Math.max(0, Math.trunc(config.lead_time_minutes) || 0),
    max_orders_per_slot: Math.max(1, Math.trunc(config.max_orders_per_slot) || 1),
    max_days_ahead: Math.max(0, Math.min(14, Math.trunc(config.max_days_ahead))),
    asap_enabled: config.asap_enabled,
  };
}

/**
 * Primer instante al que se puede comprometer un pedido: ahora mas la
 * antelacion que pide la cocina, redondeado hacia arriba a la franja.
 */
export function earliestPickup(now: Date, config: PickupConfig): Date {
  const normalized = normalizeConfig(config);
  const target = now.getTime() + normalized.lead_time_minutes * 60000;
  const slotMs = normalized.slot_minutes * 60000;
  return new Date(Math.ceil(target / slotMs) * slotMs);
}

/**
 * Todas las franjas disponibles, agrupadas por dia.
 *
 * Una franja llena NO se esconde: se devuelve con `isFull`, para que la
 * pantalla la muestre apagada. Esconderla haria pensar que la tienda
 * cierra antes de lo que cierra.
 */
export function buildPickupDays(input: SlotInput): readonly PickupDay[] {
  const config = normalizeConfig(input.config);
  const { hours, closures, timeZone, now } = input;

  const occupancyByStart = new Map<number, number>();
  for (const entry of input.occupancy) {
    const t = Date.parse(entry.startsAt);
    if (Number.isFinite(t)) occupancyByStart.set(t, entry.count);
  }

  const earliest = earliestPickup(now, config);
  const today = partsInZone(now, timeZone);
  const days: PickupDay[] = [];

  for (let offset = 0; offset <= config.max_days_ahead; offset += 1) {
    // Se avanza sobre el calendario local sumando dias a mediodia, que
    // evita saltarse un dia en los cambios de horario de verano.
    const noon = zonedTimeToInstant(
      { year: today.year, month: today.month, day: today.day + offset },
      12,
      0,
      timeZone,
    );
    const dayParts = partsInZone(noon, timeZone);
    const key = dayKey(noon, timeZone);

    const dayHours = hours.filter((entry) => entry.weekday === dayParts.weekday);
    if (dayHours.length === 0) {
      days.push({ day: key, offsetDays: offset, slots: [] });
      continue;
    }

    const slots: PickupSlot[] = [];

    for (const window of dayHours) {
      const opens = minutesFromClock(window.opens_at);
      const closes = minutesFromClock(window.closes_at);
      if (closes <= opens) continue;

      // La ultima franja tiene que caber entera antes del cierre: no se
      // promete una recogida a la hora exacta en que apagan las luces.
      for (
        let minute = opens;
        minute + config.slot_minutes <= closes;
        minute += config.slot_minutes
      ) {
        const startsAt = zonedTimeToInstant(
          { year: dayParts.year, month: dayParts.month, day: dayParts.day },
          Math.floor(minute / 60),
          minute % 60,
          timeZone,
        );

        if (startsAt.getTime() < earliest.getTime()) continue;
        if (isClosedAt(startsAt, closures)) continue;

        const used = occupancyByStart.get(startsAt.getTime()) ?? 0;
        const remaining = Math.max(0, config.max_orders_per_slot - used);

        slots.push({
          startsAt: startsAt.toISOString(),
          label: formatSlotLabel(minute),
          day: key,
          remaining,
          isFull: remaining === 0,
        });
      }
    }

    slots.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
    days.push({ day: key, offsetDays: offset, slots });
  }

  return days;
}

/** Los dias que tienen algo que ofrecer. */
export function daysWithSlots(days: readonly PickupDay[]): readonly PickupDay[] {
  return days.filter((day) => day.slots.length > 0);
}

export function firstAvailableSlot(days: readonly PickupDay[]): PickupSlot | null {
  for (const day of days) {
    for (const slot of day.slots) {
      if (!slot.isFull) return slot;
    }
  }
  return null;
}

/** ¿Se puede ofrecer "lo antes posible"? */
export function canOrderAsap(days: readonly PickupDay[], config: PickupConfig): boolean {
  if (!config.asap_enabled) return false;
  const first = firstAvailableSlot(days);
  if (first === null) return false;
  // Solo tiene sentido si la primera franja libre es de hoy.
  return first.day === days[0]?.day;
}

export type SlotRejection = 'not-found' | 'full' | 'too-soon' | 'closed';

/**
 * Revalida la franja elegida justo antes de mandar el pedido.
 *
 * Entre que el cliente elige y confirma pueden pasar minutos, y otro
 * cliente puede haber ocupado el ultimo hueco. El servidor lo comprueba
 * otra vez de todos modos; esto evita el viaje.
 */
export function validateChosenSlot(
  startsAt: string,
  days: readonly PickupDay[],
  now: Date,
  config: PickupConfig,
): SlotRejection | null {
  const target = Date.parse(startsAt);
  if (!Number.isFinite(target)) return 'not-found';

  if (target < earliestPickup(now, config).getTime()) return 'too-soon';

  for (const day of days) {
    for (const slot of day.slots) {
      if (Date.parse(slot.startsAt) === target) {
        return slot.isFull ? 'full' : null;
      }
    }
  }
  return 'not-found';
}
