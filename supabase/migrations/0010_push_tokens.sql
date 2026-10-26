-- =====================================================================
-- 0010_push_tokens.sql
-- Registro del token de notificaciones desde la app.
--
-- POR QUE HACE FALTA UNA FUNCION SI YA HAY POLICY
-- `push_tokens` tiene policy propia (`user_id = auth.uid()`) y grants,
-- asi que el cliente ya puede escribir sus filas. El problema es otro: la
-- columna `token` es UNIQUE GLOBAL, y un mismo telefono puede cambiar de
-- dueno. Familia que comparte movil, empleado que devuelve el equipo,
-- alguien que se registra con otro correo.
--
-- En ese caso el upsert choca con la fila del dueno anterior, y la clausula
-- USING de la policy la evalua sobre la fila EXISTENTE, que no es del que
-- llama: el insert falla. El sintoma no es un error visible, es que ese
-- usuario nunca vuelve a recibir un aviso, y nadie se entera.
--
-- Esta funcion es SECURITY DEFINER solo para poder reasignar esa fila.
--
-- LO QUE ESO CONCEDE, DICHO CLARO
-- Quien presente un token se queda con el. Es aceptable porque un token de
-- push solo existe en el dispositivo que lo genero, y el efecto de
-- reclamarlo es que el anterior deja de recibir avisos en ESE aparato: no
-- da acceso a ningun dato. No se filtra nada del dueno anterior, ni
-- siquiera si existia.
-- =====================================================================

create or replace function public.register_push_token(
  p_token        text,
  p_platform     text,
  p_device_model text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_catalog
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'auth_required';
  end if;

  -- Un token de Expo es del estilo ExponentPushToken[xxxxxxxx]; el largo
  -- minimo solo descarta basura evidente.
  if p_token is null or length(p_token) < 10 or length(p_token) > 512 then
    raise exception 'invalid_token';
  end if;

  if p_platform not in ('android', 'ios', 'web') then
    raise exception 'invalid_platform';
  end if;

  insert into public.push_tokens (user_id, token, platform, device_model)
  values (v_user, p_token, p_platform, left(p_device_model, 120))
  on conflict (token) do update
    set user_id      = v_user,
        platform     = excluded.platform,
        device_model = excluded.device_model,
        last_seen_at = now();
end;
$$;

comment on function public.register_push_token is
  'Alta del token de push del dispositivo. SECURITY DEFINER unicamente '
  'para poder reasignar un token que ya estaba a nombre de otro usuario, '
  'caso real cuando un telefono cambia de manos. Ver 0010_push_tokens.sql.';

grant execute on function public.register_push_token(text, text, text) to authenticated;

-- Dar de baja el token es un delete normal: la policy ya deja borrar solo
-- las filas propias, y ahi no hay nada que reasignar.
