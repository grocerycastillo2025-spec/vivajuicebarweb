-- =====================================================================
-- Pruebas de la 0020: dueño, empleado, cliente y extraño contra un
-- negocio sin Clover, y una sucursal CON Clover que no debe abrirse.
--
-- Se corre en CI despues de las migraciones (job `database`). Cada
-- comprobacion lanza una excepcion si falla; el archivo entero corre en
-- una transaccion que se deshace al final.
-- =====================================================================

\set ON_ERROR_STOP on

-- En Supabase los roles de la API pueden llamar a auth.uid(); el arnes de
-- CI crea el esquema `auth` sin ese permiso.
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;

begin;

-- ---------------------------------------------------------------------
-- Datos
-- ---------------------------------------------------------------------
\i supabase/tests/fixtures/viva_jugos_mx.sql
-- El seed trae su propio begin/commit; se abre otra transaccion.
begin;

insert into auth.users (id, email) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'duena@viva.mx'),
  ('aaaaaaaa-0000-4000-8000-000000000002', 'cajero@viva.mx'),
  ('aaaaaaaa-0000-4000-8000-000000000003', 'cliente@correo.mx'),
  ('aaaaaaaa-0000-4000-8000-000000000004', 'otro-dueno@otro.mx');

select app.grant_restaurant_role('duena@viva.mx',  '11111111-1111-4111-8111-111111111111', 'owner');
select app.grant_restaurant_role('cajero@viva.mx', '11111111-1111-4111-8111-111111111111', 'staff');

-- Otro negocio CON Clover, con su propio dueño.
insert into public.restaurants (id, name, slug, status)
values ('99999999-9999-4999-8999-999999999999', 'Otro', 'otro-negocio', 'active');
insert into public.stores (id, restaurant_id, name, slug, status, setup_checklist, payments_mode, catalog_source)
values ('88888888-8888-4888-8888-888888888888', '99999999-9999-4999-8999-999999999999',
        'Otro', 'otro', 'draft', '{}'::jsonb, 'counter', 'clover');
insert into public.catalog_items (store_id, clover_item_id, name, price_cents)
values ('88888888-8888-4888-8888-888888888888', 'CLOVER-1', 'De Clover', 100);
select app.grant_restaurant_role('otro-dueno@otro.mx', '99999999-9999-4999-8999-999999999999', 'owner');

-- Ayudante: actuar como un usuario.
create or replace function pg_temp.como(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
  execute 'set local role authenticated';
  if current_user <> 'authenticated' or auth.uid() is distinct from p_user then
    raise exception 'El ayudante no cambio de usuario';
  end if;
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

-- ---------------------------------------------------------------------
-- 1. LA DUEÑA ARMA SU MENU
-- ---------------------------------------------------------------------
select pg_temp.como('aaaaaaaa-0000-4000-8000-000000000001');

insert into public.catalog_categories (store_id, name, sort_order)
values ('33333333-3333-4333-8333-333333333333', 'Jugos', 10);

insert into public.catalog_items (store_id, category_id, name, price_cents)
select '33333333-3333-4333-8333-333333333333', c.id, 'Jugo Verde', 6500
from public.catalog_categories c where c.name = 'Jugos';

insert into public.app_item_overrides (store_id, clover_item_id, marketing_copy, featured)
select store_id, clover_item_id, 'Nopal, piña, apio', true
from public.catalog_items where name = 'Jugo Verde';

do $$ begin
  if (select clover_item_id from public.catalog_items where name = 'Jugo Verde') not like 'own-%' then
    raise exception 'El id del producto propio deberia generarse con prefijo own-';
  end if;
  if (select description from public.menu_items where name = 'Jugo Verde') <> 'Nopal, piña, apio' then
    raise exception 'menu_items no mezcla el override del producto propio';
  end if;
end $$;

update public.store_hours set opens_at = '07:00' where store_id = '33333333-3333-4333-8333-333333333333';
update public.app_settings set primary_color = '#123456' where restaurant_id = '11111111-1111-4111-8111-111111111111';
update public.stores set phone = '+525512345678' where id = '33333333-3333-4333-8333-333333333333';

-- Lo que NO puede tocar ni siendo dueña.
select pg_temp.esperar_error(
  $$update public.stores set payments_mode = 'live' where id = '33333333-3333-4333-8333-333333333333'$$,
  'store_platform_column');
select pg_temp.esperar_error(
  $$update public.stores set catalog_source = 'clover' where id = '33333333-3333-4333-8333-333333333333'$$,
  'store_platform_column');
select pg_temp.esperar_error(
  $$update public.restaurants set status = 'disabled' where id = '11111111-1111-4111-8111-111111111111'$$,
  'restaurant_platform_column');
select pg_temp.esperar_error(
  $$insert into public.restaurant_members (restaurant_id, user_id) values
    ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-000000000003')$$,
  null);

-- Ni el negocio de otro.
do $$ begin
  update public.catalog_items set price_cents = 1 where clover_item_id = 'CLOVER-1';
  if exists (select 1 from public.catalog_items where clover_item_id = 'CLOVER-1' and price_cents = 1) then
    raise exception 'La dueña de VIVA pudo cambiar un precio de otro negocio';
  end if;
end $$;
reset role;

-- ---------------------------------------------------------------------
-- 2. EL CATALOGO DE CLOVER NO SE EDITA, NI POR SU DUEÑO
-- ---------------------------------------------------------------------
select pg_temp.como('aaaaaaaa-0000-4000-8000-000000000004');
do $$ begin
  update public.catalog_items set price_cents = 1 where clover_item_id = 'CLOVER-1';
  if exists (select 1 from public.catalog_items where clover_item_id = 'CLOVER-1' and price_cents = 1) then
    raise exception 'Un dueño pudo editar un catalogo espejo de Clover';
  end if;
end $$;
reset role;

-- ---------------------------------------------------------------------
-- 3. EL CLIENTE SOLO VE Y PIDE
-- ---------------------------------------------------------------------
select pg_temp.como('aaaaaaaa-0000-4000-8000-000000000003');

do $$ begin
  update public.catalog_items set price_cents = 1 where name = 'Jugo Verde';
  update public.app_settings set primary_color = '#000000';
  update public.store_hours set opens_at = '00:00';
  if exists (select 1 from public.catalog_items where name = 'Jugo Verde' and price_cents = 1)
     or exists (select 1 from public.app_settings where primary_color = '#000000')
     or exists (select 1 from public.store_hours where opens_at = '00:00') then
    raise exception 'Un cliente pudo editar el negocio';
  end if;
end $$;

select pg_temp.esperar_error(
  $$insert into public.catalog_items (store_id, name, price_cents)
    values ('33333333-3333-4333-8333-333333333333', 'Gratis', 0)$$,
  null);

-- Pide para mañana a las 10:00 hora de la tienda (abierta de 7 a 20).
do $$
declare
  v_item text;
  v_at   timestamptz := ((now() at time zone 'America/Mexico_City')::date + 1 + time '10:00')
                          at time zone 'America/Mexico_City';
  v_res  jsonb;
begin
  select clover_item_id into v_item from public.catalog_items where name = 'Jugo Verde';
  v_res := public.place_counter_order(
    '33333333-3333-4333-8333-333333333333', 'prueba-pedido-0001', v_at, false, 'sin hielo',
    jsonb_build_array(jsonb_build_object('clover_item_id', v_item, 'quantity', 2))
  );
  if v_res ->> 'status' <> 'confirmed' or v_res ->> 'payment_method' <> 'counter'
     or (v_res ->> 'total_cents')::bigint <> 13000 or v_res ->> 'currency' <> 'MXN' then
    raise exception 'Pedido de mostrador mal creado: %', v_res;
  end if;
  -- Mismo intento: mismo pedido, no uno nuevo.
  if public.place_counter_order(
       '33333333-3333-4333-8333-333333333333', 'prueba-pedido-0001', v_at, false, 'sin hielo',
       jsonb_build_array(jsonb_build_object('clover_item_id', v_item, 'quantity', 2))
     ) ->> 'order_id' <> v_res ->> 'order_id' then
    raise exception 'El reintento creo un segundo pedido';
  end if;
end $$;

-- El cliente no mueve su propio pedido.
select pg_temp.esperar_error(
  $$select public.set_order_status((select id from public.orders limit 1), 'completed')$$,
  'order_not_found');

-- Y no puede pedir en mostrador a una sucursal con Clover.
select pg_temp.esperar_error(
  $$select public.place_counter_order('88888888-8888-4888-8888-888888888888', 'prueba-pedido-0002',
      now() + interval '1 day', false, null, '[{"clover_item_id":"CLOVER-1"}]'::jsonb)$$,
  'counter_orders_not_allowed');
reset role;

-- ---------------------------------------------------------------------
-- 4. EL CAJERO VE Y MUEVE PEDIDOS, PERO NO EDITA EL MENU
-- ---------------------------------------------------------------------
select pg_temp.como('aaaaaaaa-0000-4000-8000-000000000002');

do $$
declare v_id uuid;
begin
  select id into v_id from public.orders where idempotency_key = 'prueba-pedido-0001';
  if v_id is null then raise exception 'El cajero no ve los pedidos de su negocio'; end if;
  if (select count(*) from public.order_items where order_id = v_id) <> 1 then
    raise exception 'El cajero no ve las lineas del pedido';
  end if;

  perform public.set_order_status(v_id, 'preparing');
  perform public.set_order_status(v_id, 'ready');

  begin
    perform public.set_order_status(v_id, 'preparing');
    raise exception 'Se permitio volver de ready a preparing';
  exception when others then
    if sqlerrm not like 'transition_not_allowed%' then raise; end if;
  end;

  perform public.set_order_status(v_id, 'completed');
  if (select completed_at from public.orders where id = v_id) is null then
    raise exception 'completed_at no se sello';
  end if;

  update public.catalog_items set price_cents = 1 where name = 'Jugo Verde';
  if exists (select 1 from public.catalog_items where name = 'Jugo Verde' and price_cents = 1) then
    raise exception 'El cajero (staff) pudo editar el menu';
  end if;
end $$;
reset role;

-- ---------------------------------------------------------------------
-- 5. EL DUEÑO DE OTRO NEGOCIO NO VE LOS PEDIDOS DE VIVA
-- ---------------------------------------------------------------------
select pg_temp.como('aaaaaaaa-0000-4000-8000-000000000004');
do $$ begin
  if exists (select 1 from public.orders) then
    raise exception 'Un dueño ve pedidos de otro negocio';
  end if;
end $$;
reset role;

rollback;
\echo 'OK 0020: dueño, empleado, cliente y extraño se comportan como se espera'

-- =====================================================================
-- 0025: equipo desde el panel
-- =====================================================================
begin;
insert into auth.users (id, email) values
  ('dddddddd-0000-4000-8000-000000000001', 'jefa@viva.mx'),
  ('dddddddd-0000-4000-8000-000000000002', 'nuevo-cajero@viva.mx'),
  ('dddddddd-0000-4000-8000-000000000003', 'curioso@correo.mx');
select app.grant_restaurant_role('jefa@viva.mx', '11111111-1111-4111-8111-111111111111', 'owner');

create or replace function pg_temp.como2(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  execute 'set local role authenticated';
end $$;

create or replace function pg_temp.falla(p_sql text, p_contiene text) returns void language plpgsql as $$
begin
  execute p_sql;
  raise exception 'SE ESPERABA ERROR (%): %', p_contiene, p_sql;
exception when others then
  if sqlerrm like 'SE ESPERABA ERROR%' then raise; end if;
  if position(p_contiene in sqlerrm) = 0 then
    raise exception 'Error distinto al esperado (%): %', p_contiene, sqlerrm;
  end if;
end $$;

-- Un cliente no ve ni toca el equipo.
select pg_temp.como2('dddddddd-0000-4000-8000-000000000003');
select pg_temp.falla($$select * from public.list_team('11111111-1111-4111-8111-111111111111')$$, 'owner_only');
select pg_temp.falla($$select public.add_team_member('11111111-1111-4111-8111-111111111111', 'curioso@correo.mx', 'owner')$$, 'owner_only');
reset role;

-- La dueña agrega un cajero, no puede quitarse a si misma ni dejar el
-- negocio sin dueño, y quita al cajero.
select pg_temp.como2('dddddddd-0000-4000-8000-000000000001');
select public.add_team_member('11111111-1111-4111-8111-111111111111', 'NUEVO-CAJERO@viva.mx', 'staff');
select pg_temp.falla($$select public.add_team_member('11111111-1111-4111-8111-111111111111', 'no-existe@x.mx', 'staff')$$, 'account_not_found');
select pg_temp.falla($$select public.remove_team_member('11111111-1111-4111-8111-111111111111', 'dddddddd-0000-4000-8000-000000000001')$$, 'cannot_remove_self');
do $$ begin
  if not exists (select 1 from public.list_team('11111111-1111-4111-8111-111111111111') where email = 'nuevo-cajero@viva.mx' and role = 'staff') then
    raise exception 'El cajero no aparece en el equipo';
  end if;
  perform public.remove_team_member('11111111-1111-4111-8111-111111111111', 'dddddddd-0000-4000-8000-000000000002');
  if exists (select 1 from public.list_team('11111111-1111-4111-8111-111111111111') where email = 'nuevo-cajero@viva.mx') then
    raise exception 'El cajero sigue en el equipo';
  end if;
end $$;
reset role;
rollback;
\echo 'OK 0025: el dueño administra su equipo y nadie mas'
