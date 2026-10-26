-- =====================================================================
-- Pruebas de 0030: impuesto por producto y recargo por forma de pago.
-- Una sola cantidad a pagar: total = subtotal + impuesto + recargo.
-- =====================================================================

\set ON_ERROR_STOP on

\i supabase/seed/viva_juice_us.sql
begin;

insert into auth.users (id, email) values
  ('ffffffff-0000-4000-8000-000000000001', 'owner30@vivajuice.test'),
  ('ffffffff-0000-4000-8000-000000000002', 'customer30@example.test');
select app.grant_restaurant_role('owner30@vivajuice.test', '11111111-1111-4111-8111-111111111111', 'owner');

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

-- Pedido para mañana a las 10:00 de Nueva York.
create or replace function pg_temp.pedir(p_key text, p_pay text, p_items jsonb) returns jsonb language plpgsql as $$
declare
  v_at timestamptz := ((now() at time zone 'America/New_York')::date + 1 + time '10:00')
                        at time zone 'America/New_York';
begin
  return public.place_counter_order('22222222-2222-4222-8222-222222222222', p_key, v_at, false, null, p_items, p_pay);
end $$;

-- ---------------------------------------------------------------------
-- Sin configurar: sin impuesto ni recargo, el total es el subtotal.
-- ---------------------------------------------------------------------
select pg_temp.como('ffffffff-0000-4000-8000-000000000002');
do $$
declare r jsonb := pg_temp.pedir('k30-prueba-a', 'cash', '[{"clover_item_id":"viva-juice-green"}]');
begin
  if (r->>'subtotal_cents')::int <> 850 or (r->>'tax_cents')::int <> 0
     or (r->>'surcharge_cents')::int <> 0 or (r->>'total_cents')::int <> 850 then
    raise exception 'Sin configurar: %', r;
  end if;
end $$;
reset role;

-- ---------------------------------------------------------------------
-- El dueño configura: 6.625% de impuesto, 3% con tarjeta en línea y en
-- mostrador; un producto exento (el agua fresca) y uno con tasa propia.
-- ---------------------------------------------------------------------
select pg_temp.como('ffffffff-0000-4000-8000-000000000001');
update public.stores
   set tax_rate = 0.06625,
       payment_surcharges = '{"stripe": 0.03, "card_counter": 0.03}',
       zelle_recipient = 'pagos@vivajuice.test',
       payment_options = payment_options || '{"zelle": true}'
 where id = '22222222-2222-4222-8222-222222222222';
update public.catalog_items set taxable = false where clover_item_id = 'viva-drink-agua';
update public.catalog_items set tax_rate_override = 0.1 where clover_item_id = 'viva-bowl-acai';
-- Valores fuera de rango se rechazan.
select pg_temp.esperar_error(
  $q$update public.stores set tax_rate = 0.5 where id = '22222222-2222-4222-8222-222222222222'$q$, 'stores_tax_rate_check');
select pg_temp.esperar_error(
  $q$update public.stores set payment_surcharges = '{"stripe": 0.5}' where id = '22222222-2222-4222-8222-222222222222'$q$,
  'stores_payment_surcharges_check');
select pg_temp.esperar_error(
  $q$update public.stores set payment_surcharges = '{"bitcoin": 0.01}' where id = '22222222-2222-4222-8222-222222222222'$q$,
  'stores_payment_surcharges_check');
reset role;

-- El cliente no puede configurar nada de esto.
select pg_temp.como('ffffffff-0000-4000-8000-000000000002');
update public.stores set tax_rate = 0 where id = '22222222-2222-4222-8222-222222222222';
update public.catalog_items set taxable = false where clover_item_id = 'viva-juice-green';
reset role;
do $$ begin
  if (select tax_rate from public.stores where id = '22222222-2222-4222-8222-222222222222') <> 0.06625
     or not (select taxable from public.catalog_items where clover_item_id = 'viva-juice-green') then
    raise exception 'El cliente cambió la configuración de impuestos';
  end if;
end $$;

select pg_temp.como('ffffffff-0000-4000-8000-000000000002');
do $$
declare r jsonb;
begin
  -- 2 Green Juice (1700) + agua fresca exenta (450) + Acai Bowl con 10% (1250).
  -- Impuesto: 1700 × 0.06625 = 112.625 ; 1250 × 0.10 = 125 → 237.625 → 238.
  -- Efectivo: sin recargo. Total 3400 + 238 = 3638.
  r := pg_temp.pedir('k30-prueba-b', 'cash',
    '[{"clover_item_id":"viva-juice-green","quantity":2},{"clover_item_id":"viva-drink-agua"},{"clover_item_id":"viva-bowl-acai"}]');
  if (r->>'subtotal_cents')::int <> 3400 or (r->>'tax_cents')::int <> 238
     or (r->>'surcharge_cents')::int <> 0 or (r->>'total_cents')::int <> 3638 then
    raise exception 'Efectivo con impuesto: %', r;
  end if;

  -- Tarjeta en mostrador: + 3% sobre 3638 = 109.14 → 109. Total 3747.
  r := pg_temp.pedir('k30-prueba-c', 'card_counter',
    '[{"clover_item_id":"viva-juice-green","quantity":2},{"clover_item_id":"viva-drink-agua"},{"clover_item_id":"viva-bowl-acai"}]');
  if (r->>'tax_cents')::int <> 238 or (r->>'surcharge_cents')::int <> 109 or (r->>'total_cents')::int <> 3747 then
    raise exception 'Tarjeta con recargo: %', r;
  end if;

  -- Zelle sin recargo configurado: lo mismo que efectivo.
  r := pg_temp.pedir('k30-prueba-d', 'zelle', '[{"clover_item_id":"viva-juice-green"}]');
  -- 850 × 0.06625 = 56.3125 → 56 ; total 906.
  if (r->>'tax_cents')::int <> 56 or (r->>'surcharge_cents')::int <> 0 or (r->>'total_cents')::int <> 906 then
    raise exception 'Zelle: %', r;
  end if;

  -- Las opciones con costo también pagan impuesto (leche de avena +$1.00).
  r := pg_temp.pedir('k30-prueba-e', 'cash',
    '[{"clover_item_id":"viva-iced-latte","modifiers":["viva-mod-milk-oat"]}]');
  -- (475 + 100) × 0.06625 = 38.09375 → 38 ; total 613.
  if (r->>'subtotal_cents')::int <> 575 or (r->>'tax_cents')::int <> 38 or (r->>'total_cents')::int <> 613 then
    raise exception 'Opciones con impuesto: %', r;
  end if;

  -- Repetir el mismo pedido (misma llave) no cambia los montos.
  r := pg_temp.pedir('k30-prueba-c', 'card_counter',
    '[{"clover_item_id":"viva-juice-green","quantity":2},{"clover_item_id":"viva-drink-agua"},{"clover_item_id":"viva-bowl-acai"}]');
  if (r->>'total_cents')::int <> 3747 then
    raise exception 'Repetir cambió el total: %', r;
  end if;
end $$;
reset role;

-- Stripe y PayPal cobran el total con impuesto y recargo.
do $$
declare v_id uuid;
begin
  select id into v_id from public.orders where idempotency_key = 'k30-prueba-c';
  if app.order_amount_cents(v_id) <> 3747 then
    raise exception 'order_amount_cents no es el total: %', app.order_amount_cents(v_id);
  end if;
end $$;

-- Nadie desde la app cambia los montos de un pedido, aunque tuviera permiso
-- de UPDATE (política temporal, solo para la prueba).
create policy prueba_30_update on public.orders for update to authenticated using (true) with check (true);
grant update on public.orders to authenticated;
select pg_temp.como('ffffffff-0000-4000-8000-000000000002');
select pg_temp.esperar_error(
  $q$update public.orders set total_cents = 1 where idempotency_key = 'k30-prueba-b'$q$, 'order_online_column');
select pg_temp.esperar_error(
  $q$update public.orders set online_payment_id = 'pi_falso' where idempotency_key = 'k30-prueba-b'$q$, 'order_online_column');
reset role;

-- La vista del menú trae lo que la app necesita para el estimado.
select pg_temp.como(null);
do $$
declare v record;
begin
  select taxable, tax_rate_override into v from public.menu_items where clover_item_id = 'viva-drink-agua';
  if v.taxable then raise exception 'menu_items.taxable'; end if;
  select taxable, tax_rate_override into v from public.menu_items where clover_item_id = 'viva-bowl-acai';
  if v.tax_rate_override <> 0.1 then raise exception 'menu_items.tax_rate_override'; end if;
end $$;
reset role;

rollback;
\echo 'OK 0030: impuesto por producto y recargo por forma de pago'
