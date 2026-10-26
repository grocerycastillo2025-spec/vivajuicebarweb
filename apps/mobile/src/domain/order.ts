/**
 * Pedido: estados, idempotencia y lo que se le promete al cliente.
 *
 * DOS CAPAS QUE NO SE MEZCLAN (Variable 1 del addendum)
 *   `status`               -> capa NUESTRA, la experiencia
 *   `clover_payment_state` -> capa de Clover, los hechos del dinero
 * Son columnas distintas en la base y aqui son tipos distintos.
 *
 * LO QUE NO SE PROMETE
 * Clover no modela el fin de la preparacion: no existe un webhook "order
 * ready". Mientras no entre el APK companion (fase 9), `ready` se deriva
 * del reloj, asi que la app dice "estimado para las 4:30" y nunca
 * "tu pedido esta listo". La copia esta en `strings.order`.
 *
 * Modulo puro, sin imports de runtime.
 */

import type { Cents } from './money';

export type OrderStatus =
  | 'draft'
  | 'payment_pending'
  | 'payment_failed'
  | 'confirmed'
  | 'preparing'
  | 'ready'
  | 'completed'
  | 'canceled'
  | 'refunded';

export type CloverPaymentState = 'unknown' | 'open' | 'paid' | 'credited';

/** Estados en los que el pedido sigue vivo para el cliente. */
const ACTIVE: readonly OrderStatus[] = ['payment_pending', 'confirmed', 'preparing', 'ready'];

export function isActiveOrder(status: OrderStatus): boolean {
  return ACTIVE.includes(status);
}

export function isFinishedOrder(status: OrderStatus): boolean {
  return status === 'completed' || status === 'canceled' || status === 'refunded';
}

/**
 * ¿Se le puede ensenar al cliente un codigo de recogida?
 *
 * No mientras el pago este pendiente: un codigo visible invita a ir al
 * mostrador por un pedido que la cocina todavia no tiene.
 */
export function showsPickupCode(status: OrderStatus): boolean {
  return status === 'confirmed' || status === 'preparing' || status === 'ready';
}

/** Posicion en la barra de progreso. -1 = fuera del camino feliz. */
export function progressStep(status: OrderStatus): number {
  switch (status) {
    case 'payment_pending':
      return 0;
    case 'confirmed':
      return 1;
    case 'preparing':
      return 2;
    case 'ready':
      return 3;
    case 'completed':
      return 4;
    default:
      return -1;
  }
}

export const ORDER_PROGRESS_STEPS = 5;

// ---------------------------------------------------------------------
// IDEMPOTENCIA
// ---------------------------------------------------------------------

/**
 * Clave de idempotencia de un intento de checkout.
 *
 * Regla del proyecto: existe desde ya, aunque el pago sea simulado. El
 * escenario que evita es R10, el critico: dinero cobrado sin pedido, o
 * dos pedidos por una sola compra. Un reintento con la misma clave tiene
 * que devolver el resultado anterior, nunca crear un segundo pedido.
 *
 * Se genera UNA vez por intento y se reutiliza en cada reintento. Se
 * renueva solo cuando el pedido sale bien, o cuando el cliente cambia el
 * carrito de forma que ya es otra compra.
 *
 * `randomHex` se inyecta para poder testear: en la app lo aporta
 * `expo-crypto`, que usa el generador del sistema.
 */
export function makeIdempotencyKey(randomHex: string, now: Date = new Date()): string {
  const clean = randomHex.replace(/[^0-9a-f]/gi, '').toLowerCase();
  const padded = (clean + '0'.repeat(32)).slice(0, 32);
  // El prefijo temporal facilita depurar y ordenar en la tabla
  // checkout_attempts sin tener que unir con nada.
  return `co_${now.getTime().toString(36)}_${padded}`;
}

export function isValidIdempotencyKey(value: string): boolean {
  return /^co_[0-9a-z]+_[0-9a-f]{32}$/.test(value);
}

/**
 * Clave de idempotencia de UN INTENTO DE PAGO.
 *
 * Es distinta de la del pedido, y esa separacion no es cosmetica. Con una
 * sola clave, un rechazo se quedaria cacheado: el proveedor devolveria el
 * mismo rechazo a cada reintento y el cliente no podria pagar nunca.
 *
 *   clave del pedido -> una por compra. Reintentar no crea un segundo
 *                       pedido.
 *   clave del intento -> una por intento. Reintentar tras un rechazo es
 *                       un intento nuevo; repetir el MISMO intento (la
 *                       respuesta se perdio por red, el cliente pulso dos
 *                       veces) no cobra dos veces.
 *
 * Se deriva de la del pedido a proposito: asi un pago se puede rastrear
 * hasta su compra sin unir con nada, y el numero de intento es
 * reproducible desde el telefono sin guardar estado local.
 */
export function makePaymentAttemptKey(orderKey: string, attempt: number): string {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error('El numero de intento empieza en 1');
  }
  return `${orderKey}#p${attempt}`;
}

export function isValidPaymentAttemptKey(value: string): boolean {
  const at = value.lastIndexOf('#p');
  if (at === -1) return false;
  return isValidIdempotencyKey(value.slice(0, at)) && /^[1-9][0-9]*$/.test(value.slice(at + 2));
}

/** ¿Este pedido esta esperando un pago? */
export function isPayable(status: OrderStatus): boolean {
  return status === 'payment_pending' || status === 'payment_failed';
}

// ---------------------------------------------------------------------
// PROMESA DE RECOGIDA
// ---------------------------------------------------------------------

export interface OrderTotals {
  readonly subtotalCents: Cents;
  readonly discountCents: Cents;
  readonly taxCents: Cents;
  readonly tipCents: Cents;
  readonly totalCents: Cents;
}

/**
 * ¿Se puede ensenar un total, o solo el subtotal?
 *
 * Los impuestos y el total los calcula Clover al crear la orden. Mientras
 * `tax_cents` y `total_cents` sigan a cero, ensenar un "total" seria
 * inventarse una cifra que despues no cuadraria con el ticket.
 */
export function hasAuthoritativeTotal(totals: OrderTotals): boolean {
  return totals.totalCents > 0 && totals.totalCents >= totals.subtotalCents;
}

/** Lo que se ensena como importe grande del pedido. */
export function displayAmountCents(totals: OrderTotals): Cents {
  return hasAuthoritativeTotal(totals) ? totals.totalCents : totals.subtotalCents;
}
