-- =====================================================================
-- 0032_tarjeta_lealtad.sql
-- Tarjeta de lealtad del cliente: la TIENDA escanea el QR del cliente.
--
-- COMO FUNCIONA
--   1. Cada cliente tiene un QR propio en la app (Puntos → Mi tarjeta).
--      El QR lleva un código de tarjeta al azar (no su id ni su correo).
--   2. En el mostrador, la tienda lo escanea (Panel → Lealtad → Escanear
--      tarjeta, o con la cámara del teléfono: abre /admin/cliente).
--   3. Ve el nombre, los puntos y qué recompensas ya alcanzó. Toca
--      "Sumar visita" y, si ya juntó lo de una recompensa, "Entregar":
--      se le descuentan esos puntos (su conteo vuelve a empezar) y queda
--      registrado qué recibió, cuándo y quién se lo dio.
--
-- El QR fijo del local (0021, el cliente escanea) sigue existiendo pero
-- queda APAGADO por defecto (`self_checkin`); el dueño lo puede prender.
--
-- Todo pasa por funciones SECURITY DEFINER que revisan que quien llama
-- trabaja en el negocio (dueño o Tienda). Nadie escribe puntos directo.
--
-- MIGRACION NUEVA. Idempotente.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Columnas nuevas
-- ---------------------------------------------------------------------
alter table public.loyalty_accounts
  add column if not exists card_code text;
create unique index if not exists uq_loyalty_accounts_card
  on public.loyalty_accounts(tenant_id, card_code) where card_code is not null;

alter table public.loyalty_programs
  add column if not exists self_checkin boolean not null default false;
comment on column public.loyalty_programs.self_checkin is
  'Si el cliente puede sumar visitas escaneando el QR del local (0021). '
  'Apagado: solo la tienda suma, escaneando la tarjeta del cliente (0032).';

-- Quién registró el movimiento (la tienda que escaneó).
alter table public.loyalty_transactions
  add column if not exists created_by uuid references auth.users(id) on delete set null;

-- Recompensas bilingües, como el menú: {"es": {"name", "description"}}.
alter table public.rewards
  add column if not exists i18n jsonb not null default '{}'::jsonb;
alter table public.rewards drop constraint if exists rewards_i18n_check;
alter table public.rewards add constraint rewards_i18n_check check (app.i18n_valid(i18n));

-- Quién entregó (para el historial): ya existe used_by (0021).

-- ---------------------------------------------------------------------
-- 2. Código de tarjeta
-- ---------------------------------------------------------------------
-- 10 caracteres sin 0/O ni 1/I: ~10^15 combinaciones, imposible de adivinar
-- a mano y fácil de dictar si la cámara falla.
create or replace function app.card_code()
returns text
language plpgsql
volatile
as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_code text := '';
begin
  for i in 1..10 loop
    v_code := v_code || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1);
  end loop;
  return v_code;
end;
$$;

create or replace function app.normalize_card(p text)
returns text
language sql
immutable
as $$
  select nullif(regexp_replace(upper(coalesce(p, '')), '[^A-Z0-9]', '', 'g'), '');
$$;

-- El cliente pide su tarjeta (se crea la primera vez).
create or replace function public.my_loyalty_card(p_restaurant_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, app, pg_catalog
as $$
declare
  v_user    uuid := auth.uid();
  v_account public.loyalty_accounts%rowtype;
  v_code    text;
begin
  if v_user is null then
    raise exception 'auth_required' using errcode = '28000';
  end if;
  if not exists (select 1 from public.restaurants where id = p_restaurant_id) then
    raise exception 'restaurant_not_found' using errcode = 'P0002';
  end if;

  v_account := app.loyalty_account_for(p_restaurant_id, v_user);
  if v_account.card_code is null then
    loop
      v_code := app.card_code();
      exit when not exists (
        select 1 from public.loyalty_accounts where tenant_id = p_restaurant_id and card_code = v_code);
    end loop;
    update public.loyalty_accounts set card_code = v_code where id = v_account.id
    returning * into v_account;
  end if;

  return jsonb_build_object(
    'code', v_account.card_code,
    'balance', v_account.points_balance,
    'lifetime', v_account.lifetime_points
  );
end;
$$;

-- ---------------------------------------------------------------------
-- 3. Lo que ve la tienda al escanear
-- ---------------------------------------------------------------------
create or replace function app.card_state(p_account public.loyalty_accounts, p_program public.loyalty_programs)
returns jsonb
language sql
stable
security definer
set search_path = public, app, pg_catalog
as $$
  with last_visit as (
    select max(t.created_at) as at, count(*) as visits
      from public.loyalty_transactions t
     where t.account_id = p_account.id and t.source = 'visit'
  ),
  person as (
    select nullif(btrim(concat_ws(' ', p.first_name, p.last_name)), '') as name,
           u.email
      from auth.users u
      left join public.profiles p on p.id = u.id
     where u.id = p_account.user_id
  )
  select jsonb_build_object(
    'card', p_account.card_code,
    'customer', coalesce((select name from person),
                         -- Sin nombre: el correo a medias (ana•••@gmail.com).
                         (select regexp_replace(email, '^(.{1,3})[^@]*', '\1•••') from person),
                         '—'),
    'balance', p_account.points_balance,
    'lifetime', p_account.lifetime_points,
    'visits', (select visits from last_visit),
    'last_visit_at', (select at from last_visit),
    'next_visit_at', (select at + make_interval(hours => p_program.visit_cooldown_hours) from last_visit),
    'can_visit', coalesce((select at + make_interval(hours => p_program.visit_cooldown_hours) <= now() from last_visit), true),
    'points_per_visit', p_program.points_per_visit,
    'rewards_given', (select count(*) from public.reward_redemptions r
                       where r.user_id = p_account.user_id and r.tenant_id = p_account.tenant_id and r.status = 'used'),
    'rewards', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', w.id, 'name', w.name, 'i18n', w.i18n, 'cost', w.cost_points,
               'eligible', p_account.points_balance >= w.cost_points,
               'missing', greatest(w.cost_points - p_account.points_balance, 0))
             order by w.cost_points)
        from public.rewards w
       where w.tenant_id = p_account.tenant_id and w.active), '[]'::jsonb)
  );
$$;
revoke execute on function app.card_state(public.loyalty_accounts, public.loyalty_programs) from public, anon, authenticated;

-- Busca la tarjeta y comprueba que quien llama trabaja ahí. Bloquea la
-- cuenta (FOR UPDATE) para que dos toques seguidos no sumen dos veces.
create or replace function app.staff_card(p_store_id uuid, p_card text)
returns table (account public.loyalty_accounts, program public.loyalty_programs, restaurant uuid)
language plpgsql
volatile
security definer
set search_path = public, app, pg_catalog
as $$
declare
  v_restaurant uuid;
  v_program    public.loyalty_programs%rowtype;
  v_account    public.loyalty_accounts%rowtype;
begin
  select s.restaurant_id into v_restaurant from public.stores s where s.id = p_store_id and s.deleted_at is null;
  if not found then
    raise exception 'store_not_found' using errcode = 'P0002';
  end if;
  if not coalesce(app.works_at_restaurant(v_restaurant), false) then
    raise exception 'staff_only' using errcode = '42501';
  end if;

  select * into v_program from public.loyalty_programs where restaurant_id = v_restaurant;
  if not found or not v_program.enabled then
    raise exception 'loyalty_disabled' using errcode = '22023';
  end if;

  select * into v_account from public.loyalty_accounts a
   where a.tenant_id = v_restaurant and a.card_code = app.normalize_card(p_card)
   for update;
  if not found then
    raise exception 'card_not_found' using errcode = 'P0002';
  end if;
  account := v_account;
  program := v_program;
  restaurant := v_restaurant;
  return next;
end;
$$;
revoke execute on function app.staff_card(uuid, text) from public, anon, authenticated;

create or replace function public.loyalty_lookup(p_store_id uuid, p_card text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, app, pg_catalog
as $$
declare
  r record;
  v_account public.loyalty_accounts%rowtype;
  v_program public.loyalty_programs%rowtype;
begin
  select * into r from app.staff_card(p_store_id, p_card);
  v_account := r.account;
  v_program := r.program;
  return app.card_state(v_account, v_program);
end;
$$;

-- ---------------------------------------------------------------------
-- 4. La tienda suma la visita
-- ---------------------------------------------------------------------
create or replace function public.staff_add_visit(p_store_id uuid, p_card text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, app, pg_catalog
as $$
declare
  r          record;
  v_account  public.loyalty_accounts%rowtype;
  v_last     timestamptz;
  v_next     timestamptz;
  v_before   int;
  v_state    jsonb;
  v_program  public.loyalty_programs%rowtype;
begin
  select * into r from app.staff_card(p_store_id, p_card);
  v_account := r.account;
  v_program := r.program;
  v_before := v_account.points_balance;

  select max(t.created_at) into v_last
    from public.loyalty_transactions t
   where t.account_id = v_account.id and t.source = 'visit';
  v_next := v_last + make_interval(hours => v_program.visit_cooldown_hours);
  if v_last is not null and v_next > now() then
    raise exception 'too_soon:%', to_char(v_next at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
      using errcode = '22023';
  end if;

  insert into public.loyalty_transactions (account_id, delta_points, reason, source, store_id, created_by)
  values (v_account.id, v_program.points_per_visit, 'earn', 'visit', p_store_id, auth.uid());

  update public.loyalty_accounts
     set points_balance  = points_balance + v_program.points_per_visit,
         lifetime_points = lifetime_points + v_program.points_per_visit
   where id = v_account.id
  returning * into v_account;

  v_state := app.card_state(v_account, v_program);
  return v_state || jsonb_build_object(
    'added', v_program.points_per_visit,
    -- Las que alcanzó CON esta visita: la tienda le avisa "¡ya la tiene!".
    'newly_eligible', coalesce((
      select jsonb_agg(w.name order by w.cost_points)
        from public.rewards w
       where w.tenant_id = r.restaurant and w.active
         and w.cost_points > v_before and w.cost_points <= v_account.points_balance), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------
-- 5. La tienda entrega la recompensa
-- ---------------------------------------------------------------------
create or replace function public.staff_give_reward(p_store_id uuid, p_card text, p_reward_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, app, pg_catalog
as $$
declare
  r         record;
  v_reward  public.rewards%rowtype;
  v_account public.loyalty_accounts%rowtype;
  v_program public.loyalty_programs%rowtype;
begin
  select * into r from app.staff_card(p_store_id, p_card);
  v_account := r.account;
  v_program := r.program;

  select * into v_reward from public.rewards
   where id = p_reward_id and tenant_id = r.restaurant and active;
  if not found then
    raise exception 'reward_not_available' using errcode = '22023';
  end if;
  if v_account.points_balance < v_reward.cost_points then
    raise exception 'not_enough_points' using errcode = '22023';
  end if;

  insert into public.reward_redemptions
    (reward_id, user_id, points_cost, status, tenant_id, reward_name, used_at, used_by)
  values
    (v_reward.id, v_account.user_id, v_reward.cost_points, 'used', r.restaurant, v_reward.name, now(), auth.uid());

  insert into public.loyalty_transactions (account_id, delta_points, reason, source, store_id, created_by)
  values (v_account.id, -v_reward.cost_points, 'redeem', 'redeem', p_store_id, auth.uid());

  update public.loyalty_accounts
     set points_balance = points_balance - v_reward.cost_points
   where id = v_account.id
  returning * into v_account;

  return app.card_state(v_account, v_program) || jsonb_build_object('given', v_reward.name);
end;
$$;

-- ---------------------------------------------------------------------
-- 6. Historial: a quién se le dio qué, cuándo y quién lo entregó
-- ---------------------------------------------------------------------
create or replace function public.rewards_given(p_restaurant_id uuid, p_limit int default 30)
returns table (id uuid, given_at timestamptz, reward_name text, customer text, given_by text, status text, code text,
               reward_i18n jsonb)
language sql
stable
security definer
set search_path = public, app, pg_catalog
as $$
  select r.id,
         coalesce(r.used_at, r.redeemed_at),
         r.reward_name,
         coalesce(nullif(btrim(concat_ws(' ', pc.first_name, pc.last_name)), ''),
                  regexp_replace(uc.email, '^(.{1,3})[^@]*', '\1•••')),
         coalesce(nullif(btrim(concat_ws(' ', ps.first_name, ps.last_name)), ''), us.email),
         r.status,
         r.code,
         coalesce(w.i18n, '{}'::jsonb)
    from public.reward_redemptions r
    left join public.rewards w on w.id = r.reward_id
    left join auth.users uc on uc.id = r.user_id
    left join public.profiles pc on pc.id = r.user_id
    left join auth.users us on us.id = r.used_by
    left join public.profiles ps on ps.id = r.used_by
   where r.tenant_id = p_restaurant_id
     and coalesce(app.works_at_restaurant(p_restaurant_id), false)
   order by coalesce(r.used_at, r.redeemed_at) desc
   limit least(greatest(coalesce(p_limit, 30), 1), 100);
$$;

-- ---------------------------------------------------------------------
-- 7. El QR del local solo suma si el dueño lo deja (self_checkin)
--    Misma función que 0021 con esa comprobación de más.
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
  if not v_program.self_checkin then
    raise exception 'self_checkin_disabled' using errcode = '22023';
  end if;

  select * into v_code from public.store_visit_codes where store_id = p_store_id;
  if not found then
    raise exception 'invalid_code' using errcode = '22023';
  end if;

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
-- 8. Permisos
-- ---------------------------------------------------------------------
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.my_loyalty_card(uuid)',
    'public.loyalty_lookup(uuid, text)',
    'public.staff_add_visit(uuid, text)',
    'public.staff_give_reward(uuid, text, uuid)',
    'public.rewards_given(uuid, int)',
    'public.claim_visit(uuid, text)'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;
revoke execute on function app.card_code() from public, anon, authenticated;
