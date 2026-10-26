/**
 * Dinero. Regla del proyecto: SIEMPRE centavos enteros, nunca float.
 * Este modulo no importa nada en tiempo de ejecucion a proposito, para
 * poder correrlo bajo `node --test --experimental-strip-types`.
 */

import type { Cents } from '@juicebar/shared-types';

export type { Cents };

/**
 * Moneda e idioma por defecto. Arrancan en USD / en-US (lo que esperan
 * los tests y la app de Estados Unidos) y la app los fija al arrancar con
 * `configureMoney`, desde `app.json` (`extra.currency`, `extra.locale`).
 * VIVA Juice and Coffee: USD, en-US o es-US según el idioma elegido (i18n.ts).
 */
let defaultCurrency = 'USD';
let defaultLocale = 'en-US';

export function configureMoney(currency: string, locale: string): void {
  if (/^[A-Z]{3}$/.test(currency)) defaultCurrency = currency;
  if (locale.trim() !== '') defaultLocale = locale;
}

export function moneyDefaults(): { currency: string; locale: string } {
  return { currency: defaultCurrency, locale: defaultLocale };
}

/** Formatea centavos como moneda. 850 -> "$8.50". */
export function formatMoney(cents: Cents, currency = defaultCurrency, locale = defaultLocale): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
  }).format(cents / 100);
}

/**
 * Formatea un recargo con signo: 100 -> "+$1.00", 0 -> "".
 * Los modificadores sin costo no muestran precio.
 */
export function formatSurcharge(
  cents: Cents,
  currency = defaultCurrency,
  locale = defaultLocale,
): string {
  if (cents === 0) return '';
  const sign = cents > 0 ? '+' : '-';
  return `${sign}${formatMoney(Math.abs(cents), currency, locale)}`;
}

/** Suma defensiva: cualquier valor no finito se trata como 0. */
export function sumCents(values: readonly Cents[]): Cents {
  let total = 0;
  for (const value of values) {
    total += Number.isFinite(value) ? Math.trunc(value) : 0;
  }
  return total;
}
