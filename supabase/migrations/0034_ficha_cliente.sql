-- =====================================================================
-- 0034_ficha_cliente.sql
-- Para que la tienda reconozca al cliente al escanear su tarjeta:
--   - foto de perfil (la sube el cliente en Perfil → Editar perfil),
--   - últimos 4 dígitos de su teléfono.
--
-- La foto vive en un bucket PRIVADO `avatars`, en la carpeta del propio
-- cliente (<user_id>/...). La puede ver él mismo y quien trabaja en un
-- negocio donde ese cliente tiene tarjeta. Nadie más.
--
-- MIGRACION NUEVA. Idempotente.
-- =====================================================================

alter table public.profiles add column if not exists avatar_path text;
alter table public.profiles drop constraint if exists profiles_avatar_path_check;
alter table public.profiles add constraint profiles_avatar_path_check
  check (avatar_path is null or (avatar_path like id::text || '/%' and length(avatar_path) <= 200));

alter table public.profiles drop constraint if exists profiles_phone_len_check;
alter table public.profiles add constraint profiles_phone_len_check
  check (phone is null or length(phone) <= 30);

-- ¿Quien llama trabaja en algún negocio donde este cliente tiene tarjeta?
-- SECURITY DEFINER porque la tienda no puede leer `loyalty_accounts` ajenas.
create or replace function app.staff_sees_customer(p_user_folder text)
returns boolean
language sql
stable
security definer
set search_path = public, app, pg_catalog
as $$
  select exists (
    select 1 from public.loyalty_accounts a
     where a.user_id::text = p_user_folder
       and coalesce(app.works_at_restaurant(a.tenant_id), false)
  );
$$;
revoke execute on function app.staff_sees_customer(text) from public, anon;
grant execute on function app.staff_sees_customer(text) to authenticated;

-- ---------------------------------------------------------------------
-- Bucket y permisos (si hay esquema storage; en CI con Postgres puro no).
-- ---------------------------------------------------------------------
do $$
begin
  if to_regclass('storage.objects') is null then
    raise notice 'Esquema storage no disponible: se omite la parte de fotos de 0034.';
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('avatars', 'avatars', false, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
  on conflict (id) do update set public = false, file_size_limit = 2097152,
    allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

  drop policy if exists "customers manage their avatar" on storage.objects;
  create policy "customers manage their avatar" on storage.objects
    for all to authenticated
    using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
    with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

  drop policy if exists "staff see avatars of their customers" on storage.objects;
  create policy "staff see avatars of their customers" on storage.objects
    for select to authenticated
    using (
      bucket_id = 'avatars'
      and app.staff_sees_customer((storage.foldername(name))[1])
    );
end;
$$;

-- ---------------------------------------------------------------------
-- La ficha que ve la tienda: lo de 0032 más foto y últimos 4 del teléfono.
-- ---------------------------------------------------------------------
create or replace function app.card_state(p_account public.loyalty_accounts, p_program public.loyalty_programs)
returns jsonb
language sql
stable
security definer
set search_path = public, app, pg_catalog
as $$
  with last_visit as (
    select max(t.created_at) as at, count(*) as visits
      from public.loyalty_transactions t
     where t.account_id = p_account.id and t.source = 'visit'
  ),
  person as (
    select nullif(btrim(concat_ws(' ', p.first_name, p.last_name)), '') as name,
           u.email,
           p.avatar_path,
           -- Solo los últimos 4 dígitos: para reconocerlo, no para llamarle.
           nullif(right(regexp_replace(coalesce(p.phone, ''), '[^0-9]', '', 'g'), 4), '') as phone_last4
      from auth.users u
      left join public.profiles p on p.id = u.id
     where u.id = p_account.user_id
  )
  select jsonb_build_object(
    'card', p_account.card_code,
    'customer', coalesce((select name from person),
                         -- Sin nombre: el correo a medias (ana•••@gmail.com).
                         (select regexp_replace(email, '^(.{1,3})[^@]*', '\1•••') from person),
                         '—'),
    'avatar_path', (select avatar_path from person),
    'phone_last4', (select case when length(phone_last4) = 4 then phone_last4 end from person),
    'balance', p_account.points_balance,
    'lifetime', p_account.lifetime_points,
    'visits', (select visits from last_visit),
    'last_visit_at', (select at from last_visit),
    'next_visit_at', (select at + make_interval(hours => p_program.visit_cooldown_hours) from last_visit),
    'can_visit', coalesce((select at + make_interval(hours => p_program.visit_cooldown_hours) <= now() from last_visit), true),
    'points_per_visit', p_program.points_per_visit,
    'rewards_given', (select count(*) from public.reward_redemptions r
                       where r.user_id = p_account.user_id and r.tenant_id = p_account.tenant_id and r.status = 'used'),
    'rewards', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', w.id, 'name', w.name, 'i18n', w.i18n, 'cost', w.cost_points,
               'eligible', p_account.points_balance >= w.cost_points,
               'missing', greatest(w.cost_points - p_account.points_balance, 0))
             order by w.cost_points)
        from public.rewards w
       where w.tenant_id = p_account.tenant_id and w.active), '[]'::jsonb)
  );
$$;
revoke execute on function app.card_state(public.loyalty_accounts, public.loyalty_programs) from public, anon, authenticated;
