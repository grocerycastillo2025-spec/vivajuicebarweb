/**
 * Frontera de pagos (§5 del documento de arquitectura).
 *
 *   PaymentService (interfaz)
 *   ├── MockPaymentService          <- fase 6
 *   ├── CloverPaymentService        <- fases 7-8
 *   └── StripePaymentService        <- futuro, fuera del roadmap v1
 *
 * `getPayment` esta en la interfaz desde el dia uno y no es adorno: sin
 * el no hay reconciliacion posible. El reconciliador de pagos compara
 * cada 15 minutos nuestros `payments` contra los del proveedor para
 * detectar cobro sin pedido, pedido sin cobro y montos distintos (§9), y
 * eso exige poder preguntar por un pago concreto.
 *
 * Modulo puro: solo tipos y una implementacion en memoria.
 */

import type { Cents } from '../domain/money';

export type PaymentStatus = 'pending' | 'succeeded' | 'failed' | 'voided';

export interface SessionInput {
  readonly orderId: string;
  readonly storeId: string;
  readonly amountCents: Cents;
  readonly currency: string;
  /** La misma que la del pedido: un reintento no crea una segunda sesion. */
  readonly idempotencyKey: string;
}

export interface SessionRef {
  readonly sessionId: string;
  /**
   * URL que se abre en el WebView. Con Clover sera el iframe alojado; el
   * PAN y el CVV no pasan nunca por nuestro backend ni por este codigo.
   */
  readonly url: string | null;
  readonly expiresAt: string;
}

export interface PayInput {
  readonly orderId: string;
  readonly sessionId: string;
  /** Token de la tarjeta, nunca el numero. */
  readonly sourceToken: string;
  readonly amountCents: Cents;
  readonly tipCents: Cents;
  readonly idempotencyKey: string;
}

export interface PaymentRef {
  readonly provider: string;
  readonly providerPaymentId: string;
}

export interface PaymentResult {
  readonly provider: string;
  readonly providerPaymentId: string;
  readonly orderId: string;
  readonly status: PaymentStatus;
  readonly amountCents: Cents;
  readonly tipCents: Cents;
  readonly currency: string;
  readonly failureCode: string | null;
  readonly createdAt: string;
}

export interface RefundInput {
  readonly paymentRef: PaymentRef;
  readonly amountCents: Cents;
  readonly reason: string;
  readonly idempotencyKey: string;
}

export interface RefundResult {
  readonly providerRefundId: string;
  readonly status: 'pending' | 'succeeded' | 'failed';
  readonly amountCents: Cents;
}

export interface PaymentService {
  readonly provider: string;
  createSession(input: SessionInput): Promise<SessionRef>;
  /** Idempotente: la misma clave devuelve el mismo resultado. */
  payOrder(input: PayInput): Promise<PaymentResult>;
  /** Obligatorio para reconciliar. */
  getPayment(ref: PaymentRef): Promise<PaymentResult>;
  refund(input: RefundInput): Promise<RefundResult>;
}

/**
 * Tokens de prueba.
 *
 * Un sandbox de pagos de verdad (Clover, Stripe) no expone un interruptor
 * "falla ahora": expone TOKENS que provocan cada resultado. Se imita eso
 * para que la pantalla de pago de la fase 6 sea la misma que la de la
 * fase 7, cambiando solo de donde sale el token.
 */
export const TEST_TOKENS = {
  approve: 'tok_test_approve',
  declineCard: 'tok_test_decline_card_declined',
  declineFunds: 'tok_test_decline_insufficient_funds',
} as const;

export const DECLINE_TOKEN_PREFIX = 'tok_test_decline_';

/** Codigo de rechazo que provoca un token, o null si aprueba. */
export function declineCodeForToken(token: string): string | null {
  return token.startsWith(DECLINE_TOKEN_PREFIX)
    ? (token.slice(DECLINE_TOKEN_PREFIX.length) || 'declined')
    : null;
}

export class PaymentError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'PaymentError';
    this.code = code;
  }
}
