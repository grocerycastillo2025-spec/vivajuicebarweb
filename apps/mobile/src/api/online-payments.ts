/**
 * Cobro en línea (0029): Stripe y PayPal, siempre a través de Edge
 * Functions. Las llaves secretas viven en Supabase → Edge Functions →
 * Secrets; la app nunca las ve, y el monto lo lee la función de la base,
 * nunca de aquí.
 */

import { dataError } from '../domain/errors';
import type { OnlineProvider } from '../domain/payment-options';
import { getSupabase } from '../supabase';

interface FunctionError {
  readonly context?: { json?: () => Promise<unknown> };
  readonly message: string;
}

async function invoke<T>(fn: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await getSupabase().functions.invoke<T>(fn, { body });
  if (error !== null) {
    // El cuerpo trae el motivo ("ya_pagado", "no_conectado"...).
    let reason = (error as FunctionError).message;
    try {
      const payload = (await (error as FunctionError).context?.json?.()) as { error?: unknown } | undefined;
      if (typeof payload?.error === 'string') reason = payload.error;
    } catch {
      // se queda el mensaje genérico
    }
    throw dataError(reason);
  }
  if (data === null) throw dataError('respuesta_vacia');
  return data;
}

const FUNCTION: Record<OnlineProvider, string> = { stripe: 'stripe-pago', paypal: 'paypal-pago' };

/** La página de pago del proveedor, con el total exacto del pedido. */
export async function startOnlinePayment(provider: OnlineProvider, orderId: string): Promise<string> {
  const result = await invoke<{ url?: unknown }>(FUNCTION[provider], { order_id: orderId });
  if (typeof result.url !== 'string') throw dataError('pago_rechazado');
  return result.url;
}

/**
 * Al volver de PayPal: la función cobra la orden aprobada y la verifica con
 * PayPal antes de marcar el pedido. Stripe no lo necesita (cobra solo y avisa
 * por webhook), pero se le pregunta igual para no esperar al aviso.
 */
export async function confirmOnlinePayment(provider: OnlineProvider, orderId: string): Promise<{ paid: boolean }> {
  const result = await invoke<{ paid?: unknown }>(FUNCTION[provider], { action: 'confirmar', order_id: orderId });
  return { paid: result.paid === true };
}

export interface ProviderStatus {
  readonly connected: boolean;
  /** Cuenta o llaves de prueba (Stripe test mode / PayPal sandbox). */
  readonly test?: boolean;
  readonly account?: string | null;
  /** Falta el secreto del webhook (solo Stripe). */
  readonly webhook?: boolean;
  readonly reason?: string;
}

/** El dueño prueba que las llaves guardadas en Supabase funcionan. */
export async function checkProvider(provider: OnlineProvider, storeId: string): Promise<ProviderStatus> {
  return invoke<ProviderStatus>(FUNCTION[provider], { action: 'estado', store_id: storeId });
}

/** Proveedores con cuenta conectada en la sucursal (lectura pública). */
export async function connectedProviders(storeId: string): Promise<Set<OnlineProvider>> {
  const { data, error } = await getSupabase()
    .from('payment_provider_accounts')
    .select('provider, status')
    .eq('store_id', storeId)
    .eq('status', 'active')
    .returns<{ provider: string; status: string }[]>();
  const set = new Set<OnlineProvider>();
  if (error !== null) return set;
  for (const row of data ?? []) {
    if (row.provider === 'stripe' || row.provider === 'paypal') set.add(row.provider);
  }
  return set;
}
