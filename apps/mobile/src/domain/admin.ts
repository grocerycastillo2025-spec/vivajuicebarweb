/**
 * Panel del negocio: las decisiones que se pueden razonar sin red.
 *
 * Modulo puro, sin imports en tiempo de ejecucion, para correrlo bajo
 * `node --test --experimental-strip-types`.
 */

import type { Cents } from './money';
import type { OrderStatus } from './order';

// ---------------------------------------------------------------------
// PRECIOS: lo que teclea el dueño -> centavos
// ---------------------------------------------------------------------

/**
 * "65" -> 6500, "65.5" -> 6550, "$1,250.00" -> 125000.
 *
 * Devuelve `null` si no es un precio: el formulario lo dice y no guarda.
 * Nada de float: se separan pesos y centavos como texto. Acepta coma
 * decimal solo si no hay punto ("65,50"), que es como lo escribe mucha
 * gente; con punto, la coma es separador de miles.
 */
export function parsePriceInput(raw: string): Cents | null {
  let text = raw.trim().replace(/^\$/, '').replace(/\s/g, '');
  if (text === '') return null;

  if (!text.includes('.') && /^\d+,\d{1,2}$/.test(text)) {
    text = text.replace(',', '.');
  } else {
    text = text.replace(/,(?=\d{3}(\D|$))/g, '');
  }

  const match = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(text);
  if (match === null) return null;

  const pesos = Number.parseInt(match[1] ?? '0', 10);
  const cents = Number.parseInt((match[2] ?? '0').padEnd(2, '0'), 10);
  return pesos * 100 + cents;
}

/** 6550 -> "65.50": para rellenar el campo al editar. */
export function priceToInput(cents: Cents): string {
  const safe = Math.max(0, Math.trunc(cents));
  return `${Math.floor(safe / 100)}.${String(safe % 100).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------
// PEDIDOS: que boton ensenar en cada estado
// ---------------------------------------------------------------------

export interface OrderAction {
  readonly to: OrderStatus;
  readonly kind: 'primary' | 'secondary';
}

/**
 * Mismas transiciones que `app.order_transition_allowed` (0020). Si se
 * cambia una, hay que cambiar la otra; el test de este modulo las fija.
 */
export function orderActions(status: OrderStatus): readonly OrderAction[] {
  switch (status) {
    case 'confirmed':
      return [
        { to: 'preparing', kind: 'primary' },
        { to: 'ready', kind: 'secondary' },
      ];
    case 'preparing':
      return [{ to: 'ready', kind: 'primary' }];
    case 'ready':
      return [{ to: 'completed', kind: 'primary' }];
    default:
      return [];
  }
}

export function canCancel(status: OrderStatus): boolean {
  return (
    status === 'payment_pending' ||
    status === 'confirmed' ||
    status === 'preparing' ||
    status === 'ready'
  );
}

export type OrderColumn = 'new' | 'preparing' | 'ready' | 'done';

export function orderColumn(status: OrderStatus): OrderColumn {
  if (status === 'confirmed' || status === 'payment_pending') return 'new';
  if (status === 'preparing') return 'preparing';
  if (status === 'ready') return 'ready';
  return 'done';
}

/** Ids de pedidos nuevos que no estaban en la carga anterior. */
export function newArrivals(
  previous: ReadonlySet<string> | null,
  current: readonly { id: string; status: OrderStatus }[],
): string[] {
  if (previous === null) return [];
  return current
    .filter((order) => orderColumn(order.status) === 'new' && !previous.has(order.id))
    .map((order) => order.id);
}

// ---------------------------------------------------------------------
// HORARIOS
// ---------------------------------------------------------------------

/** "8" -> "08:00", "8:5" -> null, "20:30" -> "20:30", "8:30 pm" -> "20:30". */
export function parseClockInput(raw: string): string | null {
  const text = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\. ?m\.|p\. ?m\.)?$/.exec(text);
  if (match === null) return null;

  let hour = Number.parseInt(match[1] ?? '', 10);
  const minute = Number.parseInt(match[2] ?? '0', 10);
  const meridiem = match[3]?.replace(/[.\s]/g, '');

  if (minute > 59) return null;
  if (meridiem !== undefined) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === 'pm' && hour !== 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
  }
  if (hour > 23) return null;

  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** "08:00:00" -> "08:00". */
export function clockFromDb(value: string): string {
  return value.slice(0, 5);
}

export interface DayHours {
  readonly weekday: number;
  readonly open: boolean;
  readonly opensAt: string;
  readonly closesAt: string;
}

export type HoursProblem = { readonly weekday: number; readonly reason: 'bad_time' | 'closes_before_opens' };

/** Revisa la semana entera antes de guardar. */
export function validateWeek(days: readonly DayHours[]): HoursProblem[] {
  const problems: HoursProblem[] = [];
  for (const day of days) {
    if (!day.open) continue;
    const opens = parseClockInput(day.opensAt);
    const closes = parseClockInput(day.closesAt);
    if (opens === null || closes === null) {
      problems.push({ weekday: day.weekday, reason: 'bad_time' });
    } else if (closes <= opens) {
      problems.push({ weekday: day.weekday, reason: 'closes_before_opens' });
    }
  }
  return problems;
}

// ---------------------------------------------------------------------
// COLORES
// ---------------------------------------------------------------------

/** "0e4a2b" o "#0E4A2B" -> "#0E4A2B"; cualquier otra cosa -> null. */
export function normalizeHex(raw: string): string | null {
  const text = raw.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(text)) return null;
  return `#${text.toUpperCase()}`;
}
