# VIVA Juice and Coffee — app web

App web instalable (PWA) para pedir y recoger en **VIVA Juice and Coffee**,
31 South St, Freehold, NJ. En inglés o español, a elección del cliente.
Hecha con Expo (React Native Web) y Supabase; se publica en GitHub Pages.

https://grocerycastillo2025-spec.github.io/vivajuicebarweb/

| Para… | Ver |
|---|---|
| Ponerla en línea la primera vez | [docs/PUESTA-EN-MARCHA.md](docs/PUESTA-EN-MARCHA.md) |
| El panel del dueño y del cajero (`/admin`) | [docs/PANEL-NEGOCIO.md](docs/PANEL-NEGOCIO.md) |
| Zelle, Stripe y PayPal | [docs/PAGOS.md](docs/PAGOS.md) |
| Instalación, service worker, dominio | [docs/APP-WEB.md](docs/APP-WEB.md) |

## Estructura

- `apps/mobile` — la app (cliente y panel `/admin`).
- `supabase/migrations` — esquema, RLS y funciones (0001–0029).
- `supabase/seed/viva_juice_us.sql` — alta del negocio y menú bilingüe.
- `supabase/functions` — `stripe-pago`, `stripe-webhook`, `paypal-pago`,
  `paypal-webhook` (lógica en `_shared/`).
- `entregas/` — los `.sql` para pegar en Supabase → SQL Editor. Se arman con
  `node scripts/sql/armar-entrega.mjs`; no se editan a mano.
- `materiales/` — póster tamaño carta y QR (`scripts/materiales/armar.py`).

## Pruebas

```bash
pnpm lint && pnpm typecheck && pnpm test          # lógica, incluido el dinero
bash scripts/sql/probar-ci.sh                      # migraciones + pruebas SQL de permisos
bash scripts/sql/probar-entrega.sh entregas/01-base-viva-juice.sql   # entrega sobre base vacía, 2 veces
bash tools/e2e/correr.sh                           # navegador de punta a punta (capturas en tools/e2e/capturas)
```

La prueba en navegador levanta una base real con la entrega, PostgREST, las
funciones de cobro de verdad y un Stripe/PayPal falsos, y recorre la app
como cliente (español e inglés, Zelle, Stripe, PayPal) y como dueño.
Necesita Postgres local, `postgrest` y Chromium de Playwright.
