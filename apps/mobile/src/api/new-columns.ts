/**
 * Columnas de migraciones recientes que la base puede no tener todavía.
 *
 * La app web se publica en cuanto se sube el código, y el SQL lo corre el
 * dueño en Supabase cuando puede. Pedir una columna que no existe hace
 * fallar toda la consulta (Postgres 42703) y dejaría la app sin tienda ni
 * pedidos. Así que se pide con las columnas nuevas y, si la base aún no
 * las tiene, se repite sin ellas y se recuerda para esta sesión.
 */

/** Migraciones 0029 y 0030: Zelle, impuesto y recargos. */
export const STORE_COLUMNS_0026 = ', zelle_recipient, zelle_name, tax_rate, payment_surcharges';
/** Migraciones 0026, 0029 y 0030: pago confirmado, cobro en línea y recargo. */
export const ORDER_COLUMNS_0026 = ', paid_confirmed_at, online_status, surcharge_cents';

/**
 * Mensaje para el dueño cuando la base todavía no tiene las columnas: qué
 * archivo correr. Se escribe en la consola (la app sigue funcionando sin
 * ellas) y lo enseña el panel.
 */
export const MISSING_SQL_FILE = 'entregas/01-base-viva-juice.sql';

let baseHas0026 = true;

/** ¿La base ya tiene las columnas nuevas? (para que el panel lo diga) */
export function baseHasNewColumns(): boolean {
  return baseHas0026;
}

interface Result<T> {
  readonly data: T | null;
  readonly error: { message: string; code?: string } | null;
}

export async function with0026<T>(run: (withNew: boolean) => PromiseLike<Result<T>>): Promise<Result<T>> {
  if (!baseHas0026) return run(false);
  const first = await run(true);
  if (first.error?.code === '42703' || first.error?.code === 'PGRST204') {
    baseHas0026 = false;
    console.warn(`[VIVA] A la base le faltan columnas nuevas. Corre ${MISSING_SQL_FILE} en Supabase → SQL Editor.`);
    return run(false);
  }
  return first;
}
