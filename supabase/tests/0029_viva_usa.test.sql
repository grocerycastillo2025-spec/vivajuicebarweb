-- =====================================================================
-- Pruebas de 0029: menú bilingüe y formas de pago de EE. UU.
-- El cobro con Stripe y PayPal (Edge Functions) se prueba en Node contra
-- esta misma base (supabase/functions/_shared/__tests__/cobro-db.test.ts).
-- =====================================================================

\set ON_ERROR_STOP on

\i supabase/seed/viva_juice_us.sql
begin;

insert into auth.users (id, email) values
  ('eeeeeeee-0000-4000-8000-000000000001', 'owner29@vivajuice.test'),
  ('eeeeeeee-0000-4000-8000-000000000002', 'cashier29@vivajuice.test'),
  ('eeeeeeee-0000-4000-8000-000000000003', 'customer29@example.test'),
  ('eeeeeeee-0000-4000-8000-000000000004', 'other29@example.test');
select app.grant_restaurant_role('owner29@vivajuice.test', '11111111-1111-4111-8111-111111111111', 'owner');
select app.grant_restaurant_role('cashier29@vivajuice.test', '11111111-1111-4111-8111-111111111111', 'staff');

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

-- Pedido para mañana a las 10:00 de Nueva York (dentro del horario).
create or replace function pg_temp.pedir(p_key text, p_pay text) returns uuid language plpgsql as $$
declare
  v_at timestamptz := ((now() at time zone 'America/New_York')::date + 1 + time '10:00')
                        at time zone 'America/New_York';
begin
  return (public.place_counter_order('22222222-2222-4222-8222-222222222222', p_key, v_at, false, null,
            '[{"clover_item_id":"viva-juice-green"}]'::jsonb, p_pay) ->> 'order_id')::uuid;
end $$;

-- ---------------------------------------------------------------------
-- Alta: dólares, Nueva York, catálogo propio y cobro en mostrador
-- ---------------------------------------------------------------------
do $$
declare s record;
begin
  select currency, timezone, catalog_source, payments_mode, payment_options into s
    from public.stores where id = '22222222-2222-4222-8222-222222222222';
  if s.currency <> 'USD' or s.timezone <> 'America/New_York' or s.catalog_source <> 'own' or s.payments_mode <> 'counter' then
    raise exception 'Alta incorrecta: %', row_to_json(s);
  end if;
  if (s.payment_options ->> 'zelle')::boolean or (s.payment_options ->> 'stripe')::boolean
     or (s.payment_options ->> 'paypal')::boolean or (s.payment_options ->> 'transfer')::boolean then
    raise exception 'Zelle, Stripe, PayPal y transferencia arrancan apagados';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Menú bilingüe
-- ---------------------------------------------------------------------
select pg_temp.como(null);
do $$
declare v record;
begin
  select name, i18n, category_name, category_i18n into v
    from public.menu_items where clover_item_id = 'viva-juice-green';
  if v.name <> 'Green Juice' or v.i18n -> 'es' ->> 'name' <> 'Jugo Verde'
     or v.category_i18n -> 'es' ->> 'name' <> '🍊 Jugos' then
    raise exception 'Traducción del menú: %', row_to_json(v);
  end if;
end $$;
reset role;

-- La traducción tiene forma fija: {"es": {...}}.
select pg_temp.esperar_error(
  $q$update public.catalog_items set i18n = '{"es": "Jugo"}' where clover_item_id = 'viva-juice-green'$q$,
  'i18n_check');
select pg_temp.esperar_error(
  $q$update public.catalog_items set i18n = '["es"]' where clover_item_id = 'viva-juice-green'$q$,
  'i18n_check');

-- El dueño edita la traducción; el cliente no.
select pg_temp.como('eeeeeeee-0000-4000-8000-000000000001');
update public.catalog_items set i18n = '{"es": {"name": "Jugo verdecito"}}' where clover_item_id = 'viva-juice-green';
select pg_temp.como('eeeeeeee-0000-4000-8000-000000000003');
update public.catalog_items set i18n = '{"es": {"name": "HACKEADO"}}' where clover_item_id = 'viva-juice-green';
reset role;
do $$ begin
  if (select i18n -> 'es' ->> 'name' from public.catalog_items where clover_item_id = 'viva-juice-green') <> 'Jugo verdecito' then
    raise exception 'El cliente pudo cambiar el menú, o el dueño no';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Zelle
-- ---------------------------------------------------------------------
select pg_temp.como('eeeeeeee-0000-4000-8000-000000000001');
select pg_temp.esperar_error(
  $q$update public.stores set zelle_recipient = '55 1234 5678' where id = '22222222-2222-4222-8222-222222222222'$q$,
  'zelle_recipient_check');
select pg_temp.esperar_error(
  $q$update public.stores set zelle_recipient = 'pagos@viva' where id = '22222222-2222-4222-8222-222222222222'$q$,
  'zelle_recipient_check');
-- Prendido sin datos: no se ofrece.
update public.stores set payment_options = payment_options || '{"zelle": true}' where id = '22222222-2222-4222-8222-222222222222';
reset role;
do $$ begin
  if app.pay_with_available('22222222-2222-4222-8222-222222222222', 'zelle') then
    raise exception 'Zelle sin datos no debe ofrecerse';
  end if;
end $$;
select pg_temp.como('eeeeeeee-0000-4000-8000-000000000001');
update public.stores set zelle_recipient = '+17324968863', zelle_name = 'VIVA Juice and Coffee'
 where id = '22222222-2222-4222-8222-222222222222';
reset role;
do $$ begin
  if not app.pay_with_available('22222222-2222-4222-8222-222222222222', 'zelle') then
    raise exception 'Zelle con datos debe ofrecerse';
  end if;
end $$;

-- El cliente paga con Zelle: queda por confirmar y solo el negocio lo marca.
select pg_temp.como('eeeeeeee-0000-4000-8000-000000000003');
create temp table _p29 as select pg_temp.pedir('k29-zelle', 'zelle') as id;
reset role;
do $$
declare o record;
begin
  select pay_with, status, currency, paid_confirmed_at into o from public.orders where id = (select id from _p29);
  if o.pay_with <> 'zelle' or o.status <> 'confirmed' or o.currency <> 'USD' or o.paid_confirmed_at is not null then
    raise exception 'Pedido Zelle: %', row_to_json(o);
  end if;
end $$;

select pg_temp.como('eeeeeeee-0000-4000-8000-000000000003');
select pg_temp.esperar_error(format('select public.set_order_paid(%L, true)', (select id from _p29)), 'staff_only');
-- Ni siquiera su propio pedido puede tocar el rastro del cobro en línea.
update public.orders set online_status = 'paid' where id = (select id from _p29);
reset role;
do $$ begin
  if (select online_status from public.orders where id = (select id from _p29)) is not null then
    raise exception 'El cliente escribió online_status';
  end if;
end $$;

select pg_temp.como('eeeeeeee-0000-4000-8000-000000000002');
select public.set_order_paid((select id from _p29), true);
reset role;
do $$ begin
  if (select paid_confirmed_at from public.orders where id = (select id from _p29)) is null then
    raise exception 'El cajero no pudo marcar el pago de Zelle';
  end if;
end $$;

-- El cajero tampoco escribe el rastro del cobro en línea (lo hace el
-- servidor): RLS no le deja actualizar pedidos y, si algún día una política
-- se lo permitiera, el trigger de 0029 lo frena.
select pg_temp.como('eeeeeeee-0000-4000-8000-000000000002');
update public.orders set online_payment_id = 'pi_falso' where id = (select id from _p29);
reset role;
do $$ begin
  if (select online_payment_id from public.orders where id = (select id from _p29)) is not null then
    raise exception 'El cajero escribió online_payment_id';
  end if;
end $$;
-- El trigger se prueba directo en 0030 (con una política temporal).


-- ---------------------------------------------------------------------
-- Stripe y PayPal: prendidos Y conectados
-- ---------------------------------------------------------------------
select pg_temp.como('eeeeeeee-0000-4000-8000-000000000001');
update public.stores set payment_options = payment_options || '{"stripe": true, "paypal": true}'
 where id = '22222222-2222-4222-8222-222222222222';
-- El dueño no puede "conectar" una cuenta a mano.
select pg_temp.esperar_error(
  $q$insert into public.payment_provider_accounts (store_id, provider, status)
     values ('22222222-2222-4222-8222-222222222222', 'stripe', 'active')$q$, null);
reset role;

do $$ begin
  if app.pay_with_available('22222222-2222-4222-8222-222222222222', 'stripe')
     or app.pay_with_available('22222222-2222-4222-8222-222222222222', 'paypal') then
    raise exception 'Sin cuenta conectada no debe ofrecerse el cobro en línea';
  end if;
end $$;
select pg_temp.como('eeeeeeee-0000-4000-8000-000000000003');
select pg_temp.esperar_error($q$select pg_temp.pedir('k29-stripe-no', 'stripe')$q$, 'payment_method_not_available');
reset role;

-- Lo que hace la Edge Function al "Probar conexión" con llaves buenas.
insert into public.payment_provider_accounts (store_id, provider, status, live_mode, account_label)
values ('22222222-2222-4222-8222-222222222222', 'paypal', 'active', false, 'sandbox');
select pg_temp.como('eeeeeeee-0000-4000-8000-000000000003');
create temp table _p29b as select pg_temp.pedir('k29-paypal', 'paypal') as id;
reset role;
do $$ begin
  if (select pay_with from public.orders where id = (select id from _p29b)) <> 'paypal' then
    raise exception 'Pedido PayPal no guardó la forma de pago';
  end if;
end $$;

-- Apagado gana a la cuenta conectada.
update public.stores set payment_options = payment_options || '{"paypal": false}'
 where id = '22222222-2222-4222-8222-222222222222';
do $$ begin
  if app.pay_with_available('22222222-2222-4222-8222-222222222222', 'paypal') then
    raise exception 'PayPal apagado no debe ofrecerse';
  end if;
end $$;

-- Nadie fuera del servidor consulta las cuentas con la función interna.
select pg_temp.como('eeeeeeee-0000-4000-8000-000000000003');
select pg_temp.esperar_error(
  $q$select app.provider_connected('22222222-2222-4222-8222-222222222222', 'stripe')$q$, null);
reset role;

rollback;
\echo 'OK 0029: menú bilingüe y pagos de EE. UU.'
