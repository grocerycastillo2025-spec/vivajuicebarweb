/**
 * Pagos.
 *
 * El registro NO es un insert: el cliente no puede escribir en `payments`
 * (0004_rls.sql). Pasa por el RPC `record_simulated_payment`, que es
 * SECURITY DEFINER y solo acepta el cobro si la sucursal esta en modo
 * simulado Y no tiene conexion con Clover. Ver 0009_payments.sql.
 *
 * El importe que se manda se compara alli con el subtotal releido de la
 * base. Si no cuadra, el RPC lo rechaza: el telefono no decide cuanto se
 * cobra.
 */

import { dataError } from '../domain/errors';
import type { Cents } from '../domain/money';
import type { OrderStatus } from '../domain/order';
import type { PaymentStatus } from '../payments/payment-service';
import {
  PermanentRecordError,
  type PaymentRecorder,
  type RecordedPayment,
  type RecordPaymentInput,
} from '../payments/checkout-flow';
import { getSupabase } from '../supabase';

export interface PaymentRow {
  id: string;
  order_id: string;
  provider: string;
  provider_payment_id: string | null;
  amount_cents: Cents;
  tip_cents: Cents;
  currency: string;
  status: PaymentStatus;
  failure_code: string | null;
  created_at: string;
}

// `raw_response` no se pide nunca: el cliente ve el resultado del pago,
// no la respuesta cruda del proveedor.
const PAYMENT_COLUMNS =
  'id, order_id, provider, provider_payment_id, amount_cents, tip_cents, ' +
  'currency, status, failure_code, created_at';

export async function fetchOrderPayments(orderId: string): Promise<PaymentRow[]> {
  const { data, error } = await getSupabase()
    .from('payments')
    .select(PAYMENT_COLUMNS)
    .eq('order_id', orderId)
    .order('created_at', { ascending: true })
    .returns<PaymentRow[]>();

  if (error) throw dataError(error.message, error.code);
  return data ?? [];
}

/** Errores de negocio del RPC. La copia esta en `strings.payment`. */
export type RecordPaymentFailure =
  | 'auth_required'
  | 'invalid_attempt_key'
  | 'invalid_payment_status'
  | 'idempotency_key_conflict'
  | 'order_not_found'
  | 'order_not_payable'
  | 'simulated_payments_disabled'
  | 'amount_mismatch'
  | 'tips_not_supported_yet'
  | 'unknown';

const KNOWN_FAILURES: readonly RecordPaymentFailure[] = [
  'auth_required',
  'invalid_attempt_key',
  'invalid_payment_status',
  'idempotency_key_conflict',
  'order_not_found',
  'order_not_payable',
  'simulated_payments_disabled',
  'amount_mismatch',
  'tips_not_supported_yet',
];

export function parseRecordPaymentError(message: string): RecordPaymentFailure {
  for (const code of KNOWN_FAILURES) {
    if (message.includes(code)) return code;
  }
  return 'unknown';
}

interface RecordPaymentResponse {
  payment_id: string;
  provider: string;
  provider_payment_id: string;
  status: PaymentStatus;
  amount_cents: Cents;
  tip_cents: Cents;
  failure_code: string | null;
  order_status: OrderStatus;
  simulated: boolean;
  replayed: boolean;
}

/** Implementacion real del puerto que usa `runPaymentAttempt`. */
export const supabasePaymentRecorder: PaymentRecorder = {
  async record(input: RecordPaymentInput): Promise<RecordedPayment> {
    const { data, error } = await getSupabase().rpc('record_simulated_payment', {
      p_order_id: input.orderId,
      p_attempt_key: input.attemptKey,
      p_provider_payment_id: input.providerPaymentId,
      p_status: input.status,
      p_amount_cents: input.amountCents,
      p_tip_cents: 0,
      p_failure_code: input.failureCode,
    });

    if (error) {
      // Un rechazo por regla nuestra no se reintenta: la respuesta seria
      // la misma siempre. Un fallo de red si, y por eso se distinguen.
      const failure = parseRecordPaymentError(error.message);
      if (failure !== 'unknown') throw new PermanentRecordError(failure, error.message);
      throw dataError(error.message, error.code);
    }
    if (data === null || data === undefined) {
      throw dataError('El servidor no devolvio el resultado del pago');
    }

    const response = data as RecordPaymentResponse;
    return {
      paymentId: response.payment_id,
      status: response.status,
      orderStatus: response.order_status,
      replayed: response.replayed,
    };
  },
};
