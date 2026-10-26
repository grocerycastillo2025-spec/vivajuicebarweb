# App web (PWA)

> Primera vez: [PUESTA-EN-MARCHA.md](PUESTA-EN-MARCHA.md). Panel del dueño:
> [PANEL-NEGOCIO.md](PANEL-NEGOCIO.md).

La misma app de `apps/mobile` exportada para navegador con
`expo export --platform web`. Es el mismo código: lo que se cambia en la app
llega también a la web en la siguiente publicación.

## Publicar

Cada push a `main` corre **Actions → Publicar app web (GitHub Pages)**:
lint, typecheck, tests, exportación y despliegue. Queda en
`https://<cuenta>.github.io/<repo>/`.

Configuración (una sola vez): **Settings → Pages → Source: GitHub
Actions**. La URL y la clave **publicable** de Supabase van en
`apps/mobile/app.json` (`extra.supabaseUrl`, `extra.supabaseKey`); el
workflow rechaza una clave secreta. Sin ellas, el workflow no publica nada
y lo avisa.

## Dominio propio

1. En el DNS del dominio, un `CNAME` de `app` (o el subdominio que se elija)
   a `<cuenta>.github.io`.
2. Settings → Pages → Custom domain → `app.vivajuicecoffee.com`, y marcar
   *Enforce HTTPS* cuando GitHub emita el certificado.
3. Settings → Secrets and variables → Actions → **Variables** →
   `WEB_BASE_URL` = `/`, y volver a lanzar el workflow. Sin esa variable la
   app se compila para vivir bajo `/<repo>/` y con dominio propio no
   encontraría sus archivos.

## Probar en local

```bash
pnpm --filter @juicebar/mobile web          # servidor de desarrollo
pnpm --filter @juicebar/mobile build:web    # exportación, en apps/mobile/dist
```

## Qué cambia respecto al teléfono

| Pieza | En la web |
|---|---|
| Notificaciones push | No hay. `src/push/notifications.ts` devuelve `web` y el perfil explica que el pedido se sigue en la pestaña Pedidos (que se actualiza sola mientras el pedido está en curso). |
| Vibración al añadir | `expo-haptics` no hace nada en el navegador. |
| Pantalla ancha | La app se pinta en una columna centrada de 520 px (`public/index.html` y `src/hooks/use-content-width.ts`, que deben coincidir). |
| Instalación | `public/manifest.webmanifest` + `public/sw.js`: se puede "añadir a pantalla de inicio" en Android y en iPhone. |
| Rutas directas | `scripts/web-postbuild.mjs` copia `index.html` a `404.html`, así abrir o recargar `/order/<id>` funciona en Pages. |

Ojo al probar en local: Metro guarda en caché las variables `EXPO_PUBLIC_*`
ya sustituidas. Si cambias la URL de Supabase entre dos exportaciones, usa
`npx expo export --platform web --clear`. En CI no pasa (cada run empieza de
cero).

El service worker solo guarda en caché los archivos de la propia app (con
hash en el nombre). El menú, los precios y los pedidos se leen siempre en
vivo de Supabase.

## Instalar la app

- **Chrome / Edge / Samsung**: aviso "Instalar app" con botón (un toque y
  confirmar).
- **iPhone**: los pasos de Safari (Compartir → Agregar a pantalla de
  inicio).
- **Dentro de WhatsApp / Instagram / Facebook / TikTok**: aviso para abrir
  la liga en el navegador, con botón para copiarla.
- La liga con `?instalar=1` (la del póster) abre el aviso aunque se haya
  cerrado antes.

## Service worker

`public/sw.js` lleva la versión de cada publicación (fecha + commit, la
pone `scripts/web-postbuild.mjs`; también queda en `version.json`). Al
publicar, el teléfono descarta la versión anterior. El menú, los precios y
los pedidos nunca salen de caché: se leen en vivo de Supabase.
