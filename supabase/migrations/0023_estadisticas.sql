-- =====================================================================
-- 0023_estadisticas.sql
-- Que se vende, que se consulta y que historias se ven.
--
-- VENTAS: salen de los pedidos (order_items), no hace falta registrar
-- nada nuevo. Cuentan los pedidos confirmados en adelante, nunca los
-- cancelados.
--
-- CONSULTAS Y VISTAS: la app registra un evento cuando alguien abre un
-- producto o ve una historia (`track_event`). Para que los numeros
-- signifiquen "personas" y no "toques", se cuenta UNA vez por visitante,
-- por cosa y por dia: abrir diez veces el mismo jugo en una tarde es una
-- consulta.
--
-- Quien ve: el usuario si inicio sesion; si no, un identificador
-- anonimo que la app genera y guarda en el telefono (`visitor`). No se
-- guarda nada mas: ni IP, ni dispositivo.
--
-- MIGRACION NUEVA. Las 0001 a 0022 estan aplicadas y no se tocan.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. CORRECCION DE LA 0020: `owns_restaurant` NUNCA devuelve nulo.
--
-- Para quien no es miembro, `member_role()` es NULL, y `NULL = 'owner'`
-- es NULL, no falso. En una policy da igual (NULL no deja pasar), pero en
-- PL/pgSQL `if not app.owns_restaurant(...) then raise` con un NULL NO
-- entra al raise: la comprobacion se saltaba. Afectaba a
-- `cancel_redemption` (0021), que dejaba a cualquiera anular el canje de
-- otro. Lo encontraron las pruebas de esta migracion.
-- ---------------------------------------------------------------------
create or replace function app.owns_restaurant(p_restaurant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, app, pg_catalog
as $$
  select coalesce(app.member_role(p_restaurant_id) = 'owner', false) or app.is_platform_admin();
$$;

create table if not exists public.analytics_events (
  id            bigserial primary key,
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  kind          text not null check (kind in ('item_view', 'story_view')),
  ref_id        uuid not null,
  visitor       text not null check (char_length(visitor) between 8 and 64),
  user_id       uuid references auth.users(id) on delete set null,
  day           date not null,
  created_at    timestamptz not null default now(),
  unique (kind, ref_id, visitor, day)
);

create index if not exists idx_analytics_restaurant_day
  on public.analytics_events(restaurant_id, kind, day);

alter table public.analytics_events enable row level security;
-- Sin policies: nadie la lee ni la escribe directo. Se escribe con
-- `track_event` y se lee agregada con `business_stats`.
revoke all on public.analytics_events from anon, authenticated;

comment on table public.analytics_events is
  'Consultas de producto y vistas de historia, una por visitante, cosa y '
  'dia. Solo por funciones (track_event, business_stats). Ver 0023.';


-- ---------------------------------------------------------------------
-- REGISTRAR (cualquiera, con o sin sesion)
-- ---------------------------------------------------------------------
create or replace function public.track_event(p_kind text, p_ref uuid, p_visitor text)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_catalog
as $$
declare
  v_restaurant uuid;
  v_tz         text := 'America/Mexico_City';
begin
  if p_kind = 'item_view' then
    select s.restaurant_id, s.timezone into v_restaurant, v_tz
      from public.catalog_items i
      join public.stores s on s.id = i.store_id
     where i.id = p_ref;
  elsif p_kind = 'story_view' then
    select st.restaurant_id into v_restaurant from public.stories st where st.id = p_ref;
  else
    return;  -- tipo desconocido: se ignora sin error
  end if;

  if v_restaurant is null or p_visitor is null or char_length(p_visitor) not between 8 and 64 then
    return;
  end if;

  insert into public.analytics_events (restaurant_id, kind, ref_id, visitor, user_id, day)
  values (v_restaurant, p_kind, p_ref, p_visitor, auth.uid(),
          (now() at time zone coalesce(v_tz, 'America/Mexico_City'))::date)
  on conflict (kind, ref_id, visitor, day) do nothing;
end;
$$;

revoke execute on function public.track_event(text, uuid, text) from public;
grant execute on function public.track_event(text, uuid, text) to anon, authenticated;


-- ---------------------------------------------------------------------
-- LEER (solo quien trabaja en el negocio)
--
-- Devuelve todo el tablero de una vez, para un rango de dias en la zona
-- de la sucursal: un viaje en vez de seis.
-- ---------------------------------------------------------------------
create or replace function public.business_stats(p_restaurant_id uuid, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, app, pg_catalog
as $$
declare
  v_result jsonb;
begin
  if not app.owns_restaurant(p_restaurant_id) then
    raise exception 'owner_only' using errcode = '42501';
  end if;
  if p_to < p_from or p_to - p_from > 366 then
    raise exception 'invalid_range' using errcode = '22023';
  end if;

  with sold_orders as (
    select o.*
      from public.orders o
     where o.tenant_id = p_restaurant_id
       and o.business_day between p_from and p_to
       and o.status in ('confirmed', 'preparing', 'ready', 'completed')
  ),
  totals as (
    select count(*)::int as orders,
           coalesce(sum(case when total_cents > 0 then total_cents else subtotal_cents end), 0)::bigint as revenue_cents,
           count(distinct user_id)::int as customers
      from sold_orders
  ),
  by_day as (
    select d::date as day,
           coalesce(count(o.id), 0)::int as orders,
           coalesce(sum(case when o.total_cents > 0 then o.total_cents else o.subtotal_cents end), 0)::bigint as revenue_cents
      from generate_series(p_from, p_to, interval '1 day') d
      left join sold_orders o on o.business_day = d::date
     group by d
     order by d
  ),
  top_sold as (
    select oi.name_snapshot as name,
           sum(oi.quantity)::int as quantity,
           sum(oi.line_total_cents)::bigint as revenue_cents
      from public.order_items oi
      join sold_orders o on o.id = oi.order_id
     group by oi.name_snapshot
     order by sum(oi.quantity) desc, sum(oi.line_total_cents) desc
     limit 10
  ),
  top_viewed as (
    select i.name, count(*)::int as views
      from public.analytics_events e
      join public.catalog_items i on i.id = e.ref_id
     where e.restaurant_id = p_restaurant_id and e.kind = 'item_view'
       and e.day between p_from and p_to
     group by i.name
     order by count(*) desc
     limit 10
  ),
  top_stories as (
    select st.id, coalesce(nullif(st.caption, ''), 'Historia') as name,
           st.media_url, st.media_type, count(*)::int as views
      from public.analytics_events e
      join public.stories st on st.id = e.ref_id
     where e.restaurant_id = p_restaurant_id and e.kind = 'story_view'
       and e.day between p_from and p_to
     group by st.id
     order by count(*) desc
     limit 10
  ),
  visits as (
    select count(*)::int as loyalty_visits
      from public.loyalty_transactions t
      join public.loyalty_accounts a on a.id = t.account_id
     where a.tenant_id = p_restaurant_id and t.source = 'visit'
       and (t.created_at at time zone 'America/Mexico_City')::date between p_from and p_to
  )
  select jsonb_build_object(
    'orders',        (select orders from totals),
    'revenue_cents', (select revenue_cents from totals),
    'customers',     (select customers from totals),
    'loyalty_visits',(select loyalty_visits from visits),
    'item_views',    (select count(*) from public.analytics_events e
                       where e.restaurant_id = p_restaurant_id and e.kind = 'item_view'
                         and e.day between p_from and p_to),
    'story_views',   (select count(*) from public.analytics_events e
                       where e.restaurant_id = p_restaurant_id and e.kind = 'story_view'
                         and e.day between p_from and p_to),
    'by_day',        coalesce((select jsonb_agg(to_jsonb(b)) from by_day b), '[]'::jsonb),
    'top_sold',      coalesce((select jsonb_agg(to_jsonb(t)) from top_sold t), '[]'::jsonb),
    'top_viewed',    coalesce((select jsonb_agg(to_jsonb(t)) from top_viewed t), '[]'::jsonb),
    'top_stories',   coalesce((select jsonb_agg(to_jsonb(t)) from top_stories t), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

revoke execute on function public.business_stats(uuid, date, date) from public, anon;
grant execute on function public.business_stats(uuid, date, date) to authenticated;
