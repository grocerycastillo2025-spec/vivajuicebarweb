-- =====================================================================
-- 0003_orders_loyalty.sql
-- Ordenes, pagos, reembolsos, reconciliacion, loyalty, promociones
-- y notificaciones.
--
-- Punto clave: order_status (nuestro) y clover_payment_state (de Clover)
-- son columnas DISTINTAS y no se mezclan nunca. Ver §1 del addendum.
-- =====================================================================

-- ---------------------------------------------------------------------
-- NUMERACION DE PEDIDOS (por sucursal y por dia)
-- ---------------------------------------------------------------------

create table public.order_counters (
  store_id    uuid not null references public.stores(id) on delete cascade,
  business_day date not null,
  last_number int not null default 1000,
  primary key (store_id, business_day)
);

create or replace function app.next_order_number(p_store_id uuid, p_day date)
returns int
language plpgsql
as $$
declare
  n int;
begin
  insert into public.order_counters (store_id, business_day, last_number)
  values (p_store_id, p_day, 1001)
  on conflict (store_id, business_day)
    do update set last_number = public.order_counters.last_number + 1
  returning last_number into n;
  return n;
end;
$$;

-- ---------------------------------------------------------------------
-- IDEMPOTENCIA DE CHECKOUT
-- Se escribe ANTES de tocar Clover. Un reintento con la misma clave
-- devuelve el resultado previo y jamas crea una segunda orden.
-- ---------------------------------------------------------------------

create table public.checkout_attempts (
  id               uuid primary key default gen_random_uuid(),
  idempotency_key  text not null unique,
  user_id          uuid references auth.users(id) on delete set null,
  store_id         uuid not null references public.stores(id) on delete cascade,
  order_id         uuid,
  state            text not null default 'started'
                     check (state in ('started','order_created','paid','printed','done','failed')),
  request_payload  jsonb,
  result           jsonb,
  error            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index idx_checkout_attempts_state
  on public.checkout_attempts(state, created_at)
  where state not in ('done', 'failed');

create trigger trg_checkout_attempts_updated
  before update on public.checkout_attempts
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------
-- ORDENES
-- ---------------------------------------------------------------------

create table public.orders (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references public.restaurants(id) on delete restrict,
  store_id             uuid not null references public.stores(id) on delete restrict,
  user_id              uuid references auth.users(id) on delete set null,

  order_number         int not null,
  business_day         date not null default current_date,
  pickup_code          text not null default app.generate_pickup_code(),

  -- ---- CAPA NUESTRA (experiencia) ----
  status               app.order_status not null default 'draft',
  fulfillment          app.fulfillment_type not null default 'pickup',
  pickup_at            timestamptz,
  is_asap              boolean not null default false,
  customer_note        text,

  -- ---- CAPA CLOVER (hechos, solo lectura) ----
  clover_order_id      text,
  clover_customer_id   text,
  clover_payment_state app.clover_payment_state not null default 'unknown',
  clover_modified_time bigint,
  printed_at           timestamptz,          -- respuesta OK de print_event
  print_failed_at      timestamptz,

  -- ---- DINERO (centavos, calculado por Clover) ----
  currency             char(3) not null default 'USD',
  subtotal_cents       bigint not null default 0 check (subtotal_cents >= 0),
  discount_cents       bigint not null default 0 check (discount_cents >= 0),
  tax_cents            bigint not null default 0 check (tax_cents >= 0),
  tip_cents            bigint not null default 0 check (tip_cents >= 0),
  total_cents          bigint not null default 0 check (total_cents >= 0),

  promotion_id         uuid,
  loyalty_points_earned int not null default 0,
  loyalty_points_spent  int not null default 0,

  idempotency_key      text unique,
  ready_at             timestamptz,
  completed_at         timestamptz,
  canceled_at          timestamptz,
  cancel_reason        text,

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  unique (store_id, business_day, order_number),
  constraint orders_clover_unique unique (clover_order_id)
);

create index idx_orders_user on public.orders(user_id, created_at desc);
create index idx_orders_store_day on public.orders(store_id, business_day, status);
create index idx_orders_clover on public.orders(clover_order_id);
create index idx_orders_active
  on public.orders(store_id, pickup_at)
  where status in ('confirmed', 'preparing', 'ready');
-- Para el reconciliador de las ultimas 24 h.
create index idx_orders_recent on public.orders(created_at desc);

create trigger trg_orders_updated
  before update on public.orders
  for each row execute function app.touch_updated_at();

-- Sellos de tiempo automaticos segun el estado.
create or replace function app.stamp_order_status()
returns trigger
language plpgsql
as $$
begin
  if new.status is distinct from old.status then
    case new.status
      when 'ready'     then new.ready_at     := coalesce(new.ready_at, now());
      when 'completed' then new.completed_at := coalesce(new.completed_at, now());
      when 'canceled'  then new.canceled_at  := coalesce(new.canceled_at, now());
      else null;
    end case;
  end if;
  return new;
end;
$$;

create trigger trg_orders_stamp
  before update on public.orders
  for each row execute function app.stamp_order_status();

create table public.order_items (
  id                        uuid primary key default gen_random_uuid(),
  order_id                  uuid not null references public.orders(id) on delete cascade,
  clover_item_id            text not null,
  clover_line_item_id       text,
  -- Snapshots: el historial debe mostrar lo que el cliente pago ese dia,
  -- no el precio actual en Clover. Esto NO es duplicar catalogo.
  name_snapshot             text not null,
  unit_price_snapshot_cents bigint not null check (unit_price_snapshot_cents >= 0),
  quantity                  int not null default 1 check (quantity > 0),
  line_total_cents          bigint not null default 0,
  note                      text,
  sort_order                int not null default 0
);

create index idx_order_items_order on public.order_items(order_id);

create table public.order_item_modifiers (
  id                    uuid primary key default gen_random_uuid(),
  order_item_id         uuid not null references public.order_items(id) on delete cascade,
  clover_modifier_id    text not null,
  clover_group_id       text,
  name_snapshot         text not null,
  price_snapshot_cents  bigint not null default 0
);

create index idx_order_item_mods on public.order_item_modifiers(order_item_id);

-- ---------------------------------------------------------------------
-- PAGOS Y REEMBOLSOS
-- El cobro se hace SOBRE la orden de Clover ("Pay for an order"),
-- nunca como charge suelto. Los reembolsos van por la Ecommerce API.
-- ---------------------------------------------------------------------

create table public.payments (
  id                   uuid primary key default gen_random_uuid(),
  order_id             uuid not null references public.orders(id) on delete restrict,
  tenant_id            uuid not null references public.restaurants(id) on delete restrict,
  provider             text not null default 'clover',
  provider_payment_id  text,
  provider_charge_id   text,
  amount_cents         bigint not null check (amount_cents >= 0),
  tip_cents            bigint not null default 0,
  currency             char(3) not null default 'USD',
  status               app.payment_status not null default 'pending',
  card_brand           text,
  card_last4           char(4),      -- unico dato de tarjeta que guardamos
  failure_code         text,
  failure_message      text,
  raw_response         jsonb,        -- redactado antes de persistir
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint payments_provider_unique unique (provider, provider_payment_id)
);

create index idx_payments_order on public.payments(order_id);
create index idx_payments_status on public.payments(status, created_at desc);

create trigger trg_payments_updated
  before update on public.payments
  for each row execute function app.touch_updated_at();

create table public.refunds (
  id                  uuid primary key default gen_random_uuid(),
  payment_id          uuid not null references public.payments(id) on delete restrict,
  order_id            uuid not null references public.orders(id) on delete restrict,
  provider_refund_id  text,
  amount_cents        bigint not null check (amount_cents > 0),
  reason              text,
  status              app.refund_status not null default 'pending',
  -- 'platform' = iniciado desde nuestro SaaS
  -- 'merchant'  = detectado por webhook P / paymentState = CREDITED
  origin              text not null default 'platform'
                        check (origin in ('platform', 'merchant')),
  raw_response        jsonb,
  created_at          timestamptz not null default now(),
  constraint refunds_provider_unique unique (provider_refund_id)
);

create index idx_refunds_order on public.refunds(order_id);

-- ---------------------------------------------------------------------
-- RECONCILIACION
-- ---------------------------------------------------------------------

create table public.reconciliation_runs (
  id           bigserial primary key,
  kind         text not null check (kind in ('orders', 'payments', 'catalog')),
  store_id     uuid references public.stores(id) on delete cascade,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  checked      int not null default 0,
  findings     int not null default 0,
  error        text
);

create table public.reconciliation_findings (
  id          bigserial primary key,
  run_id      bigint references public.reconciliation_runs(id) on delete cascade,
  kind        text not null,     -- missing_order, duplicate_order, amount_mismatch...
  severity    text not null default 'warning'
                check (severity in ('info', 'warning', 'critical')),
  store_id    uuid references public.stores(id) on delete cascade,
  order_id    uuid references public.orders(id) on delete set null,
  detail      jsonb not null default '{}'::jsonb,
  auto_action text,
  resolved_at timestamptz,
  resolved_by uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now()
);

create index idx_recon_open
  on public.reconciliation_findings(severity, created_at desc)
  where resolved_at is null;

-- ---------------------------------------------------------------------
-- LOYALTY  (100% nuestro)
-- ---------------------------------------------------------------------

create table public.loyalty_programs (
  restaurant_id        uuid primary key references public.restaurants(id) on delete cascade,
  enabled              boolean not null default true,
  points_per_dollar    numeric(6,2) not null default 1.00,
  points_expire_days   int,
  min_points_to_redeem int not null default 100,
  updated_at           timestamptz not null default now()
);

create table public.loyalty_accounts (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.restaurants(id) on delete cascade,
  user_id        uuid not null references auth.users(id) on delete cascade,
  points_balance int not null default 0 check (points_balance >= 0),
  lifetime_points int not null default 0,
  tier           text not null default 'base',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (tenant_id, user_id)
);

create trigger trg_loyalty_accounts_updated
  before update on public.loyalty_accounts
  for each row execute function app.touch_updated_at();

create table public.loyalty_transactions (
  id           uuid primary key default gen_random_uuid(),
  account_id   uuid not null references public.loyalty_accounts(id) on delete cascade,
  order_id     uuid references public.orders(id) on delete set null,
  delta_points int not null,
  reason       app.loyalty_reason not null,
  -- Al detectar un reembolso hay que revertir los puntos ganados.
  reverts_id   uuid references public.loyalty_transactions(id) on delete set null,
  expires_at   timestamptz,
  created_at   timestamptz not null default now()
);

create index idx_loyalty_tx_account on public.loyalty_transactions(account_id, created_at desc);
create index idx_loyalty_tx_order on public.loyalty_transactions(order_id);

create table public.rewards (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.restaurants(id) on delete cascade,
  name          text not null,
  description   text,
  image_url     text,
  cost_points   int not null check (cost_points > 0),
  type          app.promotion_type not null default 'fixed',
  value_cents   bigint,
  clover_item_id text,          -- para recompensas de producto gratis
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

create table public.reward_redemptions (
  id          uuid primary key default gen_random_uuid(),
  reward_id   uuid not null references public.rewards(id) on delete restrict,
  user_id     uuid not null references auth.users(id) on delete cascade,
  order_id    uuid references public.orders(id) on delete set null,
  points_cost int not null,
  redeemed_at timestamptz not null default now()
);

create index idx_redemptions_user on public.reward_redemptions(user_id, redeemed_at desc);

-- ---------------------------------------------------------------------
-- PROMOCIONES  (se aplican como descuento de line item en Clover para
-- que el ticket y los reportes del restaurante cuadren)
-- ---------------------------------------------------------------------

create table public.promotions (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.restaurants(id) on delete cascade,
  store_ids     uuid[] not null default '{}',   -- vacio = todas las sucursales
  name          text not null,
  code          text,
  type          app.promotion_type not null,
  value         bigint not null,                -- % en basis points o centavos
  min_order_cents bigint not null default 0,
  target_item_ids text[] not null default '{}',
  starts_at     timestamptz not null default now(),
  ends_at       timestamptz,
  max_uses      int,
  max_uses_per_user int not null default 1,
  uses_count    int not null default 0,
  active        boolean not null default true,
  conditions    jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  unique (tenant_id, code)
);

create index idx_promotions_active
  on public.promotions(tenant_id, active, starts_at, ends_at);

create table public.promotion_uses (
  id           uuid primary key default gen_random_uuid(),
  promotion_id uuid not null references public.promotions(id) on delete cascade,
  user_id      uuid references auth.users(id) on delete set null,
  order_id     uuid references public.orders(id) on delete set null,
  used_at      timestamptz not null default now()
);

create index idx_promotion_uses on public.promotion_uses(promotion_id, user_id);

alter table public.orders
  add constraint orders_promotion_fk
  foreign key (promotion_id) references public.promotions(id) on delete set null;

alter table public.checkout_attempts
  add constraint checkout_attempts_order_fk
  foreign key (order_id) references public.orders(id) on delete set null;

-- ---------------------------------------------------------------------
-- NOTIFICACIONES
-- ---------------------------------------------------------------------

create table public.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  tenant_id  uuid references public.restaurants(id) on delete cascade,
  order_id   uuid references public.orders(id) on delete cascade,
  type       text not null,   -- order_confirmed, order_preparing, order_ready...
  title      text not null,
  body       text not null,
  data       jsonb not null default '{}'::jsonb,
  sent_at    timestamptz,
  delivered_at timestamptz,
  read_at    timestamptz,
  created_at timestamptz not null default now()
);

create index idx_notifications_user on public.notifications(user_id, created_at desc);
create index idx_notifications_unread
  on public.notifications(user_id) where read_at is null;

create table public.favorites (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  store_id       uuid not null references public.stores(id) on delete cascade,
  clover_item_id text not null,
  created_at     timestamptz not null default now(),
  unique (user_id, store_id, clover_item_id)
);

create index idx_favorites_user on public.favorites(user_id);
