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
  // Mapa del panel sin internet: Leaflet desde node_modules, mosaicos en
  // blanco y un buscador de direcciones falso (31 South St, Freehold).
  const LEAFLET = join(here, '..', '..', 'node_modules', 'leaflet', 'dist');
  await context.route('https://unpkg.com/leaflet@1.9.4/dist/**', (route) => {
    const file = join(LEAFLET, new URL(route.request().url()).pathname.replace('/leaflet@1.9.4/dist/', ''));
    if (!existsSync(file)) return route.fulfill({ status: 404 });
    const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'image/png';
    return route.fulfill({ body: readFileSync(file), contentType: type });
  });
  await context.route('https://tile.openstreetmap.org/**', (route) =>
    route.fulfill({ body: readFileSync(join(LEAFLET, 'images', 'layers.png')), contentType: 'image/png' }),
  );
  await context.route('https://nominatim.openstreetmap.org/**', (route) =>
    route.fulfill({ body: JSON.stringify([{ lat: '40.2602115', lon: '-74.2738712' }]), contentType: 'application/json' }),
  );
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
// Lealtad: 10 puntos por visita; un shot a los 10 y un jugo a los 30.
await db`insert into public.loyalty_programs (restaurant_id, enabled, points_per_visit, visit_cooldown_hours)
           values (${RESTAURANT}, true, 10, 20)
           on conflict (restaurant_id) do update set enabled = true, points_per_visit = 10, visit_cooldown_hours = 20`;
await db`insert into public.rewards (tenant_id, name, cost_points, i18n) values
           (${RESTAURANT}, 'Free shot', 10, '{"es":{"name":"Shot gratis"}}'),
           (${RESTAURANT}, 'Free juice', 30, '{"es":{"name":"Jugo gratis"}}')`;
await db`update public.app_settings set features = features || '{"loyalty": true}'::jsonb where restaurant_id = ${RESTAURANT}`;

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
    // Contraseña equivocada: el aviso se ve en la página (en web no hay Alert).
    await d.getByPlaceholder('Contraseña').fill('equivocada-1');
    await boton(d, 'Entrar').click();
    await visible(d, 'Correo o contraseña incorrectos.');
    await d.getByPlaceholder('Contraseña').fill('clave-segura-1');
    // El ojito deja ver lo que se escribió.
    await d.getByRole('button', { name: 'Mostrar contraseña' }).click();
    if ((await d.getByPlaceholder('Contraseña').getAttribute('type')) === 'password') throw new Error('El ojito no muestra la contraseña');
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
    // El "Guardado" de impuestos ya está en pantalla: se espera a la base.
    let tienda;
    for (let i = 0; i < 40; i += 1) {
      [tienda] = await db`select payment_options from public.stores where id = ${STORE}`;
      if (tienda.payment_options.stripe === true && tienda.payment_options.paypal === true) break;
      await d.waitForTimeout(250);
    }
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
  console.log('Tienda (cajero), tableta');
  const t = await nuevaPagina({ locale: 'es-US', width: 1024, height: 768 });
  await paso(t, 'tienda-entra', async () => {
    await t.goto(`${APP}profile`);
    await t.getByRole('button', { name: 'Cerrar' }).first().click({ timeout: 5000 }).catch(() => {});
    await t.getByPlaceholder('Correo').fill('cajero@vivajuice.test');
    await t.getByPlaceholder('Contraseña').fill('clave-segura-1');
    await boton(t, 'Entrar').click();
    await boton(t, 'Abrir el panel').click();
    await visible(t, 'Nuevos');
    // Ve Pedidos, Tienda y Lealtad; no Menú, Estadísticas ni Negocio.
    for (const oculto of ['Negocio', 'Estadísticas']) {
      if (await t.getByRole('link', { name: oculto }).filter({ visible: true }).count()) throw new Error(`La tienda ve ${oculto}`);
    }
  });
  await paso(t, 'tienda-agota-producto', async () => {
    await t.goto(`${APP}admin/tienda`);
    await visible(t, 'Recibiendo pedidos');
    await t.getByLabel('Buscar producto u opción').fill('verde');
    await t.getByRole('switch', { name: /^Jugo Verde: Disponible/ }).filter({ visible: true }).first().click();
    await visible(t, '1 agotado');
    await t.getByLabel('Buscar producto u opción').fill('avena');
    await t.getByRole('switch', { name: /avena: Disponible/i }).filter({ visible: true }).first().click();
    await t.getByLabel('Buscar producto u opción').fill('');
    await t.waitForTimeout(800);
    const [item] = await db`select available from public.catalog_items where clover_item_id = 'viva-juice-green'`;
    const [oat] = await db`select available from public.catalog_modifiers where clover_modifier_id = 'viva-mod-milk-oat'`;
    if (item.available || oat.available) throw new Error('No se guardó el agotado');
  });
  await paso(t, 'tienda-agota-naranja-y-sus-jugos', async () => {
    await t.getByLabel('Buscar producto u opción').fill('naranja');
    await t.getByRole('switch', { name: /^Naranja: Disponible/ }).filter({ visible: true }).first().click();
    await visible(t, 'Naranja también se usa en esto');
    await visible(t, 'Viva Juice');
    await visible(t, 'Anti Flu');
    await t.getByTestId('cascada-si').click();
    await t.getByLabel('Buscar producto u opción').fill('');
    let row;
    for (let i = 0; i < 40; i += 1) {
      [row] = await db`select bool_or(available) as alguno from public.catalog_items where name in ('Viva Juice', 'Anti Flu')`;
      if (row.alguno === false) break;
      await t.waitForTimeout(250);
    }
    if (row.alguno !== false) throw new Error('No se apagaron los jugos con naranja');
  });
  await paso(t, 'tienda-regresa-naranja', async () => {
    await t.getByLabel('Buscar producto u opción').fill('naranja');
    await t.getByRole('switch', { name: /^Naranja: Agotado/ }).filter({ visible: true }).first().click();
    await visible(t, 'Ya hay Naranja');
    // Jugo Verde lleva naranja pero se había agotado por otra razón: sale
    // en la lista SIN marcar; los que se apagaron con la naranja, marcados.
    if (await t.getByRole('checkbox', { name: 'Jugo Verde' }).isChecked()) {
      throw new Error('Jugo Verde venía marcado para encender');
    }
    await t.screenshot({ path: join(here, 'capturas', `${String(n).padStart(2, '0')}b-cascada.png`) });
    await t.getByTestId('cascada-si').click();
    await t.getByLabel('Buscar producto u opción').fill('');
    let row;
    for (let i = 0; i < 40; i += 1) {
      [row] = await db`select bool_and(available) as todos from public.catalog_items where name in ('Viva Juice', 'Anti Flu')`;
      if (row.todos === true) break;
      await t.waitForTimeout(250);
    }
    if (row.todos !== true) throw new Error('No se volvieron a encender');
  });
  await paso(t, 'tienda-pausa-pedidos', async () => {
    await boton(t, 'Pausar pedidos').click();
    await visible(t, '¿Pausar los pedidos de la app?');
    await boton(t, 'Sí, pausar').click();
    await visible(t, 'Pedidos en pausa');
    await visible(t, 'pausó los pedidos');
    const [s] = await db`select pickup_enabled from public.stores where id = ${STORE}`;
    if (s.pickup_enabled) throw new Error('La tienda no quedó en pausa');
  });
  await paso(c, 'cliente-ve-agotado-y-pausa', async () => {
    await c.goto(`${APP}menu`);
    await visible(c, 'Pedidos en pausa');
    await visible(c, 'Este producto no está disponible ahora');
  });
  await paso(t, 'tienda-reanuda', async () => {
    await boton(t, 'Volver a recibir pedidos').click();
    await visible(t, 'Recibiendo pedidos');
    // Y no puede cambiar precios: la base lo impide aunque lo intente.
    const res = await t.evaluate(async () => {
      const key = Object.keys(localStorage).find((k) => k.includes('auth-token'));
      return key ? JSON.parse(localStorage.getItem(key)).access_token : null;
    });
    if (res) {
      await fetch(`${GATEWAY}/rest/v1/catalog_items?clover_item_id=eq.viva-juice-green`, {
        method: 'PATCH',
        headers: { authorization: `Bearer ${res}`, 'content-type': 'application/json' },
        body: JSON.stringify({ price_cents: 1 }),
      });
    }
    const [item] = await db`select price_cents from public.catalog_items where clover_item_id = 'viva-juice-green'`;
    if (Number(item.price_cents) !== 850) throw new Error('La tienda cambió un precio');
  });

  // -------------------------------------------------------------------
  console.log('Lealtad: la tienda escanea la tarjeta del cliente');
  await paso(c, 'cliente-mi-tarjeta', async () => {
    await c.goto(`${APP}rewards`);
    await visible(c, 'Mi tarjeta');
    await visible(c, 'Muéstrala en el mostrador');
    await visible(c, 'Shot gratis');
    await visible(c, 'Te falta 1 visita');
  });
  const [cuentaAna] = await db`select a.card_code from public.loyalty_accounts a join auth.users u on u.id = a.user_id
                                where u.email = 'ana@example.test'`;
  if (!cuentaAna?.card_code) throw new Error('Ana no tiene tarjeta');
  await paso(c, 'cliente-foto-y-telefono', async () => {
    await c.getByText('Agrega tu foto y teléfono').first().click();
    await c.getByTestId('editar-perfil').filter({ visible: true }).click();
    const [chooser] = await Promise.all([
      c.waitForEvent('filechooser'),
      c.getByTestId('elegir-foto-perfil').filter({ visible: true }).click(),
    ]);
    await chooser.setFiles(join(here, '..', '..', 'apps', 'mobile', 'public', 'img', 'menu', 'anti-flu.jpg'));
    await c.getByLabel('Apellido').filter({ visible: true }).fill('López');
    await c.getByLabel('Teléfono').filter({ visible: true }).fill('(732) 555-0142');
    await c.getByTestId('guardar-perfil').filter({ visible: true }).click();
    await visible(c, 'Ana López');
    await visible(c, '(732) 555-0142');
    const [p] = await db`select p.avatar_path from public.profiles p join auth.users u on u.id = p.id where u.email = 'ana@example.test'`;
    if (!p?.avatar_path) throw new Error('No se guardó la foto');
  });
  await paso(t, 'tienda-abre-tarjeta', async () => {
    await t.goto(`${APP}admin/lealtad`);
    await visible(t, 'Tarjeta del cliente');
    await t.getByLabel('O escribe el código de la tarjeta').fill(`${cuentaAna.card_code.slice(0, 5)}-${cuentaAna.card_code.slice(5)}`);
    await t.getByTestId('abrir-tarjeta').click();
    await visible(t, 'Ana López');
    await visible(t, 'Tel. ••• 0142');
    await visible(t, 'Primera visita');
    // La foto del cliente, desde el bucket privado (liga firmada).
    await t.getByRole('img', { name: 'Ana López' }).filter({ visible: true }).first().waitFor({ timeout: 10_000 });
  });
  await paso(t, 'tienda-suma-visita-y-avisa', async () => {
    await t.getByTestId('sumar-visita').click();
    await visible(t, '+10 puntos. Ahora tiene 10.');
    await visible(t, 'ya tiene su recompensa');
    await visible(t, 'Ya sumó su visita');
  });
  await paso(t, 'tienda-entrega-recompensa', async () => {
    await t.getByTestId('entregar').click();
    await visible(t, '¿Entregar Shot gratis?');
    await t.getByTestId('confirmar-entrega').click();
    await visible(t, 'Listo: Shot gratis para Ana López');
    const [a] = await db`select points_balance from public.loyalty_accounts where card_code = ${cuentaAna.card_code}`;
    if (Number(a.points_balance) !== 0) throw new Error(`El conteo no volvió a 0: ${a.points_balance}`);
  });
  await paso(t, 'tienda-historial-recompensas', async () => {
    await t.goto(`${APP}admin/lealtad`);
    await visible(t, 'Recompensas entregadas');
    await visible(t, 'Shot gratis → Ana López');
    await visible(t, 'entregó cajero@vivajuice.test');
  });
  await paso(c, 'cliente-recompensa-recibida', async () => {
    await c.goto(`${APP}rewards`);
    await visible(c, 'Recompensas recibidas');
    await visible(c, 'Te faltan 30 pts');
  });

  // -------------------------------------------------------------------
  console.log('Dueña: estadísticas y QR de la app');
  await paso(d, 'estadisticas-graficas', async () => {
    await d.goto(`${APP}admin/estadisticas`);
    await visible(d, 'En resumen');
    await visible(d, 'Vendiste');
    await visible(d, 'La hora con más pedidos');
    await visible(d, '¿Cuándo te piden?');
    await visible(d, '¿Cómo pagan?');
    await visible(d, 'Tarjeta en línea');
    await visible(d, 'Jugo Verde');
    await d.getByText('¿Cuándo te piden?').scrollIntoViewIfNeeded();
    await d.screenshot({ path: join(here, 'capturas', `${String(n).padStart(2, '0')}b-estadisticas-calor.png`) });
    await d.getByText('Interés en la app').scrollIntoViewIfNeeded();
    await d.screenshot({ path: join(here, 'capturas', `${String(n).padStart(2, '0')}c-estadisticas-pagos.png`) });
  });
  await paso(d, 'estadisticas-hoy', async () => {
    await d.getByRole('radio', { name: 'Hoy' }).click();
    await visible(d, 'Pedidos por hora');
  });
  await paso(d, 'panel-en-ingles', async () => {
    await d.getByTestId('panel-idioma-en').click();
    await visible(d, 'At a glance');
    await visible(d, 'Sales by day');
    await visible(d, 'Loyalty');
    await d.goto(`${APP}admin/tienda`);
    // Se recuerda al navegar; los productos salen con su nombre en inglés.
    await visible(d, 'Taking orders');
    await visible(d, 'Green Juice');
  });
  await paso(d, 'panel-de-vuelta-en-espanol', async () => {
    await d.getByTestId('panel-idioma-es').click();
    await visible(d, 'Recibiendo pedidos');
    await visible(d, 'Jugo Verde');
  });
  await paso(d, 'sucursal-en-el-mapa', async () => {
    await d.goto(`${APP}admin/business`);
    await visible(d, 'Ubicación en el mapa');
    await d.locator('.leaflet-marker-icon').first().waitFor({ timeout: 15_000 });
    await d.getByTestId('buscar-direccion').click();
    await visible(d, 'Marcado: 40.260212, -74.273871');
    // Tocar el mapa un poco a la derecha del pin: el pin se va ahí.
    await d.waitForTimeout(900);
    const pin = d.locator('.leaflet-marker-icon').first();
    const box = await pin.boundingBox();
    await d.mouse.click(box.x + box.width / 2 + 80, box.y + box.height - 2);
    await d.waitForTimeout(400);
    const before = await d.getByText(/^Marcado: /).first().innerText();
    if (before.includes('-74.273871')) throw new Error(`El pin no se movió: ${before}`);
    await d.getByRole('button', { name: 'Guardar cambios' }).first().click();
    let s;
    for (let i = 0; i < 40; i += 1) {
      [s] = await db`select latitude, longitude from public.stores where id = ${STORE}`;
      if (s.latitude !== null && Number(s.longitude) > -74.273871) break;
      await d.waitForTimeout(250);
    }
    if (s.latitude === null || !(Number(s.longitude) > -74.273871)) throw new Error(`No se guardó el punto: ${JSON.stringify(s)}`);
  });
  let nuevaClave = '';
  await paso(d, 'equipo-crear-cuenta-tienda', async () => {
    await d.goto(`${APP}admin/business`);
    await visible(d, 'Crear cuenta nueva');
    await d.getByLabel('Nombre', { exact: true }).last().fill('Luis');
    await d.getByLabel('Correo de la persona').fill('luis@vivajuice.test');
    nuevaClave = await d.getByLabel('Contraseña temporal').inputValue();
    if (!/^Viva-[A-Z]{4}-\d{4}$/.test(nuevaClave)) throw new Error(`Contraseña temporal rara: ${nuevaClave}`);
    await d.getByTestId('crear-cuenta-equipo').click();
    await visible(d, 'Cuenta lista. Pásale estos datos:');
    await visible(d, 'luis@vivajuice.test');
    const [m] = await db`select m.role from public.restaurant_members m join auth.users u on u.id = m.user_id
                          where u.email = 'luis@vivajuice.test'`;
    if (m?.role !== 'staff') throw new Error(`Rol de Luis: ${m?.role}`);
  });
  await paso(d, 'equipo-luis-entra-y-cambia-clave', async () => {
    const l = await nuevaPagina({ locale: 'es-US', width: 1024, height: 768 });
    await l.goto(`${APP}profile`);
    await l.getByRole('button', { name: 'Cerrar' }).first().click({ timeout: 5000 }).catch(() => {});
    await l.getByPlaceholder('Correo').fill('luis@vivajuice.test');
    await l.getByPlaceholder('Contraseña').fill(nuevaClave);
    await boton(l, 'Entrar').click();
    await visible(l, 'Panel del negocio');
    await visible(l, 'Luis');
    await l.getByTestId('cambiar-contrasena').click();
    await l.getByLabel('Contraseña nueva').fill('mi-clave-propia-1');
    await l.getByLabel('Repite la contraseña').fill('mi-clave-propia-1');
    await l.getByTestId('guardar-contrasena').click();
    await visible(l, 'Listo, tu contraseña cambió.');
    await boton(l, 'Abrir el panel').click();
    await visible(l, 'Tienda');
    if (await l.getByRole('tab', { name: 'Negocio' }).filter({ visible: true }).count()) throw new Error('Luis ve Negocio');
    await l.screenshot({ path: join(here, 'capturas', `${String(n).padStart(2, '0')}b-luis-tienda.png`) });
    await visible(l, 'luis@vivajuice.test · Tienda');
    // Cerrar sesión desde el panel cierra también la app.
    await l.getByTestId('panel-salir').click();
    await visible(l, 'Inicia sesión');
    await l.goto(`${APP}admin`);
    await visible(l, 'Entra al panel');
    await l.close();
  });
  await paso(d, 'panel-en-telefono', async () => {
    const p = await nuevaPagina({ locale: 'es-US' });
    await p.goto(`${APP}profile`);
    await p.getByRole('button', { name: 'Cerrar' }).first().click({ timeout: 5000 }).catch(() => {});
    await p.getByPlaceholder('Correo').fill('duena@vivajuice.test');
    await p.getByPlaceholder('Contraseña').fill('clave-segura-1');
    await boton(p, 'Entrar').click();
    await boton(p, 'Abrir el panel').click();
    await p.getByRole('button', { name: 'Cerrar sesión' }).filter({ visible: true }).first().waitFor();
    await p.screenshot({ path: join(here, 'capturas', `${String(n).padStart(2, '0')}b-panel-telefono.png`) });
    await p.close();
  });
  await paso(d, 'qr-de-la-app', async () => {
    await d.goto(`${APP}admin/business`);
    await visible(d, 'QR de la app');
    const [cartel] = await Promise.all([
      d.context().waitForEvent('page'),
      d.getByTestId('imprimir-cartel').click(),
    ]);
    await cartel.getByText('Order ahead').waitFor({ timeout: 10_000 });
    await cartel.getByText('Pide desde tu teléfono').waitFor();
    await cartel.waitForFunction(() => { const img = document.querySelector('img.logo'); return img === null || (img.complete && img.naturalWidth > 0); }, null, { timeout: 5000 })
      // La ventana nueva pide el logo a la app publicada (sin internet aquí).
      .catch(() => {});
    await cartel.screenshot({ path: join(here, 'capturas', `${String(n).padStart(2, '0')}b-cartel.png`) });
    await cartel.close();
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
