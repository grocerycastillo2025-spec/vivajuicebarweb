-- =====================================================================
-- Pruebas de 0032: la tienda escanea la tarjeta del cliente, suma la
-- visita, avisa cuando alcanza una recompensa y la entrega.
-- =====================================================================

\set ON_ERROR_STOP on

\i supabase/seed/viva_juice_us.sql
begin;

insert into auth.users (id, email) values
  ('cdcdcdcd-0000-4000-8000-000000000001', 'owner32@vivajuice.test'),
  ('cdcdcdcd-0000-4000-8000-000000000002', 'tienda32@vivajuice.test'),
  ('cdcdcdcd-0000-4000-8000-000000000003', 'ana32@example.test'),
  ('cdcdcdcd-0000-4000-8000-000000000004', 'otro32@example.test');
update public.profiles set first_name = 'Ana', last_name = 'López' where id = 'cdcdcdcd-0000-4000-8000-000000000003';
insert into public.profiles (id, first_name, last_name)
select 'cdcdcdcd-0000-4000-8000-000000000003', 'Ana', 'López'
 where not exists (select 1 from public.profiles where id = 'cdcdcdcd-0000-4000-8000-000000000003');
select app.grant_restaurant_role('owner32@vivajuice.test', '11111111-1111-4111-8111-111111111111', 'owner');
select app.grant_restaurant_role('tienda32@vivajuice.test', '11111111-1111-4111-8111-111111111111', 'staff');

insert into public.loyalty_programs (restaurant_id, enabled, points_per_visit, visit_cooldown_hours)
values ('11111111-1111-4111-8111-111111111111', true, 10, 20)
on conflict (restaurant_id) do update set enabled = true, points_per_visit = 10, visit_cooldown_hours = 20;
delete from public.rewards where tenant_id = '11111111-1111-4111-8111-111111111111';
insert into public.rewards (id, tenant_id, name, cost_points, active, i18n) values
  ('cdcdcdcd-1111-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'Free shot', 20, true, '{"es":{"name":"Shot gratis"}}'),
  ('cdcdcdcd-1111-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 'Free juice', 30, true, '{}'),
  ('cdcdcdcd-1111-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111', 'Old reward', 10, false, '{}');

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

create temp table _t (k text primary key, v text);
grant all on _t to anon, authenticated;

-- ---------------------------------------------------------------------
-- El cliente obtiene su tarjeta; siempre la misma.
-- ---------------------------------------------------------------------
select pg_temp.como('cdcdcdcd-0000-4000-8000-000000000003');
insert into _t select 'card', public.my_loyalty_card('11111111-1111-4111-8111-111111111111') ->> 'code';
do $$ begin
  if (select v from _t where k = 'card') !~ '^[A-HJ-NP-Z2-9]{10}$' then raise exception 'Código de tarjeta raro'; end if;
  if public.my_loyalty_card('11111111-1111-4111-8111-111111111111') ->> 'code' <> (select v from _t where k = 'card') then
    raise exception 'La tarjeta cambió';
  end if;
end $$;
-- El cliente NO puede sumarse ni entregarse nada.
select pg_temp.esperar_error($q$select public.staff_add_visit('22222222-2222-4222-8222-222222222222', (select v from _t where k='card'))$q$, 'staff_only');
select pg_temp.esperar_error($q$select public.loyalty_lookup('22222222-2222-4222-8222-222222222222', (select v from _t where k='card'))$q$, 'staff_only');
-- El QR del local está apagado por defecto.
select pg_temp.esperar_error($q$select public.claim_visit('22222222-2222-4222-8222-222222222222', 'x')$q$, 'self_checkin_disabled');
reset role;

-- ---------------------------------------------------------------------
-- La tienda escanea (con guiones y minúsculas también vale).
-- ---------------------------------------------------------------------
select pg_temp.como('cdcdcdcd-0000-4000-8000-000000000002');
do $$
declare s jsonb; c text := (select v from _t where k = 'card');
begin
  s := public.loyalty_lookup('22222222-2222-4222-8222-222222222222', lower(substr(c, 1, 5) || '-' || substr(c, 6)));
  if s ->> 'customer' <> 'Ana López' or (s ->> 'balance')::int <> 0 or not (s ->> 'can_visit')::boolean then
    raise exception 'Lookup inicial: %', s;
  end if;
  if jsonb_array_length(s -> 'rewards') <> 2 then raise exception 'Recompensas activas: %', s -> 'rewards'; end if;

  s := public.staff_add_visit('22222222-2222-4222-8222-222222222222', c);
  if (s ->> 'balance')::int <> 10 or (s ->> 'added')::int <> 10 or jsonb_array_length(s -> 'newly_eligible') <> 0 then
    raise exception 'Primera visita: %', s;
  end if;
end $$;
-- Dos veces el mismo día: no.
select pg_temp.esperar_error($q$select public.staff_add_visit('22222222-2222-4222-8222-222222222222', (select v from _t where k='card'))$q$, 'too_soon');
reset role;

-- Pasa un día (se mueve la visita al pasado) y vuelve.
update public.loyalty_transactions set created_at = now() - interval '25 hours'
 where created_by = 'cdcdcdcd-0000-4000-8000-000000000002';

select pg_temp.como('cdcdcdcd-0000-4000-8000-000000000002');
do $$
declare s jsonb; c text := (select v from _t where k = 'card');
begin
  s := public.staff_add_visit('22222222-2222-4222-8222-222222222222', c);
  if (s ->> 'balance')::int <> 20 or s -> 'newly_eligible' <> '["Free shot"]'::jsonb then
    raise exception 'Segunda visita debía avisar Free shot: %', s;
  end if;
  if not (s -> 'rewards' -> 0 ->> 'eligible')::boolean or (s -> 'rewards' -> 1 ->> 'missing')::int <> 10 then
    raise exception 'Elegibilidad: %', s -> 'rewards';
  end if;
  -- No alcanza el jugo.
  begin
    perform public.staff_give_reward('22222222-2222-4222-8222-222222222222', c, 'cdcdcdcd-1111-4000-8000-000000000002');
    raise exception 'Entregó sin puntos';
  exception when others then
    if sqlerrm not like '%not_enough_points%' then raise; end if;
  end;
  -- Inactiva: tampoco.
  begin
    perform public.staff_give_reward('22222222-2222-4222-8222-222222222222', c, 'cdcdcdcd-1111-4000-8000-000000000003');
    raise exception 'Entregó una inactiva';
  exception when others then
    if sqlerrm not like '%reward_not_available%' then raise; end if;
  end;
  -- Entrega el shot: el conteo vuelve a 0.
  s := public.staff_give_reward('22222222-2222-4222-8222-222222222222', c, 'cdcdcdcd-1111-4000-8000-000000000001');
  if (s ->> 'balance')::int <> 0 or s ->> 'given' <> 'Free shot' or (s ->> 'rewards_given')::int <> 1 then
    raise exception 'Entrega: %', s;
  end if;
  -- Queda en el historial con nombre del cliente y quién lo dio.
  if not exists (select 1 from public.rewards_given('11111111-1111-4111-8111-111111111111')
                  where customer = 'Ana López' and given_by = 'tienda32@vivajuice.test'
                    and reward_name = 'Free shot' and status = 'used') then
    raise exception 'No quedó en el historial';
  end if;
end $$;
select pg_temp.esperar_error($q$select public.loyalty_lookup('22222222-2222-4222-8222-222222222222', 'NOEXISTE22')$q$, 'card_not_found');
reset role;

-- El otro cliente no ve el historial.
select pg_temp.como('cdcdcdcd-0000-4000-8000-000000000004');
do $$ begin
  if exists (select 1 from public.rewards_given('11111111-1111-4111-8111-111111111111')) then
    raise exception 'Un cliente ve el historial';
  end if;
end $$;
reset role;
select pg_temp.como(null);
select pg_temp.esperar_error($q$select public.my_loyalty_card('11111111-1111-4111-8111-111111111111')$q$, null);
reset role;

-- El dueño puede prender el QR del local y entonces sí suma.
update public.loyalty_programs set self_checkin = true where restaurant_id = '11111111-1111-4111-8111-111111111111';
select pg_temp.como('cdcdcdcd-0000-4000-8000-000000000001');
insert into _t select 'qr', public.visit_qr('22222222-2222-4222-8222-222222222222') ->> 'code';
reset role;
select pg_temp.como('cdcdcdcd-0000-4000-8000-000000000004');
select public.claim_visit('22222222-2222-4222-8222-222222222222', (select v from _t where k = 'qr'));
reset role;

rollback;
\echo 'OK 0032: la tienda escanea la tarjeta del cliente, suma visitas y entrega recompensas'
