# VIVA Juice and Coffee — Panel del negocio

App web para pedir y recoger en **VIVA Juice and Coffee** (31 South St,
Freehold, NJ). Sin Clover: el menú, los precios y los pedidos viven en
Supabase y los maneja el dueño desde `/admin`, dentro de la misma app.

| | |
|---|---|
| Moneda | USD (`app.json` → `extra.currency`) |
| Idioma del cliente | Inglés o español, a elección (Inicio: botón ES/EN; Perfil: Idioma). La primera vez se toma el idioma del teléfono. `?lang=es` en la liga lo fuerza. |
| Idioma del panel | Español o inglés: botón ES/EN arriba a la derecha del panel (se recuerda en ese navegador) |
| Zona horaria | America/New_York |
| Alta y menú base | `supabase/seed/viva_juice_us.sql` (va dentro de `entregas/01-base-viva-juice.sql`) |

## Quién puede qué

| | Cliente | Tienda (`staff`) | Dueño (`owner`) |
|---|---|---|---|
| Ver el menú y pedir | ✔ | ✔ | ✔ |
| Ver y mover pedidos, cancelar con motivo | — | ✔ | ✔ |
| Marcar "Pago recibido" | — | ✔ | ✔ |
| Escanear la tarjeta del cliente, sumar visita, entregar recompensa | — | ✔ | ✔ |
| Agotar / encender productos y opciones | — | ✔ | ✔ |
| Pausar / reanudar los pedidos de la app | — | ✔ | ✔ |
| Menú, precios, fotos, historias | — | — | ✔ |
| Horario, marca, impuestos, formas de pago, equipo, estadísticas | — | — | ✔ |

Lo decide la base con RLS y funciones `SECURITY DEFINER`, no la app. Nadie
se vuelve dueño desde la app: registrarse crea una cuenta de **cliente**.
El primer dueño se da de alta una vez desde el SQL Editor (ver
[PUESTA-EN-MARCHA.md](PUESTA-EN-MARCHA.md)); después, el dueño da y quita
acceso desde **Negocio → Equipo** (elige **Tienda** para quien atiende el
mostrador). Nadie se quita a sí mismo y siempre
queda al menos un dueño.

## Las pestañas

- **Pedidos**: Nuevos, En preparación y Listos para entregar. Se actualiza
  cada 15 s y suena cuando entra uno (hay que haber tocado la página una
  vez; los navegadores no dejan sonar sin eso). Cancelar pide motivo.
  Los pedidos de Zelle, Stripe y PayPal muestran **Pago por confirmar** o
  **Pago en línea pendiente** hasta que llega el pago; el cajero puede
  tocar **Pago recibido** (Zelle siempre se confirma así).
- **Tienda** (dueño y Tienda): el día a día del mostrador. Arriba, un
  cuadro grande verde **Recibiendo pedidos** / rojo **Pedidos en pausa**
  con su botón (pausar pide confirmación). Abajo, todos los productos y
  opciones (leches, frutas, extras) con su interruptor
  **Disponible / Agotado** y un buscador. Al lado, **Últimos cambios**:
  quién agotó, encendió o pausó y cuándo. El cliente ve el aviso de pausa
  en Inicio, Menú y al pagar (no deja hacer el pedido), y los agotados
  en gris.
- **Menú**: categorías y productos con nombre y descripción en inglés y en
  español (si falta el español, se muestra el inglés), precio en dólares,
  foto, destacado y el interruptor de agotado.
- **Historias**: foto o video (hasta 50 MB) que sale arriba en Inicio, como
  Instagram. Duran 24 h, 3 días, 7 días o quedan destacadas. Se pueden
  ligar a un producto (botón **Pedir**). Texto en inglés y en español. Al
  abrir la app salen solas una vez por visita, primero las no vistas.
- **Estadísticas** (Hoy, 7, 30 o 90 días): arriba, **En resumen** en
  frases (cuánto vendiste y si subió o bajó, tu mejor día, la hora pico, lo
  que más se vende, clientes nuevos y los que regresaron). Luego Ventas,
  Pedidos, Ticket promedio y Clientes con flecha ▲▼ contra el periodo
  anterior; ventas por día con línea de promedio (en "Hoy", pedidos por
  hora); **¿Cuándo te piden?** (mapa de calor día × hora); lo más vendido;
  **¿Cómo pagan?**; clientes nuevos vs. que regresan; visitas y recompensas
  entregadas; e interés en la app (productos vistos, historias). Las
  vistas se cuentan una vez por visitante al día.
- **Lealtad**: el cliente tiene su **tarjeta** en la app (Puntos → Mi
  tarjeta: un QR y un código tipo `ABCDE-23456`). En el mostrador, la
  tienda toca **Escanear tarjeta** (o escribe el código, o lo escanea con
  la cámara del teléfono) y ve el nombre, los puntos y cuánto le falta para
  cada recompensa. **Sumar visita** (una cada X horas). Cuando ya le
  alcanza, sale **"¡Fulano ya tiene su recompensa!"**: se la das y tocas
  **Entregar** → se le descuentan esos puntos (su conteo vuelve a empezar)
  y queda en **Recompensas entregadas** con quién la dio y cuándo. El
  cliente también lo ve en su app.
  - Para reconocerlo, la ficha muestra su **foto** y los **últimos 4
    dígitos de su teléfono** (los pone el cliente en Perfil → Editar
    perfil; la app se lo sugiere bajo su tarjeta). La foto está en un
    bucket privado: solo la ven el cliente y quien trabaja en el negocio.
  - Puedes tener **varias recompensas activas** a la vez (ej. 10 pts =
    shot, 30 pts = jugo), cada una con nombre en español e inglés.
  - El QR fijo del local (el cliente escanea) queda apagado; se prende en
    Programa de puntos → "El cliente también puede escanear el QR del
    local".
  - Los códigos de canje de 6 letras de antes se siguen validando abajo.
- **Negocio**: **QR de la app** (Imprimir cartel tamaño carta con tu logo
  y texto en inglés y español, Descargar QR, Copiar liga), sucursal (con
  **Ubicación en el mapa**: arrastra el pin o toca el mapa hasta la puerta;
  "Buscar la dirección" o "Usar mi ubicación" si estás en el local; es a
  donde lleva "Cómo llegar" al cliente), horario, pausar pedidos, marca y colores, equipo,
  **impuestos y recargos** y **formas de pago** (ver [PAGOS.md](PAGOS.md)).
  En cada producto (Menú) se elige si cobra impuesto y, opcional, su tasa
  propia.

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
