-- =====================================================================
-- 0013_refresh_lease.sql
-- El cerrojo del worker de refresco: una conexion, un refresco a la vez.
--
-- POR QUE HACE FALTA UN CERROJO
-- El refresh token de Clover es de UN SOLO USO. Dos refrescos en paralelo
-- sobre la misma conexion no se estorban: se MATAN. El primero canjea A y
-- recibe B; el segundo llega con A ya gastado, se lleva un 401 y, si
-- alguien "arregla" ese 401 marcando la conexion como degradada, el par B
-- que si existia queda huerfano. Es el fallo mas caro que puede tener este
-- worker y no da ninguna senal hasta que el local intenta vender.
--
-- Y no hace falta un despliegue raro para que pase: basta con que una
-- ejecucion de pg_cron tarde mas que su periodo y la siguiente arranque
-- encima, o con dos instancias del worker durante un despliegue.
--
-- POR QUE UN ARRIENDO EN UNA COLUMNA Y NO UN ADVISORY LOCK
-- `pg_advisory_lock` es de SESION, y el pooler de Supabase en modo
-- transaccion recicla la sesion entre transacciones: el cerrojo se queda
-- cogido en una sesion que ya no es tuya, o se suelta sin que lo sueltes.
-- Un arriendo con fecha en la propia fila no depende de la sesion, se ve
-- desde SQL, y se cae solo si el worker muere a media faena.
--
-- EL ARRIENDO ES ADEMAS EL TEMPORIZADOR DEL BACKOFF
-- Al terminar bien, el worker lo pone a null. Al fallar, lo empuja hacia
-- adelante con el backoff que toque. Asi no hace falta ni una columna mas
-- ni una tabla de reintentos: lo que impide dos refrescos a la vez es lo
-- mismo que impide machacar a Clover con una conexion rota.
--
-- MIGRACION NUEVA. Las 0001 a 0012 estan corriendo y no se tocan.
-- =====================================================================

alter table public.clover_connections
  -- Hasta cuando esta reservada esta fila para un worker. null o pasada
  -- = libre. NO es un secreto ni un dato del merchant: es fontaneria.
  add column refresh_lease_until timestamptz;

comment on column public.clover_connections.refresh_lease_until is
  'Arriendo del worker de refresco: mientras este en el futuro, ninguna '
  'otra ejecucion toca esta conexion. Sirve tambien de temporizador del '
  'backoff tras un fallo. null = libre.';

-- El indice del claim. El de 0002 (idx_clover_conn_token_refresh) solo
-- cubre 'connected', y aqui tambien se reclaman las degradadas: una
-- conexion degradada es justo la que puede volver con el token de
-- recuperacion, y si nunca se reintenta se queda muerta para siempre.
create index idx_clover_conn_refresh_due
  on public.clover_connections (access_token_expires_at nulls first)
  where status in ('connected', 'degraded');

-- ---------------------------------------------------------------------
-- RECLAMAR LOTE
--
-- Un solo statement: seleccionar y reservar no pueden ser dos pasos, o
-- entre uno y otro se cuela la otra ejecucion. `for update skip locked`
-- hace que dos workers simultaneos se repartan filas distintas en vez de
-- pelearse por las mismas.
--
-- LA POLITICA NO VIVE AQUI. Cuando una conexion "toca" lo decide el
-- worker y entra por `p_due_before` (= ahora + margen). Repetir el margen
-- en SQL seria tener la misma regla en dos sitios, que es como se acaba
-- teniendo dos reglas distintas.
--
-- OJO AL ESCRIBIR SOBRE ESTA TABLA DESDE AQUI: este update NO menciona
-- `recovery_token_expires_at`, asi que no dispara el trigger de la 0012.
-- Si alguien anade esa columna a este SET, la ventana de recuperacion se
-- movera —o el trigger lo parara— por reservar una fila. No se anade.
-- ---------------------------------------------------------------------
create or replace function app.claim_clover_connections_for_refresh(
  p_due_before    timestamptz,
  p_lease_seconds int,
  p_limit         int
)
returns table (
  id                        uuid,
  store_id                  uuid,
  merchant_id               text,
  environment               text,
  status                    app.connection_status,
  access_token_secret_id    uuid,
  access_token_expires_at   timestamptz,
  refresh_token_secret_id   uuid,
  recovery_token_secret_id  uuid,
  recovery_token_expires_at timestamptz,
  consecutive_failures      int
)
language sql
as $$
  update public.clover_connections c
     set refresh_lease_until = now() + make_interval(secs => p_lease_seconds)
   where c.id in (
     select d.id
       from public.clover_connections d
      where d.status in ('connected', 'degraded')
        -- Sin refresh no hay nada que refrescar: una conexion a medio
        -- OAuth no es trabajo de este worker.
        and d.refresh_token_secret_id is not null
        -- null = no sabemos cuando caduca; se trata como vencida, que es
        -- el lado barato de equivocarse.
        and (d.access_token_expires_at is null or d.access_token_expires_at <= p_due_before)
        and (d.refresh_lease_until is null or d.refresh_lease_until <= now())
      order by d.access_token_expires_at asc nulls first
      limit greatest(p_limit, 0)
      for update skip locked
   )
  returning
    c.id,
    c.store_id,
    c.merchant_id,
    c.environment,
    c.status,
    c.access_token_secret_id,
    c.access_token_expires_at,
    c.refresh_token_secret_id,
    c.recovery_token_secret_id,
    c.recovery_token_expires_at,
    c.consecutive_failures;
$$;

comment on function app.claim_clover_connections_for_refresh(timestamptz, int, int) is
  'Reserva y devuelve el lote de conexiones que toca refrescar. Reservar '
  'y seleccionar van en el mismo statement a proposito: si fueran dos, '
  'entre uno y otro cabe la otra ejecucion del worker, y dos refrescos en '
  'paralelo sobre la misma conexion la dejan muerta (el refresh token es '
  'de un solo uso). No devuelve ningun token: solo ids de Vault.';

-- Sin GRANT a nadie. Solo `service_role` —que ya tiene acceso a la tabla
-- por ser BYPASSRLS— la ejecuta, y el worker corre con esa clave. Un
-- grant a `authenticated` aqui daria ids de Vault a cualquier usuario de
-- la app movil.
revoke execute on function app.claim_clover_connections_for_refresh(timestamptz, int, int)
  from public;
