/**
 * Un "Supabase" de prueba en una sola máquina, para la prueba en navegador.
 *
 *   :54321  /rest/v1/*       -> PostgREST de verdad, contra la base de la
 *                               entrega (RLS, grants y funciones reales).
 *           /auth/v1/*       -> Auth falso: registra en auth.users y firma
 *                               JWT con el mismo secreto que PostgREST.
 *           /functions/v1/*  -> las Edge Functions de cobro DE VERDAD
 *                               (stripe-pago, paypal-pago, webhooks), con
 *                               Stripe y PayPal falsos.
 *           /fake-stripe, /fake-paypal -> la "página de pago" del proveedor:
 *                               marca el pago y regresa a la app.
 *   :8080   la app web exportada (apps/mobile/dist) bajo /vivajuicebarweb/,
 *           con 404.html como GitHub Pages.
 *
 *   node --experimental-strip-types tools/e2e/servidor.ts
 */
import { createHmac, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';

import postgres from 'postgres';

import { createPagoHandler, type Sql } from '../../supabase/functions/_shared/cobro.ts';
import { paypalAdapter } from '../../supabase/functions/_shared/paypal.ts';
import { signStripePayload, stripeAdapter } from '../../supabase/functions/_shared/stripe.ts';
import { createPayPalWebhookHandler } from '../../supabase/functions/paypal-webhook/handler.ts';
import { createStripeWebhookHandler } from '../../supabase/functions/stripe-webhook/handler.ts';

export const JWT_SECRET = 'e2e-secreto-de-prueba-de-32-caracteres-o-mas';
const GATEWAY = Number(process.env['E2E_GATEWAY_PORT'] ?? 54321);
const WEB = Number(process.env['E2E_WEB_PORT'] ?? 8080);
const PGRST = process.env['E2E_PGRST'] ?? 'http://127.0.0.1:3001';
const DB_URL = process.env['E2E_DB_URL'] ?? 'postgresql://postgres:postgres@localhost:5432/e2e';
const DIST = process.env['E2E_DIST'] ?? join(import.meta.dirname, '..', '..', 'apps', 'mobile', 'dist');
const BASE = '/vivajuicebarweb/';
const SELF = `http://localhost:${GATEWAY}`;
const APP = `http://localhost:${WEB}${BASE}`;
const WHSEC = 'whsec_e2e';

// ---------------------------------------------------------------------
// JWT HS256
// ---------------------------------------------------------------------
const b64 = (data: string | Buffer): string => Buffer.from(data).toString('base64url');
export function signJwt(payload: Record<string, unknown>): string {
  const head = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64(JSON.stringify(payload));
  const sig = createHmac('sha256', JWT_SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}
function readJwt(token: string): Record<string, unknown> | null {
  const [head, body, sig] = token.split('.');
  if (head === undefined || body === undefined || sig === undefined) return null;
  const expected = createHmac('sha256', JWT_SECRET).update(`${head}.${body}`).digest('base64url');
  if (expected !== sig) return null;
  return JSON.parse(Buffer.from(body, 'base64url').toString()) as Record<string, unknown>;
}
export const ANON_KEY = signJwt({ iss: 'supabase', ref: 'e2e', role: 'anon', iat: 1700000000, exp: 2100000000 });

const db = postgres(DB_URL, { max: 4, onnotice: () => undefined });
const sql: Sql = (text, params) => db.unsafe(text, (params ?? []) as never[]) as unknown as Promise<Record<string, unknown>[]>;

// ---------------------------------------------------------------------
// Auth falso (lo justo de GoTrue que usa supabase-js)
// ---------------------------------------------------------------------
const passwords = new Map<string, string>(); // correo -> contraseña

async function session(userId: string, email: string): Promise<Record<string, unknown>> {
  const now = Math.floor(Date.now() / 1000);
  const meta = (await db`select raw_user_meta_data from auth.users where id = ${userId}`)[0]?.['raw_user_meta_data'] ?? {};
  const user = {
    id: userId, aud: 'authenticated', role: 'authenticated', email,
    email_confirmed_at: new Date().toISOString(), user_metadata: meta, app_metadata: { provider: 'email' },
    created_at: new Date().toISOString(),
  };
  return {
    access_token: signJwt({ sub: userId, email, role: 'authenticated', aud: 'authenticated', iat: now, exp: now + 3600 }),
    token_type: 'bearer', expires_in: 3600, expires_at: now + 3600,
    refresh_token: `r-${userId}`, user,
  };
}

async function auth(req: IncomingMessage, res: ServerResponse, path: string, body: Record<string, unknown>): Promise<void> {
  const url = new URL(req.url ?? '/', SELF);
  if (path === '/auth/v1/signup' && req.method === 'POST') {
    const email = String(body['email'] ?? '').toLowerCase();
    if ((await db`select 1 from auth.users where email = ${email}`).length > 0) {
      return send(res, 422, { code: 422, error_code: 'user_already_exists', msg: 'User already registered' });
    }
    const id = randomUUID();
    await db`insert into auth.users (id, email, raw_user_meta_data) values (${id}, ${email}, ${db.json((body['data'] ?? {}) as never)})`;
    passwords.set(email, String(body['password'] ?? ''));
    return send(res, 200, await session(id, email));
  }
  if (path === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password') {
    const email = String(body['email'] ?? '').toLowerCase();
    const row = (await db`select id from auth.users where email = ${email}`)[0];
    if (row === undefined || passwords.get(email) !== String(body['password'] ?? '')) {
      return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
    }
    return send(res, 200, await session(String(row['id']), email));
  }
  if (path === '/auth/v1/token' && url.searchParams.get('grant_type') === 'refresh_token') {
    const id = String(body['refresh_token'] ?? '').replace(/^r-/, '');
    const row = (await db`select email from auth.users where id::text = ${id}`)[0];
    if (row === undefined) return send(res, 400, { error: 'invalid_grant' });
    return send(res, 200, await session(id, String(row['email'])));
  }
  if (path === '/auth/v1/user') {
    const claims = readJwt((req.headers.authorization ?? '').replace(/^Bearer /i, ''));
    if (claims === null || typeof claims['sub'] !== 'string') return send(res, 401, { msg: 'invalid JWT' });
    const s = await session(claims['sub'], String(claims['email'] ?? ''));
    return send(res, 200, s['user'] as Record<string, unknown>);
  }
  if (path === '/auth/v1/logout') return send(res, 204, null);
  if (path === '/auth/v1/settings') return send(res, 200, { external: { email: true, google: false }, disable_signup: false });
  return send(res, 404, { msg: `auth: ${path}` });
}

/** Crea una cuenta desde la prueba (el dueño y el cajero). */
export async function crearCuenta(email: string, password: string): Promise<string> {
  const id = randomUUID();
  await db`insert into auth.users (id, email) values (${id}, ${email}) on conflict do nothing`;
  passwords.set(email, password);
  return id;
}

// ---------------------------------------------------------------------
// Stripe y PayPal falsos
// ---------------------------------------------------------------------
const stripeSessions = new Map<string, Record<string, unknown>>();
const paypalOrders = new Map<string, Record<string, unknown>>();

const providerFetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const method = init?.method ?? 'GET';
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  if (url.pathname === '/auth/v1/user') return fetch(input, init); // identificar() contra este mismo servidor

  if (url.host === 'stripe.e2e') {
    if (url.pathname === '/v1/account') return reply(200, { id: 'acct_e2e', settings: { dashboard: { display_name: 'VIVA Juice (prueba)' } } });
    if (method === 'POST' && url.pathname === '/v1/checkout/sessions') {
      const form = new URLSearchParams(String(init?.body ?? ''));
      const id = `cs_test_e2e${stripeSessions.size + 1}`;
      stripeSessions.set(id, {
        id, url: `${SELF}/fake-stripe/${id}`, status: 'open', payment_status: 'unpaid',
        amount_total: Number(form.get('line_items[0][price_data][unit_amount]')),
        currency: form.get('line_items[0][price_data][currency]'),
        client_reference_id: form.get('client_reference_id'),
        success_url: form.get('success_url'), cancel_url: form.get('cancel_url'), payment_intent: null,
      });
      return reply(200, stripeSessions.get(id));
    }
    const m = /^\/v1\/checkout\/sessions\/(cs_test_e2e\d+)$/.exec(url.pathname);
    if (m !== null) return stripeSessions.has(m[1] ?? '') ? reply(200, stripeSessions.get(m[1] ?? '')) : reply(404, {});
    return reply(404, {});
  }

  if (url.host === 'paypal-sandbox.e2e' || url.host === 'paypal-live.e2e') {
    if (url.pathname === '/v1/oauth2/token') return url.host === 'paypal-live.e2e' ? reply(401, {}) : reply(200, { access_token: 'tok' });
    if (method === 'POST' && url.pathname === '/v2/checkout/orders') {
      const body = JSON.parse(String(init?.body)) as { purchase_units: unknown[]; payment_source: { paypal: { experience_context: { return_url: string; cancel_url: string } } } };
      const id = `E2EORDER${paypalOrders.size + 1}`;
      paypalOrders.set(id, {
        id, status: 'PAYER_ACTION_REQUIRED', purchase_units: body.purchase_units,
        return_url: body.payment_source.paypal.experience_context.return_url,
        links: [{ rel: 'payer-action', href: `${SELF}/fake-paypal/${id}` }],
      });
      return reply(201, paypalOrders.get(id));
    }
    const cap = /^\/v2\/checkout\/orders\/(\w+)\/capture$/.exec(url.pathname);
    if (cap !== null) {
      const o = paypalOrders.get(cap[1] ?? '') as { status: string; purchase_units: { custom_id: string; amount: unknown; payments?: unknown }[] } | undefined;
      if (o === undefined || o.status !== 'APPROVED') return reply(422, {});
      const unit = o.purchase_units[0];
      if (unit === undefined) return reply(500, {});
      o.status = 'COMPLETED';
      unit.payments = { captures: [{ id: `CAP${cap[1]}`, status: 'COMPLETED', amount: unit.amount, custom_id: unit.custom_id }] };
      return reply(201, o);
    }
    const ord = /^\/v2\/checkout\/orders\/(\w+)$/.exec(url.pathname);
    if (ord !== null) return paypalOrders.has(ord[1] ?? '') ? reply(200, paypalOrders.get(ord[1] ?? '')) : reply(404, {});
    return reply(404, {});
  }
  throw new Error(`fetch inesperado: ${url.href}`);
}) as typeof fetch;

const common = { sql, fetch: providerFetch, supabaseUrl: SELF, anonKey: ANON_KEY, appUrl: APP };
const functions: Record<string, (req: Request) => Promise<Response>> = {
  'stripe-pago': createPagoHandler({
    ...common,
    adapter: stripeAdapter({ secretKey: 'sk_test_e2e', webhookSecret: WHSEC, fetch: providerFetch, api: 'https://stripe.e2e' }),
  }),
  'paypal-pago': createPagoHandler({
    ...common,
    adapter: paypalAdapter({
      clientId: 'cid', clientSecret: 'secret', env: null, fetch: providerFetch,
      liveApi: 'https://paypal-live.e2e', sandboxApi: 'https://paypal-sandbox.e2e',
    }),
  }),
  'stripe-webhook': createStripeWebhookHandler({ sql, fetch: providerFetch, secretKey: 'sk_test_e2e', webhookSecret: WHSEC, api: 'https://stripe.e2e' }),
  'paypal-webhook': createPayPalWebhookHandler({
    sql, fetch: providerFetch, clientId: 'cid', clientSecret: 'secret', env: null,
    liveApi: 'https://paypal-live.e2e', sandboxApi: 'https://paypal-sandbox.e2e',
  }),
};

// ---------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
  'access-control-expose-headers': 'content-range, content-profile',
};

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { ...CORS, 'content-type': 'application/json', ...headers });
  res.end(body === null ? undefined : JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

const gateway = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', SELF);
    if (req.method === 'OPTIONS') return send(res, 204, null);
    const raw = await readBody(req);

    if (url.pathname.startsWith('/rest/v1/')) {
      // supabase-js manda la clave anónima como Bearer cuando no hay sesión.
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string' && !['host', 'connection', 'content-length', 'apikey'].includes(k)) headers.set(k, v);
      }
      const upstream = await fetch(`${PGRST}${url.pathname.slice('/rest/v1'.length)}${url.search}`, {
        method: req.method, headers, ...(raw.length > 0 && req.method !== 'GET' ? { body: raw } : {}),
      });
      const out: Record<string, string> = {};
      upstream.headers.forEach((v, k) => {
        if (!['content-encoding', 'transfer-encoding', 'connection'].includes(k)) out[k] = v;
      });
      res.writeHead(upstream.status, { ...CORS, ...out });
      res.end(Buffer.from(await upstream.arrayBuffer()));
      return;
    }

    if (url.pathname.startsWith('/auth/v1/')) {
      const body = raw.length > 0 ? (JSON.parse(raw.toString()) as Record<string, unknown>) : {};
      return auth(req, res, url.pathname, body);
    }

    const fn = /^\/functions\/v1\/([\w-]+)$/.exec(url.pathname)?.[1];
    if (fn !== undefined && functions[fn] !== undefined) {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
      const response = await functions[fn](new Request(url.href, {
        method: req.method, headers, ...(raw.length > 0 ? { body: raw } : {}),
      }));
      const out: Record<string, string> = {};
      response.headers.forEach((v, k) => (out[k] = v));
      res.writeHead(response.status, { ...CORS, ...out });
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }

    // "Página de pago" de Stripe: la prueba toca "Pagar" y vuelve a la app.
    const st = /^\/fake-stripe\/(cs_test_e2e\d+)(\/pagar)?$/.exec(url.pathname);
    if (st !== null) {
      const s = stripeSessions.get(st[1] ?? '');
      if (s === undefined) return send(res, 404, {});
      if (st[2] === undefined) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><title>Stripe Checkout (prueba)</title><h1>Stripe (prueba)</h1>
          <p id="monto">${(Number(s['amount_total']) / 100).toFixed(2)} ${String(s['currency']).toUpperCase()}</p>
          <a id="pagar" href="${url.pathname}/pagar">Pay</a>`);
        return;
      }
      Object.assign(s, { status: 'complete', payment_status: 'paid', payment_intent: `pi_${st[1]}` });
      // Stripe también avisa por webhook, firmado.
      const body = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: s['id'] } } });
      void functions['stripe-webhook']?.(new Request(`${SELF}/functions/v1/stripe-webhook`, {
        method: 'POST', body, headers: { 'stripe-signature': await signStripePayload(body, WHSEC, Math.floor(Date.now() / 1000)) },
      }));
      res.writeHead(303, { location: String(s['success_url']) });
      res.end();
      return;
    }
    const pp = /^\/fake-paypal\/(E2EORDER\d+)(\/aprobar)?$/.exec(url.pathname);
    if (pp !== null) {
      const o = paypalOrders.get(pp[1] ?? '');
      if (o === undefined) return send(res, 404, {});
      if (pp[2] === undefined) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><title>PayPal (prueba)</title><h1>PayPal (prueba)</h1><a id="aprobar" href="${url.pathname}/aprobar">Pay Now</a>`);
        return;
      }
      o['status'] = 'APPROVED';
      res.writeHead(303, { location: `${String(o['return_url'])}&token=${pp[1]}` });
      res.end();
      return;
    }

    if (url.pathname === '/__e2e/cuenta' && req.method === 'POST') {
      const body = JSON.parse(raw.toString()) as { email: string; password: string };
      return send(res, 200, { id: await crearCuenta(body.email, body.password) });
    }
    send(res, 404, { msg: `sin ruta: ${url.pathname}` });
  })().catch((cause: unknown) => {
    console.error('[e2e] error', cause);
    if (!res.headersSent) send(res, 500, { msg: String(cause) });
  });
});

// La app exportada, como la sirve GitHub Pages.
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.txt': 'text/plain',
};
const web = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${WEB}`);
  if (!url.pathname.startsWith(BASE)) {
    res.writeHead(302, { location: BASE });
    res.end();
    return;
  }
  const rel = normalize(decodeURIComponent(url.pathname.slice(BASE.length))).replace(/^(\.\.[/\\])+/, '');
  let file = join(DIST, rel === '' || rel === '.' ? 'index.html' : rel);
  let status = 200;
  if (!existsSync(file) || statSync(file).isDirectory()) {
    file = join(DIST, '404.html');
    status = 404; // igual que Pages: el 404.html arranca la app y el router pinta la ruta
  }
  res.writeHead(status, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
});

gateway.listen(GATEWAY, () => console.log(`[e2e] Supabase de prueba en ${SELF}`));
web.listen(WEB, () => console.log(`[e2e] App web en ${APP}`));
