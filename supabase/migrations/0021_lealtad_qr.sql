-- =====================================================================
-- 0021_lealtad_qr.sql
-- Puntos por visita con un QR en el local, recompensas y canjes.
--
-- COMO FUNCIONA
--   1. El negocio pone un QR en el mostrador. El QR es un enlace a la app
--      (/visita?s=<sucursal>&c=<codigo>).
--   2. El cliente lo escanea con la app (o con la camara, que abre la
--      app). Con sesion iniciada, `claim_visit` le suma los puntos de una
--      visita.
--   3. Con puntos suficientes canjea una recompensa (`redeem_reward`) y
--      recibe un codigo corto. En el mostrador, el cajero lo valida en el
--      panel (`use_redemption`) y entrega el producto.
--
-- CONTRA TRAMPAS
-- Un QR impreso se puede fotografiar y compartir. Tres defensas, todas en
-- el servidor:
--   * una visita por cliente cada `visit_cooldown_hours` (configurable);
--   * el dueño puede generar un codigo nuevo y el impreso deja de valer;
--   * modo `rotating`: el codigo cambia cada minuto y se muestra en una
--     pantalla del local. Una foto vieja no sirve.
-- Los puntos los escribe SOLO la base. El cliente no tiene permiso de
-- escritura sobre ninguna tabla de lealtad (0004); todo pasa por estas
-- funciones SECURITY DEFINER.
--
-- MIGRACION NUEVA. Las 0001 a 0020 estan aplicadas y no se tocan.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. CONFIGURACION DEL PROGRAMA
-- ---------------------------------------------------------------------
alter table public.loyalty_programs
  add column if not exists points_per_visit int not null default 10
    check (points_per_visit between 1 and 10000),
  add column if not exists visit_cooldown_hours int not null default 20
    check (visit_cooldown_hours between 0 and 168);

comment on column public.loyalty_programs.points_per_visit is
  'Puntos que gana el cliente cada vez que escanea el QR del local (0021).';
comment on column public.loyalty_programs.visit_cooldown_hours is
  'Horas minimas entre dos visitas del mismo cliente. 20 = una al dia con '
  'margen para quien viene un poco antes que ayer (0021).';

-- De donde salio cada movimiento de puntos, y en que sucursal.
alter table public.loyalty_transactions
  add column if not exists source text
    check (source is null or source in ('visit', 'order', 'redeem', 'refund', 'adjust')),
  add column if not exists store_id uuid references public.stores(id) on delete set null;

create index if not exists idx_loyalty_tx_visits
  on public.loyalty_transactions(account_id, created_at desc)
  where source = 'visit';


-- ---------------------------------------------------------------------
-- 2. EL CODIGO DEL QR, POR SUCURSAL
--
-- Nadie lo lee directamente: ni siquiera el dueño tiene policy de select.
-- El panel lo pide con `visit_qr`, que comprueba que trabaja ahi. Si el
-- cliente pudiera leer esta tabla, sumaria puntos sin pisar el local.
-- ---------------------------------------------------------------------
create table if not exists public.store_visit_codes (
  store_id    uuid primary key references public.stores(id) on delete cascade,
  mode        text not null default 'static' check (mode in ('static', 'rotating')),
  static_code text not null default substr(replace(gen_random_uuid()::text, '-', ''), 1, 16),
  secret      text not null default replace(gen_random_uuid()::text, '-', ''),
  rotated_at  timestamptz not null default now()
);

alter table public.store_visit_codes enable row level security;
revoke all on public.store_visit_codes from anon, authenticated;

comment on table public.store_visit_codes is
  'Codigo del QR de visitas de cada sucursal. Sin policies: solo se lee y '
  'escribe por funciones (visit_qr, claim_visit, regenerate_visit_code).';

-- Ventana de 60 s del modo rotativo.
create or replace function app.visit_window(p_at timestamptz default now())
returns bigint
language sql
stable
as $$
  select floor(extract(epoch from p_at) / 60)::bigint;
$$;

create or replace function app.rotating_code(p_secret text, p_window bigint)
returns text
language sql
immutable
as $$
  select substr(md5(p_secret || ':' || p_window::text), 1, 12);
$$;

create or replace function app.ensure_visit_code(p_store_id uuid)
returns public.store_visit_codes
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_row public.store_visit_codes%rowtype;
begin
  insert into public.store_visit_codes (store_id) values (p_store_id)
  on conflict (store_id) do nothing;
  select * into v_row from public.store_visit_codes where store_id = p_store_id;
  return v_row;
end;
$$;


-- ---------------------------------------------------------------------
-- 3. EL PANEL PIDE EL QR
-- ---------------------------------------------------------------------
create or replace function public.visit_qr(p_store_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, app, pg_catalog
as $$
declare
  v_store  public.stores%rowtype;
  v_row    public.store_visit_codes%rowtype;
  v_window bigint := app.visit_window();
begin
  select * into v_store from public.stores where id = p_store_id and deleted_at is null;
  if not found or not app.works_at_restaurant(v_store.restaurant_id) then
    raise exception 'store_not_found' using errcode = '42501';
  end if;

  v_row := app.ensure_visit_code(p_store_id);

  if v_row.mode = 'rotating' then
    return jsonb_build_object(
      'mode', 'rotating',
      'code', app.rotating_code(v_row.secret, v_window),
      'expires_at', to_timestamp((v_window + 1) * 60)
    );
  end if;

  return jsonb_build_object(
    'mode', 'static',
    'code', v_row.static_code,
    'rotated_at', v_row.rotated_at
  );
end;
$$;

-- Fijo o en pantalla. Solo el dueño.
create or replace function public.set_visit_qr_mode(p_store_id uuid, p_mode text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, app, pg_catalog
as $$
begin
  if not app.owns_store(p_store_id) then
    raise exception 'owner_only' using errcode = '42501';
  end if;
  if p_mode not in ('static', 'rotating') then
    raise exception 'invalid_mode' using errcode = '22023';
  end if;
  perform app.ensure_visit_code(p_store_id);
  update public.store_visit_codes set mode = p_mode where store_id = p_store_id;
  return public.visit_qr(p_store_id);
end;
$$;

-- Codigo nuevo: el QR impreso anterior deja de valer, y tambien cambia el
-- secreto del modo rotativo.
create or replace function public.regenerate_visit_code(p_store_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, app, pg_catalog
as $$
begin
  if not app.owns_store(p_store_id) then
    raise exception 'owner_only' using errcode = '42501';
  end if;
  perform app.ensure_visit_code(p_store_id);
  update public.store_visit_codes
     set static_code = substr(replace(gen_random_uuid()::text, '-', ''), 1, 16),
         secret      = replace(gen_random_uuid()::text, '-', ''),
         rotated_at  = now()
   where store_id = p_store_id;
  return public.visit_qr(p_store_id);
end;
$$;


-- ---------------------------------------------------------------------
-- 4. CUENTA DE PUNTOS (se crea sola la primera vez)
-- ---------------------------------------------------------------------
create or replace function app.loyalty_account_for(p_tenant uuid, p_user uuid)
returns public.loyalty_accounts
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_account public.loyalty_accounts%rowtype;
begin
  insert into public.loyalty_accounts (tenant_id, user_id) values (p_tenant, p_user)
  on conflict (tenant_id, user_id) do nothing;
  -- FOR UPDATE: dos escaneos simultaneos del mismo cliente se ponen en
  -- fila aqui, y el segundo ve la visita del primero.
  select * into v_account from public.loyalty_accounts
   where tenant_id = p_tenant and user_id = p_user
   for update;
  return v_account;
end;
$$;


-- ---------------------------------------------------------------------
-- 5. EL CLIENTE ESCANEA: SUMAR UNA VISITA
-- ---------------------------------------------------------------------
create or replace function public.claim_visit(p_store_id uuid, p_code text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, app, pg_catalog
as $$
declare
  v_user     uuid := auth.uid();
  v_store    public.stores%rowtype;
  v_program  public.loyalty_programs%rowtype;
  v_code     public.store_visit_codes%rowtype;
  v_account  public.loyalty_accounts%rowtype;
  v_last     timestamptz;
  v_next     timestamptz;
  v_window   bigint := app.visit_window();
  v_valid    boolean;
begin
  if v_user is null then
    raise exception 'auth_required' using errcode = '28000';
  end if;

  select * into v_store from public.stores
   where id = p_store_id and deleted_at is null and status in ('active', 'paused');
  if not found then
    raise exception 'invalid_code' using errcode = '22023';
  end if;

  select * into v_program from public.loyalty_programs where restaurant_id = v_store.restaurant_id;
  if not found or not v_program.enabled then
    raise exception 'loyalty_disabled' using errcode = '22023';
  end if;

  select * into v_code from public.store_visit_codes where store_id = p_store_id;
  if not found then
    raise exception 'invalid_code' using errcode = '22023';
  end if;

  -- Rotativo: vale el codigo de este minuto y el del anterior, para quien
  -- escaneo justo en el cambio.
  v_valid := case v_code.mode
    when 'static' then p_code = v_code.static_code
    else p_code in (app.rotating_code(v_code.secret, v_window),
                    app.rotating_code(v_code.secret, v_window - 1))
  end;
  if not coalesce(v_valid, false) then
    raise exception 'invalid_code' using errcode = '22023';
  end if;

  v_account := app.loyalty_account_for(v_store.restaurant_id, v_user);

  select max(t.created_at) into v_last
    from public.loyalty_transactions t
   where t.account_id = v_account.id and t.source = 'visit';

  v_next := v_last + make_interval(hours => v_program.visit_cooldown_hours);
  if v_last is not null and v_next > now() then
    raise exception 'too_soon:%', to_char(v_next at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
      using errcode = '22023';
  end if;

  insert into public.loyalty_transactions (account_id, delta_points, reason, source, store_id)
  values (v_account.id, v_program.points_per_visit, 'earn', 'visit', p_store_id);

  update public.loyalty_accounts
     set points_balance  = points_balance + v_program.points_per_visit,
         lifetime_points = lifetime_points + v_program.points_per_visit
   where id = v_account.id
  returning * into v_account;

  return jsonb_build_object(
    'points', v_program.points_per_visit,
    'balance', v_account.points_balance,
    'next_at', now() + make_interval(hours => v_program.visit_cooldown_hours)
  );
end;
$$;


-- ---------------------------------------------------------------------
-- 6. CANJES
-- ---------------------------------------------------------------------
alter table public.reward_redemptions
  add column if not exists code text,
  add column if not exists status text not null default 'issued'
    check (status in ('issued', 'used', 'canceled')),
  add column if not exists tenant_id uuid references public.restaurants(id) on delete cascade,
  add column if not exists used_at timestamptz,
  add column if not exists used_by uuid references auth.users(id) on delete set null,
  add column if not exists reward_name text;

create unique index if not exists uq_redemptions_code
  on public.reward_redemptions(tenant_id, code) where code is not null;

-- Codigo corto y legible: sin 0/O ni 1/I, que en un mostrador se confunden.
create or replace function app.redemption_code()
returns text
language plpgsql
volatile
as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_code text := '';
begin
  for i in 1..6 loop
    v_code := v_code || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1);
  end loop;
  return v_code;
end;
$$;

create or replace function public.redeem_reward(p_reward_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, app, pg_catalog
as $$
declare
  v_user    uuid := auth.uid();
  v_reward  public.rewards%rowtype;
  v_program public.loyalty_programs%rowtype;
  v_account public.loyalty_accounts%rowtype;
  v_code    text;
  v_id      uuid;
begin
  if v_user is null then
    raise exception 'auth_required' using errcode = '28000';
  end if;

  select * into v_reward from public.rewards where id = p_reward_id and active;
  if not found then
    raise exception 'reward_not_available' using errcode = '22023';
  end if;

  select * into v_program from public.loyalty_programs where restaurant_id = v_reward.tenant_id;
  if not found or not v_program.enabled then
    raise exception 'loyalty_disabled' using errcode = '22023';
  end if;

  v_account := app.loyalty_account_for(v_reward.tenant_id, v_user);
  if v_account.points_balance < v_reward.cost_points then
    raise exception 'not_enough_points' using errcode = '22023';
  end if;

  -- Reintenta si el codigo choca con otro vivo del mismo negocio.
  loop
    v_code := app.redemption_code();
    exit when not exists (
      select 1 from public.reward_redemptions
       where tenant_id = v_reward.tenant_id and code = v_code
    );
  end loop;

  insert into public.reward_redemptions
    (reward_id, user_id, points_cost, code, status, tenant_id, reward_name)
  values
    (v_reward.id, v_user, v_reward.cost_points, v_code, 'issued', v_reward.tenant_id, v_reward.name)
  returning id into v_id;

  insert into public.loyalty_transactions (account_id, delta_points, reason, source)
  values (v_account.id, -v_reward.cost_points, 'redeem', 'redeem');

  update public.loyalty_accounts
     set points_balance = points_balance - v_reward.cost_points
   where id = v_account.id
  returning * into v_account;

  return jsonb_build_object(
    'redemption_id', v_id,
    'code', v_code,
    'reward', v_reward.name,
    'balance', v_account.points_balance
  );
end;
$$;

-- En el mostrador: el cajero escribe el codigo que le ensena el cliente.
create or replace function public.use_redemption(p_code text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, app, pg_catalog
as $$
declare
  v_row  public.reward_redemptions%rowtype;
  v_name text;
begin
  select r.* into v_row
    from public.reward_redemptions r
   where r.code = upper(btrim(p_code))
     and app.works_at_restaurant(r.tenant_id)
   for update;

  if not found then
    raise exception 'redemption_not_found' using errcode = '22023';
  end if;
  if v_row.status = 'used' then
    raise exception 'redemption_already_used:%', to_char(v_row.used_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
      using errcode = '22023';
  end if;
  if v_row.status = 'canceled' then
    raise exception 'redemption_canceled' using errcode = '22023';
  end if;

  update public.reward_redemptions
     set status = 'used', used_at = now(), used_by = auth.uid()
   where id = v_row.id;

  select nullif(btrim(concat_ws(' ', p.first_name, p.last_name)), '') into v_name
    from public.profiles p where p.id = v_row.user_id;

  return jsonb_build_object(
    'reward', v_row.reward_name,
    'customer', v_name,
    'points', v_row.points_cost
  );
end;
$$;

-- El cliente se arrepiente (o el dueño lo anula): vuelven los puntos.
create or replace function public.cancel_redemption(p_redemption_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, app, pg_catalog
as $$
declare
  v_row     public.reward_redemptions%rowtype;
  v_account public.loyalty_accounts%rowtype;
begin
  select * into v_row from public.reward_redemptions where id = p_redemption_id for update;
  if not found
     or not (v_row.user_id = auth.uid() or app.owns_restaurant(v_row.tenant_id)) then
    raise exception 'redemption_not_found' using errcode = '42501';
  end if;
  if v_row.status <> 'issued' then
    raise exception 'redemption_not_cancelable' using errcode = '22023';
  end if;

  update public.reward_redemptions set status = 'canceled' where id = v_row.id;

  v_account := app.loyalty_account_for(v_row.tenant_id, v_row.user_id);
  insert into public.loyalty_transactions (account_id, delta_points, reason, source)
  values (v_account.id, v_row.points_cost, 'revert', 'refund');
  update public.loyalty_accounts
     set points_balance = points_balance + v_row.points_cost
   where id = v_account.id
  returning * into v_account;

  return jsonb_build_object('balance', v_account.points_balance);
end;
$$;


-- ---------------------------------------------------------------------
-- 7. PERMISOS
-- ---------------------------------------------------------------------

-- El dueño configura el programa y las recompensas de SU negocio.
create policy loyalty_programs_owner_all on public.loyalty_programs
  for all to authenticated
  using (app.owns_restaurant(restaurant_id)) with check (app.owns_restaurant(restaurant_id));

create policy rewards_owner_all on public.rewards
  for all to authenticated
  using (app.owns_restaurant(tenant_id)) with check (app.owns_restaurant(tenant_id));

-- El mostrador ve los canjes del negocio (para el historial del panel).
create policy redemptions_member_read on public.reward_redemptions
  for select to authenticated
  using (tenant_id is not null and app.works_at_restaurant(tenant_id));

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.visit_qr(uuid)',
    'public.set_visit_qr_mode(uuid, text)',
    'public.regenerate_visit_code(uuid)',
    'public.claim_visit(uuid, text)',
    'public.redeem_reward(uuid)',
    'public.use_redemption(text)',
    'public.cancel_redemption(uuid)'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;

-- Los ayudantes internos no los llama nadie desde fuera.
revoke execute on function app.ensure_visit_code(uuid) from public, anon, authenticated;
revoke execute on function app.loyalty_account_for(uuid, uuid) from public, anon, authenticated;
