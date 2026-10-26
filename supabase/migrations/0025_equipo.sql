-- =====================================================================
-- 0025_equipo.sql
-- El dueño administra a su equipo desde el panel: ver quien tiene
-- acceso, dar acceso de dueño o cajero a una cuenta y quitarlo.
--
-- Reglas, todas en el servidor:
--   * solo un dueño (o la plataforma) puede tocar el equipo;
--   * solo se puede dar acceso a una cuenta que ya existe (la persona se
--     registra primero en la app, como cliente);
--   * nadie se quita el acceso a si mismo ni deja el negocio sin dueño.
--
-- `app.grant_restaurant_role` (0020) sigue siendo la via de la
-- plataforma por SQL; esto es la via del dueño desde la app.
--
-- MIGRACION NUEVA. Las 0001 a 0024 estan aplicadas y no se tocan.
-- =====================================================================

create or replace function public.list_team(p_restaurant_id uuid)
returns table (user_id uuid, email text, name text, role text, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = public, app, pg_catalog
as $$
begin
  if not app.owns_restaurant(p_restaurant_id) then
    raise exception 'owner_only' using errcode = '42501';
  end if;
  return query
    select m.user_id, u.email::text,
           nullif(btrim(concat_ws(' ', p.first_name, p.last_name)), ''),
           m.role, m.created_at
      from public.restaurant_members m
      join auth.users u on u.id = m.user_id
      left join public.profiles p on p.id = m.user_id
     where m.restaurant_id = p_restaurant_id
     order by m.role, u.email;
end;
$$;

create or replace function public.add_team_member(p_restaurant_id uuid, p_email text, p_role text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, app, pg_catalog
as $$
declare
  v_user uuid;
begin
  if not app.owns_restaurant(p_restaurant_id) then
    raise exception 'owner_only' using errcode = '42501';
  end if;
  if p_role not in ('owner', 'staff') then
    raise exception 'invalid_role' using errcode = '22023';
  end if;

  select id into v_user from auth.users where lower(email) = lower(btrim(p_email));
  if v_user is null then
    raise exception 'account_not_found' using errcode = '22023';
  end if;

  insert into public.restaurant_members (restaurant_id, user_id, role)
  values (p_restaurant_id, v_user, p_role)
  on conflict (restaurant_id, user_id) do update set role = excluded.role;

  return jsonb_build_object('user_id', v_user, 'role', p_role);
end;
$$;

create or replace function public.remove_team_member(p_restaurant_id uuid, p_user_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public, app, pg_catalog
as $$
declare
  v_role text;
begin
  if not app.owns_restaurant(p_restaurant_id) then
    raise exception 'owner_only' using errcode = '42501';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'cannot_remove_self' using errcode = '22023';
  end if;

  select role into v_role from public.restaurant_members
   where restaurant_id = p_restaurant_id and user_id = p_user_id;
  if v_role is null then
    return;
  end if;
  if v_role = 'owner' and (
    select count(*) from public.restaurant_members
     where restaurant_id = p_restaurant_id and role = 'owner'
  ) <= 1 then
    raise exception 'last_owner' using errcode = '22023';
  end if;

  delete from public.restaurant_members
   where restaurant_id = p_restaurant_id and user_id = p_user_id;
end;
$$;

revoke execute on function public.list_team(uuid) from public, anon;
revoke execute on function public.add_team_member(uuid, text, text) from public, anon;
revoke execute on function public.remove_team_member(uuid, uuid) from public, anon;
grant execute on function public.list_team(uuid) to authenticated;
grant execute on function public.add_team_member(uuid, text, text) to authenticated;
grant execute on function public.remove_team_member(uuid, uuid) to authenticated;
