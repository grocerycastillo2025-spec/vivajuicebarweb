/**
 * El cobro en línea de punta a punta contra una base REAL (con las
 * migraciones y el seed de VIVA Juice) y un Stripe / PayPal falsos.
 *
 * Prueba lo que las pruebas puras no ven: que el SQL de las funciones
 * coincide con las columnas de verdad, que el monto sale de la base, que
 * nadie paga el pedido de otro y que una devolución lo desmarca.
 *
 *   TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ci \
 *     node --test --experimental-strip-types supabase/functions/_shared/__tests__/cobro-db.test.ts
 *
 * Sin TEST_DATABASE_URL se salta (el job de CI con base la define).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import postgres from 'postgres';

import { createPagoHandler, type Sql } from '../cobro.ts';
import { paypalAdapter } from '../paypal.ts';
import { signStripePayload, stripeAdapter } from '../stripe.ts';
import { createPayPalWebhookHandler } from '../../paypal-webhook/handler.ts';
import { createStripeWebhookHandler } from '../../stripe-webhook/handler.ts';

const URL_DB = process.env['TEST_DATABASE_URL'] ?? '';
const STORE = '22222222-2222-4222-8222-222222222222';
const RESTAURANT = '11111111-1111-4111-8111-111111111111';
const SUPA = 'https://proyecto.supabase.test';
const STRIPE = 'https://stripe.test';
const PP_LIVE = 'https://paypal-live.test';
const PP_SANDBOX = 'https://paypal-sandbox.test';
const WHSEC = 'whsec_prueba';

describe('cobro en línea contra la base', { skip: URL_DB === '' ? 'sin TEST_DATABASE_URL' : false }, () => {
  const db = postgres(URL_DB, { max: 2, onnotice: () => undefined });
  const sql: Sql = (text, params) => db.unsafe(text, (params ?? []) as never[]) as unknown as Promise<Record<string, unknown>[]>;

  const owner = randomUUID();
  const customer = randomUUID();
  const stranger = randomUUID();
  const tokens = new Map([
    ['t-owner', owner],
    ['t-customer', customer],
    ['t-stranger', stranger],
  ]);

  // Estado de los proveedores falsos.
  const stripeSessions = new Map<string, Record<string, unknown>>();
  const stripeCalls: { path: string; body: string }[] = [];
  const paypalOrders = new Map<string, Record<string, unknown>>();

  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    const reply = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

    if (url.origin === SUPA && url.pathname === '/auth/v1/user') {
      const user = tokens.get((headers.get('authorization') ?? '').replace('Bearer ', ''));
      return user === undefined ? reply(401, {}) : reply(200, { id: user });
    }

    if (url.origin === STRIPE) {
      if (url.pathname === '/v1/account') return reply(200, { id: 'acct_1', settings: { dashboard: { display_name: 'VIVA Juice' } } });
      if (method === 'POST' && url.pathname === '/v1/checkout/sessions') {
        const body = String(init?.body ?? '');
        stripeCalls.push({ path: url.pathname, body });
        const form = new URLSearchParams(body);
        const id = `cs_test_${stripeSessions.size + 1}`;
        stripeSessions.set(id, {
          id,
          url: `https://checkout.stripe.test/${id}`,
          status: 'open',
          payment_status: 'unpaid',
          amount_total: Number(form.get('line_items[0][price_data][unit_amount]')),
          currency: form.get('line_items[0][price_data][currency]'),
          client_reference_id: form.get('client_reference_id'),
          payment_intent: null,
        });
        return reply(200, stripeSessions.get(id));
      }
      const session = /^\/v1\/checkout\/sessions\/(cs_test_\d+)$/.exec(url.pathname);
      if (session !== null) {
        const s = stripeSessions.get(session[1] ?? '');
        return s === undefined ? reply(404, {}) : reply(200, s);
      }
      const charge = /^\/v1\/charges\/(ch_\w+)$/.exec(url.pathname);
      if (charge !== null) return reply(200, { id: charge[1], payment_intent: 'pi_test_1', amount: 850, amount_refunded: 850, refunded: true, currency: 'usd', status: 'succeeded' });
      return reply(404, {});
    }

    if (url.origin === PP_LIVE || url.origin === PP_SANDBOX) {
      if (url.pathname === '/v1/oauth2/token') {
        // Llaves de sandbox: el entorno live las rechaza.
        return url.origin === PP_LIVE ? reply(401, {}) : reply(200, { access_token: 'tok' });
      }
      if (method === 'POST' && url.pathname === '/v2/checkout/orders') {
        const body = JSON.parse(String(init?.body)) as { purchase_units: { custom_id: string; amount: { value: string; currency_code: string } }[] };
        const id = `PPORDER${paypalOrders.size + 1}`;
        paypalOrders.set(id, { id, status: 'PAYER_ACTION_REQUIRED', purchase_units: body.purchase_units, links: [{ rel: 'payer-action', href: `https://paypal.test/checkoutnow?token=${id}` }] });
        return reply(201, paypalOrders.get(id));
      }
      const capture = /^\/v2\/checkout\/orders\/(\w+)\/capture$/.exec(url.pathname);
      if (capture !== null) {
        const o = paypalOrders.get(capture[1] ?? '') as { status: string; purchase_units: { custom_id: string; amount: unknown; payments?: unknown }[] } | undefined;
        if (o === undefined) return reply(404, {});
        if (o.status !== 'APPROVED') return reply(422, { name: 'UNPROCESSABLE_ENTITY' });
        const unit = o.purchase_units[0];
        if (unit === undefined) return reply(500, {});
        o.status = 'COMPLETED';
        unit.payments = { captures: [{ id: `CAP${capture[1]}`, status: 'COMPLETED', amount: unit.amount, custom_id: unit.custom_id }] };
        return reply(201, o);
      }
      const order = /^\/v2\/checkout\/orders\/(\w+)$/.exec(url.pathname);
      if (order !== null) {
        const o = paypalOrders.get(order[1] ?? '');
        return o === undefined ? reply(404, {}) : reply(200, o);
      }
      const cap = /^\/v2\/payments\/captures\/(\w+)$/.exec(url.pathname);
      if (cap !== null) {
        for (const o of paypalOrders.values()) {
          const unit = (o['purchase_units'] as { payments?: { captures: { id: string }[] } }[])[0];
          const found = unit?.payments?.captures.find((c) => c.id === cap[1]);
          if (found !== undefined) return reply(200, found);
        }
        return reply(404, {});
      }
      return reply(404, {});
    }
    throw new Error(`fetch inesperado: ${url.href}`);
  }) as typeof fetch;

  const appUrl = 'https://grocerycastillo2025-spec.github.io/vivajuicebarweb/';
  const stripePago = createPagoHandler({
    sql, fetch: fakeFetch, supabaseUrl: SUPA, anonKey: 'anon', appUrl,
    adapter: stripeAdapter({ secretKey: 'sk_test_123', webhookSecret: WHSEC, fetch: fakeFetch, api: STRIPE }),
  });
  const paypalPago = createPagoHandler({
    sql, fetch: fakeFetch, supabaseUrl: SUPA, anonKey: 'anon', appUrl,
    adapter: paypalAdapter({ clientId: 'cid', clientSecret: 'secret', env: null, fetch: fakeFetch, liveApi: PP_LIVE, sandboxApi: PP_SANDBOX }),
  });
  const stripeWebhook = createStripeWebhookHandler({ sql, fetch: fakeFetch, secretKey: 'sk_test_123', webhookSecret: WHSEC, api: STRIPE });
  const paypalWebhook = createPayPalWebhookHandler({
    sql, fetch: fakeFetch, clientId: 'cid', clientSecret: 'secret', env: null, liveApi: PP_LIVE, sandboxApi: PP_SANDBOX,
  });

  const call = async (handler: (r: Request) => Promise<Response>, token: string, body: unknown) => {
    const res = await handler(new Request('https://fn.test', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }));
    return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
  };

  /** Pedido de un Green Juice ($8.50) para mañana a las 10:00 de Nueva York. */
  const placeOrder = async (user: string, payWith: string): Promise<string> =>
    db.begin(async (tx) => {
      await tx`select set_config('request.jwt.claim.sub', ${user}, true)`;
      await tx.unsafe('set local role authenticated');
      const rows = await tx`
        select public.place_counter_order(
          ${STORE}::uuid, ${randomUUID()},
          ((now() at time zone 'America/New_York')::date + 1 + time '10:00') at time zone 'America/New_York',
          false, null, '[{"clover_item_id":"viva-juice-green"}]'::jsonb, ${payWith}) ->> 'order_id' as id`;
      return String(rows[0]?.['id']);
    }) as Promise<string>;

  const order = async (id: string) =>
    (await db`select pay_with, paid_confirmed_at, online_checkout_id, online_payment_id, online_status, online_paid_cents,
                     app.order_amount_cents(id) as amount from public.orders where id = ${id}`)[0];

  before(async () => {
    await db`insert into auth.users (id, email) values
      (${owner}, ${`owner-${owner}@test.local`}), (${customer}, ${`c-${customer}@test.local`}), (${stranger}, ${`s-${stranger}@test.local`})`;
    await db`select app.grant_restaurant_role(${`owner-${owner}@test.local`}, ${RESTAURANT}::uuid, 'owner')`;
    await db`update public.stores set payment_options = payment_options || '{"stripe": true, "paypal": true}'::jsonb where id = ${STORE}`;
    await db`delete from public.payment_provider_accounts where store_id = ${STORE}`;
  });

  after(async () => {
    await db.end();
  });

  it('"Probar conexión": solo el dueño, y detecta llaves de prueba', async () => {
    assert.equal((await call(stripePago, 't-customer', { action: 'estado', store_id: STORE })).status, 403);
    const stripe = await call(stripePago, 't-owner', { action: 'estado', store_id: STORE });
    assert.deepEqual(stripe.body, { connected: true, test: true, account: 'VIVA Juice', webhook: true });
    const paypal = await call(paypalPago, 't-owner', { action: 'estado', store_id: STORE });
    assert.equal(paypal.body?.['connected'], true);
    assert.equal(paypal.body?.['test'], true); // solo sirvieron en sandbox
    const rows = await db`select provider, status, live_mode from public.payment_provider_accounts where store_id = ${STORE} order by provider`;
    assert.deepEqual(rows.map((r) => [r['provider'], r['status'], r['live_mode']]), [['paypal', 'active', false], ['stripe', 'active', false]]);
  });

  it('Stripe: el monto sale de la base, solo el dueño del pedido paga, y se marca al confirmar', async () => {
    const id = await placeOrder(customer, 'stripe');
    assert.equal(Number((await order(id))?.['amount']), 850);

    // Otro usuario: como si el pedido no existiera.
    assert.equal((await call(stripePago, 't-stranger', { order_id: id })).status, 404);

    // El teléfono no manda el monto (y si lo manda, se ignora).
    const pay = await call(stripePago, 't-customer', { order_id: id, amount_cents: 1 });
    assert.equal(pay.status, 200);
    assert.match(String(pay.body?.['url']), /^https:\/\/checkout\.stripe\.test\//);
    assert.match(stripeCalls.at(-1)?.body ?? '', /unit_amount%5D=850/);
    const sessionId = String((await order(id))?.['online_checkout_id']);
    assert.match(sessionId, /^cs_test_/);

    // Vuelve sin pagar: nada.
    assert.deepEqual((await call(stripePago, 't-customer', { action: 'confirmar', order_id: id })).body, { paid: false });

    // Paga de verdad (en Stripe falso) y vuelve.
    Object.assign(stripeSessions.get(sessionId) ?? {}, { status: 'complete', payment_status: 'paid', payment_intent: 'pi_test_1' });
    assert.deepEqual((await call(stripePago, 't-customer', { action: 'confirmar', order_id: id })).body, { paid: true });
    const paid = await order(id);
    assert.notEqual(paid?.['paid_confirmed_at'], null);
    assert.equal(paid?.['online_payment_id'], 'pi_test_1');
    assert.equal(Number(paid?.['online_paid_cents']), 850);

    // Ya pagado: no se cobra otra vez.
    assert.equal((await call(stripePago, 't-customer', { order_id: id })).body?.['error'], 'ya_pagado');
  });

  it('Stripe webhook: firma obligatoria; una devolución total desmarca el pedido', async () => {
    const bad = await stripeWebhook(new Request('https://fn.test', { method: 'POST', body: '{}', headers: { 'stripe-signature': 't=1,v1=00' } }));
    assert.equal(bad.status, 400);

    const paidRows = await db`select id from public.orders where online_payment_id = 'pi_test_1'`;
    const id = String(paidRows[0]?.['id']);
    const body = JSON.stringify({ type: 'charge.refunded', data: { object: { id: 'ch_test_1' } } });
    const res = await stripeWebhook(new Request('https://fn.test', {
      method: 'POST', body, headers: { 'stripe-signature': await signStripePayload(body, WHSEC, Math.floor(Date.now() / 1000)) },
    }));
    assert.equal(res.status, 200);
    const refunded = await order(id);
    assert.equal(refunded?.['paid_confirmed_at'], null);
    assert.equal(refunded?.['online_status'], 'refunded');
  });

  it('Stripe: un pago que no cubre el total no marca nada', async () => {
    const id = await placeOrder(customer, 'stripe');
    await call(stripePago, 't-customer', { order_id: id });
    const sessionId = String((await order(id))?.['online_checkout_id']);
    Object.assign(stripeSessions.get(sessionId) ?? {}, { status: 'complete', payment_status: 'paid', payment_intent: 'pi_corto', amount_total: 100 });
    assert.deepEqual((await call(stripePago, 't-customer', { action: 'confirmar', order_id: id })).body, { paid: false });
    assert.equal((await order(id))?.['paid_confirmed_at'], null);
  });

  it('PayPal: se cobra la orden aprobada al volver y se verifica con PayPal', async () => {
    const id = await placeOrder(customer, 'paypal');
    const pay = await call(paypalPago, 't-customer', { order_id: id });
    assert.equal(pay.status, 200);
    assert.match(String(pay.body?.['url']), /^https:\/\/paypal\.test\/checkoutnow\?token=PPORDER/);
    const ppId = String((await order(id))?.['online_checkout_id']);
    const created = paypalOrders.get(ppId) as { purchase_units: { amount: { value: string } }[] };
    assert.equal(created.purchase_units[0]?.amount.value, '8.50');

    // Sin aprobar todavía: no se cobra.
    assert.deepEqual((await call(paypalPago, 't-customer', { action: 'confirmar', order_id: id })).body, { paid: false });

    // El cliente aprueba en PayPal y vuelve.
    (paypalOrders.get(ppId) as { status: string }).status = 'APPROVED';
    assert.deepEqual((await call(paypalPago, 't-customer', { action: 'confirmar', order_id: id })).body, { paid: true });
    const paid = await order(id);
    assert.equal(paid?.['online_payment_id'], `CAP${ppId}`);
    assert.equal(Number(paid?.['online_paid_cents']), 850);
  });

  it('PayPal webhook: orden aprobada sin volver a la app se cobra; devolución desmarca', async () => {
    const id = await placeOrder(customer, 'paypal');
    await call(paypalPago, 't-customer', { order_id: id });
    const ppId = String((await order(id))?.['online_checkout_id']);
    (paypalOrders.get(ppId) as { status: string }).status = 'APPROVED';

    const approved = await paypalWebhook(new Request('https://fn.test', {
      method: 'POST', body: JSON.stringify({ event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: ppId } }),
    }));
    assert.equal(await approved.text(), 'mark_paid');
    assert.notEqual((await order(id))?.['paid_confirmed_at'], null);

    // Un aviso de una orden que no es nuestra no cobra nada.
    const foreign = await paypalWebhook(new Request('https://fn.test', {
      method: 'POST', body: JSON.stringify({ event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: 'AJENA1' } }),
    }));
    assert.equal(await foreign.text(), 'orden desconocida');

    // Devolución en PayPal.
    const unit = (paypalOrders.get(ppId) as { purchase_units: { payments: { captures: { status: string }[] } }[] }).purchase_units[0];
    const cap = unit?.payments.captures[0];
    if (cap !== undefined) cap.status = 'REFUNDED';
    const refund = await paypalWebhook(new Request('https://fn.test', {
      method: 'POST',
      body: JSON.stringify({
        event_type: 'PAYMENT.CAPTURE.REFUNDED',
        resource: { id: 'REF1', links: [{ rel: 'up', href: `https://api-m.sandbox.paypal.com/v2/payments/captures/CAP${ppId}` }] },
      }),
    }));
    assert.equal(await refund.text(), 'mark_unpaid');
    assert.equal((await order(id))?.['paid_confirmed_at'], null);
  });

  it('Zelle no pasa por aquí: Stripe se niega a cobrar un pedido de otra forma de pago', async () => {
    await db`update public.stores set payment_options = payment_options || '{"cash": true}'::jsonb where id = ${STORE}`;
    const id = await placeOrder(customer, 'cash');
    assert.equal((await call(stripePago, 't-customer', { order_id: id })).body?.['error'], 'pedido_no_es_stripe');
  });
});
