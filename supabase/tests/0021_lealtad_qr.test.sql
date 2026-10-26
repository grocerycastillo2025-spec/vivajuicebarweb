-- =====================================================================
-- Pruebas de la 0021: QR de visita, puntos, canjes y permisos.
-- =====================================================================

\set ON_ERROR_STOP on

grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;

\i supabase/tests/fixtures/viva_jugos_mx.sql
begin;

insert into auth.users (id, email) values
  ('bbbbbbbb-0000-4000-8000-000000000001', 'duena2@viva.mx'),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'cajero2@viva.mx'),
  ('bbbbbbbb-0000-4000-8000-000000000003', 'cliente2@correo.mx'),
  ('bbbbbbbb-0000-4000-8000-000000000004', 'otro2@correo.mx');

select app.grant_restaurant_role('duena2@viva.mx',  '11111111-1111-4111-8111-111111111111', 'owner');
select app.grant_restaurant_role('cajero2@viva.mx', '11111111-1111-4111-8111-111111111111', 'staff');

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
-- 1. La dueña configura el programa y una recompensa
-- ---------------------------------------------------------------------
select pg_temp.como('bbbbbbbb-0000-4000-8000-000000000001');

update public.loyalty_programs
   set enabled = true, points_per_visit = 25, visit_cooldown_hours = 20
 where restaurant_id = '11111111-1111-4111-8111-111111111111';

insert into public.rewards (tenant_id, name, cost_points)
values ('11111111-1111-4111-8111-111111111111', 'Jugo gratis', 50);

do $$ begin
  if (select points_per_visit from public.loyalty_programs) <> 25 then
    raise exception 'La dueña no pudo configurar los puntos';
  end if;
end $$;

-- La tabla de codigos no se lee ni siendo dueña: solo por funcion.
select pg_temp.esperar_error($$select * from public.store_visit_codes$$, 'permission denied');
create temp table qr as select public.visit_qr('33333333-3333-4333-8333-333333333333') as j;
reset role;
grant select on qr to authenticated;

-- ---------------------------------------------------------------------
-- 2. El cliente: codigo malo, codigo bueno, segunda visita el mismo dia
-- ---------------------------------------------------------------------
select pg_temp.como('bbbbbbbb-0000-4000-8000-000000000003');

select pg_temp.esperar_error($$select * from public.store_visit_codes$$, 'permission denied');
select pg_temp.esperar_error(
  $$select public.claim_visit('33333333-3333-4333-8333-333333333333', 'adivinado')$$, 'invalid_code');

do $$
declare v jsonb;
begin
  v := public.claim_visit('33333333-3333-4333-8333-333333333333', (select j ->> 'code' from qr));
  if (v ->> 'points')::int <> 25 or (v ->> 'balance')::int <> 25 then
    raise exception 'Visita mal sumada: %', v;
  end if;
end $$;

select pg_temp.esperar_error(
  $$select public.claim_visit('33333333-3333-4333-8333-333333333333', (select j ->> 'code' from qr))$$,
  'too_soon');

-- No puede sumarse puntos a mano ni canjear sin saldo.
select pg_temp.esperar_error(
  $$update public.loyalty_accounts set points_balance = 9999$$, 'permission denied');
select pg_temp.esperar_error(
  $$insert into public.loyalty_transactions (account_id, delta_points, reason)
    select id, 9999, 'adjust' from public.loyalty_accounts$$, 'permission denied');
select pg_temp.esperar_error(
  $$select public.redeem_reward((select id from public.rewards where name = 'Jugo gratis'))$$,
  'not_enough_points');
reset role;

-- Pasa el tiempo: se mueve la visita 21 h atras.
update public.loyalty_transactions set created_at = now() - interval '21 hours' where source = 'visit';

select pg_temp.como('bbbbbbbb-0000-4000-8000-000000000003');
create temp table canje (j jsonb);
do $$
declare v jsonb;
begin
  v := public.claim_visit('33333333-3333-4333-8333-333333333333', (select j ->> 'code' from qr));
  if (v ->> 'balance')::int <> 50 then raise exception 'Segunda visita mal: %', v; end if;

  v := public.redeem_reward((select id from public.rewards where name = 'Jugo gratis'));
  if (v ->> 'balance')::int <> 0 or length(v ->> 'code') <> 6 then
    raise exception 'Canje mal: %', v;
  end if;
  insert into canje values (v);
end $$;

-- Otro cliente no puede anular el canje ajeno (lo dejaba pasar un NULL
-- de owns_restaurant hasta la correccion de la 0023).
reset role;
select pg_temp.como('bbbbbbbb-0000-4000-8000-000000000004');
select pg_temp.esperar_error(
  $$select public.cancel_redemption((select (j ->> 'redemption_id')::uuid from canje))$$,
  'redemption_not_found');
reset role;
select pg_temp.como('bbbbbbbb-0000-4000-8000-000000000003');

-- El cliente no valida su propio canje.
select pg_temp.esperar_error(
  $$select public.use_redemption((select j ->> 'code' from canje))$$, 'redemption_not_found');
reset role;
grant select on canje to authenticated;

-- ---------------------------------------------------------------------
-- 3. El cajero valida el canje una sola vez
-- ---------------------------------------------------------------------
select pg_temp.como('bbbbbbbb-0000-4000-8000-000000000002');
do $$
declare v jsonb;
begin
  v := public.use_redemption(lower((select j ->> 'code' from canje)));
  if v ->> 'reward' <> 'Jugo gratis' then raise exception 'Canje validado mal: %', v; end if;
end $$;
select pg_temp.esperar_error(
  $$select public.use_redemption((select j ->> 'code' from canje))$$, 'redemption_already_used');

-- El cajero no configura el programa ni cambia el QR.
do $$ begin
  update public.loyalty_programs set points_per_visit = 1000;
  if exists (select 1 from public.loyalty_programs where points_per_visit = 1000) then
    raise exception 'El cajero cambio los puntos';
  end if;
end $$;
select pg_temp.esperar_error(
  $$select public.regenerate_visit_code('33333333-3333-4333-8333-333333333333')$$, 'owner_only');
reset role;

-- ---------------------------------------------------------------------
-- 4. Codigo nuevo: el viejo deja de servir. Modo rotativo.
-- ---------------------------------------------------------------------
update public.loyalty_transactions set created_at = now() - interval '2 days' where source = 'visit';

select pg_temp.como('bbbbbbbb-0000-4000-8000-000000000001');
create temp table qr2 as select public.regenerate_visit_code('33333333-3333-4333-8333-333333333333') as j;
create temp table qr3 as select public.set_visit_qr_mode('33333333-3333-4333-8333-333333333333', 'rotating') as j;
reset role;
grant select on qr2, qr3 to authenticated;

select pg_temp.como('bbbbbbbb-0000-4000-8000-000000000004');
select pg_temp.esperar_error(
  $$select public.claim_visit('33333333-3333-4333-8333-333333333333', (select j ->> 'code' from qr))$$,
  'invalid_code');
-- En modo rotativo el fijo tampoco vale…
select pg_temp.esperar_error(
  $$select public.claim_visit('33333333-3333-4333-8333-333333333333', (select j ->> 'code' from qr2))$$,
  'invalid_code');
-- …y el de la pantalla, si.
do $$
declare v jsonb;
begin
  v := public.claim_visit('33333333-3333-4333-8333-333333333333', (select j ->> 'code' from qr3));
  if (v ->> 'points')::int <> 25 then raise exception 'Rotativo no sumo: %', v; end if;
end $$;
reset role;

-- Un codigo rotativo de hace 3 minutos ya no vale.
do $$
declare
  v_old text;
begin
  select app.rotating_code(secret, app.visit_window() - 3) into v_old
    from public.store_visit_codes where store_id = '33333333-3333-4333-8333-333333333333';
  perform set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-4000-8000-000000000003', true);
  begin
    perform public.claim_visit('33333333-3333-4333-8333-333333333333', v_old);
    raise exception 'Un codigo rotativo viejo sumo puntos';
  exception when others then
    if sqlerrm not like 'invalid_code%' then raise; end if;
  end;
end $$;

-- ---------------------------------------------------------------------
-- 5. Con el programa apagado no se suma nada
-- ---------------------------------------------------------------------
update public.loyalty_programs set enabled = false;
select pg_temp.como('bbbbbbbb-0000-4000-8000-000000000003');
select pg_temp.esperar_error(
  $$select public.claim_visit('33333333-3333-4333-8333-333333333333', (select j ->> 'code' from qr3))$$,
  'loyalty_disabled');
reset role;

rollback;
\echo 'OK 0021: QR de visita, puntos y canjes se comportan como se espera'
