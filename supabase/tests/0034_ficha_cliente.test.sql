-- =====================================================================
-- Pruebas de 0034: la ficha muestra foto y últimos 4 del teléfono; el
-- cliente edita los suyos y no los de otro.
-- =====================================================================

\set ON_ERROR_STOP on

\i supabase/seed/viva_juice_us.sql
begin;

insert into auth.users (id, email) values
  ('a4a4a4a4-0000-4000-8000-000000000002', 'tienda34@vivajuice.test'),
  ('a4a4a4a4-0000-4000-8000-000000000003', 'ana34@example.test'),
  ('a4a4a4a4-0000-4000-8000-000000000004', 'otro34@example.test');
insert into public.profiles (id) values
  ('a4a4a4a4-0000-4000-8000-000000000003'), ('a4a4a4a4-0000-4000-8000-000000000004')
on conflict (id) do nothing;
select app.grant_restaurant_role('tienda34@vivajuice.test', '11111111-1111-4111-8111-111111111111', 'staff');
insert into public.loyalty_programs (restaurant_id, enabled) values ('11111111-1111-4111-8111-111111111111', true)
on conflict (restaurant_id) do update set enabled = true;

create or replace function pg_temp.como(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
  execute 'set local role authenticated';
end $$;

create temp table _t (k text primary key, v text);
grant all on _t to authenticated;

-- El cliente pone su nombre, teléfono y foto.
select pg_temp.como('a4a4a4a4-0000-4000-8000-000000000003');
update public.profiles
   set first_name = 'Ana', phone = '(732) 496-8863',
       avatar_path = 'a4a4a4a4-0000-4000-8000-000000000003/avatar-1.jpg'
 where id = 'a4a4a4a4-0000-4000-8000-000000000003';
insert into _t select 'card', public.my_loyalty_card('11111111-1111-4111-8111-111111111111') ->> 'code';
-- No puede apuntar su foto a la carpeta de otro.
do $$ begin
  update public.profiles set avatar_path = 'a4a4a4a4-0000-4000-8000-000000000004/x.jpg'
   where id = 'a4a4a4a4-0000-4000-8000-000000000003';
  raise exception 'Aceptó una foto de otra carpeta';
exception when check_violation then null;
end $$;
-- Ni editar el perfil de otro (RLS: no lo ve, no cambia nada).
update public.profiles set first_name = 'HACK' where id = 'a4a4a4a4-0000-4000-8000-000000000004';
reset role;
do $$ begin
  if (select first_name from public.profiles where id = 'a4a4a4a4-0000-4000-8000-000000000004') is not null then
    raise exception 'Editó el perfil de otro';
  end if;
end $$;

-- La tienda lo ve en la ficha.
select pg_temp.como('a4a4a4a4-0000-4000-8000-000000000002');
do $$
declare s jsonb;
begin
  s := public.loyalty_lookup('22222222-2222-4222-8222-222222222222', (select v from _t where k = 'card'));
  if s ->> 'customer' <> 'Ana' or s ->> 'phone_last4' <> '8863'
     or s ->> 'avatar_path' <> 'a4a4a4a4-0000-4000-8000-000000000003/avatar-1.jpg' then
    raise exception 'Ficha: %', s;
  end if;
end $$;
reset role;

-- Sin teléfono completo, no inventa dígitos.
update public.profiles set phone = '12' where id = 'a4a4a4a4-0000-4000-8000-000000000003';
select pg_temp.como('a4a4a4a4-0000-4000-8000-000000000002');
do $$ begin
  if public.loyalty_lookup('22222222-2222-4222-8222-222222222222', (select v from _t where k = 'card')) ->> 'phone_last4' is not null then
    raise exception 'Mostró dígitos de un teléfono incompleto';
  end if;
end $$;
reset role;

-- Fotos en storage (solo donde existe el esquema).
do $$
begin
  if to_regclass('storage.objects') is null then return; end if;
  insert into storage.objects (bucket_id, name) values
    ('avatars', 'a4a4a4a4-0000-4000-8000-000000000003/avatar-1.jpg'),
    ('avatars', 'a4a4a4a4-0000-4000-8000-000000000004/avatar-1.jpg');
end $$;
select pg_temp.como('a4a4a4a4-0000-4000-8000-000000000002');
do $$ begin
  if to_regclass('storage.objects') is null then return; end if;
  -- La tienda ve la de Ana (tiene tarjeta) y no la del otro (no tiene).
  if (select count(*) from storage.objects where bucket_id = 'avatars') <> 1 then
    raise exception 'La tienda ve fotos que no debe: %', (select count(*) from storage.objects where bucket_id = 'avatars');
  end if;
end $$;
reset role;
select pg_temp.como('a4a4a4a4-0000-4000-8000-000000000004');
do $$ begin
  if to_regclass('storage.objects') is null then return; end if;
  if exists (select 1 from storage.objects where name like 'a4a4a4a4-0000-4000-8000-000000000003/%') then
    raise exception 'Un cliente ve la foto de otro';
  end if;
end $$;
reset role;

rollback;
\echo 'OK 0034: la ficha muestra foto y últimos 4 del teléfono; cada quien edita lo suyo'
