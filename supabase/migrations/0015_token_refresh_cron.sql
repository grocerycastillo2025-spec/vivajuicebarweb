-- =====================================================================
-- 0015_token_refresh_cron.sql
-- El disparador del worker de refresco. Sin esto, la logica de la 0013 y
-- de workers/src/token-refresh esta escrita pero no la llama nadie.
--
-- LA CADENA COMPLETA
--
--   pg_cron  --cada 5 min-->  app.run_token_refresh_worker()
--                                     | net.http_post (pg_net)
--                                     v
--                            POST /functions/v1/token-refresh
--                                     |
--                                     v
--                            runTokenRefresh(...)  ->  claim de la 0013
--
-- POR QUE UNA LLAMADA HTTP Y NO SQL A SECAS
-- Porque lo que hay que ejecutar habla con Clover: dos llamadas HTTP con
-- timeout, limitador de 50 req/s y breakers. Eso no cabe en una funcion
-- de Postgres, y meterlo ahi significaria reescribir en PL/pgSQL una
-- logica que ya esta probada sin red y sin base. pg_cron dispara, pg_net
-- llama, y la vuelta la da la Edge Function.
--
-- POR QUE LA URL Y EL SECRETO NO ESTAN EN ESTE ARCHIVO
-- Porque cambian por proyecto y uno de los dos es un secreto: escribirlos
-- aqui seria versionarlos. Viven en Supabase Vault y los pone
-- `app.configure_token_refresh_worker`, que es el UNICO paso manual de
-- todo el cableado. Ver docs/REFRESCO-TOKENS.md.
--
-- QUE SE VE DESDE SQL CUANDO ALGO NO CORRE
-- `cron.job_run_details` solo dice si el `select` salio bien, o sea si la
-- peticion se ENCOLO. No dice nada de la respuesta. Por eso esta migracion
-- apunta el id de cada peticion en `app.token_refresh_runs` y
-- `app.token_refresh_worker_status()` lo cruza con `net._http_response`:
-- sin ese cruce, una funcion que contesta 500 cada cinco minutos se ve
-- exactamente igual que una que va bien.
--
-- MIGRACION NUEVA. Las 0001 a 0014 estan corriendo y no se tocan.
-- =====================================================================


-- ---------------------------------------------------------------------
-- LAS DOS EXTENSIONES
--
-- En un proyecto de Supabase estan disponibles y se activan aqui. En el
-- harness de CI (postgres:16 pelado, ver .github/db-harness.sql) no
-- existen, y por eso el `if`: la alternativa seria que esta migracion
-- rompiera el job `database` de CI, que es el que comprueba que el
-- esquema entero se aplica limpio.
--
-- EL `if` NO ES UN INTERRUPTOR SILENCIOSO. En Supabase la rama de arriba
-- se toma SIEMPRE —pg_cron y pg_net estan en el catalogo de extensiones
-- disponibles aunque no esten instaladas—, asi que un proyecto real nunca
-- cae en el `raise notice`. Si algun dia cayera, el worker no correria y
-- `app.token_refresh_worker_status()` lo dice con esas palabras.
-- ---------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    -- Lo que documenta Supabase para que el rol `postgres` pueda
    -- programar y leer el historial de trabajos.
    execute 'grant usage on schema cron to postgres';
    execute 'grant all privileges on all tables in schema cron to postgres';
  else
    raise notice
      'pg_cron NO esta disponible en esta base: el worker de refresco no quedara programado. '
      'Es lo normal en el harness de CI. En Supabase se activa en '
      'Dashboard -> Database -> Extensions.';
  end if;

  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net;
  else
    raise notice
      'pg_net NO esta disponible en esta base: nadie podra llamar a la Edge Function. '
      'Es lo normal en el harness de CI.';
  end if;
end $$;


-- ---------------------------------------------------------------------
-- EL RASTRO DE CADA VUELTA
--
-- Una fila por peticion encolada. No guarda la respuesta —esa la guarda
-- pg_net en `net._http_response` y la borra sola a las horas—, guarda el
-- id que permite encontrarla. Es la pieza que convierte "creo que corre"
-- en "corrio a las 03:15 y contesto 200 con este recuento".
--
-- Vive en `app` y no en `public` a proposito: no es un dato del negocio,
-- no la lee la app movil y no tiene que aparecer en los tipos generados.
-- ---------------------------------------------------------------------
create table if not exists app.token_refresh_runs (
  request_id   bigint primary key,
  requested_at timestamptz not null default now()
);

comment on table app.token_refresh_runs is
  'Id de cada peticion que pg_cron encolo contra la Edge Function del '
  'worker de refresco. Se cruza con net._http_response para saber que '
  'contesto. Se poda sola a los 7 dias.';

create index if not exists idx_token_refresh_runs_requested_at
  on app.token_refresh_runs (requested_at desc);


-- ---------------------------------------------------------------------
-- LEER UN AJUSTE DE VAULT
--
-- Falta el secreto = el worker NO esta configurado, y eso tiene que doler
-- ahora. Se levanta una excepcion en vez de devolver null: asi la vuelta
-- aparece como fallida en `cron.job_run_details` cada cinco minutos, con
-- el mensaje que dice exactamente que ejecutar. Un `return null` educado
-- dejaria el trabajo "corriendo" y sin hacer nada, que es el modo de
-- fallo que esta migracion existe para evitar.
-- ---------------------------------------------------------------------
create or replace function app.token_refresh_setting(p_name text)
returns text
language plpgsql
stable
as $$
declare
  v_valor text;
begin
  select decrypted_secret into v_valor
    from vault.decrypted_secrets
   where name = p_name;

  if v_valor is null or v_valor = '' then
    raise exception
      'El worker de refresco no esta configurado: falta el secreto de Vault "%".', p_name
      using hint =
        'Ejecuta: select app.configure_token_refresh_worker(''https://<ref>.supabase.co'', '
        '''<WORKER_CRON_SECRET>''); Ver docs/REFRESCO-TOKENS.md, "Como se dispara".';
  end if;

  return v_valor;
end;
$$;


-- ---------------------------------------------------------------------
-- CONFIGURAR: el unico paso manual de todo esto
--
-- Guarda en Vault la URL del proyecto y el secreto compartido, y deja el
-- trabajo programado. Es idempotente: volver a ejecutarlo con otro
-- secreto lo rota, y `cron.schedule` con el mismo `jobname` pisa el
-- anterior en vez de duplicarlo.
--
-- EL SECRETO TIENE QUE SER EL MISMO QUE `supabase secrets set
-- WORKER_CRON_SECRET=...`. Son los dos extremos del mismo cable; si no
-- coinciden, la Edge Function contesta 401 y `status()` lo ensena.
--
-- OJO CON `vault.create_secret`: la firma es (new_secret, new_name,
-- new_description) — EL SECRETO VA PRIMERO. Cambiarlos de sitio no da
-- error: guarda el nombre como secreto. Es la misma trampa que avisa
-- workers/src/token-refresh/postgres.ts.
--
-- Y ESTO NO ES UN HELPER GENERICO DE VAULT, a proposito. Para los tokens
-- de Clover, `create` y `update` NO son intercambiables: sobrescribir el
-- secreto del refresh vigente destruye el token de recuperacion en el
-- mismo movimiento (ver worker.ts, regla 2). Un `upsert` publico seria
-- una escopeta cargada al lado de esa regla, asi que el upsert vive aqui
-- dentro y solo para estos dos ajustes, que no son tokens de nadie.
-- ---------------------------------------------------------------------
create or replace function app.configure_token_refresh_worker(
  p_project_url text,
  p_cron_secret text
)
returns text
language plpgsql
as $$
declare
  v_url    text := rtrim(btrim(coalesce(p_project_url, '')), '/');
  v_secret text := btrim(coalesce(p_cron_secret, ''));
  v_nombre text;
  v_valor  text;
  v_id     uuid;
begin
  -- Solo el origen. Si aqui entra la URL de la funcion entera, el
  -- `net.http_post` acabaria pidiendo .../token-refresh/functions/v1/...
  if v_url !~ '^https://[^/[:space:]]+$' then
    raise exception
      'p_project_url tiene que ser SOLO el origen (https://<ref>.supabase.co), sin ruta '
      'ni barra final, y llego: %', p_project_url;
  end if;

  -- El mismo minimo que comprueba `assertCronSecret` en la Edge Function.
  -- Este endpoint no tiene nada que limite intentos.
  if length(v_secret) < 32 then
    raise exception
      'El secreto del cron tiene menos de 32 caracteres.'
      using hint = 'Generalo con: openssl rand -base64 32';
  end if;

  -- Las dos extensiones. Sin esto el fallo llega mas tarde y mas feo: un
  -- "schema cron does not exist" a secas, o —peor— un `configure` que
  -- pasa y un worker que no dispara nunca porque falta pg_net.
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise exception 'pg_cron no esta activo en este proyecto.'
      using hint = 'Dashboard -> Database -> Extensions -> pg_cron, y vuelve a ejecutar esto.';
  end if;
  -- Por NOMBRES de parametro y no por firma exacta: `run_token_refresh_worker`
  -- llama con `url =>`, `body =>`, `headers =>`, `timeout_milliseconds =>`, y
  -- eso sigue funcionando aunque pg_net anada parametros con valor por
  -- defecto. Un guard atado a la firma exacta daria un falso "pg_net no esta
  -- activo" en cuanto cambie de version, que es peor que no tener guard.
  if not exists (
    select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'net'
       and p.proname = 'http_post'
       and array['url', 'body', 'headers', 'timeout_milliseconds'] <@ coalesce(p.proargnames, '{}')
  ) then
    raise exception 'pg_net no esta activo en este proyecto: nadie podria llamar a la Edge Function.'
      using hint = 'Dashboard -> Database -> Extensions -> pg_net, y vuelve a ejecutar esto.';
  end if;

  foreach v_nombre in array array['token_refresh_project_url', 'token_refresh_cron_secret']
  loop
    v_valor := case v_nombre
                 when 'token_refresh_project_url' then v_url
                 else v_secret
               end;

    select id into v_id from vault.secrets where name = v_nombre;
    if v_id is null then
      perform vault.create_secret(v_valor, v_nombre, 'Cableado del worker de refresco (0015)');
    else
      perform vault.update_secret(v_id, v_valor, v_nombre, 'Cableado del worker de refresco (0015)');
    end if;
  end loop;

  -- El periodo esta en dos idiomas: aqui y en `WORKER_PERIOD_MS`
  -- (workers/src/token-refresh/policy.ts). Hay una prueba que abre este
  -- archivo y comprueba que dicen lo mismo
  -- (supabase/functions/token-refresh/__tests__/schedule.test.ts). Si
  -- cambias uno, cambia el otro: `policy.ts` razona sobre cuantos
  -- intentos caben en el margen, y ese razonamiento es falso en cuanto
  -- el cron dispara con otro periodo.
  perform cron.schedule(
    'token-refresh',
    '*/5 * * * *',
    'select app.run_token_refresh_worker();'
  );

  return v_url || '/functions/v1/token-refresh';
end;
$$;

comment on function app.configure_token_refresh_worker(text, text) is
  'Deja el worker de refresco disparandose: guarda en Vault la URL del '
  'proyecto y el secreto compartido con la Edge Function, y programa el '
  'pg_cron. Idempotente. Devuelve la URL que se va a llamar.';


-- ---------------------------------------------------------------------
-- LO QUE EJECUTA EL CRON
--
-- `net.http_post` es ASINCRONA: encola y vuelve enseguida con un id. Por
-- eso este `select` dura milisegundos aunque la vuelta tarde un minuto, y
-- por eso dos tics del cron no se solapan aqui. Que dos VUELTAS no se
-- pisen es otra cosa, y de eso se encarga el arriendo de la 0013.
--
-- EL TIMEOUT SON 2 MINUTOS, igual que `LEASE_MS`. No es una cifra
-- decorativa: pasado el arriendo, el propio worker corta el lote (ver
-- `PER_CONNECTION_BUDGET_MS`), asi que una vuelta sana nunca llega ahi.
-- Y cortar por timeout no rompe nada: cada conexion se escribe cuando se
-- termina, y lo que quede se coge en la vuelta siguiente.
-- ---------------------------------------------------------------------
create or replace function app.run_token_refresh_worker()
returns bigint
language plpgsql
as $$
declare
  v_url        text := app.token_refresh_setting('token_refresh_project_url');
  v_secret     text := app.token_refresh_setting('token_refresh_cron_secret');
  v_request_id bigint;
begin
  select net.http_post(
           url                  => v_url || '/functions/v1/token-refresh',
           body                 => '{}'::jsonb,
           headers              => jsonb_build_object(
                                     'Content-Type', 'application/json',
                                     'Authorization', 'Bearer ' || v_secret
                                   ),
           timeout_milliseconds => 120000
         )
    into v_request_id;

  insert into app.token_refresh_runs (request_id) values (v_request_id);

  -- Podar aqui y no en otro trabajo de cron: son dos filas al dia y una
  -- tabla de fontaneria no merece su propio programador.
  delete from app.token_refresh_runs where requested_at < now() - interval '7 days';

  return v_request_id;
end;
$$;

comment on function app.run_token_refresh_worker() is
  'Lo que ejecuta pg_cron cada 5 minutos: encola un POST a la Edge '
  'Function del worker de refresco y apunta el id de la peticion. Falla '
  'con un mensaje accionable si el worker no esta configurado.';


-- ---------------------------------------------------------------------
-- ESTA CORRIENDO?
--
-- La pregunta que hay que poder contestar en diez segundos a las tres de
-- la manana. Cruza las cuatro cosas que pueden estar mal por separado:
-- la configuracion, el trabajo programado, la ultima peticion encolada y
-- lo que contesto la funcion.
--
-- No levanta excepcion si falta algo: aqui se viene justamente cuando
-- algo falta, y una excepcion en vez de una fila deja sin ver el resto.
-- ---------------------------------------------------------------------
create or replace function app.token_refresh_worker_status()
returns table (
  configurado      boolean,
  url              text,
  cron_programado  boolean,
  cron_expresion   text,
  cron_activo      boolean,
  ultima_peticion  timestamptz,
  ultimo_codigo    int,
  ultimo_error     text,
  ultima_respuesta text
)
language plpgsql
stable
as $$
declare
  v_request_id bigint;
begin
  select s.decrypted_secret into url
    from vault.decrypted_secrets s
   where s.name = 'token_refresh_project_url';

  configurado := url is not null and url <> ''
             and exists (select 1 from vault.decrypted_secrets s
                          where s.name = 'token_refresh_cron_secret'
                            and s.decrypted_secret <> '');
  if url is not null then
    url := url || '/functions/v1/token-refresh';
  end if;

  cron_programado := false;
  if to_regclass('cron.job') is not null then
    execute
      'select schedule, active from cron.job where jobname = $1'
      into cron_expresion, cron_activo
      using 'token-refresh';
    cron_programado := cron_expresion is not null;
  end if;

  select r.requested_at, r.request_id into ultima_peticion, v_request_id
    from app.token_refresh_runs r
   order by r.requested_at desc
   limit 1;

  -- pg_net borra `net._http_response` a las pocas horas, asi que esto
  -- puede venir vacio aunque la vuelta fuera bien. Vacio con
  -- `ultima_peticion` reciente = mirar los logs de la funcion.
  if ultima_peticion is not null and to_regclass('net._http_response') is not null then
    execute
      'select status_code, coalesce(error_msg, case when timed_out then ''timeout'' end), '
      '       left(content, 500) '
      '  from net._http_response where id = $1'
      into ultimo_codigo, ultimo_error, ultima_respuesta
      using v_request_id;
  end if;

  return next;
end;
$$;

comment on function app.token_refresh_worker_status() is
  'Una fila con todo lo que puede estar mal por separado en el disparador '
  'del worker de refresco: configuracion, trabajo programado, ultima '
  'peticion y lo que contesto la Edge Function.';


-- ---------------------------------------------------------------------
-- PROGRAMARLO YA, sin esperar a que alguien ejecute `configure`.
--
-- Asi el trabajo existe desde el momento en que se aplica la migracion, y
-- lo que falta —los dos secretos— se ve como un fallo cada cinco minutos
-- en `cron.job_run_details`, con el mensaje que dice que ejecutar. Al
-- reves —programarlo solo al configurar— un despliegue donde se olvide el
-- paso manual se ve exactamente igual que uno correcto: en silencio.
-- ---------------------------------------------------------------------
do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is not null then
    perform cron.schedule(
      'token-refresh',
      '*/5 * * * *',
      'select app.run_token_refresh_worker();'
    );
  else
    raise notice
      'Sin pg_cron: el worker de refresco NO queda programado. Normal en el harness de CI.';
  end if;
end $$;


-- ---------------------------------------------------------------------
-- Sin GRANT a nadie, igual que el claim de la 0013.
--
-- Estas funciones no devuelven ningun token, pero `configure` escribe en
-- Vault y `status` ensena la URL del proyecto. Solo las ejecuta
-- `service_role` —y el rol `postgres` desde el editor de SQL—, que es
-- quien ya tiene la base entera.
-- ---------------------------------------------------------------------
revoke execute on function app.token_refresh_setting(text) from public;
revoke execute on function app.configure_token_refresh_worker(text, text) from public;
revoke execute on function app.run_token_refresh_worker() from public;
revoke execute on function app.token_refresh_worker_status() from public;

revoke all on table app.token_refresh_runs from public;
