-- =====================================================================
-- Pruebas de 0022 (historias) y 0023 (estadisticas).
-- =====================================================================

\set ON_ERROR_STOP on

grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;

\i supabase/tests/fixtures/viva_jugos_mx.sql
\i supabase/tests/fixtures/viva_menu_base.sql
begin;

insert into auth.users (id, email) values
  ('cccccccc-0000-4000-8000-000000000001', 'duena3@viva.mx'),
  ('cccccccc-0000-4000-8000-000000000003', 'cliente3@correo.mx');
select app.grant_restaurant_role('duena3@viva.mx', '11111111-1111-4111-8111-111111111111', 'owner');

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

-- Una caducada y una programada, ademas de las 12 destacadas del menu.
insert into public.stories (restaurant_id, media_url, caption, starts_at, expires_at)
values
  ('11111111-1111-4111-8111-111111111111', 'https://x.mx/vieja.jpg', 'vieja',
   now() - interval '3 days', now() - interval '2 days'),
  ('11111111-1111-4111-8111-111111111111', 'https://x.mx/futura.jpg', 'futura',
   now() + interval '1 day', now() + interval '2 days');

-- ---------------------------------------------------------------------
-- El visitante sin sesion ve solo las vigentes
-- ---------------------------------------------------------------------
select pg_temp.como(null);
do $$ begin
  if (select count(*) from public.stories) <> 12 then
    raise exception 'El publico ve % historias, se esperaban 12', (select count(*) from public.stories);
  end if;
end $$;
select pg_temp.esperar_error(
  $$insert into public.stories (restaurant_id, media_url) values
    ('11111111-1111-4111-8111-111111111111', 'https://x.mx/a.jpg')$$, null);

-- Consultas y vistas: una por visitante, cosa y dia.
select public.track_event('item_view', (select id from public.catalog_items where clover_item_id = 'viva-viva-juice'), 'visitante-0001');
select public.track_event('item_view', (select id from public.catalog_items where clover_item_id = 'viva-viva-juice'), 'visitante-0001');
select public.track_event('item_view', (select id from public.catalog_items where clover_item_id = 'viva-viva-juice'), 'visitante-0002');
select public.track_event('item_view', (select id from public.catalog_items where clover_item_id = 'viva-cafe'), 'visitante-0001');
select public.track_event('story_view', (select id from public.stories where caption like 'Puro%'), 'visitante-0001');
select public.track_event('cualquier_cosa', gen_random_uuid(), 'visitante-0001');
select public.track_event('item_view', gen_random_uuid(), 'visitante-0001');

-- La tabla de eventos no se lee directo.
select pg_temp.esperar_error($$select * from public.analytics_events$$, 'permission denied');
select pg_temp.esperar_error(
  $$select public.business_stats('11111111-1111-4111-8111-111111111111', current_date, current_date)$$,
  'permission denied');
reset role;

-- ---------------------------------------------------------------------
-- El cliente no ve estadisticas
-- ---------------------------------------------------------------------
select pg_temp.como('cccccccc-0000-4000-8000-000000000003');
select pg_temp.esperar_error(
  $$select public.business_stats('11111111-1111-4111-8111-111111111111', current_date - 7, current_date)$$,
  'owner_only');
-- Ningun no-dueño pasa las comprobaciones de las funciones (antes de la
-- correccion de la 0023, owns_restaurant devolvia NULL y se saltaban).
do $$ begin
  if app.owns_restaurant('11111111-1111-4111-8111-111111111111') is distinct from false then
    raise exception 'owns_restaurant no devuelve false para un cliente';
  end if;
end $$;
-- Pide 2 Viva Juice de litro y un cafe.
do $$
declare
  v_at timestamptz := ((now() at time zone 'America/Mexico_City')::date + 1 + time '10:00')
                        at time zone 'America/Mexico_City';
begin
  perform public.place_counter_order(
    '33333333-3333-4333-8333-333333333333', 'estadisticas-0001', v_at, false, null,
    '[{"clover_item_id":"viva-viva-juice","quantity":2,"modifiers":["viva-mod-1l"]},
      {"clover_item_id":"viva-cafe","quantity":1}]'::jsonb);
end $$;
-- Formas de pago (0024): una apagada o una en linea no se aceptan.
select pg_temp.esperar_error(
  $$select public.place_counter_order('33333333-3333-4333-8333-333333333333', 'pago-0002',
      now() + interval '1 day', false, null, '[{"clover_item_id":"viva-cafe"}]'::jsonb, 'mercadopago')$$,
  'payment_method_not_available');
reset role;
-- Desde 0026 la transferencia necesita datos: se pone una CLABE.
update public.stores set payment_options = payment_options || '{"cash": false}',
       transfer_clabe = '002010077777777771'
 where id = '33333333-3333-4333-8333-333333333333';
select pg_temp.como('cccccccc-0000-4000-8000-000000000003');
select pg_temp.esperar_error(
  $$select public.place_counter_order('33333333-3333-4333-8333-333333333333', 'pago-0003',
      now() + interval '1 day', false, null, '[{"clover_item_id":"viva-cafe"}]'::jsonb, 'cash')$$,
  'payment_method_not_available');
do $$
declare
  v_at timestamptz := ((now() at time zone 'America/Mexico_City')::date + 1 + time '11:00')
                        at time zone 'America/Mexico_City';
  v jsonb;
begin
  v := public.place_counter_order('33333333-3333-4333-8333-333333333333', 'pago-0004', v_at, false, null,
         '[{"clover_item_id":"viva-cafe"}]'::jsonb, 'transfer');
  if (select pay_with from public.orders where id = (v ->> 'order_id')::uuid) <> 'transfer' then
    raise exception 'pay_with no se guardo';
  end if;
end $$;
reset role;
-- Ese segundo pedido no debe contar dos veces en las cuentas de abajo:
-- se cancela.
update public.orders set status = 'canceled' where idempotency_key = 'pago-0004';

-- ---------------------------------------------------------------------
-- La dueña ve todo y administra historias
-- ---------------------------------------------------------------------
select pg_temp.como('cccccccc-0000-4000-8000-000000000001');
do $$
declare v jsonb;
begin
  if (select count(*) from public.stories) <> 14 then
    raise exception 'La dueña deberia ver las 14 historias (vigentes, vieja y futura)';
  end if;
  insert into public.stories (restaurant_id, media_url, media_type, caption, expires_at)
  values ('11111111-1111-4111-8111-111111111111', 'https://x.mx/v.mp4', 'video', 'nuevo', now() + interval '1 day');

  v := public.business_stats('11111111-1111-4111-8111-111111111111',
                             (now() at time zone 'America/Mexico_City')::date - 6,
                             (now() at time zone 'America/Mexico_City')::date + 1);
  if (v ->> 'orders')::int <> 1 then raise exception 'pedidos: %', v; end if;
  -- 2 x (35 + 15) + 30 = 130 pesos
  if (v ->> 'revenue_cents')::bigint <> 13000 then raise exception 'ventas: %', v; end if;
  if (v ->> 'item_views')::int <> 3 then raise exception 'consultas: %', v ->> 'item_views'; end if;
  if (v ->> 'story_views')::int <> 1 then raise exception 'vistas: %', v ->> 'story_views'; end if;
  if v -> 'top_sold' -> 0 ->> 'name' <> 'Viva Juice' or (v -> 'top_sold' -> 0 ->> 'quantity')::int <> 2 then
    raise exception 'mas vendido: %', v -> 'top_sold';
  end if;
  if v -> 'top_viewed' -> 0 ->> 'name' <> 'Viva Juice' or (v -> 'top_viewed' -> 0 ->> 'views')::int <> 2 then
    raise exception 'mas consultado: %', v -> 'top_viewed';
  end if;
  if jsonb_array_length(v -> 'by_day') <> 8 then raise exception 'dias: %', v -> 'by_day'; end if;
end $$;
reset role;

rollback;
\echo 'OK 0022/0023: historias y estadisticas se comportan como se espera'
