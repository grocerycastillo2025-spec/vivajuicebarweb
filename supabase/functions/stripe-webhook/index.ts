/**
 * Arranque en Deno de `stripe-webhook`. La lógica está en handler.ts.
 *
 * Secretos: STRIPE_SECRET_KEY y STRIPE_WEBHOOK_SECRET (Supabase → Edge
 * Functions → Secrets). SUPABASE_DB_URL lo pone Supabase.
 */

import postgres from 'npm:postgres@3.4.5';

import { createStripeWebhookHandler } from './handler.ts';

const url = Deno.env.get('SUPABASE_DB_URL');
if (url === undefined || url === '') throw new Error('Falta la variable de entorno SUPABASE_DB_URL.');
const sql = postgres(url, { prepare: false, max: 2 });

Deno.serve(
  createStripeWebhookHandler({
    sql: (text, params) => sql.unsafe(text, params),
    fetch,
    secretKey: Deno.env.get('STRIPE_SECRET_KEY')?.trim() || null,
    webhookSecret: Deno.env.get('STRIPE_WEBHOOK_SECRET')?.trim() || null,
    log: (event, data) => console.log(JSON.stringify({ fn: 'stripe-webhook', event, ...data })),
  }),
);
