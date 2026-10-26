/*
 * Service worker de la app web.
 *
 * Solo toca peticiones GET del MISMO origen:
 *  - los bundles de /_expo/static/ y /assets/ llevan hash en el nombre,
 *    asi que se sirven de cache y no cambian nunca;
 *  - la navegacion va primero a la red (para recoger cada publicacion
 *    nueva) y cae al index.html guardado solo si no hay conexion.
 *
 * Supabase, Stripe, PayPal y cualquier otro origen NO pasan por aqui: el menu,
 * los precios y los pedidos siempre se leen en vivo.
 */

// La pone scripts/web-postbuild.mjs en cada publicación (fecha + commit):
// así cada versión nueva limpia la cache de la anterior.
const VERSION = 'viva-juice-__VERSION__';
const SCOPE = new URL(self.registration.scope).pathname;
const SHELL = SCOPE; // index.html

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.add(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(VERSION).then((cache) => cache.put(SHELL, copy));
          }
          return response;
        })
        .catch(() => caches.match(SHELL)),
    );
    return;
  }

  const immutable = url.pathname.includes('/_expo/static/') || url.pathname.includes('/assets/');
  if (!immutable) return;

  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ??
        fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(VERSION).then((cache) => cache.put(request, copy));
          }
          return response;
        }),
    ),
  );
});

// Tocar un aviso (pedido nuevo en el panel, "tu pedido está listo" para el
// cliente) abre esa pantalla, o la trae al frente si ya estaba abierta.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || SCOPE;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (client.url.startsWith(self.location.origin) && 'focus' in client) {
          if ('navigate' in client && client.url !== target) client.navigate(target).catch(() => {});
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
