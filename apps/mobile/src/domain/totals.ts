/**
 * Impuesto y recargo (migración 0030). Módulo puro.
 *
 * Las MISMAS reglas que `app.apply_order_charges` en la base, para que el
 * total que ve el cliente antes de pedir sea el que se le cobra:
 *
 *   impuesto = redondeo( Σ importe_línea × tasa )   — solo líneas que cobran
 *              impuesto; tasa = la propia del producto o la de la sucursal
 *   recargo  = redondeo( (subtotal + impuesto) × % de la forma de pago )
 *   total    = subtotal + impuesto + recargo
 *
 * Redondeo al centavo, mitad hacia arriba. Las tasas se llevan como enteros
 * de cienmilésimas (numeric(6,5) en la base) para no arrastrar errores de
 * coma flotante: 0.06625 -> 6625.
 */

import type { Cents } from './money';

const SCALE = 100_000;

/** 0.06625 -> 6625. Cualquier cosa rara -> 0. */
export function rateUnits(rate: unknown): number {
  const n = typeof rate === 'string' ? Number(rate) : rate;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * SCALE);
}

/** Σ cents × units / 100000, redondeado mitad hacia arriba (todo positivo). */
function roundScaled(scaled: number): number {
  return Math.floor((scaled + SCALE / 2) / SCALE);
}

export interface TaxLine {
  /** Importe de la línea: (precio + opciones) × cantidad. */
  readonly lineTotalCents: Cents;
  readonly taxable: boolean;
  /** Tasa propia del producto (fracción) o null para la de la sucursal. */
  readonly taxRateOverride: number | null;
}

export interface Totals {
  readonly subtotalCents: Cents;
  readonly taxCents: Cents;
  readonly surchargeCents: Cents;
  readonly totalCents: Cents;
}

export function computeTotals(input: {
  readonly lines: readonly TaxLine[];
  /** Tasa de la sucursal (fracción). */
  readonly storeTaxRate: unknown;
  /** Recargo de la forma de pago elegida (fracción). */
  readonly surchargeRate: unknown;
}): Totals {
  const storeUnits = rateUnits(input.storeTaxRate);
  let subtotal = 0;
  let taxScaled = 0;
  for (const line of input.lines) {
    subtotal += line.lineTotalCents;
    if (!line.taxable) continue;
    const units = line.taxRateOverride === null ? storeUnits : rateUnits(line.taxRateOverride);
    taxScaled += line.lineTotalCents * units;
  }
  const tax = roundScaled(taxScaled);
  const surcharge = roundScaled((subtotal + tax) * rateUnits(input.surchargeRate));
  return { subtotalCents: subtotal, taxCents: tax, surchargeCents: surcharge, totalCents: subtotal + tax + surcharge };
}

/** Recargo de una forma de pago según `stores.payment_surcharges`. */
export function surchargeRateFor(surcharges: unknown, payWith: string | null): number {
  if (payWith === null || surcharges === null || typeof surcharges !== 'object') return 0;
  const value = (surcharges as Record<string, unknown>)[payWith];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** 0.06625 -> "6.625%", 0.03 -> "3%". */
export function formatRate(rate: number): string {
  const pct = Math.round(rate * SCALE) / 1000;
  return `${pct.toLocaleString('en-US', { maximumFractionDigits: 3 })}%`;
}

/** "6.625" o "6.625%" -> 0.06625; vacío -> 0; inválido -> null. */
export function parseRateInput(input: string, max: number): number | null {
  const clean = input.trim().replace('%', '').replace(',', '.');
  if (clean === '') return 0;
  if (!/^\d{1,2}(\.\d{1,3})?$/.test(clean)) return null;
  const rate = Math.round(Number(clean) * 1000) / SCALE;
  return rate > max ? null : rate;
}
