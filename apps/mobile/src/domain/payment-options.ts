/**
 * Formas de pago de VIVA Juice and Coffee (EE. UU.). Módulo puro.
 *
 *   En mostrador:  efectivo, tarjeta en mostrador.
 *   Zelle:         manual. El cliente manda el dinero desde su banco y el
 *                  cajero toca "Pago recibido" ("pago por confirmar").
 *   En línea:      Stripe (tarjeta, Apple Pay, Google Pay) y PayPal. Una
 *                  Edge Function crea el cobro con el total leído de la
 *                  base y otra lo confirma consultando al proveedor.
 *
 * Todas se prenden y apagan en el panel. Las mismas reglas viven en la
 * base (`app.pay_with_available`, migración 0029): esto solo decide qué se
 * enseña; la base decide qué se acepta.
 */

export type CounterMethod = 'cash' | 'card_counter';
export type OnlineProvider = 'stripe' | 'paypal';
export type CustomerMethod = CounterMethod | 'zelle' | OnlineProvider;

/** Lo que se le puede ofrecer al cliente, en el orden en que se enseña. */
export const CUSTOMER_METHODS: readonly CustomerMethod[] = ['cash', 'card_counter', 'zelle', 'stripe', 'paypal'];
export const ONLINE_PROVIDERS: readonly OnlineProvider[] = ['stripe', 'paypal'];

/** Interruptores guardados en `stores.payment_options`. */
export type PaymentOptions = Partial<Record<string, boolean>>;

export interface PaymentSetup {
  readonly payment_options?: PaymentOptions | null;
  readonly zelle_recipient?: string | null;
  /** Cuentas conectadas (`payment_provider_accounts` con status 'active'). */
  readonly connected?: ReadonlySet<OnlineProvider> | null;
}

/**
 * Formas de pago que se le ofrecen al cliente:
 *  - efectivo y tarjeta en mostrador: con el interruptor prendido;
 *  - Zelle: prendido Y con correo o teléfono de Zelle;
 *  - Stripe y PayPal: prendidos Y con la cuenta conectada.
 */
export function customerMethods(store: PaymentSetup | null | undefined): CustomerMethod[] {
  const options = store?.payment_options;
  // Base sin configuración de pagos: lo de mostrador.
  if (options === null || options === undefined) return ['cash', 'card_counter'];
  return CUSTOMER_METHODS.filter((m) => {
    if (options[m] !== true) return false;
    if (m === 'zelle') return normalizeZelleRecipient(store?.zelle_recipient ?? '') !== null;
    if (m === 'stripe' || m === 'paypal') return store?.connected?.has(m) === true;
    return true;
  });
}

export function isOnlineProvider(payWith: string | null | undefined): payWith is OnlineProvider {
  return payWith === 'stripe' || payWith === 'paypal';
}

/**
 * Pedidos cuyo pago no se cobra en el mostrador: hasta que llega, el cajero
 * ve "Pago por confirmar". Zelle lo confirma el cajero; Stripe y PayPal se
 * confirman solos, pero el cajero también puede marcarlo si el cliente
 * terminó pagando en caja.
 */
export function needsPaymentConfirmation(payWith: string | null | undefined): boolean {
  return payWith === 'zelle' || payWith === 'stripe' || payWith === 'paypal'
    || payWith === 'transfer' || payWith === 'mercadopago';
}

// ---------------------------------------------------------------------
// Zelle
// ---------------------------------------------------------------------

/**
 * Correo o teléfono de EE. UU. tal como lo guarda la base:
 *   "Pagos@Viva.com "      -> "pagos@viva.com"
 *   "(732) 496-8863"       -> "+17324968863"
 *   "1-732-496-8863"       -> "+17324968863"
 * Devuelve null si no es ni lo uno ni lo otro.
 */
export function normalizeZelleRecipient(input: string): string | null {
  const value = input.trim();
  if (value === '') return null;
  if (value.includes('@')) {
    const email = value.toLowerCase();
    return /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(email) && email.length <= 120 ? email : null;
  }
  const digits = value.replace(/\D/g, '');
  const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  // Código de área y central de EE. UU. no empiezan con 0 ni 1.
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(ten) ? `+1${ten}` : null;
}

/** "+17324968863" -> "(732) 496-8863"; un correo se queda igual. */
export function formatZelleRecipient(stored: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(stored);
  return m === null ? stored : `(${m[1]}) ${m[2]}-${m[3]}`;
}

// ---------------------------------------------------------------------
// Panel: lo que falta antes de guardar
// ---------------------------------------------------------------------

export type PaymentSetupProblem =
  | 'zelle_invalid'
  | 'zelle_without_data'
  | 'stripe_not_connected'
  | 'paypal_not_connected'
  | 'none_on';

/**
 * Problemas que impiden guardar ('zelle_invalid', 'zelle_without_data',
 * 'none_on') y avisos que no ('*_not_connected': se guarda prendido, pero
 * el cliente no lo ve hasta conectar la cuenta).
 */
export function paymentSetupProblems(input: {
  readonly options: PaymentOptions;
  readonly zelle: string;
  readonly connected: ReadonlySet<OnlineProvider>;
}): PaymentSetupProblem[] {
  const problems: PaymentSetupProblem[] = [];
  const zelle = input.zelle.trim();
  if (zelle !== '' && normalizeZelleRecipient(zelle) === null) problems.push('zelle_invalid');
  if (input.options['zelle'] === true && zelle === '') problems.push('zelle_without_data');
  if (input.options['stripe'] === true && !input.connected.has('stripe')) problems.push('stripe_not_connected');
  if (input.options['paypal'] === true && !input.connected.has('paypal')) problems.push('paypal_not_connected');
  if (!CUSTOMER_METHODS.some((m) => input.options[m] === true)) problems.push('none_on');
  return problems;
}

/** Los avisos que no impiden guardar. */
export function blocksSaving(problem: PaymentSetupProblem): boolean {
  return problem !== 'stripe_not_connected' && problem !== 'paypal_not_connected';
}
