-- =====================================================================
-- 0011_recargo.sql
-- Que hace la app cuando el merchant cobra recargo por tarjeta.
--
-- EL PROBLEMA
-- Clover permite que un merchant aplique un RECARGO por tarjeta de
-- credito. Se lee en `GET /v3/merchants/{mId}/ecomm_payment_configs`
-- (`surcharging.supported` y su `rate`). Si esta activo, al cliente se le
-- cobra MAS de lo que le enseño la app.
--
-- Eso no es un ajuste de configuracion: es una diferencia entre el precio
-- anunciado y el cobrado, y en bastantes sitios eso tiene nombre legal.
--
-- POR QUE ES CONFIGURABLE Y NO UNA DECISION EN CODIGO
-- Porque la respuesta correcta depende del restaurante y puede cambiar sin
-- que nosotros toquemos nada. Un local puede decidir absorberlo manana. Si
-- eso viviera en una constante, cambiarlo seria recompilar y publicar.
--
-- LO QUE NO ES CONFIGURABLE
-- El AVISO. Que el super admin vea "esta sucursal tiene recargo del 3,5 %"
-- sale siempre, con cualquiera de las tres politicas. Es informacion para
-- decidir antes de firmar, no una alerta que se pueda silenciar. Por eso
-- el aviso vive en el codigo del checklist y no en una columna: no hay
-- ningun valor que se pueda poner aqui para apagarlo.
--
-- POR DEFECTO SE MUESTRA
-- Es lo mas seguro legalmente: el cliente ve lo que va a pagar antes de
-- pagarlo. Absorberlo es una decision comercial que el restaurante toma a
-- sabiendas, y bloquear es para cuando no se quiere abrir esa sucursal.
--
-- MIGRACION NUEVA, NO EDITAR LAS APLICADAS
-- Las 0001 a 0010 estan corriendo en la base de Marco.
-- =====================================================================

-- Enum en `app.`, como el resto (`app.store_status`, `app.order_status`).
-- Un enum y no un texto libre: un valor mal escrito aqui decidiria mal en
-- silencio, y lo haria sobre el precio que ve el cliente.
create type app.surcharge_policy as enum (
  -- Mostrar el recargo al cliente antes de pagar. POR DEFECTO.
  'show',
  -- El restaurante lo absorbe: el cliente paga lo anunciado.
  -- OJO: esto NO desactiva el recargo en Clover. Solo dice que el
  -- restaurante asume la diferencia. Si Clover lo sigue cobrando, la
  -- diferencia sale de su margen, no del bolsillo del cliente.
  'absorb',
  -- No activar la sucursal mientras tenga recargo.
  'block'
);

alter table public.stores
  add column surcharge_policy app.surcharge_policy not null default 'show',

  -- Lo ULTIMO que vimos en Clover, no lo que alguien tecleo. Se refresca
  -- en el alta y en cada reconciliacion. `null` = todavia no se ha
  -- consultado, que NO es lo mismo que "no hay recargo": por eso es
  -- nullable y no un 0.
  add column surcharge_rate numeric(6, 5),

  -- Cuando se leyo. Un `surcharge_rate` de hace tres meses no vale para
  -- decidir: el merchant pudo activarlo la semana pasada.
  add column surcharge_checked_at timestamptz;

-- La tasa es una FRACCION (0.035 = 3,5 %), igual que la devuelve Clover.
-- No se convierte a milesimas para no acabar con dos escalas distintas en
-- la misma base: `catalog_tax_rates.rate` ya usa milesimas de porcentaje,
-- y mezclarlas da un cobro cien veces mayor. Cada columna conserva la
-- unidad de su origen y el nombre dice cual es.
alter table public.stores
  add constraint stores_surcharge_rate_fraccion
    check (surcharge_rate is null or (surcharge_rate >= 0 and surcharge_rate < 1));

comment on column public.stores.surcharge_policy is
  'Que hacer si el merchant cobra recargo por tarjeta: mostrarlo (por '
  'defecto), que el restaurante lo absorba, o no activar la sucursal. El '
  'aviso al super admin sale siempre, con cualquiera de los tres.';

comment on column public.stores.surcharge_rate is
  'Recargo por tarjeta leido de Clover (ecomm_payment_configs), como '
  'FRACCION: 0.035 = 3,5 %. Distinto de catalog_tax_rates.rate, que va en '
  'milesimas de porcentaje. null = sin consultar todavia, que no es lo '
  'mismo que sin recargo.';

comment on column public.stores.surcharge_checked_at is
  'Cuando se leyo surcharge_rate. Un valor viejo no sirve para decidir.';

-- ---------------------------------------------------------------------
-- EL CHECKLIST DE ONBOARDING GANA UNA CASILLA
--
-- `setup_checklist` tiene default para las filas nuevas, pero las que ya
-- existen se quedaron con el objeto viejo. Sin esto, una sucursal creada
-- antes de hoy no tendria la casilla y el SaaS la pintaria como si no
-- hiciera falta.
--
-- `||` sobrescribe la clave si existe, asi que se aplica al reves para no
-- pisar el estado que ya tenga cualquier otra casilla.
--
-- CONSECUENCIA QUE HAY QUE SABER, Y QUE SALE GRATIS
-- `trg_stores_activation` (0001) cuenta CUALQUIER casilla en `false` y se
-- niega a activar la sucursal. Al anadir esta, el efecto es inmediato:
--
--   A PARTIR DE AQUI, NINGUNA SUCURSAL SE ACTIVA SIN QUE ALGUIEN HAYA
--   MIRADO EL RECARGO Y DECIDIDO QUE HACER CON EL.
--
-- No hace falta codigo nuevo para eso: el trigger ya existia y esta
-- casilla se suma a las que vigila. Probado.
--
-- Las sucursales que YA estan `active` no se tocan: el trigger salta en
-- `insert or update of status`, y esta migracion no cambia el status de
-- nadie. Nadie se queda sin servicio por esto.
-- ---------------------------------------------------------------------
update public.stores
   set setup_checklist = jsonb_build_object('surcharge_reviewed', false) || setup_checklist
 where not (setup_checklist ? 'surcharge_reviewed');

alter table public.stores
  alter column setup_checklist set default jsonb_build_object(
    'clover_connected',      false,
    'ecommerce_enabled',     false,
    'order_type_ready',      false,
    -- Renombrada de hecho, no de nombre: Viva usa KDS y no impresora, y
    -- lo que hay que verificar es QUE DISPOSITIVO recibe las ordenes.
    'order_printer_ready',   false,
    'catalog_synced',        false,
    'smoke_test_passed',     false,
    'not_using_dining',      false,
    -- Nueva: alguien miro el recargo y decidio que hacer con el.
    'surcharge_reviewed',    false
  );

-- Los grants de `stores` son de tabla, no de columna (0006_grants.sql), y
-- la policy `stores_public_read` devuelve la fila entera: las tres
-- columnas nuevas quedan visibles para la app sin tocar nada mas. Es lo
-- que se quiere: la app necesita `surcharge_policy` y `surcharge_rate`
-- para poder mostrar el recargo antes de pagar.
