# Formas de pago

Todas se prenden y apagan en **Panel → Negocio → Formas de pago**. El
cliente solo ve las que están prendidas **y** listas.

| Forma | Cómo cobra | ¿Quién marca "pagado"? |
|---|---|---|
| Efectivo | En el mostrador | Nadie: se cobra al entregar |
| Tarjeta en mostrador | En la terminal del local | Nadie: se cobra al entregar |
| Zelle | El cliente manda el dinero desde su banco | El cajero, con **Pago recibido** |
| Tarjeta en línea (Stripe) | El cliente paga en la página de Stripe (tarjeta, Apple Pay, Google Pay) | Solo, al confirmarlo con Stripe |
| PayPal | El cliente paga con PayPal, Venmo o tarjeta | Solo, al confirmarlo con PayPal |

**Reglas que no se rompen:** el monto lo lee la Edge Function de la base,
nunca del teléfono. Ni el teléfono ni un aviso del proveedor marcan nada
pagado: la función le pregunta al proveedor con nuestras llaves y solo
marca si el pago está completo, en USD, es de ese pedido y cubre el total.
Una devolución total lo desmarca.

**Las llaves secretas nunca van en la app, en GitHub ni en el chat.** Van en
Supabase → Edge Functions → Secrets.

---

## Impuesto y recargos: una sola cantidad a pagar

Panel → Negocio → **Impuestos y recargos**:

- **Impuesto de la sucursal (%)**, ej. `6.625`. Se cobra en los productos
  que tienen **Cobra impuesto** prendido (Menú → producto; viene prendido
  en todos). Un producto puede llevar **tasa propia** o quedar exento.
- **Recargo por forma de pago (%)**, ej. `3` en Tarjeta en línea. Se suma
  sobre subtotal + impuesto. En blanco = sin recargo. Máximo 10%.

El cliente ve el desglose (subtotal, impuesto, recargo) y paga **un solo
total**, que también va en el botón ("Hacer pedido · $9.33"). Al elegir la
forma de pago ve "+3%" junto a la que lleva recargo. El total lo calcula la
base al crear el pedido (migración 0030); Stripe y PayPal cobran ese total.

Mientras el impuesto esté en 0, no se cobra impuesto. Confirma con quien
lleve la contabilidad de Viva la tasa y qué productos están exentos, y si
aplica algún aviso legal por el recargo con tarjeta.

---

## Zelle

1. Panel → Negocio → Formas de pago → prende **Aceptar Zelle**.
2. Escribe el **correo o teléfono registrado en Zelle** del negocio y,
   opcional, el nombre que verá el cliente en su banco.
3. **Guardar cambios**.

El cliente ve el correo/teléfono, el monto exacto y la nota "Order #N",
cada uno con botón **Copiar**. El pedido queda **Pago por confirmar**:
revisa en la app del banco que llegó y toca **Pago recibido** en Pedidos.

---

## Antes de Stripe, PayPal o de crear cuentas del equipo (una sola vez): publicar las funciones

1. Supabase → tu foto (arriba a la derecha) → **Account preferences** →
   **Access Tokens** → **Generate new token**. Nombre: `github-funciones`.
   Si deja elegir permisos, solo **Edge Functions**. Copia el token.
2. GitHub → repo `vivajuicebarweb` → **Settings** → **Secrets and
   variables** → **Actions** → **New repository secret**. Name:
   `SUPABASE_ACCESS_TOKEN`, Secret: el token → **Add secret**.
3. GitHub → **Actions** → **Funciones de pago (Supabase)** → **Run
   workflow** → **Run workflow**. Publica las de pagos y `equipo` (crear
   cuentas desde el panel; no necesita ningún secreto extra). Al terminar, el log muestra las dos URL
   de webhook (las vas a necesitar abajo):
   - `https://<ref>.supabase.co/functions/v1/stripe-webhook`
   - `https://<ref>.supabase.co/functions/v1/paypal-webhook`

---

## Stripe (tarjeta en línea)

Primero en **modo de prueba** (no se mueve dinero), luego en vivo.

1. dashboard.stripe.com → arriba, activa **Test mode** (o "Sandbox").
2. **Developers** → **API keys** → en **Secret key**, **Reveal** → copia
   (`sk_test_…`).
3. **Developers** → **Webhooks** → **Add endpoint** (o "Add destination"):
   - Endpoint URL: `https://<ref>.supabase.co/functions/v1/stripe-webhook`
   - Events: `checkout.session.completed`,
     `checkout.session.async_payment_succeeded`,
     `checkout.session.async_payment_failed`, `charge.refunded`
   - **Add endpoint**. En la página del endpoint, **Signing secret** →
     **Reveal** → copia (`whsec_…`).
4. Supabase → **Edge Functions** → **Secrets** → **Add new secret** dos
   veces:
   - `STRIPE_SECRET_KEY` = `sk_test_…`
   - `STRIPE_WEBHOOK_SECRET` = `whsec_…`
5. Panel → Negocio → Formas de pago → en Stripe, **Probar conexión**. Debe
   decir "Conectado en modo PRUEBA". Prende **Aceptar tarjeta en línea** →
   **Guardar cambios**.
6. Prueba: haz un pedido con "Tarjeta en línea" y paga con la tarjeta
   `4242 4242 4242 4242`, cualquier fecha futura, cualquier CVC y ZIP. Debe
   volver a la app con **Pago recibido**.

**Para cobrar de verdad:** repite los pasos 2–4 con **Test mode apagado**
(llave `sk_live_…`, un endpoint de webhook nuevo en vivo y su `whsec_…`),
reemplaza los dos secretos en Supabase y vuelve a tocar **Probar
conexión**: ya no debe decir "PRUEBA".

---

## PayPal

1. developer.paypal.com → **Log in** con la cuenta PayPal Business del
   negocio → **Apps & Credentials** → arriba, **Sandbox** → **Create
   App** → nombre `VIVA app` → **Create App**.
2. Copia **Client ID** y **Secret** (botón **Show**).
3. En la misma app, abajo, **Webhooks** → **Add Webhook**:
   - Webhook URL: `https://<ref>.supabase.co/functions/v1/paypal-webhook`
   - Events: `Checkout order approved`, `Payment capture completed`,
     `Payment capture denied`, `Payment capture refunded`,
     `Payment capture reversed` → **Save**.
4. Supabase → **Edge Functions** → **Secrets**:
   - `PAYPAL_CLIENT_ID` = Client ID
   - `PAYPAL_CLIENT_SECRET` = Secret
5. Panel → Negocio → Formas de pago → en PayPal, **Probar conexión** →
   "Conectado en modo PRUEBA" (las llaves de sandbox solo sirven en
   sandbox; así se detecta). Prende **Aceptar PayPal** → **Guardar
   cambios**.
6. Prueba con una cuenta de comprador de prueba (developer.paypal.com →
   **Testing Tools** → **Sandbox Accounts** → la "Personal").

**Para cobrar de verdad:** en Apps & Credentials cambia arriba a **Live**,
crea la app y su webhook, reemplaza los dos secretos en Supabase y toca
**Probar conexión**.

---

## Si algo no cuadra

- "Probar conexión" dice que faltan las llaves: revisa los nombres exactos
  de los secretos en Supabase (mayúsculas, sin espacios).
- Dice que no se pudo probar: falta publicar las funciones (Actions →
  Funciones de pago).
- Un pago aparece en Stripe/PayPal pero el pedido sigue pendiente: en
  Supabase → Edge Functions → la función → **Logs**; el webhook dice por qué
  no lo marcó (`monto_insuficiente`, `moneda_distinta`…). El cajero siempre
  puede tocar **Pago recibido** a mano.
- Devoluciones: hazlas en Stripe o PayPal. Una devolución total desmarca el
  pago del pedido sola.
