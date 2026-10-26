# Puesta en marcha

Lo que se hace **una sola vez** para tener la app en línea. Nada de esto
pide contraseñas de la base ni llaves secretas en GitHub.

## 1. La base (Supabase → SQL Editor)

1. Supabase → tu proyecto → **SQL Editor** → **New query**.
2. Abre `entregas/01-base-viva-juice.sql` (en GitHub: el archivo → botón
   **Copy raw file**), pega **todo** y **Run**.
   - Crea todas las tablas, permisos (RLS), el negocio en dólares y hora de
     Nueva York, el menú bilingüe con fotos y las historias.
   - Se puede correr dos veces: lo que ya está, se salta.
   - Si sale un error, no se aplica nada a medias: mándame el mensaje.

## 2. Supabase → Authentication

**Authentication** → **URL Configuration**:
- **Site URL**: `https://grocerycastillo2025-spec.github.io/vivajuicebarweb/`
- **Redirect URLs** → **Add URL**: la misma, con `**` al final.

Opcional, para que el cliente entre sin confirmar el correo:
**Authentication** → **Sign In / Providers** → **Email** → apaga
**Confirm email** → **Save**.

## 3. GitHub Pages

GitHub → repo → **Settings** → **Pages** → **Source**: **GitHub Actions**.
Cada push a `main` publica la app (Actions → "Publicar app web"). La
dirección queda en
`https://grocerycastillo2025-spec.github.io/vivajuicebarweb/`.

## 4. El dueño

1. El dueño abre la app, va a **Perfil** y **crea su cuenta** con su correo.
2. Supabase → **SQL Editor** → **New query** → pega, cambiando el correo, y
   **Run**:

   ```sql
   select app.grant_restaurant_role('correo-del-dueño@ejemplo.com',
          '11111111-1111-4111-8111-111111111111', 'owner');
   ```
3. El dueño recarga la app: en **Perfil** aparece **Panel del negocio**.
   Los cajeros se dan de alta desde ahí (Negocio → Equipo), sin SQL.

## 5. Formas de pago

Efectivo y tarjeta en mostrador ya están prendidos. Zelle, Stripe y PayPal:
[PAGOS.md](PAGOS.md).

## 6. Antes de lanzar

1. Imprime `materiales/poster-carta.pdf` (tamaño carta) y pégalo en el
   mostrador. `materiales/qr-app.png` es el QR solo, para redes o la caja.
   Los dos llevan a la app con el aviso de "Instalar app" abierto.
2. Borra lo que dejaron las pruebas: SQL Editor → pega
   `entregas/borrar-datos-de-prueba.sql` → **Run**. Deja el menú, las fotos,
   el horario y las cuentas; borra pedidos, pagos, puntos y estadísticas.

## Dominio propio (opcional)

1. En el DNS de vivajuicecoffee.com: un `CNAME` de `app` a
   `grocerycastillo2025-spec.github.io`.
2. GitHub → Settings → Pages → **Custom domain** → `app.vivajuicecoffee.com`
   → **Save**; cuando aparezca, marca **Enforce HTTPS**.
3. GitHub → Settings → Secrets and variables → Actions → **Variables** →
   **New repository variable**: `WEB_BASE_URL` = `/`.
4. Supabase → Edge Functions → Secrets: `APP_PUBLIC_URL` =
   `https://app.vivajuicecoffee.com/` (para que Stripe y PayPal regresen
   ahí).
5. Vuelve a generar el póster con la nueva dirección:
   `python3 scripts/materiales/armar.py https://app.vivajuicecoffee.com/`.
