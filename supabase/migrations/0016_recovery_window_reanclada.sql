-- =====================================================================
-- 0016_recovery_window_reanclada.sql
--
-- DOS COSAS, Y LAS DOS SOBRE LO MISMO: que la red de recuperacion siga
-- ahi cuando haga falta.
--
--   1. Se quita el trigger de la 0012. La regla que imponia resulto ser
--      falsa: la ventana SI se reancla al recuperar.
--   2. Se apunta cuando fue el ultimo refresco con exito, y se deriva de
--      ahi si una instalacion esta obsoleta. Sin esa marca, un worker
--      caido en silencio no se ve hasta que la ventana ya vencio.
--
-- MIGRACION NUEVA. Las 0001 a 0015 estan aplicadas a la base viva y no
-- se tocan.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. LA VENTANA SE REANCLA AL PAR NUEVO
--
-- La 0012 impuso con un trigger que la ventana de recuperacion NO se
-- moviera hacia adelante mientras el token de recuperacion fuera el
-- mismo. No era capricho: la documentacion publica admite dos lecturas
-- —"dos semanas desde que se genero el par actual" y "la cadena continua
-- hasta que un refresh se usa con exito"— y no se podian medir sin
-- perder un refresh a proposito y esperar dos semanas. Se eligio la
-- pesimista, que es la que se equivoca del lado barato, y se dejo escrito
-- que si algun dia se confirmaba lo contrario esto se quitaba con un
-- `drop trigger` en una migracion nueva. Esta es esa migracion.
--
-- LO QUE CONFIRMO CLOVER (Developer Relations, sobre el High-Trust App
-- Auth Flow):
--
--   - la ventana se ancla a la HORA DE CREACION de cada par nuevo
--     (access + refresh), venga del endpoint que venga;
--   - al recuperar con el refresh previo (token A) se genera el par C, la
--     ventana empieza de nuevo desde la creacion de C, A SIGUE SIENDO EL
--     TOKEN DE RECUPERACION DESIGNADO PARA C, y el token B queda
--     invalido;
--   - la ventana se cierra para siempre si pasan dos semanas sin generar
--     un par nuevo, o si un refresh token se usa con exito en el flujo
--     estandar.
--
-- O sea que de las dos reglas de la 0012, la del PUNTERO era correcta —y
-- sigue vigente, y sigue siendo lo contraintuitivo— y la de la VENTANA
-- era falsa.
--
-- CLOVER-PENDING: el tercer punto tiene una pregunta abierta con Clover.
-- "Si un refresh token se usa con exito en el flujo estandar" admite dos
-- lecturas: que se invalida ESE token como token de recuperacion (lo
-- normal, y lo que hace el resto del diseno), o que se cierra la ventana
-- entera de la conexion (que dejaria sin red a cualquier conexion sana en
-- cuanto el worker rota, que es cada cinco minutos). Nada de esta
-- migracion depende de la respuesta: el worker intenta la recuperacion
-- siempre y la autoridad es `X-Clover-Recovery-Available`.
--
-- QUE SE ROMPE AL QUITARLO: nada. El trigger solo rechazaba escrituras;
-- quitarlo no cambia ninguna fila ni relaja ningun permiso. Lo que si
-- cambia es el codigo del worker, que a partir de la 0016 escribe una
-- ventana nueva tambien al recuperar (ver workers/src/token-refresh/chain.ts).
--
-- UN COMENTARIO QUE SE QUEDA DESACTUALIZADO Y NO SE TOCA: el `claim` de
-- la 0013 avisa de que su `update` no menciona `recovery_token_expires_at`
-- "asi que no dispara el trigger de la 0012". El trigger ya no existe,
-- pero la 0013 esta aplicada a la base viva y no se edita. El consejo
-- sigue siendo bueno por otro motivo: reservar una fila no es emitir un
-- par, y no tiene por que mover ninguna ventana.
--
-- LAS FILAS QUE YA ESTAN NO SE TOCAN. Una conexion que hoy arrastre una
-- ventana vieja por haberse recuperado bajo la regla anterior se corrige
-- sola en su siguiente rotacion, que como mucho es dentro de cinco
-- minutos. Un `update` masivo inventaria margen sobre pares que quiza
-- nacieron hace dias, que es justo el error caro.
-- ---------------------------------------------------------------------
drop trigger if exists trg_clover_conn_recovery_window on public.clover_connections;
drop function if exists app.enforce_recovery_window();

comment on column public.clover_connections.recovery_token_expires_at is
  'Fin estimado de la ventana de recuperacion: +2 semanas desde que se '
  'genero el par ACTUAL. Se reancla con cada par nuevo, tambien cuando el '
  'par viene del endpoint de recuperacion (confirmado por Clover; la 0012 '
  'asumia lo contrario y la 0016 lo corrigio). CALCULADO POR NOSOTROS, no '
  'devuelto por Clover: sirve para avisar y para limpiar, nunca para '
  'decidir no intentarlo.';

comment on column public.clover_connections.recovery_token_secret_id is
  'Id en Vault del refresh token que SE MANDO a Clover para obtener el par '
  'actual, que es el que Clover mantiene vivo como token de recuperacion. '
  'Ojo: en el camino de recuperacion NO es el token al que sustituye el '
  'par nuevo. A -> C deja la recuperacion en A, y mata a B. null = no hay '
  'red: es el estado normal justo despues del flujo OAuth inicial.';


-- ---------------------------------------------------------------------
-- 2. CUANDO FUE EL ULTIMO REFRESCO CON EXITO
--
-- EL AGUJERO QUE TAPA
-- El worker de pg_cron es lo unico que impide que la ventana de 14 dias
-- venza. Si deja de correr en silencio —el proyecto de Supabase pausado,
-- pg_net fallando, el secreto del cron rotado sin avisar a la Edge
-- Function— no pasa nada visible durante dos semanas. Al dia 15 la unica
-- salida es que el merchant vuelva a autorizar la app a mano.
--
-- Y "en silencio" es literal: `cron.job_run_details` dice si el `select`
-- salio bien, o sea si la peticion se ENCOLO;
-- `app.token_refresh_worker_status()` (0015) cruza eso con la respuesta,
-- pero mira el DISPARADOR, no el resultado por conexion. Un worker que
-- corre, contesta 200 y no consigue rotar NINGUNA conexion se ve
-- exactamente igual que uno sano.
--
-- POR QUE UNA COLUMNA Y NO UN JOB QUE MARQUE
-- Porque el modo de fallo es "dejo de ejecutarse algo". Un detector que
-- tambien tenga que ejecutarse periodicamente para marcar comparte el
-- punto de fallo con lo que vigila: Supabase pausado no corre el worker,
-- y tampoco correria el detector, asi que nadie marcaria nada y la
-- ausencia de alertas se leeria como salud.
--
-- Aqui la obsolescencia se DERIVA en tiempo de consulta a partir de un
-- dato que solo se escribe cuando algo va BIEN. Nadie tiene que ejecutar
-- nada para que una instalacion aparezca obsoleta: aparece justamente
-- porque no se ejecuto nada. Es correcta aunque la base lleve meses sin
-- que corra un solo trabajo.
-- ---------------------------------------------------------------------
alter table public.clover_connections
  add column last_refresh_success_at timestamptz;

comment on column public.clover_connections.last_refresh_success_at is
  'Cuando se roto por ultima vez con exito el par de tokens de esta '
  'conexion, por refresco o por recuperacion. Lo escribe el worker con '
  'now() de la base, no con su reloj. null = nunca se ha rotado desde que '
  'existe esta columna, que en una conexion recien conectada es normal y '
  'en una vieja significa que el worker no la ha tocado.';

-- Retrato del momento en que se aplica la migracion.
--
-- Sin esto, TODAS las conexiones existentes saldrian obsoletas el primer
-- dia: `null` no se puede distinguir de "lleva un mes sin rotar" y el
-- panel arrancaria en rojo, que es la forma mas rapida de que nadie
-- vuelva a mirarlo. `access_token_expires_at` es lo mas cercano a un
-- ultimo exito que hay en la fila: lo escribio la ultima rotacion o el
-- OAuth inicial, que son exactamente los dos eventos que esta columna
-- apunta. Se resta el TTL documentado del access token para no fechar el
-- exito en el futuro.
--
-- Solo donde hay algo que copiar: una conexion sin esa fecha nunca tuvo
-- un par, y `null` es la respuesta honesta.
update public.clover_connections
   set last_refresh_success_at = access_token_expires_at - interval '30 minutes'
 where access_token_expires_at is not null
   and refresh_token_secret_id is not null;

-- Parcial y por fecha: la consulta que importa es "cuales llevan mas de
-- N dias", y solo sobre las que el worker deberia estar rotando. Una
-- conexion `not_connected` no esta obsoleta, esta sin conectar.
create index idx_clover_conn_refresh_staleness
  on public.clover_connections (last_refresh_success_at nulls first)
  where status in ('connected', 'degraded');


-- ---------------------------------------------------------------------
-- EL UMBRAL, EN UN SOLO SITIO
--
-- Siete dias: la mitad de la ventana de 14. No es una cifra redonda por
-- gusto, es el punto en el que todavia queda margen para arreglarlo sin
-- tocar al merchant. Con el worker rotando cada 5 minutos, una conexion
-- sana no se acerca ni de lejos: para llegar a 7 dias tienen que fallar
-- unas 2.000 vueltas seguidas.
--
-- Es una funcion y no un literal repetido en cada vista porque el dia que
-- se ajuste, se ajusta una vez, y las dos vistas dicen lo mismo por
-- construccion. `immutable` porque devuelve una constante: asi el
-- planificador la sustituye por su valor en vez de llamarla por fila.
--
-- CLOVER-PENDING: los 7 dias son la mitad de la ventana DOCUMENTADA de 2
-- semanas. La ventana real de produccion no esta medida —haria falta
-- perder un par a proposito y esperar—, asi que si algun dia se confirma
-- que es mas corta, este es el numero que se baja.
--
-- SIN `revoke`, al contrario que el resto de funciones de `app`. Esas
-- escriben en Vault o devuelven ids de secreto; esta devuelve la
-- constante `7 days` y no lee ni una fila. Revocarsela a PUBLIC dejaria
-- sin poder evaluar las dos vistas a cualquier rol que no sea el dueno,
-- `service_role` incluido, a cambio de esconder un numero que esta
-- escrito en esta misma linea.
-- ---------------------------------------------------------------------
create or replace function app.refresh_staleness_threshold()
returns interval
language sql
immutable
as $$ select interval '7 days' $$;

comment on function app.refresh_staleness_threshold() is
  'Cuanto puede pasar sin un refresco con exito antes de considerar '
  'obsoleta una instalacion: 7 dias, la mitad de la ventana de '
  'recuperacion de Clover. Ver 0016.';


-- ---------------------------------------------------------------------
-- LA VISTA DEL SaaS, CON LA MARCA
--
-- `create or replace view` no deja renombrar ni reordenar columnas: solo
-- anadir al final. Por eso las dos nuevas van detras de
-- `recovery_available_until` aunque encajarian mejor al lado de las otras
-- fechas. Es la misma nota que dejo la 0012, y sigue valiendo.
--
-- `refresh_stale` es la columna consultable que pide el operador: se
-- calcula, no se guarda, asi que no puede quedarse desincronizada ni
-- depende de que nadie la escriba.
-- ---------------------------------------------------------------------
create or replace view public.clover_connection_status as
select
  c.store_id,
  c.restaurant_id,
  c.status,
  c.environment,
  case when c.merchant_id is null then null
       else '****' || right(c.merchant_id, 4) end as merchant_masked,
  c.ecommerce_enabled,
  (c.order_type_id is not null)                    as order_type_ready,
  cardinality(c.granted_permissions)               as permissions_granted,
  c.last_sync_at,
  c.last_webhook_at,
  c.access_token_expires_at,
  c.consecutive_failures,
  c.last_error_at,
  c.recovery_token_expires_at                      as recovery_available_until,
  c.last_refresh_success_at,
  -- `null` cuenta como obsoleta: no saber cuando fue el ultimo exito es
  -- indistinguible de que no lo haya habido, y las dos piden lo mismo
  -- (que alguien mire). Solo se evalua sobre las conexiones que el worker
  -- deberia estar rotando; una `not_connected` no esta obsoleta.
  (
    c.status in ('connected', 'degraded')
    and c.refresh_token_secret_id is not null
    and (
      c.last_refresh_success_at is null
      or c.last_refresh_success_at < now() - app.refresh_staleness_threshold()
    )
  )                                                as refresh_stale
from public.clover_connections c;

-- ESTA LINEA NO ES DECORATIVA. `create or replace view` DESCARTA las
-- reloptions, asi que sin ella la vista pierde `security_invoker` y pasa
-- a ejecutarse con los permisos de su propietario: dejaria de heredar el
-- RLS de clover_connections y ensenaria TODAS las conexiones a cualquiera
-- con SELECT sobre la vista. Medido en Postgres 16, no supuesto. Es la
-- razon de ser de 0007_view_security.sql, y se repite cada vez que se
-- reemplaza esta vista.
alter view public.clover_connection_status set (security_invoker = on);

comment on view public.clover_connection_status is
  'Resumen sin secretos para el SaaS. security_invoker = on: hereda el '
  'RLS de clover_connections, que no tiene policies, asi que solo '
  'service_role obtiene filas. Nunca expone ids de Vault. '
  'refresh_stale se calcula en cada consulta: nadie tiene que escribirlo, '
  'asi que sigue siendo cierto aunque no corra ningun trabajo.';


-- ---------------------------------------------------------------------
-- LA VISTA DE GUARDIA
--
-- La anterior tiene una fila por conexion y hay que filtrarla. Esta tiene
-- una fila por PROBLEMA, y por eso es la que se consulta a las tres de la
-- manana y la que puede colgar de una alerta: si devuelve cero filas, no
-- hay nada que hacer.
--
-- Lleva `dias_sin_refrescar` porque "obsoleta" es un si/no y lo que se
-- necesita para decidir es cuanto queda: a los 8 dias sobran seis para
-- arreglarlo sin llamar al restaurante; a los 13 no.
-- ---------------------------------------------------------------------
create or replace view public.clover_refresh_stale as
select
  c.store_id,
  c.restaurant_id,
  c.status,
  c.environment,
  case when c.merchant_id is null then null
       else '****' || right(c.merchant_id, 4) end as merchant_masked,
  c.last_refresh_success_at,
  -- `null` = nunca. Se declara maximo para que ordene arriba: es el caso
  -- que menos sabemos y el que mas urge mirar.
  coalesce(
    extract(epoch from (now() - c.last_refresh_success_at))::double precision / 86400,
    'infinity'::double precision
  )                                                as dias_sin_refrescar,
  c.recovery_token_expires_at                      as recovery_available_until,
  c.consecutive_failures,
  c.last_error,
  c.last_error_at
from public.clover_connections c
where c.status in ('connected', 'degraded')
  and c.refresh_token_secret_id is not null
  and (
    c.last_refresh_success_at is null
    or c.last_refresh_success_at < now() - app.refresh_staleness_threshold()
  )
order by c.last_refresh_success_at asc nulls first;

alter view public.clover_refresh_stale set (security_invoker = on);

comment on view public.clover_refresh_stale is
  'Una fila por instalacion cuyo ultimo refresco con exito tiene mas de '
  'app.refresh_staleness_threshold(). Cero filas = no hay nada que hacer. '
  'A diferencia de app.token_refresh_worker_status(), que mira el '
  'DISPARADOR, esta mira el RESULTADO: un worker que corre, contesta 200 y '
  'no rota nada aparece aqui y alli no. security_invoker = on, y expone '
  'last_error pero ningun id de Vault.';

-- ---------------------------------------------------------------------
-- Y NO SE LA DAMOS A NADIE, EXPLICITAMENTE.
--
-- No basta con "no escribir un grant": en un proyecto de Supabase el
-- `postgres` que aplica las migraciones tiene ALTER DEFAULT PRIVILEGES a
-- favor de `anon` y `authenticated` sobre `public`, asi que una vista
-- nueva nace concedida. Eso no filtraria filas —`security_invoker = on`
-- sobre una tabla con RLS y sin policies devuelve cero— pero deja una
-- vista con `last_error` al alcance de cualquier usuario de la app movil
-- a un solo despiste de RLS de distancia. Se cierra aqui, que cuesta una
-- linea.
--
-- `service_role` conserva la suya por esos mismos default privileges, que
-- es como llegan tambien `clover_connection_status` y el resto: en este
-- repo no hay ni un grant explicito a `service_role`.
--
-- La otra vista NO se toca: `authenticated` tiene SELECT sobre ella desde
-- la 0004 a proposito, y quitarselo aqui seria arreglar otra cosa de
-- paso.
-- ---------------------------------------------------------------------
revoke all on public.clover_refresh_stale from anon, authenticated;
