-- =====================================================================
-- Pruebas de 0026: Mercado Pago con liga, transferencia con CLABE y
-- "pago recibido".
-- =====================================================================

\set ON_ERROR_STOP on

grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;

\i supabase/tests/fixtures/viva_jugos_mx.sql
\i supabase/tests/fixtures/viva_menu_base.sql
begin;

insert into auth.users (id, email) values
  ('dddddddd-0000-4000-8000-000000000001', 'duena6@viva.mx'),
  ('dddddddd-0000-4000-8000-000000000002', 'cajero6@viva.mx'),
  ('dddddddd-0000-4000-8000-000000000003', 'cliente6@correo.mx');
select app.grant_restaurant_role('duena6@viva.mx', '11111111-1111-4111-8111-111111111111', 'owner');
select app.grant_restaurant_role('cajero6@viva.mx', '11111111-1111-4111-8111-111111111111', 'staff');

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

create or replace function pg_temp.pedir(p_key text, p_pay text) returns uuid language plpgsql as $$
declare
  v_at timestamptz := ((now() at time zone 'America/Mexico_City')::date + 1 + time '10:00')
                        at time zone 'America/Mexico_City';
begin
  return (public.place_counter_order('33333333-3333-4333-8333-333333333333', p_key, v_at, false, null,
            '[{"clover_item_id":"viva-cafe"}]'::jsonb, p_pay) ->> 'order_id')::uuid;
end $$;

-- ---------------------------------------------------------------------
-- CLABE
-- ---------------------------------------------------------------------
do $$ begin
  if not app.clabe_valid('002010077777777771') or app.clabe_valid('002010077777777772')
     or app.clabe_valid('0020100777') or app.clabe_valid('00201007777777777a') then
    raise exception 'clabe_valid falla';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- La dueña configura: datos mal escritos se rechazan
-- ---------------------------------------------------------------------
select pg_temp.como('dddddddd-0000-4000-8000-000000000001');
select pg_temp.esperar_error(
  $$update public.stores set transfer_clabe = '002010077777777772' where id = '33333333-3333-4333-8333-333333333333'$$,
  'check');
select pg_temp.esperar_error(
  $$update public.stores set mercadopago_link = 'https://mercadopago.com.mx.estafa.com/x' where id = '33333333-3333-4333-8333-333333333333'$$,
  'check');
-- Prende transferencia y Mercado Pago SIN datos todavía.
update public.stores set payment_options = payment_options || '{"transfer": true, "mercadopago": true}',
       transfer_clabe = null, transfer_info = null, mercadopago_link = null
 where id = '33333333-3333-4333-8333-333333333333';

-- Sin datos no se pueden elegir aunque estén prendidas.
select pg_temp.como('dddddddd-0000-4000-8000-000000000003');
select pg_temp.esperar_error($$select pg_temp.pedir('pagomp-0001', 'transfer')$$, 'payment_method_not_available');
select pg_temp.esperar_error($$select pg_temp.pedir('pagomp-0002', 'mercadopago')$$, 'payment_method_not_available');
select pg_temp.esperar_error($$select pg_temp.pedir('pagomp-0003', 'stripe')$$, 'payment_method_not_available');
select pg_temp.esperar_error($$select pg_temp.pedir('pagomp-0004', null)$$, 'payment_method_not_available');

-- El cliente no puede cambiar los datos de pago del negocio.
update public.stores set transfer_clabe = '002010077777777771' where id = '33333333-3333-4333-8333-333333333333';
reset role;
do $$ begin
  if (select transfer_clabe from public.stores where id = '33333333-3333-4333-8333-333333333333') is not null then
    raise exception 'Un cliente cambio la CLABE';
  end if;
end $$;

-- La dueña pone los datos.
select pg_temp.como('dddddddd-0000-4000-8000-000000000001');
update public.stores
   set transfer_bank = 'BBVA', transfer_holder = 'VIVA Jugos y Café',
       transfer_clabe = '002010077777777771',
       mercadopago_link = 'https://link.mercadopago.com.mx/vivajugos'
 where id = '33333333-3333-4333-8333-333333333333';

-- 0027: las ligas cortas mpago.mx también se aceptan.
update public.stores set mercadopago_link = 'https://mpago.mx/1a2B3c'
 where id = '33333333-3333-4333-8333-333333333333';
update public.stores set mercadopago_link = 'https://link.mercadopago.com.mx/vivajugos'
 where id = '33333333-3333-4333-8333-333333333333';

-- El público ve los datos para pagar.
select pg_temp.como(null);
do $$ begin
  if (select mercadopago_link from public.stores where id = '33333333-3333-4333-8333-333333333333')
       is distinct from 'https://link.mercadopago.com.mx/vivajugos' then
    raise exception 'El cliente no ve la liga de Mercado Pago';
  end if;
end $$;

-- Ahora sí: transferencia y Mercado Pago.
select pg_temp.como('dddddddd-0000-4000-8000-000000000003');
do $$
declare v_t uuid; v_m uuid;
begin
  v_t := pg_temp.pedir('pagomp-0005', 'transfer');
  v_m := pg_temp.pedir('pagomp-0006', 'mercadopago');
  if (select pay_with from public.orders where id = v_m) <> 'mercadopago'
     or (select paid_confirmed_at from public.orders where id = v_t) is not null then
    raise exception 'Pedidos con forma de pago mal guardados';
  end if;
end $$;

-- El cliente no puede marcar su propio pedido como pagado.
select pg_temp.esperar_error(
  $$select public.set_order_paid((select id from public.orders where idempotency_key = 'pagomp-0006'), true)$$,
  'staff_only');
update public.orders set paid_confirmed_at = now() where idempotency_key = 'pagomp-0006';
reset role;
do $$ begin
  if (select paid_confirmed_at from public.orders where idempotency_key = 'pagomp-0006') is not null then
    raise exception 'El cliente se marco pagado';
  end if;
end $$;

-- El cajero sí, y puede deshacerlo.
select pg_temp.como('dddddddd-0000-4000-8000-000000000002');
select public.set_order_paid((select id from public.orders where idempotency_key = 'pagomp-0006'), true);
reset role;
do $$ begin
  if (select paid_confirmed_at is null or paid_confirmed_by <> 'dddddddd-0000-4000-8000-000000000002'
        from public.orders where idempotency_key = 'pagomp-0006') then
    raise exception 'El cajero no pudo marcar el pago';
  end if;
end $$;
select pg_temp.como('dddddddd-0000-4000-8000-000000000002');
select public.set_order_paid((select id from public.orders where idempotency_key = 'pagomp-0006'), false);
reset role;
do $$ begin
  if (select paid_confirmed_at from public.orders where idempotency_key = 'pagomp-0006') is not null then
    raise exception 'No se desmarco el pago';
  end if;
end $$;

-- Apagar Mercado Pago lo quita aunque la liga siga puesta.
update public.stores set payment_options = payment_options || '{"mercadopago": false}'
 where id = '33333333-3333-4333-8333-333333333333';
select pg_temp.como('dddddddd-0000-4000-8000-000000000003');
select pg_temp.esperar_error($$select pg_temp.pedir('pagomp-0007', 'mercadopago')$$, 'payment_method_not_available');
reset role;

rollback;
\echo 'OK 0026: Mercado Pago con liga, transferencia con CLABE y pago recibido'
