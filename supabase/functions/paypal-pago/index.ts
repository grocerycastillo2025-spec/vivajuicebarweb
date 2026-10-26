/**
 * Arranque en Deno de `paypal-pago`. La lógica está en _shared/cobro.ts y
 * _shared/paypal.ts.
 *
 * Secretos (Supabase → Edge Functions → Secrets):
 *   PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET   de la app REST de PayPal
 *   PAYPAL_ENV        (opcional) "live" o "sandbox"; sin él se detecta
 *   APP_PUBLIC_URL    (opcional) base de la app web, con "/" final
 * SUPABASE_URL, SUPABASE_ANON_KEY y SUPABASE_DB_URL los pone Supabase.
 */

import postgres from 'npm:postgres@3.4.5';

import { createPagoHandler } from '../_shared/cobro.ts';
import { paypalAdapter } from '../_shared/paypal.ts';

const sql = postgres(requerida('SUPABASE_DB_URL'), { prepare: false, max: 2 });

Deno.serve(
  createPagoHandler({
    sql: (text, params) => sql.unsafe(text, params),
    fetch,
    supabaseUrl: requerida('SUPABASE_URL'),
    anonKey: requerida('SUPABASE_ANON_KEY'),
    adapter: paypalAdapter({
      clientId: Deno.env.get('PAYPAL_CLIENT_ID')?.trim() || null,
      clientSecret: Deno.env.get('PAYPAL_CLIENT_SECRET')?.trim() || null,
      env: Deno.env.get('PAYPAL_ENV')?.trim().toLowerCase() || null,
      fetch,
    }),
    appUrl: Deno.env.get('APP_PUBLIC_URL') || 'https://grocerycastillo2025-spec.github.io/vivajuicebarweb/',
    log: (event, data) => console.log(JSON.stringify({ fn: 'paypal-pago', event, ...data })),
  }),
);

function requerida(nombre: string): string {
  const valor = Deno.env.get(nombre);
  if (valor === undefined || valor === '') throw new Error(`Falta la variable de entorno ${nombre}.`);
  return valor;
}
