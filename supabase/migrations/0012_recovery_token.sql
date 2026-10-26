-- =====================================================================
-- 0012_recovery_token.sql
-- La red de seguridad del refresco de OAuth: el token de recuperacion.
--
-- EL AGUJERO QUE TAPA
-- El refresh token de Clover es de UN SOLO USO. El momento peligroso del
-- worker de refresco es este:
--
--   1. mandamos el refresh A a /oauth/v2/refresh
--   2. Clover emite el par B y en ese instante A queda invalidado
--   3. ...y si perdemos B antes de guardarlo —la Edge Function se corta,
--      la escritura en Vault falla, el proceso muere— nos quedamos sin A
--      (ya gastado) y sin B (nunca guardado).
--
-- Sin red, ahi la conexion del merchant esta MUERTA: no hay token con el
-- que hablar con Clover, y recuperarla exige que el merchant vuelva a
-- autorizar la app a mano. Para un restaurante en hora punta, eso es la
-- app caida hasta que alguien del local entre a su Clover.
--
-- LA RED
-- Al usar A para obtener B, Clover deja A vivo como TOKEN DE RECUPERACION
-- de B. Si B se pierde, se canjea A en `POST {platform}/oauth/v2/recovery`
-- con el client_secret, y sale un par nuevo. Sin tocar al merchant.
--
--   Ventana      2 semanas desde que se genero el par ACTUAL
--   Se invalida  en cuanto un refresh se usa con exito
--   Requiere     client_secret; solo apps de alta confianza (la nuestra)
--   Despues      no hay atajo: rehacer el flujo OAuth entero
--
-- Verificado en la documentacion oficial (docs.clover.com, "Use refresh
-- token to generate new expiring token", seccion "Reauthenticate with a
-- recovery token"). Ver docs/CLOVER-ENDPOINTS.md.
--
-- POR QUE NO HAY TABLA DE HISTORIAL
-- Porque Clover solo admite el refresh INMEDIATAMENTE anterior. La cadena
-- es lineal y en cada momento hay exactamente un token de recuperacion
-- activo. Guardar la cadena entera daria una lista de tokens muertos: mas
-- superficie para filtrar y ni un caso mas recuperable.
--
-- MIGRACION NUEVA. Las 0001 a 0011 estan corriendo y no se tocan.
-- =====================================================================

alter table public.clover_connections
  -- El refresh ANTERIOR, en Vault, igual que los otros dos. Aqui solo va
  -- su id de secreto: en esta tabla no hay ni un token en claro.
  add column recovery_token_secret_id  uuid,

  -- Cuando se cierra la ventana. Lo calculamos nosotros (generacion del
  -- par actual + 2 semanas); Clover NO lo devuelve en la respuesta.
  -- Por eso es una PISTA, no la verdad -- ver el aviso de abajo.
  add column recovery_token_expires_at timestamptz;

-- O estan los dos o no esta ninguno. Un id sin fecha deja al worker sin
-- saber si la red sigue viva; una fecha sin id promete una red que no
-- existe, que es peor: se descubre el dia que hace falta.
alter table public.clover_connections
  add constraint clover_connections_recovery_completo
    check ((recovery_token_secret_id is null) = (recovery_token_expires_at is null));

comment on column public.clover_connections.recovery_token_secret_id is
  'Id en Vault del refresh token ANTERIOR, que Clover mantiene vivo como '
  'token de recuperacion del actual. null = no hay red: es el estado '
  'normal justo despues del flujo OAuth inicial, porque no hubo ningun '
  'token antes que el primero.';

comment on column public.clover_connections.recovery_token_expires_at is
  'Fin estimado de la ventana de recuperacion (+2 semanas desde el '
  'refresco que genero el token de recuperacion actual). NO se renueva al '
  'recuperar: si el token de recuperacion no cambia, su reloj tampoco '
  'empieza de nuevo, y un trigger lo impide. CALCULADO POR NOSOTROS, no '
  'devuelto por Clover: sirve para avisar y para limpiar, nunca para '
  'decidir no intentarlo.';

-- ---------------------------------------------------------------------
-- TRES COSAS QUE EL WORKER DE LA PR 2 TIENE QUE HACER BIEN
-- Van aqui, y no solo en el codigo, porque son consecuencias del
-- ESQUEMA: quien lea estas columnas dentro de un ano las necesita.
--
-- 1. NO BORRAR EL SECRETO VIEJO DE VAULT AL ROTAR.
--    El reflejo natural al rotar es limpiar el secreto anterior. Hacerlo
--    aqui destruye la red en el mismo instante en que se crea, y no se
--    nota hasta el dia que hace falta. El secreto anterior se conserva y
--    solo se borra cuando deja de ser el de recuperacion.
--
-- 2. DESPUES DE UNA RECUPERACION, EL TOKEN DE RECUPERACION NO CAMBIA.
--    Es el detalle contraintuitivo, y esta escrito en la documentacion:
--
--      refresco     A -> B    la recuperacion pasa a ser A
--      recuperacion A -> C    la recuperacion SIGUE siendo A, y B muere
--
--    O sea que "el de recuperacion es siempre el refresh que acabo de
--    sustituir" es FALSO en el camino de recuperacion: ahi el que se
--    sustituye es B, que ya no vale para nada. Escribir eso deja la
--    conexion sin red justo despues del susto en el que se uso.
--
-- 3. LA VENTANA NO SE RENUEVA AL RECUPERAR. Esta es la regla mas facil
--    de pisar sin darse cuenta, porque el reflejo es "he escrito un par
--    nuevo, luego recalculo la fecha".
--
--      refresco     A -> B   recuperacion := A,  ventana := ahora + 2 sem
--      recuperacion A -> C   recuperacion := A,  ventana := SE QUEDA IGUAL
--
--    Si el token de recuperacion no cambia, su reloj tampoco empieza de
--    nuevo. Recalcular la fecha en el camino de recuperacion se inventa
--    margen que no existe, y lo hace justo despues del susto en el que se
--    uso: la conexion parece tener red hasta dentro de dos semanas y en
--    realidad le quedan dias.
--
--    LA DOCUMENTACION NO LO RESUELVE, Y CONVIENE SABERLO
--    Dice "two weeks have passed since the CURRENT access and refresh
--    token pair was generated", y despues de una recuperacion el par
--    actual es C, lo que leido al pie de la letra renovaria la ventana.
--    Pero la misma pagina dice que la cadena de recuperaciones "continues
--    until a refresh token is successfully used": si cada recuperacion
--    reiniciara el reloj, esa cadena no caducaria nunca y el limite de
--    dos semanas no limitaria nada. Las dos lecturas no pueden ser
--    ciertas a la vez.
--
--    Sin poder medirlo —haria falta perder un refresh y esperar dos
--    semanas— se toma la lectura PESIMISTA, porque los dos errores no
--    cuestan lo mismo:
--
--      creer que hay menos margen del real  -> avisamos antes de tiempo,
--                                              y como mucho rehacemos un
--                                              OAuth que no hacia falta;
--      creer que hay mas margen del real    -> creemos tener red, no la
--                                              hay, y se descubre el dia
--                                              que se necesita.
--
--    El trigger de mas abajo lo impone: mientras el token de recuperacion
--    no cambie, su fecha no puede moverse hacia adelante.
--
-- 4. LA CABECERA MANDA SOBRE ESTA FECHA.
--    Cuando un refresh falla con 401 y existe recuperacion, Clover lo
--    dice en la respuesta: `X-Clover-Recovery-Available: true`. Esa
--    cabecera es la autoridad. `recovery_token_expires_at` es una
--    estimacion nuestra con nuestro reloj, asi que nunca debe usarse
--    para NO intentar la recuperacion: se intenta, y que conteste Clover.
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- LA REGLA DE LA VENTANA, IMPUESTA Y NO SOLO ESCRITA
--
-- El punto 3 de arriba es un comentario, y un comentario no para a nadie:
-- el worker de la PR 2 lo pisaria con una sola linea bienintencionada
-- ("acabo de guardar un par nuevo, recalculo la fecha"). Esto lo convierte
-- en una regla que la base hace cumplir.
--
-- Mientras el token de recuperacion sea EL MISMO, su fecha no puede
-- moverse hacia adelante. Para renovar la ventana hay que cambiar de
-- token de recuperacion, que es exactamente lo que pasa en un refresco y
-- exactamente lo que NO pasa en una recuperacion.
--
-- Atrasarla si se permite: acortar el margen por prudencia nunca hace
-- dano. Y ponerlo todo a null tambien, que es lo que toca cuando la
-- recuperacion se consume.
--
-- SI ALGUN DIA SE CONFIRMA QUE CLOVER SI RENUEVA LA VENTANA, esto se
-- quita con un `drop trigger` en una migracion nueva. Es una linea, y
-- mientras tanto el sistema se equivoca del lado barato.
-- ---------------------------------------------------------------------
create or replace function app.enforce_recovery_window()
returns trigger
language plpgsql
as $$
begin
  if new.recovery_token_secret_id is not null
     and new.recovery_token_secret_id is not distinct from old.recovery_token_secret_id
     and new.recovery_token_expires_at > old.recovery_token_expires_at
  then
    raise exception
      'No se puede alargar la ventana de recuperacion de la conexion % sin '
      'cambiar el token de recuperacion (de % a %). Si esto viene de una '
      'RECUPERACION: el token de recuperacion no cambia, y su reloj tampoco '
      'se reinicia; deja la fecha como esta. Si viene de un REFRESCO: hay '
      'que escribir tambien el token de recuperacion nuevo, que es el '
      'refresh que se acaba de gastar.',
      new.id, old.recovery_token_expires_at, new.recovery_token_expires_at;
  end if;
  return new;
end;
$$;

create trigger trg_clover_conn_recovery_window
  before update of recovery_token_expires_at on public.clover_connections
  for each row execute function app.enforce_recovery_window();

comment on function app.enforce_recovery_window() is
  'Impide alargar la ventana de recuperacion sin cambiar el token de '
  'recuperacion. Ver 0012_recovery_token.sql para por que la lectura '
  'pesimista es la correcta mientras no se pueda medir.';

-- ---------------------------------------------------------------------
-- RLS: NO HACE FALTA TOCAR NADA, Y CONVIENE SABER POR QUE
--
-- `clover_connections` tiene RLS habilitado (0004) y CERO policies. En
-- Postgres eso no es "sin restricciones": es lo contrario. Sin ninguna
-- policy que conceda, nadie pasa, y solo `service_role` —que la salta por
-- ser BYPASSRLS— llega a la tabla.
--
-- Las policies de Postgres son por FILA, no por columna, asi que una
-- columna nueva hereda esa proteccion en el momento en que se crea. No
-- hay ninguna policy que ampliar ni ningun grant que revisar, y anadir
-- uno "por si acaso" solo podria abrir lo que ahora esta cerrado.
--
-- Y de hecho hay DOS barreras, no una. Medido con las doce migraciones
-- aplicadas sobre Postgres 16:
--
--   anon / authenticated  -> "permission denied for table": ni siquiera
--                            llegan al RLS, porque 0006_grants.sql no les
--                            concede nada sobre esta tabla;
--   service_role          -> ve la fila y la ventana.
--
-- Comprobado ejecutandolo, no leyendolo.
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- LA VISTA DEL SaaS ENSEÑA LA FECHA, NUNCA EL SECRETO
--
-- `clover_connection_status` lista sus columnas una a una, asi que las
-- dos nuevas no salian solas. La fecha si merece salir: una red que nadie
-- puede ver es una red que se pudre en silencio, y el operador necesita
-- distinguir "esta conexion tiene margen" de "si el proximo refresco
-- falla, hay que llamar al restaurante".
--
-- El id de secreto NO sale. Ni aqui ni en ninguna vista.
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
  -- Al FINAL, y no junto a la otra fecha, donde encajaria mejor:
  -- `create or replace view` no deja renombrar ni reordenar columnas
  -- existentes, solo anadir al final. Intentar colocarla en su sitio da
  -- "cannot change name of view column". Cambiar el orden exigiria un
  -- DROP + CREATE, y eso tumbaria cualquier permiso concedido sobre la
  -- vista. No merece la pena por la estetica de una columna.
  c.recovery_token_expires_at                      as recovery_available_until
from public.clover_connections c;

-- ESTA LINEA NO ES DECORATIVA. `create or replace view` DESCARTA las
-- reloptions, asi que sin ella la vista pierde `security_invoker` y pasa
-- a ejecutarse con los permisos de su propietario: dejaria de heredar el
-- RLS de clover_connections y ensenaria TODAS las conexiones a cualquiera
-- con SELECT sobre la vista.
--
-- Medido en Postgres 16, no supuesto: se creo una vista con la opcion
-- puesta, se hizo `create or replace`, y las reloptions salieron vacias.
-- Es la razon de ser de 0007_view_security.sql, y se repite aqui porque
-- este fichero acaba de reemplazar la vista.
alter view public.clover_connection_status set (security_invoker = on);

comment on view public.clover_connection_status is
  'Resumen sin secretos para el SaaS. security_invoker = on: hereda el '
  'RLS de clover_connections, que no tiene policies, asi que solo '
  'service_role obtiene filas. Nunca expone ids de Vault.';
