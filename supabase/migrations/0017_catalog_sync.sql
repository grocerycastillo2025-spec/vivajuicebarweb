-- =====================================================================
-- 0017_catalog_sync.sql
-- Lo que el esquema le debe a la sincronizacion de catalogo.
--
-- El espejo de la 0002 ya tenia casi todo. Falta lo que aparece cuando se
-- mira el catalogo REAL de un merchant en vez del seed:
--
--   1. `price_type` deja de ser siempre FIXED, y un VARIABLE trae
--      price = 0. Sin una regla, la app enseña un producto a $0.00 y deja
--      pedirlo;
--   2. el impuesto de un item necesita distinguir EXENTO de NO LO SABEMOS.
--      En la base los dos se ven igual —cero filas de enlace— y llevan a
--      acciones opuestas;
--   3. dos barridos simultaneos sobre la misma tienda se pisan los upserts.
--
-- El mapeo entero, con el porque de cada regla, esta en
-- docs/SINCRONIZACION-CATALOGO.md. Este archivo es solo el esquema.
--
-- MIGRACION NUEVA. Las 0001 a 0016 estan aplicadas a la base viva y no
-- se tocan.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. LAS COLUMNAS NUEVAS DE `catalog_items`
-- ---------------------------------------------------------------------
alter table public.catalog_items
  -- El booleano de Clover: si el item usa las tasas POR DEFECTO del
  -- merchant en vez de unas propias. Sin el no se puede reconstruir que
  -- impuesto aplica: cero enlaces significa "exento" solo cuando esto es
  -- false. `null` = nunca se ha leido.
  add column default_tax_rates boolean,

  -- Cuando se resolvio por ultima vez la configuracion de impuesto de
  -- este item. ESTA COLUMNA EXISTE PARA DISTINGUIR DOS COSAS QUE SE VEN
  -- IGUAL:
  --
  --   exento         -> default_tax_rates = false, cero enlaces,
  --                     tax_synced_at PUESTO
  --   sin resolver   -> cero enlaces y tax_synced_at NULL
  --
  -- La expansion `taxRates` puede no llegar (Clover la omite, la
  -- respuesta se recorta, el sandbox se atraganta). Escribir cero enlaces
  -- en ese caso seria declarar exento un producto que quiza paga
  -- impuesto, y nadie lo notaria hasta cuadrar caja.
  add column tax_synced_at timestamptz;

comment on column public.catalog_items.default_tax_rates is
  'Clover `item.defaultTaxRates`: el item usa las tasas por defecto del '
  'merchant (las de catalog_tax_rates con is_default) en vez de enlaces '
  'propios. null = nunca se ha leido de Clover.';

comment on column public.catalog_items.tax_synced_at is
  'Cuando se resolvio la configuracion de impuesto de este item. null = '
  'nunca. Cero filas en catalog_item_tax_rates significa EXENTO solo si '
  'esto NO es null; con null significa que no lo sabemos, que es otra '
  'cosa y pide otra accion. Ver docs/SINCRONIZACION-CATALOGO.md.';


-- ---------------------------------------------------------------------
-- 2. `price_type` ES UN ENUM DE TRES, NO UN TEXTO LIBRE
--
-- Clover admite FIXED, VARIABLE y PER_UNIT. La columna se creo como
-- `text default 'FIXED'` sin restriccion, y mientras solo hubo seed eso
-- no importaba: todas las filas decian FIXED.
--
-- Un `check` y no un `enum` de Postgres a proposito: si Clover añade un
-- cuarto tipo, un check se amplia con un `alter ... drop constraint` y
-- otro `add constraint` en una migracion nueva, mientras que un tipo
-- enum arrastra dependencias de columnas y vistas.
--
-- QUE PASA SI CLOVER MANDA UN CUARTO TIPO: el mapeo lo detecta antes de
-- escribir y el item se ignora con motivo `price_type_desconocido`, que
-- sale en el reporte. No se escribe para que el `check` lo rechace: un
-- barrido no se aborta entero por un item raro.
-- ---------------------------------------------------------------------
alter table public.catalog_items
  add constraint catalog_items_price_type_conocido
    check (price_type in ('FIXED', 'VARIABLE', 'PER_UNIT'));

comment on column public.catalog_items.price_type is
  'FIXED = el precio del item es el precio. VARIABLE = lo teclea el '
  'cajero al vender. PER_UNIT = por unidad de medida, se pesa en caja. '
  'Solo FIXED se puede pedir desde la app: los otros dos llegan con '
  'price = 0 o con un precio que no es el que se cobra.';


-- ---------------------------------------------------------------------
-- 3. UN BARRIDO A LA VEZ POR SUCURSAL
--
-- Mismo mecanismo que el arriendo del refresco (0013) y por la misma
-- razon que alli se explica con detalle: `pg_advisory_lock` es de SESION
-- y el pooler de Supabase en modo transaccion recicla la sesion, asi que
-- el cerrojo se queda cogido en una sesion que ya no es tuya.
--
-- Aqui el daño de no tenerlo es distinto y mas silencioso que en el
-- refresco: dos barridos simultaneos no matan nada —los upserts son
-- idempotentes— pero los dos REPORTES mienten. Cada uno ve como "sin
-- cambios" lo que acaba de escribir el otro, y el reporte es justo lo
-- que se lee para validar el mapeo.
-- ---------------------------------------------------------------------
alter table public.clover_connections
  add column catalog_sweep_lease_until timestamptz;

comment on column public.clover_connections.catalog_sweep_lease_until is
  'Arriendo del barrido de catalogo: mientras este en el futuro, ninguna '
  'otra ejecucion barre esta sucursal. Independiente de '
  'refresh_lease_until: el refresco de tokens y el barrido no compiten '
  'por nada y bloquearse mutuamente solo pararia el refresco justo '
  'cuando mas trabajo hay.';

-- Tomar el arriendo. Devuelve la fila si se consiguio, cero filas si ya
-- lo tiene otro. UN SOLO STATEMENT, igual que el claim de la 0013:
-- comprobar y reservar en dos pasos deja sitio entre medias para la otra
-- ejecucion.
create or replace function app.claim_catalog_sweep(
  p_store_id      uuid,
  p_lease_seconds int
)
returns table (
  connection_id uuid,
  store_id      uuid,
  merchant_id   text,
  environment   text
)
language sql
as $$
  update public.clover_connections c
     set catalog_sweep_lease_until = now() + make_interval(secs => p_lease_seconds)
   where c.id = (
     select d.id
       from public.clover_connections d
      where d.store_id = p_store_id
        -- Sin merchant no hay a quien preguntarle el catalogo, y sin
        -- token de acceso no se puede preguntar.
        and d.merchant_id is not null
        and d.access_token_secret_id is not null
        and (d.catalog_sweep_lease_until is null or d.catalog_sweep_lease_until <= now())
      for update skip locked
   )
  returning c.id, c.store_id, c.merchant_id, c.environment;
$$;

comment on function app.claim_catalog_sweep(uuid, int) is
  'Reserva una sucursal para un barrido de catalogo y devuelve con que '
  'merchant hablar. Cero filas = ya hay un barrido en marcha, o la '
  'sucursal no esta conectada. No devuelve ningun token: solo el id del '
  'secreto lo sabe quien lee la fila entera.';

create or replace function app.release_catalog_sweep(p_connection_id uuid)
returns void
language sql
as $$
  update public.clover_connections
     set catalog_sweep_lease_until = null
   where id = p_connection_id;
$$;

revoke execute on function app.claim_catalog_sweep(uuid, int) from public;
revoke execute on function app.release_catalog_sweep(uuid) from public;


-- ---------------------------------------------------------------------
-- 4. EL RASTRO DE CADA BARRIDO
--
-- El reporte es lo que se lee para validar el mapeo, y un reporte que
-- solo existe en la respuesta de un `curl` se pierde al cerrar la
-- terminal. Aqui queda consultable, y ademas se puede comparar el barrido
-- de hoy con el de ayer, que es como se ve si algo dejo de mapearse.
--
-- Vive en `app` y no en `public`: no es un dato del negocio, no lo lee la
-- app movil y no tiene que salir en los tipos generados.
--
-- `jsonb` y no veinte columnas porque la forma del reporte va a cambiar
-- en los PR siguientes (webhooks, purgado) y una tabla de auditoria que
-- obligue a una migracion por cada campo nuevo acaba sin campos nuevos.
-- ---------------------------------------------------------------------
create table app.catalog_sync_runs (
  id            uuid primary key default gen_random_uuid(),
  store_id      uuid not null references public.stores(id) on delete cascade,
  merchant_id   text,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  -- false = alguna pagina fallo. Un barrido incompleto NO sirve para
  -- decidir borrados: "no vino" y "fallo la peticion" se ven igual.
  complete      boolean not null default false,
  report        jsonb   not null default '{}'::jsonb
);

create index idx_catalog_sync_runs_store
  on app.catalog_sync_runs (store_id, started_at desc);

comment on table app.catalog_sync_runs is
  'Un reporte por barrido de catalogo: que se creo, que se actualizo, que '
  'se ignoro y por que. `complete` en false significa que alguna pagina '
  'fallo, y entonces el reporte no sirve para decidir que falta en '
  'Clover. Ver docs/SINCRONIZACION-CATALOGO.md.';

revoke all on table app.catalog_sync_runs from public;


-- ---------------------------------------------------------------------
-- 5. QUE IMPUESTO APLICA A UN ITEM, RESUELTO EN UN SOLO SITIO
--
-- El modelo de Clover tiene dos piezas y hay que cruzarlas:
--
--   enlaces explicitos  -> catalog_item_tax_rates
--   default_tax_rates   -> las tasas del merchant con is_default
--
-- Se resuelve en LECTURA y no materializando los defaults en la tabla de
-- enlace. Materializarlos duplicaria el dato y crearia la pregunta de que
-- hacer cuando el merchant cambie su tasa por defecto: habria que
-- reescribir N filas por un cambio que ya esta en una.
--
-- `origen` no es decoracion: es lo que permite mirar una fila y saber si
-- ese impuesto se lo puso el merchant al producto o le cae por defecto.
--
-- CLOVER-PENDING: falta confirmar contra el sandbox si Clover devuelve
-- las tasas por defecto DENTRO de la expansion `taxRates` cuando
-- `defaultTaxRates = true`. Si lo hace, un item saldria aqui dos veces
-- (una por cada rama) y hay que quitar la rama de defaults. El reporte
-- del barrido trae `items_default_con_enlaces` para contestarlo con el
-- primer barrido real: si esa lista viene vacia, las ramas no se solapan.
-- ---------------------------------------------------------------------
create or replace view public.catalog_item_tax_effective as
-- Rama 1: lo que el merchant enlazo al producto.
select
  i.store_id,
  i.id                 as item_id,
  i.clover_item_id,
  t.id                 as tax_rate_id,
  t.clover_tax_rate_id,
  t.name               as tax_rate_name,
  t.rate,
  'explicito'::text    as origen
from public.catalog_items i
join public.catalog_item_tax_rates l on l.item_id = i.id
join public.catalog_tax_rates t      on t.id = l.tax_rate_id
where i.deleted_at is null
  and t.deleted_at is null

union all

-- Rama 2: lo que le cae por defecto. Solo para items que lo dicen
-- explicitamente y que NO tienen enlaces propios.
select
  i.store_id,
  i.id,
  i.clover_item_id,
  t.id,
  t.clover_tax_rate_id,
  t.name,
  t.rate,
  'por_defecto'::text
from public.catalog_items i
join public.catalog_tax_rates t
  on t.store_id = i.store_id
 and t.is_default
 and t.deleted_at is null
where i.deleted_at is null
  and i.default_tax_rates is true
  and not exists (select 1 from public.catalog_item_tax_rates l where l.item_id = i.id);

alter view public.catalog_item_tax_effective set (security_invoker = on);

comment on view public.catalog_item_tax_effective is
  'Que tasas de impuesto aplican a cada item, cruzando los enlaces '
  'explicitos con las tasas por defecto del merchant. Un item SIN filas '
  'aqui y con tax_synced_at puesto esta EXENTO; sin filas y con '
  'tax_synced_at null, no lo sabemos. NADIE DEBE DERIVAR DE AQUI UN '
  'TOTAL DE CARA AL CLIENTE: el impuesto lo calcula Clover al crear la '
  'orden, y la app enseña subtotal hasta entonces.';

-- En Supabase una vista nueva NACE CONCEDIDA a anon y authenticated por
-- los default privileges del rol que aplica migraciones: no basta con no
-- escribir el grant. Esto no es dato de la app movil —el impuesto lo
-- calcula Clover al confirmar— asi que se cierra.
revoke all on public.catalog_item_tax_effective from anon, authenticated;


-- ---------------------------------------------------------------------
-- 6. LA VISTA DEL MENU: LO UNICO QUE ESTE PR CAMBIA PARA LA APP
--
-- Antes de esta migracion `price_type` era siempre FIXED, porque lo unico
-- que habia en la tabla era el seed. En cuanto entra el catalogo real
-- pueden aparecer VARIABLE (precio tecleado en caja) y PER_UNIT (por
-- peso), y los dos llegan con `price` a 0 o con un precio que no es el
-- que se cobra.
--
-- Sin esta linea, la app enseñaria un producto a $0.00 y dejaria pedirlo.
-- No es un riesgo teorico: es la consecuencia directa de empezar a
-- sincronizar.
--
-- `create or replace view` deja cambiar las EXPRESIONES y añadir columnas
-- al final; no deja renombrar, reordenar ni quitar. Por eso `price_type`
-- y `unorderable_reason` van detras aunque encajarian mejor arriba. Misma
-- nota que dejaron la 0012 y la 0016, y sigue valiendo.
--
-- La app pide columnas por nombre (`MENU_COLUMNS` en api/menu.ts), asi
-- que añadir al final no rompe nada: las nuevas no se piden hasta que
-- alguien las pida.
-- ---------------------------------------------------------------------
create or replace view public.menu_items as
select
  i.id,
  i.store_id,
  i.clover_item_id,
  i.name,
  coalesce(o.marketing_copy, i.alternate_name) as description,
  i.price_cents,
  c.id            as category_id,
  c.name          as category_name,
  c.sort_order    as category_sort,
  o.image_url,
  coalesce(o.featured, false)   as featured,
  coalesce(o.sort_order, 0)     as sort_order,
  o.badge,
  (
    i.available
    and not i.hidden
    -- LA LINEA NUEVA. Un precio que no es el precio no se puede pedir.
    and i.price_type = 'FIXED'
    and coalesce(o.app_visible, true)
    and (o.unavailable_until is null or o.unavailable_until < now())
  ) as is_available,
  o.unavailable_reason,
  -- Desde aqui, columnas nuevas de la 0017.
  i.price_type,
  -- Por que no se puede pedir, cuando el motivo es el TIPO DE PRECIO y no
  -- la disponibilidad. Se separa de `unavailable_reason` (que es del 86
  -- manual del operador) porque son dos cosas distintas: una se arregla
  -- esperando y la otra no se arregla nunca desde la app.
  case i.price_type
    when 'FIXED'    then null
    when 'VARIABLE' then 'El precio de este producto se fija en el mostrador.'
    when 'PER_UNIT' then 'Este producto se vende por peso y se pesa en el mostrador.'
    else 'Este producto no se puede pedir desde la app.'
  end as unorderable_reason
from public.catalog_items i
left join public.catalog_categories c on c.id = i.category_id and c.deleted_at is null
left join public.app_item_overrides o
       on o.store_id = i.store_id and o.clover_item_id = i.clover_item_id
where i.deleted_at is null;

alter view public.menu_items set (security_invoker = on);

comment on view public.menu_items is
  'El menu que consume la app: el espejo de Clover mas los overrides de '
  'merchandising. Ninguna columna tiene dos dueños — la vista elige entre '
  'columnas distintas, no resuelve conflictos. is_available exige '
  'price_type = FIXED: un VARIABLE trae price = 0 y dejarlo pedible seria '
  'vender aire.';

-- `create or replace view` DESCARTA los grants? No: los conserva. Pero el
-- security_invoker de arriba si se pierde al reemplazar (medido en
-- Postgres 16, es la razon de ser de 0007_view_security.sql), y por eso
-- se vuelve a poner. Los grants de la 0004 sobre menu_items siguen en pie
-- y no se tocan aqui: quitarlos seria arreglar otra cosa de paso.


-- ---------------------------------------------------------------------
-- 7. LO QUE ESTE PR NO CAMBIA, Y CONVIENE QUE ESTE ESCRITO
--
-- `hidden` SIGUE SALIENDO EN EL MENU, atenuado. Un item oculto en el POS
-- probablemente no deberia ni listarse en la app —el merchant lo saco de
-- su propia caja, no es que se haya agotado— pero eso NO se confirmo
-- contra el catalogo real: el entorno donde se escribio esto no tiene
-- credenciales de Clover.
--
-- CLOVER-PENDING: mirar `avisos.items_ocultos` del primer barrido real
-- contra el Test Merchant RGW5JAVFT8MB1. Si son productos retirados, esta
-- vista pasa a filtrarlos con un `where not i.hidden`. Si son productos
-- que el merchant vende fuera de caja, listarlos atenuados ya era lo
-- correcto y no hay nada que cambiar. Un `where` puesto por suposicion
-- haria desaparecer productos del menu sin que nadie sepa por que.
-- ---------------------------------------------------------------------
