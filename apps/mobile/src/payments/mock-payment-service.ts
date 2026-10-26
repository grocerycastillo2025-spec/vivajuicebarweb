/**
 * Implementacion simulada, para la fase 6.
 *
 * No habla con nadie: guarda los pagos en memoria y responde como lo hara
 * Clover. Sirve para montar el flujo de checkout completo antes de tener
 * la conexion real, y para los tests.
 *
 * Respeta las dos reglas que importan del contrato:
 *  - `payOrder` es IDEMPOTENTE: la misma clave devuelve el mismo pago, no
 *    crea un segundo. Es la garantia que evita el escenario critico R10,
 *    cobrar dos veces por un pedido.
 *  - `getPayment` consulta por referencia del proveedor, que es como
 *    reconciliara el worker cuando entre Clover.
 */

import type { Cents } from '../domain/money';
import {
  declineCodeForToken,
  PaymentError,
  type PayInput,
  type PaymentRef,
  type PaymentResult,
  type PaymentService,
  type RefundInput,
  type RefundResult,
  type SessionInput,
  type SessionRef,
} from './payment-service.ts';

export interface MockOptions {
  /** Fuerza el fallo del cobro, para probar el camino de error. */
  readonly failWith?: string;
  /** Reloj inyectable, para que los tests no dependan de la hora real. */
  readonly now?: () => Date;
  /** Generador de ids inyectable, para que los tests sean deterministas. */
  readonly newId?: (prefix: string) => string;
}

const SESSION_TTL_MINUTES = 15;

export class MockPaymentService implements PaymentService {
  readonly provider = 'mock';

  private readonly byIdempotencyKey = new Map<string, PaymentResult>();
  private readonly byProviderId = new Map<string, PaymentResult>();
  private readonly sessions = new Map<string, SessionRef>();
  private readonly refunds = new Map<string, RefundResult>();
  private readonly options: MockOptions;
  private sequence = 0;

  constructor(options: MockOptions = {}) {
    this.options = options;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private nextId(prefix: string): string {
    if (this.options.newId !== undefined) return this.options.newId(prefix);
    this.sequence += 1;
    return `${prefix}_${String(this.sequence).padStart(6, '0')}`;
  }

  async createSession(input: SessionInput): Promise<SessionRef> {
    const existing = this.sessions.get(input.idempotencyKey);
    if (existing !== undefined) return existing;

    const ref: SessionRef = {
      sessionId: this.nextId('sess'),
      // Con Clover aqui ira la url del iframe alojado.
      url: null,
      expiresAt: new Date(this.now().getTime() + SESSION_TTL_MINUTES * 60000).toISOString(),
    };

    this.sessions.set(input.idempotencyKey, ref);
    return ref;
  }

  async payOrder(input: PayInput): Promise<PaymentResult> {
    // Idempotencia primero: antes de decidir nada mas.
    const previous = this.byIdempotencyKey.get(input.idempotencyKey);
    if (previous !== undefined) return previous;

    // El rechazo puede venir de la opcion (tests) o del token (pantalla de
    // pago), igual que en un sandbox de verdad.
    const decline = this.options.failWith ?? declineCodeForToken(input.sourceToken);

    if (decline !== null && decline !== undefined) {
      const failed: PaymentResult = {
        provider: this.provider,
        providerPaymentId: this.nextId('pay'),
        orderId: input.orderId,
        status: 'failed',
        amountCents: input.amountCents,
        tipCents: input.tipCents,
        currency: 'USD',
        failureCode: decline,
        createdAt: this.now().toISOString(),
      };
      // Un rechazo NO es una excepcion: es un resultado del negocio, y
      // por eso PaymentResult tiene `status` y `failureCode`. Lanzar aqui
      // haria que la primera llamada tirase y el reintento con la misma
      // clave devolviese un objeto, dos comportamientos distintos para la
      // misma operacion. Esa incoherencia es justo la que lleva a tratar
      // una tarjeta rechazada como un cobro bueno.
      //
      // Las excepciones quedan para lo excepcional de verdad: una
      // referencia que no existe, un reembolso imposible.
      this.byIdempotencyKey.set(input.idempotencyKey, failed);
      this.byProviderId.set(failed.providerPaymentId, failed);
      return failed;
    }

    const result: PaymentResult = {
      provider: this.provider,
      providerPaymentId: this.nextId('pay'),
      orderId: input.orderId,
      status: 'succeeded',
      amountCents: input.amountCents,
      tipCents: input.tipCents,
      currency: 'USD',
      failureCode: null,
      createdAt: this.now().toISOString(),
    };

    this.byIdempotencyKey.set(input.idempotencyKey, result);
    this.byProviderId.set(result.providerPaymentId, result);
    return result;
  }

  async getPayment(ref: PaymentRef): Promise<PaymentResult> {
    const found = this.byProviderId.get(ref.providerPaymentId);
    if (found === undefined) {
      throw new PaymentError('not_found', `No existe el pago ${ref.providerPaymentId}`);
    }
    return found;
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    const previous = this.refunds.get(input.idempotencyKey);
    if (previous !== undefined) return previous;

    const payment = await this.getPayment(input.paymentRef);
    if (payment.status !== 'succeeded') {
      throw new PaymentError('not_refundable', 'Solo se reembolsa un pago exitoso');
    }
    if (input.amountCents > payment.amountCents + payment.tipCents) {
      throw new PaymentError('amount_too_high', 'El reembolso supera lo cobrado');
    }

    const result: RefundResult = {
      providerRefundId: this.nextId('ref'),
      status: 'succeeded',
      amountCents: input.amountCents,
    };
    this.refunds.set(input.idempotencyKey, result);
    return result;
  }

  /** Solo para tests: cuantos pagos distintos se crearon de verdad. */
  countPayments(): number {
    return this.byProviderId.size;
  }

  /** Solo para tests: el total cobrado, para detectar cobros dobles. */
  totalChargedCents(): Cents {
    let total = 0;
    for (const payment of this.byProviderId.values()) {
      if (payment.status === 'succeeded') total += payment.amountCents + payment.tipCents;
    }
    return total;
  }
}
