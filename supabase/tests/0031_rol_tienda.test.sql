-- =====================================================================
-- Pruebas de 0031: el rol Tienda (staff) agota productos y opciones y
-- pausa los pedidos, sin poder administrar nada más.
-- =====================================================================

\set ON_ERROR_STOP on

\i supabase/seed/viva_juice_us.sql
begin;

insert into auth.users (id, email) values
  ('abababab-0000-4000-8000-000000000001', 'owner31@vivajuice.test'),
  ('abababab-0000-4000-8000-000000000002', 'tienda31@vivajuice.test'),
  ('abababab-0000-4000-8000-000000000003', 'cliente31@example.test');
select app.grant_restaurant_role('owner31@vivajuice.test', '11111111-1111-4111-8111-111111111111', 'owner');
select app.grant_restaurant_role('tienda31@vivajuice.test', '11111111-1111-4111-8111-111111111111', 'staff');

create or replace function pg_temp.como(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
  if p_user is null then execute 'set local role anon'; else execute 'set local role authenticated'; end if;
end $$;

create or replace function pg_temp.esperar_error(p_sql text, p_contiene text) returns void language plpgsql as $$
begin
  execute p_sql;
  raise exception 'SE ESPERABA ERROR (%): %', p_contiene, p_sql;
exception when others then
  if sqlerrm like 'SE ESPERABA ERROR%' then raise; end if;
  if p_contiene is not null and position(p_contiene in sqlerrm) = 0 then
    raise exception 'Error distinto al esperado (%): %', p_contiene, sqlerrm;
  end if;
end $$;

create temp table _ids as
select (select id from public.catalog_items where clover_item_id = 'viva-juice-green') as item,
       (select id from public.catalog_modifiers where clover_modifier_id = 'viva-mod-milk-oat') as oat;
grant select on _ids to anon, authenticated;

-- ---------------------------------------------------------------------
-- La tienda agota y enciende, pausa y reanuda.
-- ---------------------------------------------------------------------
select pg_temp.como('abababab-0000-4000-8000-000000000002');
select public.set_item_available((select item from _ids), false);
select public.set_modifier_available((select oat from _ids), false);
select public.set_store_accepting_orders('22222222-2222-4222-8222-222222222222', false);
reset role;

do $$ begin
  if (select available from public.catalog_items where id = (select item from _ids))
     or (select available from public.catalog_modifiers where id = (select oat from _ids))
     or (select pickup_enabled from public.stores where id = '22222222-2222-4222-8222-222222222222') then
    raise exception 'La tienda no pudo agotar o pausar';
  end if;
  if (select is_available from public.menu_items where id = (select item from _ids)) then
    raise exception 'El producto agotado sigue disponible en el menú';
  end if;
end $$;

select pg_temp.como('abababab-0000-4000-8000-000000000002');
select public.set_item_available((select item from _ids), true);
select public.set_store_accepting_orders('22222222-2222-4222-8222-222222222222', true);
-- Ve lo que pasó, con su nombre.
do $$
declare n int;
begin
  select count(*) into n from public.store_activity('11111111-1111-4111-8111-111111111111')
   where who = 'tienda31@vivajuice.test';
  if n <> 5 then raise exception 'Actividad de la tienda: % (se esperaban 5)', n; end if;
end $$;

-- ---------------------------------------------------------------------
-- Pero NO administra: ni precios, ni nombres, ni horario, ni pagos,
-- ni impuestos, ni equipo.
-- ---------------------------------------------------------------------
update public.catalog_items set price_cents = 1, name = 'HACK' where id = (select item from _ids);
update public.stores set tax_rate = 0.2, payment_options = '{}', zelle_recipient = null
 where id = '22222222-2222-4222-8222-222222222222';
delete from public.store_hours where store_id = '22222222-2222-4222-8222-222222222222';
select pg_temp.esperar_error(
  $q$select public.add_team_member('11111111-1111-4111-8111-111111111111', 'cliente31@example.test', 'owner')$q$, null);
reset role;

do $$ begin
  if (select price_cents from public.catalog_items where id = (select item from _ids)) <> 850
     or (select name from public.catalog_items where id = (select item from _ids)) <> 'Green Juice' then
    raise exception 'La tienda cambió precio o nombre';
  end if;
  if (select tax_rate from public.stores where id = '22222222-2222-4222-8222-222222222222') <> 0 then
    raise exception 'La tienda cambió el impuesto';
  end if;
  if (select count(*) from public.store_hours where store_id = '22222222-2222-4222-8222-222222222222') <> 7 then
    raise exception 'La tienda borró el horario';
  end if;
  if exists (select 1 from public.restaurant_members m join auth.users u on u.id = m.user_id
              where u.email = 'cliente31@example.test') then
    raise exception 'La tienda dio acceso a alguien';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Un cliente no puede nada de esto.
-- ---------------------------------------------------------------------
select pg_temp.como('abababab-0000-4000-8000-000000000003');
select pg_temp.esperar_error($q$select public.set_item_available((select item from _ids), false)$q$, 'staff_only');
select pg_temp.esperar_error($q$select public.set_modifier_available((select oat from _ids), true)$q$, 'staff_only');
select pg_temp.esperar_error(
  $q$select public.set_store_accepting_orders('22222222-2222-4222-8222-222222222222', false)$q$, 'staff_only');
do $$ begin
  if exists (select 1 from public.store_activity('11111111-1111-4111-8111-111111111111')) then
    raise exception 'El cliente ve la actividad de la tienda';
  end if;
end $$;
reset role;

select pg_temp.como(null);
select pg_temp.esperar_error($q$select public.set_item_available((select item from _ids), false)$q$, null);
reset role;

-- El dueño también puede (es miembro).
select pg_temp.como('abababab-0000-4000-8000-000000000001');
select public.set_modifier_available((select oat from _ids), true);
reset role;

rollback;
\echo 'OK 0031: rol Tienda agota productos y opciones y pausa pedidos, sin administrar'
