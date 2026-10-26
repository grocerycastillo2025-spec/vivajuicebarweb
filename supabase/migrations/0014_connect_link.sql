-- =====================================================================
-- 0014_connect_link.sql
-- El enlace que el operador le manda al merchant para conectar Clover.
--
-- POR QUE HACE FALTA UNA FUNCION Y NO UN UPDATE A MANO
-- La columna `connect_token` existe desde la 0002 y hasta ahora no la
-- escribia nadie: el flujo de OAuth no estaba construido. Ya lo esta
-- (`supabase/functions/oauth`), y este es el unico sitio donde nace un
-- enlace valido. Un `update` a mano en el editor de SQL parece igual y no
-- lo es: es donde se cuela un token corto, uno reutilizado, o uno sin
-- caducidad — y sin caducidad el enlace vale para siempre, que es
-- justamente lo que no queremos de la unica credencial que viaja por
-- correo.
--
-- QUE ES ESTE TOKEN, EXACTAMENTE
-- Es el `state` del flujo v2/OAuth. Es lo que ata el callback de Clover a
-- UNA sucursal: sin el, un `code` cualquiera haria que nuestro backend
-- escribiera tokens en la fila que no. Por eso es largo, aleatorio, de un
-- solo uso —la Edge Function lo borra al conectar— y caduca.
--
-- QUIEN LO USA
--   1. el operador llama a esta funcion y obtiene el enlace;
--   2. se lo manda al dueño del restaurante (§0.3: el super admin NO
--      puede autorizar por el, no tiene sus credenciales de Clover);
--   3. el merchant lo abre y aterriza en /functions/v1/oauth/start.
--
-- MIGRACION NUEVA. Las 0001 a 0013 estan corriendo y no se tocan.
-- =====================================================================

-- ---------------------------------------------------------------------
-- EMITIR UN ENLACE
--
-- Devuelve solo el token. La URL completa se arma fuera, porque el
-- dominio del proyecto no es un dato que deba vivir duplicado en la base:
-- ya vive en `SUPABASE_URL`, que es de donde la Edge Function saca tambien
-- el `redirect_uri`. Dos sitios con la misma URL es como se acaba teniendo
-- dos URLs distintas, y en este flujo eso significa un OAuth que no
-- completa nunca.
-- ---------------------------------------------------------------------
create or replace function app.issue_clover_connect_token(
  p_store_id uuid,
  p_ttl      interval default interval '7 days'
)
returns text
language plpgsql
as $$
declare
  v_token text;
begin
  -- 32 bytes de `gen_random_bytes`, en base64url para que sobreviva a un
  -- correo, a un WhatsApp y a la barra de direcciones sin que nadie tenga
  -- que escapar nada. Postgres no trae 'base64url', asi que se traduce a
  -- mano: es eso o descubrir que un '+' llego como espacio.
  v_token := rtrim(translate(encode(gen_random_bytes(32), 'base64'), '+/', '-_'), '=');

  update public.clover_connections
     set connect_token            = v_token,
         connect_token_expires_at = now() + p_ttl,
         -- OJO CON EL ESTADO: solo se mueve hacia 'pending_auth' desde
         -- una conexion que no esta sirviendo. Una sucursal 'connected'
         -- que se va a reconectar sigue vendiendo con los tokens que ya
         -- tiene hasta que el par nuevo aterrice; degradarla aqui la
         -- sacaria de la app por emitir un enlace que quiza nadie abra.
         status = case
                    when status in ('not_connected', 'revoked') then 'pending_auth'
                    else status
                  end
   where store_id = p_store_id;

  if not found then
    raise exception
      'La sucursal % no tiene fila en clover_connections. El enlace de '
      'conexion se emite sobre una conexion existente, aunque este vacia.',
      p_store_id;
  end if;

  return v_token;
end;
$$;

comment on function app.issue_clover_connect_token(uuid, interval) is
  'Emite el token del enlace de conexion de Clover (el `state` del flujo '
  'v2/OAuth) y lo deja en clover_connections.connect_token. De un solo '
  'uso: la Edge Function oauth lo borra al conectar. La URL se arma '
  'fuera: <SUPABASE_URL>/functions/v1/oauth/start?t=<token>.';

-- Sin GRANT a nadie. Solo `service_role` llega a `clover_connections`
-- (RLS sin policies desde la 0004), y un grant a `authenticated` aqui
-- dejaria a cualquier usuario de la app movil emitir enlaces de conexion
-- de cualquier restaurante.
revoke execute on function app.issue_clover_connect_token(uuid, interval) from public;

-- ---------------------------------------------------------------------
-- CADUCADO ES LO MISMO QUE NO TENER
--
-- El indice unico de `connect_token` (0002) impide dos enlaces iguales,
-- no dos enlaces vivos para la misma sucursal: emitir uno nuevo pisa el
-- anterior, que es justo lo que se quiere. Lo que si conviene es que los
-- caducados no se queden ahi para siempre ocupando el unico hueco de
-- token de su fila y confundiendo a quien mire la tabla.
--
-- No hace falta un worker: la Edge Function ya trata un enlace caducado
-- como invalido (y uno sin fecha tambien, que es el lado barato de
-- equivocarse). Esto es solo limpieza, y se puede colgar de cualquier
-- pasada de pg_cron que ya exista.
-- ---------------------------------------------------------------------
create or replace function app.purge_expired_clover_connect_tokens()
returns int
language sql
as $$
  with limpiadas as (
    update public.clover_connections
       set connect_token = null, connect_token_expires_at = null
     where connect_token is not null
       and connect_token_expires_at is not null
       and connect_token_expires_at <= now()
    returning 1
  )
  select count(*)::int from limpiadas;
$$;

comment on function app.purge_expired_clover_connect_tokens() is
  'Borra los enlaces de conexion ya caducados. No es una medida de '
  'seguridad —la Edge Function ya los rechaza— sino higiene: un enlace '
  'muerto en la fila hace dudar de si la sucursal esta a medio conectar.';

revoke execute on function app.purge_expired_clover_connect_tokens() from public;
