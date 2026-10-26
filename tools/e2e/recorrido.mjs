/**
 * Recorrido en navegador (Playwright): lo que haría una persona.
 *
 *   Cliente (teléfono, español): historias, idioma, menú bilingüe, "arma tu
 *     jugo", carrito, cuenta, pedido con Zelle, con Stripe y con PayPal.
 *   Dueño (computadora): panel, pedidos, "Pago recibido", formas de pago con
 *     "Probar conexión".
 *
 * Cada paso deja una captura en tools/e2e/capturas/. Si un paso falla, la
 * captura y el texto de la pantalla quedan para ver qué pasó.
 *
 * Lo corre correr.sh (que levanta la base y los servicios).
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import postgres from 'postgres';

const here = dirname(fileURLToPath(import.meta.url));
const DIST = join(here, '..', '..', 'apps', 'mobile', 'dist');
const APP = 'http://localhost:8080/vivajuicebarweb/';
const GATEWAY = 'http://localhost:54321';
const PUBLISHED = 'https://grocerycastillo2025-spec.github.io/vivajuicebarweb/';
const STORE = '22222222-2222-4222-8222-222222222222';
const RESTAURANT = '11111111-1111-4111-8111-111111111111';
const db = postgres(process.env.E2E_DB_URL ?? 'postgresql://postgres:postgres@localhost:5432/e2e', { onnotice: () => {} });

const browser = await chromium.launch();
let n = 0;
const problems = [];

/** Las fotos del seed apuntan a la app publicada: aquí se sirven de dist/. */
async function servirFotos(context) {
  await context.route(`${PUBLISHED}**`, (route) => {
    const file = join(DIST, new URL(route.request().url()).pathname.replace('/vivajuicebarweb/', ''));
    if (!existsSync(file)) return route.fulfill({ status: 404 });
    return route.fulfill({ body: readFileSync(file), contentType: file.endsWith('.png') ? 'image/png' : 'image/jpeg' });
  });
}

async function nuevaPagina({ locale = 'es-US', width = 390, height = 844, userAgent } = {}) {
  const context = await browser.newContext({ locale, viewport: { width, height }, deviceScaleFactor: 2, ...(userAgent ? { userAgent } : {}) });
  await servirFotos(context);
  const page = await context.newPage();
  page.on('pageerror', (e) => problems.push(`[${locale}] ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push(`[consola] ${m.text()}`);
  });
  return page;
}

async function paso(page, nombre, fn) {
  n += 1;
  const file = join(here, 'capturas', `${String(n).padStart(2, '0')}-${nombre}.png`);
  try {
    await fn();
    await page.waitForTimeout(400);
    await page.screenshot({ path: file });
    console.log(`  ✓ ${String(n).padStart(2, '0')} ${nombre}`);
  } catch (cause) {
    await page.screenshot({ path: file.replace('.png', '-FALLO.png') }).catch(() => {});
    const text = await page.locator('body').innerText().catch(() => '');
    console.log(`  ✗ ${nombre}\n${String(cause).slice(0, 600)}\n--- pantalla ---\n${text.slice(0, 1200)}`);
    throw cause;
  }
}

// Las pantallas anteriores del stack siguen en el DOM, ocultas: se busca
// siempre lo VISIBLE.
const visible = (page, text) =>
  page.getByText(text, { exact: false }).filter({ visible: true }).first().waitFor({ state: 'visible', timeout: 15_000 });
const texto = (page, text) => page.getByText(text, { exact: true }).filter({ visible: true }).first();
const boton = (page, name) => page.getByRole('button', { name, exact: false }).filter({ visible: true }).first();

// ---------------------------------------------------------------------
// Preparación: dueño y cajero (se registran antes, como en la vida real),
// Zelle con datos y horario de todo el día para que la prueba no dependa
// de la hora.
// ---------------------------------------------------------------------
async function cuenta(email) {
  const res = await fetch(`${GATEWAY}/__e2e/cuenta`, { method: 'POST', body: JSON.stringify({ email, password: 'clave-segura-1' }) });
  return (await res.json()).id;
}
await cuenta('duena@vivajuice.test');
await cuenta('cajero@vivajuice.test');
await db`select app.grant_restaurant_role('duena@vivajuice.test', ${RESTAURANT}::uuid, 'owner')`;
await db`select app.grant_restaurant_role('cajero@vivajuice.test', ${RESTAURANT}::uuid, 'staff')`;
await db`update public.stores set zelle_recipient = '+17324968863', zelle_name = 'VIVA Juice and Coffee',
           payment_options = payment_options || '{"zelle": true}'::jsonb where id = ${STORE}`;
await db`update public.store_hours set opens_at = '00:00', closes_at = '23:59' where store_id = ${STORE}`;

try {
  // -------------------------------------------------------------------
  console.log('Cliente, teléfono en español');
  const c = await nuevaPagina({ locale: 'es-US' });

  await paso(c, 'historias-solas-al-abrir', async () => {
    await c.goto(APP);
    await visible(c, 'El clásico de la casa');
    await c.locator('img').first().waitFor({ state: 'attached' });
  });
  await paso(c, 'inicio-es', async () => {
    await c.getByRole('button', { name: 'Cerrar' }).first().click();
    await visible(c, 'Fresco, hecho al momento');
    await visible(c, 'Destacados');
  });
  await paso(c, 'inicio-en', async () => {
    await c.getByTestId('cambiar-idioma').click();
    await visible(c, 'Fresh, made to order');
    await visible(c, 'Featured');
  });
  await paso(c, 'menu-en', async () => {
    await texto(c, 'Menu').click();
    await visible(c, '🍊 Juices');
    await visible(c, 'Green Juice');
  });
  await paso(c, 'menu-es', async () => {
    await c.goto(`${APP}menu`);
    // El idioma elegido se recuerda; se regresa a español desde Perfil.
    await visible(c, 'Green Juice');
    await c.goto(`${APP}profile`);
    await c.getByRole('radio', { name: 'Español' }).filter({ visible: true }).click();
    await visible(c, 'Perfil');
    await c.goto(`${APP}menu`);
    await visible(c, '🍊 Jugos');
    await visible(c, 'Jugo Verde');
    await visible(c, '$8.50');
  });
  await paso(c, 'arma-tu-jugo', async () => {
    await texto(c, 'Arma tu jugo').click();
    await visible(c, 'Obligatorio · elige 3');
    // Ninguna viene marcada: el cliente elige. Si intenta agregar con 2,
    // la app le dice lo que falta; luego cambia de opinión y completa.
    for (const fruta of ['Naranja', 'Zanahoria']) await texto(c, fruta).click();
    await boton(c, 'Agregar ·').click();
    await visible(c, 'Te falta elegir 1');
    await texto(c, 'Zanahoria').click();
    for (const fruta of ['Betabel', 'Jengibre']) await texto(c, fruta).click();
    await boton(c, 'Agregar ·').click();
  });
  await paso(c, 'carrito', async () => {
    await c.goto(`${APP}cart`);
    await visible(c, 'Tu carrito');
    await visible(c, 'Arma tu jugo');
    await visible(c, 'Naranja');
    await visible(c, 'Jengibre');
  });
  await paso(c, 'crear-cuenta', async () => {
    await boton(c, 'Elegir hora para recoger').click();
    await visible(c, 'Inicia sesión');
    await texto(c, 'No tengo cuenta').click();
    await c.getByPlaceholder('Nombre').filter({ visible: true }).fill('Ana');
    await c.getByPlaceholder('Correo').filter({ visible: true }).fill('ana@example.test');
    await c.getByPlaceholder('Contraseña').filter({ visible: true }).fill('clave-segura-1');
    await boton(c, 'Crear cuenta').click();
    await visible(c, '¿Cómo vas a pagar?');
  });
  await paso(c, 'formas-de-pago', async () => {
    await visible(c, 'Efectivo');
    await visible(c, 'Zelle');
    // Stripe y PayPal no se ofrecen: no están conectados todavía.
    if (await c.getByText('Tarjeta en línea').filter({ visible: true }).count()) throw new Error('Stripe se ofrece sin estar conectado');
  });
  await paso(c, 'pedido-zelle', async () => {
    await c.getByRole('radio', { name: /Zelle/ }).filter({ visible: true }).click();
    await boton(c, 'Hacer pedido').click();
    await visible(c, 'Paga tu pedido');
    await visible(c, '(732) 496-8863');
    await visible(c, 'Pedido #');
    await visible(c, 'Pago por confirmar');
    await visible(c, 'Código para recoger');
    // El pedido guarda el nombre en inglés; en español se ve traducido.
    await visible(c, 'Arma tu jugo');
    await visible(c, 'Jengibre');
  });
  const zelleUrl = c.url();

  // -------------------------------------------------------------------
  console.log('Dueña, computadora');
  const d = await nuevaPagina({ locale: 'es-US', width: 1280, height: 860 });
  await paso(d, 'duena-entra', async () => {
    await d.goto(`${APP}profile`);
    await d.getByRole('button', { name: 'Cerrar' }).first().click({ timeout: 5000 }).catch(() => {});
    await d.getByPlaceholder('Correo').fill('duena@vivajuice.test');
    await d.getByPlaceholder('Contraseña').fill('clave-segura-1');
    await boton(d, 'Entrar').click();
    await visible(d, 'Panel del negocio');
  });
  await paso(d, 'panel-pedidos', async () => {
    await boton(d, 'Abrir el panel').click();
    await visible(d, 'Nuevos');
    await visible(d, 'Pago por confirmar');
    await visible(d, 'Arma tu jugo');
  });
  await paso(d, 'panel-pago-recibido', async () => {
    await boton(d, 'Pago recibido').click();
    await visible(d, 'Pagado');
  });
  await paso(d, 'panel-menu-bilingue', async () => {
    await d.goto(`${APP}admin/menu`);
    await visible(d, '🍊 Juices');
    await visible(d, '🍊 Jugos');
  });
  await paso(d, 'panel-formas-de-pago', async () => {
    await d.goto(`${APP}admin/business`);
    await visible(d, 'Formas de pago');
    await visible(d, 'Aceptar Zelle');
    const probar = d.getByRole('button', { name: 'Probar conexión' });
    await probar.nth(0).click();
    await visible(d, 'modo PRUEBA');
    await probar.nth(1).click();
    await d.getByText('modo PRUEBA').nth(1).waitFor({ timeout: 15_000 });
    await d.getByRole('switch', { name: /tarjeta en línea/i }).click();
    await d.getByRole('switch', { name: /PayPal/ }).click();
    // Impuesto 6.625% y 3% de recargo con tarjeta en línea.
    await d.getByLabel('Impuesto de la sucursal (%)').fill('6.625');
    await d.getByLabel('Tarjeta en línea', { exact: true }).fill('3');
    await d.getByTestId('guardar-impuestos').click();
    await visible(d, 'Guardado');
    await d.getByTestId('guardar-pagos').click();
    await visible(d, 'Guardado');
    const [tienda] = await db`select payment_options from public.stores where id = ${STORE}`;
    if (tienda.payment_options.stripe !== true || tienda.payment_options.paypal !== true) {
      throw new Error(`No se guardaron Stripe y PayPal: ${JSON.stringify(tienda.payment_options)}`);
    }
  });

  // -------------------------------------------------------------------
  console.log('Cliente: pagos en línea');
  await paso(c, 'zelle-ya-pagado', async () => {
    await c.goto(zelleUrl);
    await visible(c, 'Pago recibido');
  });

  async function pedirOtro(metodo) {
    await c.goto(`${APP}menu`);
    await texto(c, 'Jugo Verde').click();
    await boton(c, 'Agregar ·').click();
    await c.goto(`${APP}cart`);
    await boton(c, 'Elegir hora para recoger').click();
    await c.getByRole('radio', { name: new RegExp(metodo) }).filter({ visible: true }).click();
    await boton(c, 'Hacer pedido').click();
  }

  await paso(c, 'checkout-con-impuesto-y-recargo', async () => {
    await c.goto(`${APP}menu`);
    await texto(c, 'Jugo Verde').click();
    await boton(c, 'Agregar ·').click();
    await c.goto(`${APP}cart`);
    await boton(c, 'Elegir hora para recoger').click();
    // 8.50 + 6.625% = 9.06 ; con tarjeta en línea +3% = 9.33.
    await c.getByRole('radio', { name: /Efectivo/ }).filter({ visible: true }).click();
    await visible(c, 'Impuesto');
    await visible(c, 'Hacer pedido · $9.06');
    await c.getByRole('radio', { name: /Tarjeta en línea/ }).filter({ visible: true }).click();
    await visible(c, 'Recargo por pagar con Tarjeta en línea (3%)');
    await visible(c, 'Hacer pedido · $9.33');
  });
  await paso(c, 'stripe-pagina-de-pago', async () => {
    await boton(c, 'Hacer pedido').click();
    await c.waitForURL(/fake-stripe/, { timeout: 20_000 });
    // Stripe cobra lo mismo que se enseñó: una sola cantidad.
    await visible(c, '9.33 USD');
  });
  await paso(c, 'stripe-pagado', async () => {
    await c.locator('#pagar').click();
    await c.waitForURL(/pago=ok/, { timeout: 20_000 });
    await visible(c, 'Pago recibido');
    await visible(c, '$9.33');
  });
  await paso(c, 'paypal-pagina', async () => {
    await pedirOtro('PayPal');
    await c.waitForURL(/fake-paypal/, { timeout: 20_000 });
  });
  await paso(c, 'paypal-pagado', async () => {
    await c.locator('#aprobar').click();
    await c.waitForURL(/pago=ok/, { timeout: 20_000 });
    await visible(c, 'Pago recibido');
    await visible(c, '$9.06'); // PayPal sin recargo: solo el impuesto
  });
  await paso(c, 'historial', async () => {
    await c.goto(`${APP}orders`);
    await visible(c, 'En curso');
  });

  // -------------------------------------------------------------------
  console.log('Instalar la app');
  const iphone =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
  const i = await nuevaPagina({ locale: 'en-US', userAgent: iphone });
  await paso(i, 'instalar-iphone-en-ingles', async () => {
    await i.goto(`${APP}?instalar=1`);
    await i.getByRole('button', { name: 'Close' }).first().click({ timeout: 8000 }).catch(() => {});
    await visible(i, 'Add to Home Screen');
  });
  const w = await nuevaPagina({ locale: 'es-MX', userAgent: iphone.replace('Safari/604.1', 'WhatsApp/2.24 Safari/604.1') });
  await paso(w, 'instalar-desde-whatsapp', async () => {
    await w.goto(`${APP}?instalar=1`);
    await w.getByRole('button', { name: 'Cerrar' }).first().click({ timeout: 8000 }).catch(() => {});
    await visible(w, 'Ábrela en tu navegador');
  });

  const rows = await db`select pay_with, paid_confirmed_at is not null as pagado, online_status, total_cents, online_paid_cents
                          from public.orders order by created_at`;
  const stripe = rows.find((r) => r.pay_with === 'stripe');
  if (Number(stripe.total_cents) !== 933 || Number(stripe.online_paid_cents) !== 933) {
    throw new Error(`Stripe: total ${stripe.total_cents}, cobrado ${stripe.online_paid_cents} (se esperaba 933)`);
  }
  console.log('Pedidos en la base:', rows.map((r) => `${r.pay_with}:${r.pagado ? 'pagado' : 'pendiente'}`).join(', '));
  if (rows.some((r) => !r.pagado)) throw new Error('Quedó un pedido sin pagar');
} finally {
  await browser.close();
  await db.end();
}

if (problems.length > 0) {
  console.log('\nErrores en la consola del navegador:');
  for (const p of [...new Set(problems)]) console.log(`  - ${p}`);
  process.exitCode = 1;
}
console.log(problems.length === 0 ? '\nOK: recorrido completo sin errores.' : '');
