/**
 * Tipos compartidos entre app movil, SaaS y backend.
 *
 * `database.ts` se genera desde el esquema real:
 *   pnpm db:types
 * No editar a mano.
 */

/** Estado NUESTRO del pedido (capa de experiencia). */
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

/** Espejo del paymentState de Clover (capa de hechos). NO mezclar con OrderStatus. */
export type CloverPaymentState = 'unknown' | 'open' | 'paid' | 'credited';

export type StoreStatus = 'draft' | 'pending_setup' | 'active' | 'paused' | 'disabled';

export type ConnectionStatus =
  | 'not_connected'
  | 'pending_auth'
  | 'connected'
  | 'degraded'
  | 'revoked';

/** Checklist de onboarding. Todos en true para poder activar la sucursal. */
export interface StoreSetupChecklist {
  clover_connected: boolean;
  ecommerce_enabled: boolean;
  order_type_ready: boolean;
  order_printer_ready: boolean;
  catalog_synced: boolean;
  smoke_test_passed: boolean;
  not_using_dining: boolean;
}

/** Importes SIEMPRE en centavos enteros. */
export type Cents = number;

export interface MoneyBreakdown {
  subtotalCents: Cents;
  discountCents: Cents;
  taxCents: Cents;
  tipCents: Cents;
  totalCents: Cents;
  currency: string;
}
