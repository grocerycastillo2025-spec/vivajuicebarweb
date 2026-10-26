/**
 * Arranque en Deno de `paypal-webhook`. La lógica está en handler.ts.
 *
 * Secretos: PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET y, opcional, PAYPAL_ENV
 * (Supabase → Edge Functions → Secrets). SUPABASE_DB_URL lo pone Supabase.
 */

import postgres from 'npm:postgres@3.4.5';

import { createPayPalWebhookHandler } from './handler.ts';

const url = Deno.env.get('SUPABASE_DB_URL');
if (url === undefined || url === '') throw new Error('Falta la variable de entorno SUPABASE_DB_URL.');
const sql = postgres(url, { prepare: false, max: 2 });

Deno.serve(
  createPayPalWebhookHandler({
    sql: (text, params) => sql.unsafe(text, params),
    fetch,
    clientId: Deno.env.get('PAYPAL_CLIENT_ID')?.trim() || null,
    clientSecret: Deno.env.get('PAYPAL_CLIENT_SECRET')?.trim() || null,
    env: Deno.env.get('PAYPAL_ENV')?.trim().toLowerCase() || null,
    log: (event, data) => console.log(JSON.stringify({ fn: 'paypal-webhook', event, ...data })),
  }),
);
