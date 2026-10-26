# VIVA Juice and Coffee — Panel del negocio

App web para pedir y recoger en **VIVA Juice and Coffee** (31 South St,
Freehold, NJ). Sin Clover: el menú, los precios y los pedidos viven en
Supabase y los maneja el dueño desde `/admin`, dentro de la misma app.

| | |
|---|---|
| Moneda | USD (`app.json` → `extra.currency`) |
| Idioma del cliente | Inglés o español, a elección (Inicio: botón ES/EN; Perfil: Idioma). La primera vez se toma el idioma del teléfono. `?lang=es` en la liga lo fuerza. |
| Idioma del panel | Español |
| Zona horaria | America/New_York |
| Alta y menú base | `supabase/seed/viva_juice_us.sql` (va dentro de `entregas/01-base-viva-juice.sql`) |

## Quién puede qué

| | Cliente | Cajero (`staff`) | Dueño (`owner`) |
|---|---|---|---|
| Ver el menú y pedir | ✔ | ✔ | ✔ |
| Ver y mover pedidos, cancelar con motivo | — | ✔ | ✔ |
| Marcar "Pago recibido" | — | ✔ | ✔ |
| Validar canjes de puntos | — | ✔ | ✔ |
| Menú, precios, fotos, agotados, historias | — | — | ✔ |
| Horario, pausar pedidos, marca, formas de pago, equipo | — | — | ✔ |

Lo decide la base con RLS y funciones `SECURITY DEFINER`, no la app. Nadie
se vuelve dueño desde la app: registrarse crea una cuenta de **cliente**.
El primer dueño se da de alta una vez desde el SQL Editor (ver
[PUESTA-EN-MARCHA.md](PUESTA-EN-MARCHA.md)); después, el dueño da y quita
acceso desde **Negocio → Equipo**. Nadie se quita a sí mismo y siempre
queda al menos un dueño.

## Las pestañas

- **Pedidos**: Nuevos, En preparación y Listos para entregar. Se actualiza
  cada 15 s y suena cuando entra uno (hay que haber tocado la página una
  vez; los navegadores no dejan sonar sin eso). Cancelar pide motivo.
  Los pedidos de Zelle, Stripe y PayPal muestran **Pago por confirmar** o
  **Pago en línea pendiente** hasta que llega el pago; el cajero puede
  tocar **Pago recibido** (Zelle siempre se confirma así).
- **Menú**: categorías y productos con nombre y descripción en inglés y en
  español (si falta el español, se muestra el inglés), precio en dólares,
  foto, destacado y el interruptor de agotado.
- **Historias**: foto o video (hasta 50 MB) que sale arriba en Inicio, como
  Instagram. Duran 24 h, 3 días, 7 días o quedan destacadas. Se pueden
  ligar a un producto (botón **Pedir**). Texto en inglés y en español. Al
  abrir la app salen solas una vez por visita, primero las no vistas.
- **Estadísticas**: ventas, pedidos, ticket promedio, clientes, ventas por
  día, lo más vendido, lo más consultado e historias más vistas (7, 30 o 90
  días). Las vistas se cuentan una vez por visitante al día.
- **Lealtad**: puntos por visita con el QR del local (fijo para imprimir o
  en pantalla, cambia cada minuto), horas mínimas entre visitas,
  recompensas y validación de canjes (código de 6 letras).
- **Negocio**: sucursal, horario, pausar pedidos, marca y colores, equipo
  y **formas de pago** (ver [PAGOS.md](PAGOS.md)).

## "Arma tu jugo / licuado / bowl"

Productos con grupos de opciones obligatorias ("Elige 3 frutas o
verduras"). Ninguna opción viene marcada: el cliente elige, puede cambiar
de opinión, y la app no deja agregar hasta completar el número. La leche sí
viene preseleccionada (la regular, sin recargo). Los grupos y opciones se
cargan desde el seed; crear grupos nuevos desde el panel todavía no está.

## Lo que todavía no está

- Editar grupos de opciones (extras) desde el panel.
- Promociones y descuentos.
- Notificaciones push en la web: el cliente sigue su pedido en Pedidos.
