/**
 * De donde sale el `PaymentService` que usa la app.
 *
 * Hoy siempre el simulado, porque no hay proveedor conectado. En la fase
 * 7 esta funcion mira la sucursal —`stores.payments_mode` y su conexion
 * de Clover— y devuelve `CloverPaymentService` cuando corresponda. Las
 * pantallas no cambian: hablan con la interfaz, no con la implementacion.
 *
 * Una sola instancia por proceso, para que la idempotencia en memoria del
 * simulado sobreviva a los cambios de pantalla: si el cliente sale de la
 * pantalla de pago y vuelve, el mismo intento no cobra dos veces.
 */

import { MockPaymentService } from './mock-payment-service';
import type { PaymentService } from './payment-service';

let instance: PaymentService | null = null;

export function getPaymentService(): PaymentService {
  instance ??= new MockPaymentService();
  return instance;
}

/**
 * ¿El cobro de esta app es de mentira?
 *
 * La interfaz tiene que decirlo alto y claro mientras lo sea. Se deriva
 * del proveedor, no de una constante: el dia que entre Clover, deja de
 * salir el aviso solo.
 */
export function isSimulatedPayments(service: PaymentService = getPaymentService()): boolean {
  return service.provider === 'mock';
}
