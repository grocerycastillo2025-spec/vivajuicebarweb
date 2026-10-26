-- =====================================================================
-- Pruebas de 0033: comparación con el periodo anterior, clientes nuevos,
-- horas pico, formas de pago y nombres en español. Solo el dueño.
-- =====================================================================

\set ON_ERROR_STOP on

\i supabase/seed/viva_juice_us.sql
begin;

insert into auth.users (id, email) values
  ('efefefef-0000-4000-8000-000000000001', 'owner33@vivajuice.test'),
  ('efefefef-0000-4000-8000-000000000002', 'tienda33@vivajuice.test'),
  ('efefefef-0000-4000-8000-000000000003', 'a33@example.test'),
  ('efefefef-0000-4000-8000-000000000004', 'b33@example.test');
select app.grant_restaurant_role('owner33@vivajuice.test', '11111111-1111-4111-8111-111111111111', 'owner');
select app.grant_restaurant_role('tienda33@vivajuice.test', '11111111-1111-4111-8111-111111111111', 'staff');

-- Hoy (business_day = día 0) y la semana pasada. Horas en Nueva York.
-- A: cliente de antes (pidió hace 10 días) que regresa. B: nuevo.
insert into public.orders (id, tenant_id, store_id, order_number, user_id, business_day, status, subtotal_cents, total_cents, pay_with, created_at)
values
  ('efefefef-2222-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 9001,
   'efefefef-0000-4000-8000-000000000003', date '2026-10-15', 'completed', 1000, 1000, 'cash', timestamptz '2026-10-15 09:10 America/New_York'),
  ('efefefef-2222-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 9002,
   'efefefef-0000-4000-8000-000000000003', date '2026-10-25', 'completed', 2000, 2000, 'stripe', timestamptz '2026-10-25 08:30 America/New_York'),
  ('efefefef-2222-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 9003,
   'efefefef-0000-4000-8000-000000000004', date '2026-10-25', 'ready', 1000, 1000, 'cash', timestamptz '2026-10-25 08:45 America/New_York'),
  -- Cancelado: no cuenta.
  ('efefefef-2222-4000-8000-000000000004', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 9004,
   'efefefef-0000-4000-8000-000000000004', date '2026-10-25', 'canceled', 5000, 5000, 'cash', timestamptz '2026-10-25 12:00 America/New_York');
insert into public.order_items (order_id, clover_item_id, name_snapshot, unit_price_snapshot_cents, quantity, line_total_cents)
values ('efefefef-2222-4000-8000-000000000002', 'viva-juice-green', 'Green Juice', 850, 2, 1700);

create or replace function pg_temp.como(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
  execute 'set local role authenticated';
end $$;

select pg_temp.como('efefefef-0000-4000-8000-000000000001');
do $$
declare v jsonb;
begin
  -- Periodo: 19–25 oct. Anterior: 12–18 oct.
  v := public.business_insights('11111111-1111-4111-8111-111111111111', date '2026-10-19', date '2026-10-25');
  if (v -> 'prev' ->> 'orders')::int <> 1 or (v -> 'prev' ->> 'revenue_cents')::int <> 1000 then
    raise exception 'Periodo anterior: %', v -> 'prev';
  end if;
  if (v ->> 'new_customers')::int <> 1 or (v ->> 'returning_customers')::int <> 1 then
    raise exception 'Nuevos/regresan: % / %', v ->> 'new_customers', v ->> 'returning_customers';
  end if;
  -- Domingo (isodow 7) a las 8: dos pedidos; el cancelado de las 12 no.
  if v -> 'heat' <> '[{"dow": 7, "hour": 8, "orders": 2}]'::jsonb then
    raise exception 'Mapa de calor: %', v -> 'heat';
  end if;
  if (v -> 'by_payment' -> 0 ->> 'method') <> 'stripe' or jsonb_array_length(v -> 'by_payment') <> 2 then
    raise exception 'Formas de pago: %', v -> 'by_payment';
  end if;
  if (v -> 'top_sold' -> 0 ->> 'name_es') <> 'Jugo Verde' then
    raise exception 'Nombre en español: %', v -> 'top_sold';
  end if;
end $$;
reset role;

-- La tienda no ve estadísticas.
select pg_temp.como('efefefef-0000-4000-8000-000000000002');
do $$ begin
  perform public.business_insights('11111111-1111-4111-8111-111111111111', date '2026-10-19', date '2026-10-25');
  raise exception 'La tienda vio estadísticas';
exception when others then
  if sqlerrm not like '%owner_only%' then raise; end if;
end $$;
reset role;

rollback;
\echo 'OK 0033: estadísticas con comparación, horas pico, formas de pago y clientes nuevos'
