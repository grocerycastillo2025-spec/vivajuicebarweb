/**
 * Cuentas de Estadísticas que se pueden probar sin red (0033).
 * Módulo puro, sin imports en tiempo de ejecución.
 */

export interface Change {
  /** Porcentaje entero, con signo. */
  readonly pct: number;
  readonly dir: 'up' | 'down' | 'same';
}

/** Cambio contra el periodo anterior. `null` si antes no hubo nada. */
export function percentChange(current: number, previous: number): Change | null {
  if (previous <= 0) return null;
  const pct = Math.round(((current - previous) / previous) * 100);
  return { pct, dir: pct > 0 ? 'up' : pct < 0 ? 'down' : 'same' };
}

export interface HeatCell {
  /** 1 = lunes … 7 = domingo (ISO). */
  readonly dow: number;
  readonly hour: number;
  readonly orders: number;
}

/** Pedidos por hora del día (suma de todos los días). */
export function ordersByHour(heat: readonly HeatCell[]): number[] {
  const hours = Array.from({ length: 24 }, () => 0);
  for (const cell of heat) {
    if (cell.hour >= 0 && cell.hour < 24) hours[cell.hour] = (hours[cell.hour] ?? 0) + cell.orders;
  }
  return hours;
}

/** La hora con más pedidos, o `null` si no hubo. */
export function peakHour(heat: readonly HeatCell[]): number | null {
  const hours = ordersByHour(heat);
  let best = -1;
  let max = 0;
  hours.forEach((n, h) => {
    if (n > max) {
      max = n;
      best = h;
    }
  });
  return best === -1 ? null : best;
}

/** El día de la semana con más pedidos (1–7), o `null`. */
export function peakWeekday(heat: readonly HeatCell[]): number | null {
  const days = Array.from({ length: 8 }, () => 0);
  for (const cell of heat) days[cell.dow] = (days[cell.dow] ?? 0) + cell.orders;
  let best: number | null = null;
  let max = 0;
  for (let d = 1; d <= 7; d += 1) {
    if ((days[d] ?? 0) > max) {
      max = days[d] ?? 0;
      best = d;
    }
  }
  return best;
}

/**
 * Horas que vale la pena dibujar en el mapa de calor: de la primera a la
 * última con pedidos, y al menos de 7 a 19 para que no quede una tira.
 */
export function hourWindow(heat: readonly HeatCell[]): { from: number; to: number } {
  const withOrders = heat.filter((c) => c.orders > 0).map((c) => c.hour);
  const from = Math.min(7, ...withOrders);
  const to = Math.max(19, ...withOrders);
  return { from: Math.max(0, from), to: Math.min(23, to) };
}

/** "8 a. m." / "3 p. m." (o "8 AM" en inglés), sin minutos. */
export function hourLabel(hour: number, lang: 'es' | 'en'): string {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const am = hour < 12;
  return lang === 'es' ? `${h12} ${am ? 'a. m.' : 'p. m.'}` : `${h12} ${am ? 'AM' : 'PM'}`;
}

export interface Share {
  readonly key: string;
  readonly value: number;
  /** 0–100, enteros que suman 100 (método del mayor residuo). */
  readonly pct: number;
}

export function shares(rows: readonly { key: string; value: number }[]): Share[] {
  const total = rows.reduce((s, r) => s + Math.max(0, r.value), 0);
  if (total === 0) return rows.map((r) => ({ ...r, pct: 0 }));
  const raw = rows.map((r) => (Math.max(0, r.value) / total) * 100);
  const floors = raw.map((x) => Math.floor(x));
  let left = 100 - floors.reduce((s, x) => s + x, 0);
  const order = raw.map((x, i) => ({ i, rest: x - Math.floor(x) })).sort((a, b) => b.rest - a.rest);
  for (const { i } of order) {
    if (left <= 0) break;
    floors[i] = (floors[i] ?? 0) + 1;
    left -= 1;
  }
  return rows.map((r, i) => ({ ...r, pct: floors[i] ?? 0 }));
}

/** Índice del día con más ventas, o `null` si todo fue 0. */
export function bestIndex(values: readonly number[]): number | null {
  let best: number | null = null;
  let max = 0;
  values.forEach((v, i) => {
    if (v > max) {
      max = v;
      best = i;
    }
  });
  return best;
}
