-- =====================================================================
-- 0001_core.sql
-- Extensiones, enums, helpers, tenancy (restaurants/stores) y usuarios.
-- Convenciones:
--   * dinero SIEMPRE en enteros de centavos (nunca float, nunca numeric)
--   * todos los timestamps son timestamptz
--   * toda tabla de negocio lleva tenant_id (restaurant_id) para RLS simple
--   * soft delete con deleted_at donde el historico importa
-- =====================================================================

create extension if not exists pgcrypto;

-- Esquema privado para helpers. No se expone via PostgREST.
create schema if not exists app;
revoke all on schema app from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- ENUMS
-- ---------------------------------------------------------------------

create type app.restaurant_status as enum (
  'draft', 'active', 'paused', 'disabled'
);

create type app.store_status as enum (
  'draft',          -- creada en el SaaS, sin configurar
  'pending_setup',  -- checklist de onboarding incompleto -> NO visible en la app
  'active',
  'paused',         -- temporalmente sin recibir pedidos
  'disabled'
);

create type app.connection_status as enum (
  'not_connected',
  'pending_auth',
  'connected',
  'degraded',       -- token o permisos con problema; no acepta pedidos nuevos
  'revoked'         -- el merchant desinstalo la app (webhook 'A')
);

-- Estado NUESTRO del pedido (capa de experiencia).
create type app.order_status as enum (
  'draft',
  'payment_pending',
  'payment_failed',
  'confirmed',
  'preparing',
  'ready',
  'completed',
  'canceled',
  'refunded'
);

-- Espejo del paymentState de Clover (capa de hechos). NUNCA se mezcla
-- con order_status: son dos columnas distintas a proposito.
create type app.clover_payment_state as enum (
  'unknown', 'open', 'paid', 'credited'
);

create type app.payment_status as enum (
  'pending', 'succeeded', 'failed', 'voided'
);

create type app.refund_status as enum (
  'pending', 'succeeded', 'failed'
);

create type app.fulfillment_type as enum (
  'pickup', 'delivery'
);

create type app.webhook_status as enum (
  'pending', 'processing', 'processed', 'failed', 'skipped'
);

create type app.sync_entity as enum (
  'items', 'categories', 'modifier_groups', 'modifiers', 'tax_rates', 'orders', 'payments'
);

create type app.promotion_type as enum (
  'percent', 'fixed', 'bogo', 'free_item'
);

create type app.loyalty_reason as enum (
  'earn', 'redeem', 'adjust', 'revert', 'expire'
);

create type app.admin_role as enum (
  'super_admin', 'support', 'read_only'
);

-- ---------------------------------------------------------------------
-- HELPERS
-- ---------------------------------------------------------------------

-- Trigger generico de updated_at.
create or replace function app.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Codigo corto para retiro en mostrador (evita 0/O/1/I).
create or replace function app.generate_pickup_code()
returns text
language sql
volatile
as $$
  select string_agg(
           substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789',
                  1 + floor(random() * 31)::int, 1),
           ''
         )
  from generate_series(1, 4);
$$;

-- ---------------------------------------------------------------------
-- TENANCY
-- ---------------------------------------------------------------------

create table public.restaurants (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  slug                text not null unique,
  status              app.restaurant_status not null default 'draft',
  support_email       text,
  support_phone       text,
  subscription_status text not null default 'trial',
  subscription_ends_at timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint restaurants_slug_format check (slug ~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$')
);

create trigger trg_restaurants_updated
  before update on public.restaurants
  for each row execute function app.touch_updated_at();

comment on table public.restaurants is
  'Marca comercial (el cliente que nos paga). tenant_id = restaurants.id';

-- Una sucursal equivale a UN merchant de Clover (mId). Ver §6 del addendum:
-- el catalogo cuelga de store, no de restaurant, porque los merchants
-- divergen entre si.
create table public.stores (
  id                 uuid primary key default gen_random_uuid(),
  restaurant_id      uuid not null references public.restaurants(id) on delete cascade,
  name               text not null,
  slug               text not null,
  status             app.store_status not null default 'draft',

  address_line1      text,
  address_line2      text,
  city               text,
  state              text,
  postal_code        text,
  country            char(2) not null default 'US',
  latitude           double precision,
  longitude          double precision,
  phone              text,
  timezone           text not null default 'America/New_York',

  pickup_enabled     boolean not null default true,
  delivery_enabled   boolean not null default false,  -- fuera de v1

  -- Checklist de onboarding bloqueante (§2 del addendum).
  -- Mientras no este completo, la sucursal no puede pasar a 'active'.
  setup_checklist    jsonb not null default jsonb_build_object(
                       'clover_connected',      false,
                       'ecommerce_enabled',     false,
                       'order_type_ready',      false,
                       'order_printer_ready',   false,
                       'catalog_synced',        false,
                       'smoke_test_passed',     false,
                       'not_using_dining',      false
                     ),

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz,

  unique (restaurant_id, slug),
  constraint stores_latlng check (
    (latitude is null and longitude is null) or
    (latitude between -90 and 90 and longitude between -180 and 180)
  )
);

create index idx_stores_restaurant on public.stores(restaurant_id) where deleted_at is null;
create index idx_stores_active on public.stores(status) where deleted_at is null;

create trigger trg_stores_updated
  before update on public.stores
  for each row execute function app.touch_updated_at();

-- Regla dura: no se puede activar una sucursal con el checklist incompleto.
create or replace function app.enforce_store_activation()
returns trigger
language plpgsql
as $$
declare
  incomplete int;
begin
  if new.status = 'active' then
    select count(*) into incomplete
    from jsonb_each(new.setup_checklist) as kv(k, v)
    where v = 'false'::jsonb;

    if incomplete > 0 then
      raise exception
        'No se puede activar la sucursal %: checklist de onboarding incompleto (% pendientes)',
        new.id, incomplete;
    end if;
  end if;
  return new;
end;
$$;

create trigger trg_stores_activation
  before insert or update of status on public.stores
  for each row execute function app.enforce_store_activation();

-- Horarios de servicio. Default desde Clover (evento SH), editable en el SaaS.
create table public.store_hours (
  id         uuid primary key default gen_random_uuid(),
  store_id   uuid not null references public.stores(id) on delete cascade,
  weekday    smallint not null check (weekday between 0 and 6), -- 0 = domingo
  opens_at   time not null,
  closes_at  time not null,
  created_at timestamptz not null default now(),
  unique (store_id, weekday, opens_at)
);

create index idx_store_hours_store on public.store_hours(store_id);

-- Capacidad de pickup: dato 100% nuestro, Clover no agenda.
create table public.store_pickup_config (
  store_id            uuid primary key references public.stores(id) on delete cascade,
  slot_minutes        smallint not null default 15 check (slot_minutes between 5 and 60),
  lead_time_minutes   smallint not null default 10 check (lead_time_minutes >= 0),
  max_orders_per_slot smallint not null default 8 check (max_orders_per_slot > 0),
  max_days_ahead      smallint not null default 2 check (max_days_ahead between 0 and 14),
  asap_enabled        boolean not null default true,
  updated_at          timestamptz not null default now()
);

create trigger trg_pickup_config_updated
  before update on public.store_pickup_config
  for each row execute function app.touch_updated_at();

-- Cierres puntuales (feriados, mantenimiento).
create table public.store_closures (
  id         uuid primary key default gen_random_uuid(),
  store_id   uuid not null references public.stores(id) on delete cascade,
  starts_at  timestamptz not null,
  ends_at    timestamptz not null,
  reason     text,
  created_at timestamptz not null default now(),
  constraint store_closures_range check (ends_at > starts_at)
);

create index idx_store_closures_store on public.store_closures(store_id, starts_at);

-- ---------------------------------------------------------------------
-- CONFIGURACION DE APP Y BRANDING (por marca, no por sucursal)
-- ---------------------------------------------------------------------

create table public.app_settings (
  restaurant_id     uuid primary key references public.restaurants(id) on delete cascade,
  app_display_name  text not null,
  logo_url          text,
  icon_url          text,
  splash_url        text,
  primary_color     text not null default '#111111',
  secondary_color   text not null default '#FFFFFF',
  accent_color      text not null default '#111111',
  banners           jsonb not null default '[]'::jsonb,
  -- feature flags: loyalty, promotions, tips, favorites, scheduling...
  features          jsonb not null default jsonb_build_object(
                      'loyalty',    true,
                      'promotions', true,
                      'tips',       true,   -- DECISION PENDIENTE (recomendado: true)
                      'favorites',  true,
                      'scheduling', true
                    ),
  legal_urls        jsonb not null default '{}'::jsonb,
  updated_at        timestamptz not null default now(),
  constraint app_settings_color_format check (
    primary_color ~ '^#[0-9A-Fa-f]{6}$' and
    secondary_color ~ '^#[0-9A-Fa-f]{6}$' and
    accent_color ~ '^#[0-9A-Fa-f]{6}$'
  )
);

create trigger trg_app_settings_updated
  before update on public.app_settings
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------
-- USUARIOS
-- ---------------------------------------------------------------------

create table public.profiles (
  id                uuid primary key references auth.users(id) on delete cascade,
  first_name        text,
  last_name         text,
  phone             text,
  birthdate         date,
  marketing_opt_in  boolean not null default false,
  default_store_id  uuid references public.stores(id) on delete set null,
  locale            text not null default 'en-US',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create trigger trg_profiles_updated
  before update on public.profiles
  for each row execute function app.touch_updated_at();

-- Crear perfil automaticamente al registrarse.
create or replace function app.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  insert into public.profiles (id, first_name, last_name)
  values (
    new.id,
    new.raw_user_meta_data ->> 'first_name',
    new.raw_user_meta_data ->> 'last_name'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger trg_auth_user_created
  after insert on auth.users
  for each row execute function app.handle_new_user();

create table public.addresses (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  label      text,
  line1      text not null,
  line2      text,
  city       text not null,
  state      text,
  postal_code text,
  country    char(2) not null default 'US',
  latitude   double precision,
  longitude  double precision,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_addresses_user on public.addresses(user_id);

create trigger trg_addresses_updated
  before update on public.addresses
  for each row execute function app.touch_updated_at();

create table public.push_tokens (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  token        text not null unique,
  platform     text not null check (platform in ('android', 'ios', 'web')),
  device_model text,
  last_seen_at timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

create index idx_push_tokens_user on public.push_tokens(user_id);

-- ---------------------------------------------------------------------
-- ADMINISTRADORES DE PLATAFORMA
-- ---------------------------------------------------------------------

create table public.platform_admins (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null unique references auth.users(id) on delete cascade,
  role        app.admin_role not null default 'read_only',
  created_at  timestamptz not null default now(),
  disabled_at timestamptz
);

-- ¿El usuario actual es administrador de la plataforma?
-- SECURITY DEFINER para evitar recursion de RLS al consultar platform_admins.
-- Se define aqui (y no en la seccion de helpers) porque PostgreSQL valida
-- el cuerpo de las funciones SQL en el momento de crearlas.
create or replace function app.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = app, public, pg_catalog
as $$
  select exists (
    select 1
    from public.platform_admins pa
    where pa.user_id = auth.uid()
      and pa.disabled_at is null
  );
$$;

-- Toda accion del super admin sobre datos de tenant queda registrada.
create table public.admin_audit_log (
  id           bigserial primary key,
  admin_user_id uuid references auth.users(id) on delete set null,
  action       text not null,
  entity_type  text,
  entity_id    text,
  restaurant_id uuid references public.restaurants(id) on delete set null,
  detail       jsonb,
  ip_address   inet,
  created_at   timestamptz not null default now()
);

create index idx_audit_admin on public.admin_audit_log(admin_user_id, created_at desc);
create index idx_audit_restaurant on public.admin_audit_log(restaurant_id, created_at desc);
