/**
 * Arranque en Deno de `stripe-pago`. La lógica está en _shared/cobro.ts y
 * _shared/stripe.ts.
 *
 * Secretos (Supabase → Edge Functions → Secrets):
 *   STRIPE_SECRET_KEY       llave secreta de Stripe (sk_live_… o sk_test_…)
 *   STRIPE_WEBHOOK_SECRET   (lo usa stripe-webhook; aquí solo se informa si falta)
 *   APP_PUBLIC_URL          (opcional) base de la app web, con "/" final
 * SUPABASE_URL, SUPABASE_ANON_KEY y SUPABASE_DB_URL los pone Supabase.
 */

import postgres from 'npm:postgres@3.4.5';

import { createPagoHandler } from '../_shared/cobro.ts';
import { stripeAdapter } from '../_shared/stripe.ts';

const sql = postgres(requerida('SUPABASE_DB_URL'), { prepare: false, max: 2 });

Deno.serve(
  createPagoHandler({
    sql: (text, params) => sql.unsafe(text, params),
    fetch,
    supabaseUrl: requerida('SUPABASE_URL'),
    anonKey: requerida('SUPABASE_ANON_KEY'),
    adapter: stripeAdapter({
      secretKey: Deno.env.get('STRIPE_SECRET_KEY')?.trim() || null,
      webhookSecret: Deno.env.get('STRIPE_WEBHOOK_SECRET')?.trim() || null,
      fetch,
    }),
    appUrl: Deno.env.get('APP_PUBLIC_URL') || 'https://grocerycastillo2025-spec.github.io/vivajuicebarweb/',
    log: (event, data) => console.log(JSON.stringify({ fn: 'stripe-pago', event, ...data })),
  }),
);

function requerida(nombre: string): string {
  const valor = Deno.env.get(nombre);
  if (valor === undefined || valor === '') throw new Error(`Falta la variable de entorno ${nombre}.`);
  return valor;
}
