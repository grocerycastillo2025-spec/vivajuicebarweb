-- =====================================================================
-- 0033_estadisticas_graficas.sql
-- Datos extra para que Estadísticas se entienda de un vistazo:
--   - el periodo anterior (para "▲ 12% vs. la semana pasada"),
--   - clientes nuevos y los que regresan,
--   - pedidos por día de la semana y hora (mapa de calor, horas pico),
--   - cómo pagan,
--   - visitas y recompensas entregadas,
--   - lo más vendido con su nombre en español.
-- Todo en la zona horaria de la sucursal. Solo el dueño.
--
-- MIGRACION NUEVA. Idempotente. `business_stats` (0023) no se toca.
-- =====================================================================

create or replace function public.business_insights(p_restaurant_id uuid, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, app, pg_catalog
as $$
declare
  v_days     int;
  v_prev_to  date;
  v_prev_from date;
  v_result   jsonb;
begin
  if not app.owns_restaurant(p_restaurant_id) then
    raise exception 'owner_only' using errcode = '42501';
  end if;
  if p_to < p_from or p_to - p_from > 366 then
    raise exception 'invalid_range' using errcode = '22023';
  end if;
  v_days := p_to - p_from + 1;
  v_prev_to := p_from - 1;
  v_prev_from := p_from - v_days;

  with sold as (
    select o.*, coalesce(s.timezone, 'America/New_York') as tz,
           case when o.total_cents > 0 then o.total_cents else o.subtotal_cents end as amount
      from public.orders o
      join public.stores s on s.id = o.store_id
     where o.tenant_id = p_restaurant_id
       and o.business_day between v_prev_from and p_to
       and o.status in ('confirmed', 'preparing', 'ready', 'completed')
  ),
  cur as (select * from sold where business_day between p_from and p_to),
  prev as (select * from sold where business_day between v_prev_from and v_prev_to),
  firsts as (
    -- Primer pedido de cada cliente en el negocio (de siempre).
    select o.user_id, min(o.business_day) as first_day
      from public.orders o
     where o.tenant_id = p_restaurant_id and o.user_id is not null
       and o.status in ('confirmed', 'preparing', 'ready', 'completed')
     group by o.user_id
  ),
  heat as (
    select extract(isodow from (c.created_at at time zone c.tz))::int as dow,
           extract(hour from (c.created_at at time zone c.tz))::int as hour,
           count(*)::int as orders
      from cur c
     group by 1, 2
  ),
  pay as (
    select coalesce(c.pay_with, 'cash') as method, count(*)::int as orders, sum(c.amount)::bigint as revenue_cents
      from cur c
     group by 1
     order by 3 desc
  ),
  top_sold as (
    select oi.name_snapshot as name,
           max(ci.i18n -> 'es' ->> 'name') as name_es,
           sum(oi.quantity)::int as quantity,
           sum(oi.line_total_cents)::bigint as revenue_cents
      from public.order_items oi
      join cur c on c.id = oi.order_id
      left join public.catalog_items ci on ci.store_id = c.store_id and ci.clover_item_id = oi.clover_item_id
     group by oi.name_snapshot
     order by sum(oi.quantity) desc, sum(oi.line_total_cents) desc
     limit 8
  ),
  top_viewed as (
    select i.name, max(i.i18n -> 'es' ->> 'name') as name_es, count(*)::int as views
      from public.analytics_events e
      join public.catalog_items i on i.id = e.ref_id
     where e.restaurant_id = p_restaurant_id and e.kind = 'item_view'
       and e.day between p_from and p_to
     group by i.name
     order by count(*) desc
     limit 8
  ),
  tz as (
    select coalesce((select s.timezone from public.stores s
                      where s.restaurant_id = p_restaurant_id and s.deleted_at is null
                      order by s.created_at limit 1), 'America/New_York') as name
  )
  select jsonb_build_object(
    'prev', jsonb_build_object(
      'orders', (select count(*) from prev),
      'revenue_cents', (select coalesce(sum(amount), 0) from prev),
      'customers', (select count(distinct user_id) from prev)
    ),
    'new_customers', (select count(*) from firsts f where f.first_day between p_from and p_to),
    'returning_customers', (select count(distinct c.user_id) from cur c
                             join firsts f on f.user_id = c.user_id where f.first_day < p_from),
    'heat', coalesce((select jsonb_agg(to_jsonb(h)) from heat h), '[]'::jsonb),
    'by_payment', coalesce((select jsonb_agg(to_jsonb(p)) from pay p), '[]'::jsonb),
    'top_sold', coalesce((select jsonb_agg(to_jsonb(t)) from top_sold t), '[]'::jsonb),
    'top_viewed', coalesce((select jsonb_agg(to_jsonb(t)) from top_viewed t), '[]'::jsonb),
    'loyalty_visits', (select count(*) from public.loyalty_transactions t
                        join public.loyalty_accounts a on a.id = t.account_id
                       where a.tenant_id = p_restaurant_id and t.source = 'visit'
                         and (t.created_at at time zone (select name from tz))::date between p_from and p_to),
    'rewards_given', (select count(*) from public.reward_redemptions r
                       where r.tenant_id = p_restaurant_id and r.status = 'used'
                         and (r.used_at at time zone (select name from tz))::date between p_from and p_to)
  ) into v_result;

  return v_result;
end;
$$;

revoke execute on function public.business_insights(uuid, date, date) from public, anon;
grant execute on function public.business_insights(uuid, date, date) to authenticated;
