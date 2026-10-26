/**
 * Orquestacion del cobro (fase 6).
 *
 * Esta es la unica pieza que sabe en que orden pasan las cosas, y vive
 * fuera de React a proposito: asi se puede probar el camino completo
 * —incluido el que sale mal— sin montar una pantalla.
 *
 * EL ORDEN, Y POR QUE ESE
 *   1. abrir sesion con el proveedor  (con Clover, el iframe alojado)
 *   2. cobrar
 *   3. registrar el resultado en NUESTRA base
 *
 * Entre 2 y 3 hay un hueco, y ese hueco es el escenario critico R10: el
 * dinero ya se movio y nosotros todavia no lo sabemos. Si la app se
 * limitara a reintentar el paso 2, cobraria dos veces.
 *
 * Por eso un cobro que no se pudo registrar no se trata como un fallo:
 * se devuelve como `unrecorded`, con la referencia del proveedor. La
 * recuperacion (`resumeUnrecordedAttempt`) NO vuelve a cobrar: pregunta
 * al proveedor que paso con ese pago —`getPayment`— y registra la
 * respuesta. Esto es reconciliacion en pequeno, y es la razon concreta
 * por la que `getPayment` esta en la interfaz desde el dia uno.
 *
 * Y hay que separar dos fallos que se parecen y no lo son:
 *   - la escritura NO llego (red, 5xx): no sabemos nada, se cierra
 *     preguntando al proveedor y reintentando -> `unrecorded`
 *   - la escritura llego y la base la RECHAZO por regla nuestra (importe
 *     que no cuadra, pedido que ya no admite pago): reintentar no va a
 *     cambiar la respuesta nunca, y sin embargo el cobro ya se hizo. Es
 *     un cobro huerfano -> `orphaned`
 *
 * Confundirlos es lo que produce una pantalla que dice "guardando…" en
 * bucle sobre un cobro que la base no va a aceptar jamas.
 *
 * Modulo sin dependencias de React ni de Supabase: recibe el proveedor y
 * el registrador como puertos.
 */

import type { Cents } from '../domain/money';
import { makePaymentAttemptKey } from '../domain/order.ts';
import type { OrderStatus } from '../domain/order';
import { type PaymentService, type PaymentStatus } from './payment-service.ts';

export interface RecordPaymentInput {
  readonly orderId: string;
  readonly attemptKey: string;
  readonly providerPaymentId: string;
  readonly status: Extract<PaymentStatus, 'succeeded' | 'failed'>;
  readonly amountCents: Cents;
  readonly failureCode: string | null;
}

export interface RecordedPayment {
  readonly paymentId: string;
  readonly status: PaymentStatus;
  readonly orderStatus: OrderStatus;
  /** true si este intento ya estaba registrado: no se cobro de nuevo. */
  readonly replayed: boolean;
}

/**
 * Rechazo por una regla nuestra, no un fallo de transporte. Reintentarlo
 * dara siempre la misma respuesta, asi que no se reintenta.
 */
export class PermanentRecordError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'PermanentRecordError';
    this.code = code;
  }
}

/**
 * Puerta a nuestra base. En la app la implementa el RPC
 * `record_simulated_payment`; en los tests, una tabla en memoria.
 *
 * Quien la implementa tiene que lanzar `PermanentRecordError` cuando la
 * base rechaza por regla. Todo lo demas se toma como "no sabemos".
 */
export interface PaymentRecorder {
  record(input: RecordPaymentInput): Promise<RecordedPayment>;
}

export interface CheckoutDeps {
  readonly payments: PaymentService;
  readonly recorder: PaymentRecorder;
}

export interface PaymentAttemptInput {
  readonly orderId: string;
  readonly storeId: string;
  /** La clave del PEDIDO. La del intento se deriva de ella. */
  readonly orderKey: string;
  /** 1 para el primer intento. Se cuenta con los pagos ya registrados. */
  readonly attempt: number;
  readonly amountCents: Cents;
  readonly currency: string;
  /** Token de la tarjeta. Nunca un numero de tarjeta. */
  readonly sourceToken: string;
}

export type PaymentOutcome =
  | { readonly kind: 'paid'; readonly orderStatus: OrderStatus; readonly paymentId: string }
  | { readonly kind: 'declined'; readonly failureCode: string; readonly orderStatus: OrderStatus }
  /**
   * Se cobro pero no se pudo guardar. El dinero se movio: la salida
   * lleva la referencia para poder cerrar el hueco sin volver a cobrar.
   */
  | {
      readonly kind: 'unrecorded';
      readonly providerPaymentId: string;
      readonly attemptKey: string;
      readonly cause: Error;
    }
  /**
   * Se cobro y la base lo rechaza por regla. Reintentar no arregla nada:
   * hay dinero que no pertenece a ningun pedido y eso lo resuelve una
   * persona (y, desde la fase 8, el reconciliador).
   */
  | {
      readonly kind: 'orphaned';
      readonly code: string;
      readonly providerPaymentId: string;
      readonly attemptKey: string;
      readonly cause: Error;
    };

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

/** Un intento de cobro completo: sesion, cobro y registro. */
export async function runPaymentAttempt(
  deps: CheckoutDeps,
  input: PaymentAttemptInput,
): Promise<PaymentOutcome> {
  const attemptKey = makePaymentAttemptKey(input.orderKey, input.attempt);

  const session = await deps.payments.createSession({
    orderId: input.orderId,
    storeId: input.storeId,
    amountCents: input.amountCents,
    currency: input.currency,
    idempotencyKey: attemptKey,
  });

  // Con la misma clave, un segundo toque devuelve el mismo pago en vez de
  // crear otro. La garantia es del proveedor, y ademas de nuestra base.
  const result = await deps.payments.payOrder({
    orderId: input.orderId,
    sessionId: session.sessionId,
    sourceToken: input.sourceToken,
    amountCents: input.amountCents,
    tipCents: 0,
    idempotencyKey: attemptKey,
  });

  if (result.status !== 'succeeded' && result.status !== 'failed') {
    // 'pending' o 'voided' no los produce el simulado. Con Clover habra
    // que esperar al webhook; hasta entonces esto es un hueco conocido.
    throw new Error(`Estado de pago no soportado todavia: ${result.status}`);
  }

  return recordResult(deps, {
    orderId: input.orderId,
    attemptKey,
    providerPaymentId: result.providerPaymentId,
    status: result.status,
    amountCents: result.amountCents,
    failureCode: result.failureCode,
  });
}

/**
 * Cierra un cobro que se hizo pero no se llego a guardar.
 *
 * No cobra: pregunta al proveedor y registra lo que diga. Repetirlo es
 * inofensivo, porque el registro es idempotente por `attemptKey`.
 */
export async function resumeUnrecordedAttempt(
  deps: CheckoutDeps,
  pending: { readonly orderId: string; readonly attemptKey: string; readonly providerPaymentId: string },
): Promise<PaymentOutcome> {
  const payment = await deps.payments.getPayment({
    provider: deps.payments.provider,
    providerPaymentId: pending.providerPaymentId,
  });

  if (payment.status !== 'succeeded' && payment.status !== 'failed') {
    throw new Error(`Estado de pago no soportado todavia: ${payment.status}`);
  }

  return recordResult(deps, {
    orderId: pending.orderId,
    attemptKey: pending.attemptKey,
    providerPaymentId: payment.providerPaymentId,
    status: payment.status,
    amountCents: payment.amountCents,
    failureCode: payment.failureCode,
  });
}

async function recordResult(
  deps: CheckoutDeps,
  input: RecordPaymentInput,
): Promise<PaymentOutcome> {
  let recorded: RecordedPayment;
  try {
    recorded = await deps.recorder.record(input);
  } catch (cause) {
    if (input.status === 'failed') {
      // No se cobro nada, asi que no hay hueco que cerrar: el error del
      // registro es el error del intento.
      throw toError(cause);
    }
    if (cause instanceof PermanentRecordError) {
      return {
        kind: 'orphaned',
        code: cause.code,
        providerPaymentId: input.providerPaymentId,
        attemptKey: input.attemptKey,
        cause,
      };
    }
    return {
      kind: 'unrecorded',
      providerPaymentId: input.providerPaymentId,
      attemptKey: input.attemptKey,
      cause: toError(cause),
    };
  }

  if (recorded.status === 'succeeded') {
    return { kind: 'paid', orderStatus: recorded.orderStatus, paymentId: recorded.paymentId };
  }
  return {
    kind: 'declined',
    failureCode: input.failureCode ?? 'declined',
    orderStatus: recorded.orderStatus,
  };
}
