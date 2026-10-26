-- =====================================================================
-- 01-base-viva-juice.sql
-- Generado por scripts/sql/armar-entrega.mjs. No editar a mano.
--
-- Cómo correrlo: Supabase → SQL Editor → New query → pegar TODO el
-- archivo → Run. Se puede correr dos veces: lo que ya está, se salta.
-- Migraciones incluidas: 0001_core.sql … 0033_estadisticas_graficas.sql (33).
-- =====================================================================

create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (
  version    text not null primary key,
  statements text[],
  name       text
);

-- 0001_core.sql
do $entrega$
begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '0001') then
    raise notice 'Migración 0001 ya aplicada: se salta.';
    return;
  end if;
  execute $m0001$
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

$m0001$;
  insert into supabase_migrations.schema_migrations (version, name) values ('0001', 'core');
  raise notice 'Migración 0001 aplicada.';
end
$entrega$;

-- 0002_clover_catalog.sql
do $entrega$
begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '0002') then
    raise notice 'Migración 0002 ya aplicada: se salta.';
    return;
  end if;
  execute $m0002$
-- =====================================================================
-- 0002_clover_catalog.sql
-- Integracion con Clover: conexiones, webhooks, estado de sync,
-- y el catalogo espejo (SOLO LECTURA desde Clover).
--
-- Regla: nunca escribimos catalogo en Clover. Este espejo existe por
-- latencia y por los limites de rate (50 req/s por app, compartidos).
-- =====================================================================

-- ---------------------------------------------------------------------
-- CONEXION OAUTH POR SUCURSAL  (1 store = 1 merchantId = 1 conexion)
-- ---------------------------------------------------------------------

create table public.clover_connections (
  id                        uuid primary key default gen_random_uuid(),
  store_id                  uuid not null unique references public.stores(id) on delete cascade,
  restaurant_id             uuid not null references public.restaurants(id) on delete cascade,

  merchant_id               text,                 -- mId de Clover
  environment               text not null default 'sandbox'
                              check (environment in ('sandbox', 'production')),
  api_base_url              text not null default 'https://apisandbox.dev.clover.com',

  -- Los tokens NO se guardan en claro. Se referencian por id de secreto
  -- en Supabase Vault. Esta tabla ademas tiene RLS sin ninguna policy,
  -- asi que solo service_role puede leerla.
  access_token_secret_id    uuid,
  refresh_token_secret_id   uuid,
  access_token_expires_at   timestamptz,
  refresh_token_expires_at  timestamptz,

  granted_permissions       text[] not null default '{}',
  order_type_id             text,                 -- cacheado en onboarding
  ecommerce_enabled         boolean not null default false,
  ecommerce_public_key      text,                 -- PAKMS (publica, no es secreto)
  default_tax_rate_id       text,

  status                    app.connection_status not null default 'not_connected',
  connect_token             text unique,          -- enlace firmado enviado al merchant
  connect_token_expires_at  timestamptz,

  last_sync_at              timestamptz,
  last_webhook_at           timestamptz,
  last_error                text,
  last_error_at             timestamptz,
  consecutive_failures      int not null default 0,

  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  -- Un merchant de Clover no puede estar conectado a dos sucursales.
  constraint clover_connections_merchant_unique unique (environment, merchant_id)
);

create index idx_clover_conn_merchant on public.clover_connections(merchant_id);
create index idx_clover_conn_status on public.clover_connections(status);
create index idx_clover_conn_token_refresh
  on public.clover_connections(access_token_expires_at)
  where status = 'connected';

create trigger trg_clover_conn_updated
  before update on public.clover_connections
  for each row execute function app.touch_updated_at();

comment on table public.clover_connections is
  'RLS habilitado SIN policies: accesible unicamente por service_role. '
  'El SaaS lee un resumen sin secretos via Edge Function.';

-- Vista segura para el SaaS: nunca expone secretos ni ids de vault.
create or replace view public.clover_connection_status as
select
  c.store_id,
  c.restaurant_id,
  c.status,
  c.environment,
  case when c.merchant_id is null then null
       else '****' || right(c.merchant_id, 4) end as merchant_masked,
  c.ecommerce_enabled,
  (c.order_type_id is not null)                    as order_type_ready,
  cardinality(c.granted_permissions)               as permissions_granted,
  c.last_sync_at,
  c.last_webhook_at,
  c.access_token_expires_at,
  c.consecutive_failures,
  c.last_error_at
from public.clover_connections c;

-- ---------------------------------------------------------------------
-- WEBHOOKS
-- Payload de Clover: {appId, merchants:{mId:[{objectId,type,ts}]}}
-- No trae el objeto: siempre hay que hacer GET despues. Ver §3.
-- ---------------------------------------------------------------------

create table public.clover_webhook_events (
  id            bigserial primary key,
  merchant_id   text not null,
  store_id      uuid references public.stores(id) on delete set null,

  object_type   text not null,   -- 'O','P','I','IC','IG','IM','M','A','C','SH','E','CA'
  object_id     text not null,
  event_type    text not null check (event_type in ('CREATE', 'UPDATE', 'DELETE')),
  clover_ts     bigint not null, -- epoch ms tal cual lo manda Clover

  status        app.webhook_status not null default 'pending',
  attempts      int not null default 0,
  last_error    text,
  raw_payload   jsonb,

  received_at   timestamptz not null default now(),
  processed_at  timestamptz,

  -- Idempotencia: Clover no garantiza entrega unica ni ordenada.
  constraint clover_webhook_dedupe
    unique (merchant_id, object_type, object_id, event_type, clover_ts)
);

create index idx_webhook_pending
  on public.clover_webhook_events(status, received_at)
  where status in ('pending', 'failed');
create index idx_webhook_merchant
  on public.clover_webhook_events(merchant_id, received_at desc);

-- ---------------------------------------------------------------------
-- ESTADO DE SINCRONIZACION
-- Se filtra por modifiedTime para no re-descargar lo que no cambio
-- (practica recomendada por Clover para evitar 429).
-- ---------------------------------------------------------------------

create table public.clover_sync_state (
  id                  uuid primary key default gen_random_uuid(),
  store_id            uuid not null references public.stores(id) on delete cascade,
  entity_type         app.sync_entity not null,
  last_modified_time  bigint,          -- epoch ms del ultimo objeto procesado
  last_full_sync_at   timestamptz,
  last_delta_sync_at  timestamptz,
  last_error          text,
  -- offset determinista para escalonar los barridos entre sucursales
  sweep_offset_seconds smallint not null default 0,
  updated_at          timestamptz not null default now(),
  unique (store_id, entity_type)
);

create trigger trg_sync_state_updated
  before update on public.clover_sync_state
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------
-- CATALOGO ESPEJO  (read-only desde Clover)
-- ---------------------------------------------------------------------

create table public.catalog_categories (
  id                   uuid primary key default gen_random_uuid(),
  store_id             uuid not null references public.stores(id) on delete cascade,
  clover_category_id   text not null,
  name                 text not null,
  sort_order           int not null default 0,
  clover_modified_time bigint,
  synced_at            timestamptz not null default now(),
  deleted_at           timestamptz,
  unique (store_id, clover_category_id)
);

create index idx_catalog_categories_store
  on public.catalog_categories(store_id) where deleted_at is null;

create table public.catalog_tax_rates (
  id                 uuid primary key default gen_random_uuid(),
  store_id           uuid not null references public.stores(id) on delete cascade,
  clover_tax_rate_id text not null,
  name               text not null,
  rate               bigint not null,   -- Clover usa millonesimas de porcentaje
  is_default         boolean not null default false,
  synced_at          timestamptz not null default now(),
  deleted_at         timestamptz,
  unique (store_id, clover_tax_rate_id)
);

create table public.catalog_items (
  id                   uuid primary key default gen_random_uuid(),
  store_id             uuid not null references public.stores(id) on delete cascade,
  clover_item_id       text not null,
  category_id          uuid references public.catalog_categories(id) on delete set null,

  name                 text not null,
  alternate_name       text,
  sku                  text,
  price_cents          bigint not null default 0 check (price_cents >= 0),
  price_type           text not null default 'FIXED',

  -- Disponibilidad tal como la reporta Clover. El comportamiento exacto
  -- de estos flags se valida en sandbox (Fase 7).
  available            boolean not null default true,
  hidden               boolean not null default false,
  stock_count          numeric,

  clover_modified_time bigint,
  synced_at            timestamptz not null default now(),
  deleted_at           timestamptz,

  unique (store_id, clover_item_id)
);

create index idx_catalog_items_store
  on public.catalog_items(store_id) where deleted_at is null;
create index idx_catalog_items_category
  on public.catalog_items(category_id) where deleted_at is null;

create table public.catalog_item_tax_rates (
  item_id     uuid not null references public.catalog_items(id) on delete cascade,
  tax_rate_id uuid not null references public.catalog_tax_rates(id) on delete cascade,
  primary key (item_id, tax_rate_id)
);

create table public.catalog_modifier_groups (
  id                   uuid primary key default gen_random_uuid(),
  store_id             uuid not null references public.stores(id) on delete cascade,
  clover_group_id      text not null,
  name                 text not null,
  min_required         smallint not null default 0,
  max_allowed          smallint,
  sort_order           int not null default 0,
  clover_modified_time bigint,
  synced_at            timestamptz not null default now(),
  deleted_at           timestamptz,
  unique (store_id, clover_group_id),
  constraint modifier_group_bounds check (
    max_allowed is null or max_allowed >= min_required
  )
);

create table public.catalog_item_modifier_groups (
  item_id           uuid not null references public.catalog_items(id) on delete cascade,
  modifier_group_id uuid not null references public.catalog_modifier_groups(id) on delete cascade,
  sort_order        int not null default 0,
  primary key (item_id, modifier_group_id)
);

create table public.catalog_modifiers (
  id                   uuid primary key default gen_random_uuid(),
  store_id             uuid not null references public.stores(id) on delete cascade,
  modifier_group_id    uuid not null references public.catalog_modifier_groups(id) on delete cascade,
  clover_modifier_id   text not null,
  name                 text not null,
  price_cents          bigint not null default 0,
  available            boolean not null default true,
  sort_order           int not null default 0,
  clover_modified_time bigint,
  synced_at            timestamptz not null default now(),
  deleted_at           timestamptz,
  unique (store_id, clover_modifier_id)
);

create index idx_catalog_modifiers_group
  on public.catalog_modifiers(modifier_group_id) where deleted_at is null;

-- ---------------------------------------------------------------------
-- OVERRIDES DE MERCHANDISING
-- Unico lugar donde mandamos nosotros sobre el catalogo, y SOLO para
-- presentacion. Jamas para precio. Ver §8.4 del documento de arquitectura.
-- ---------------------------------------------------------------------

create table public.app_item_overrides (
  id                 uuid primary key default gen_random_uuid(),
  store_id           uuid not null references public.stores(id) on delete cascade,
  clover_item_id     text not null,

  app_visible        boolean not null default true,
  featured           boolean not null default false,
  sort_order         int not null default 0,
  image_url          text,
  marketing_copy     text,
  badge              text,

  -- "86" rapido: ocultar el item hasta una hora concreta, para cuando el
  -- restaurante no mantiene el stock en Clover (que es lo habitual).
  unavailable_until  timestamptz,
  unavailable_reason text,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (store_id, clover_item_id)
);

create trigger trg_item_overrides_updated
  before update on public.app_item_overrides
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------
-- VISTA DE MENU PARA LA APP
-- Combina el espejo de Clover con los overrides. La app consume esto.
-- ---------------------------------------------------------------------

create or replace view public.menu_items as
select
  i.id,
  i.store_id,
  i.clover_item_id,
  i.name,
  coalesce(o.marketing_copy, i.alternate_name) as description,
  i.price_cents,
  c.id            as category_id,
  c.name          as category_name,
  c.sort_order    as category_sort,
  o.image_url,
  coalesce(o.featured, false)   as featured,
  coalesce(o.sort_order, 0)     as sort_order,
  o.badge,
  -- Disponible solo si Clover lo permite Y no hay un 86 activo.
  (
    i.available
    and not i.hidden
    and coalesce(o.app_visible, true)
    and (o.unavailable_until is null or o.unavailable_until < now())
  ) as is_available,
  o.unavailable_reason
from public.catalog_items i
left join public.catalog_categories c on c.id = i.category_id and c.deleted_at is null
left join public.app_item_overrides o
       on o.store_id = i.store_id and o.clover_item_id = i.clover_item_id
where i.deleted_at is null;

$m0002$;
  insert into supabase_migrations.schema_migrations (version, name) values ('0002', 'clover_catalog');
  raise notice 'Migración 0002 aplicada.';
end
$entrega$;

-- 0003_orders_loyalty.sql
do $entrega$
begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '0003') then
    raise notice 'Migración 0003 ya aplicada: se salta.';
    return;
  end if;
  execute $m0003$
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

$m0003$;
  insert into supabase_migrations.schema_migrations (version, name) values ('0003', 'orders_loyalty');
  raise notice 'Migración 0003 aplicada.';
end
$entrega$;

-- 0004_rls.sql
do $entrega$
begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '0004') then
    raise notice 'Migración 0004 ya aplicada: se salta.';
    return;
  end if;
  execute $m0004$
-- =====================================================================
-- 0004_rls.sql
-- Row Level Security. Todas las policies viven en un solo archivo para
-- que sean auditables de un vistazo.
--
-- Modelo mental:
--   anon           -> puede ver el menu publico de sucursales activas
--   authenticated  -> lo anterior + SUS datos (perfil, ordenes, loyalty)
--   platform_admin -> lectura/escritura administrativa
--   service_role   -> bypass total (Edge Functions y workers)
--
-- REGLA CRITICA: el cliente NUNCA inserta ni actualiza ordenes, pagos ni
-- loyalty directamente. Eso lo hace el backend con service_role. Si una
-- tabla no tiene policy de INSERT/UPDATE, es deliberado.
-- =====================================================================

-- Habilitar RLS en absolutamente todo.
alter table public.restaurants              enable row level security;
alter table public.stores                   enable row level security;
alter table public.store_hours              enable row level security;
alter table public.store_pickup_config      enable row level security;
alter table public.store_closures           enable row level security;
alter table public.app_settings             enable row level security;
alter table public.profiles                 enable row level security;
alter table public.addresses                enable row level security;
alter table public.push_tokens              enable row level security;
alter table public.platform_admins          enable row level security;
alter table public.admin_audit_log          enable row level security;
alter table public.clover_connections       enable row level security;
alter table public.clover_webhook_events    enable row level security;
alter table public.clover_sync_state        enable row level security;
alter table public.catalog_categories       enable row level security;
alter table public.catalog_tax_rates        enable row level security;
alter table public.catalog_items            enable row level security;
alter table public.catalog_item_tax_rates   enable row level security;
alter table public.catalog_modifier_groups  enable row level security;
alter table public.catalog_item_modifier_groups enable row level security;
alter table public.catalog_modifiers        enable row level security;
alter table public.app_item_overrides       enable row level security;
alter table public.order_counters           enable row level security;
alter table public.checkout_attempts        enable row level security;
alter table public.orders                   enable row level security;
alter table public.order_items              enable row level security;
alter table public.order_item_modifiers     enable row level security;
alter table public.payments                 enable row level security;
alter table public.refunds                  enable row level security;
alter table public.reconciliation_runs      enable row level security;
alter table public.reconciliation_findings  enable row level security;
alter table public.loyalty_programs         enable row level security;
alter table public.loyalty_accounts         enable row level security;
alter table public.loyalty_transactions     enable row level security;
alter table public.rewards                  enable row level security;
alter table public.reward_redemptions       enable row level security;
alter table public.promotions               enable row level security;
alter table public.promotion_uses           enable row level security;
alter table public.notifications            enable row level security;
alter table public.favorites                enable row level security;

-- ---------------------------------------------------------------------
-- CATALOGO Y TIENDAS: lectura publica de lo activo
-- ---------------------------------------------------------------------

create policy restaurants_public_read on public.restaurants
  for select to anon, authenticated
  using (status = 'active');

create policy stores_public_read on public.stores
  for select to anon, authenticated
  using (
    deleted_at is null
    and status in ('active', 'paused')
    and exists (
      select 1 from public.restaurants r
      where r.id = stores.restaurant_id and r.status = 'active'
    )
  );

create policy store_hours_public_read on public.store_hours
  for select to anon, authenticated
  using (exists (
    select 1 from public.stores s
    where s.id = store_hours.store_id
      and s.deleted_at is null
      and s.status in ('active', 'paused')
  ));

create policy pickup_config_public_read on public.store_pickup_config
  for select to anon, authenticated
  using (exists (
    select 1 from public.stores s
    where s.id = store_pickup_config.store_id and s.status in ('active', 'paused')
  ));

create policy closures_public_read on public.store_closures
  for select to anon, authenticated
  using (exists (
    select 1 from public.stores s
    where s.id = store_closures.store_id and s.status in ('active', 'paused')
  ));

create policy app_settings_public_read on public.app_settings
  for select to anon, authenticated
  using (exists (
    select 1 from public.restaurants r
    where r.id = app_settings.restaurant_id and r.status = 'active'
  ));

-- Helper: ¿la sucursal es visible para clientes?
create or replace function app.store_is_public(p_store_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select exists (
    select 1 from public.stores s
    where s.id = p_store_id
      and s.deleted_at is null
      and s.status in ('active', 'paused')
  );
$$;

create policy catalog_categories_read on public.catalog_categories
  for select to anon, authenticated
  using (deleted_at is null and app.store_is_public(store_id));

create policy catalog_items_read on public.catalog_items
  for select to anon, authenticated
  using (deleted_at is null and app.store_is_public(store_id));

create policy catalog_tax_rates_read on public.catalog_tax_rates
  for select to anon, authenticated
  using (deleted_at is null and app.store_is_public(store_id));

create policy catalog_mod_groups_read on public.catalog_modifier_groups
  for select to anon, authenticated
  using (deleted_at is null and app.store_is_public(store_id));

create policy catalog_modifiers_read on public.catalog_modifiers
  for select to anon, authenticated
  using (deleted_at is null and app.store_is_public(store_id));

create policy catalog_item_mod_groups_read on public.catalog_item_modifier_groups
  for select to anon, authenticated
  using (exists (
    select 1 from public.catalog_items i
    where i.id = catalog_item_modifier_groups.item_id
      and app.store_is_public(i.store_id)
  ));

create policy catalog_item_tax_read on public.catalog_item_tax_rates
  for select to anon, authenticated
  using (exists (
    select 1 from public.catalog_items i
    where i.id = catalog_item_tax_rates.item_id
      and app.store_is_public(i.store_id)
  ));

create policy item_overrides_read on public.app_item_overrides
  for select to anon, authenticated
  using (app.store_is_public(store_id));

-- Escritura de catalogo y overrides: solo admins (los overrides) y
-- service_role (el espejo). El catalogo espejo NO se edita a mano.
create policy item_overrides_admin_write on public.app_item_overrides
  for all to authenticated
  using (app.is_platform_admin())
  with check (app.is_platform_admin());

-- ---------------------------------------------------------------------
-- DATOS DEL USUARIO
-- ---------------------------------------------------------------------

create policy profiles_self on public.profiles
  for select to authenticated using (id = auth.uid());

create policy profiles_self_update on public.profiles
  for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

create policy addresses_self on public.addresses
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy push_tokens_self on public.push_tokens
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy favorites_self on public.favorites
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy notifications_self_read on public.notifications
  for select to authenticated using (user_id = auth.uid());

-- Solo se permite marcar como leida; nada mas.
create policy notifications_self_mark_read on public.notifications
  for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------------------------------------------------------------------
-- ORDENES: lectura propia. La escritura es exclusiva del backend.
-- ---------------------------------------------------------------------

create policy orders_self_read on public.orders
  for select to authenticated using (user_id = auth.uid());

create policy order_items_self_read on public.order_items
  for select to authenticated
  using (exists (
    select 1 from public.orders o
    where o.id = order_items.order_id and o.user_id = auth.uid()
  ));

create policy order_item_mods_self_read on public.order_item_modifiers
  for select to authenticated
  using (exists (
    select 1 from public.order_items oi
    join public.orders o on o.id = oi.order_id
    where oi.id = order_item_modifiers.order_item_id and o.user_id = auth.uid()
  ));

-- El cliente ve el resultado del pago, nunca el raw_response.
create policy payments_self_read on public.payments
  for select to authenticated
  using (exists (
    select 1 from public.orders o
    where o.id = payments.order_id and o.user_id = auth.uid()
  ));

create policy refunds_self_read on public.refunds
  for select to authenticated
  using (exists (
    select 1 from public.orders o
    where o.id = refunds.order_id and o.user_id = auth.uid()
  ));

-- ---------------------------------------------------------------------
-- LOYALTY Y PROMOCIONES
-- ---------------------------------------------------------------------

create policy loyalty_accounts_self on public.loyalty_accounts
  for select to authenticated using (user_id = auth.uid());

create policy loyalty_tx_self on public.loyalty_transactions
  for select to authenticated
  using (exists (
    select 1 from public.loyalty_accounts a
    where a.id = loyalty_transactions.account_id and a.user_id = auth.uid()
  ));

create policy loyalty_programs_read on public.loyalty_programs
  for select to anon, authenticated
  using (exists (
    select 1 from public.restaurants r
    where r.id = loyalty_programs.restaurant_id and r.status = 'active'
  ));

create policy rewards_read on public.rewards
  for select to anon, authenticated
  using (active and exists (
    select 1 from public.restaurants r
    where r.id = rewards.tenant_id and r.status = 'active'
  ));

create policy redemptions_self_read on public.reward_redemptions
  for select to authenticated using (user_id = auth.uid());

-- Promociones publicas: se ven las activas y vigentes. Las de codigo
-- se validan en el backend, no se listan.
create policy promotions_public_read on public.promotions
  for select to anon, authenticated
  using (
    active
    and code is null
    and starts_at <= now()
    and (ends_at is null or ends_at > now())
    and exists (
      select 1 from public.restaurants r
      where r.id = promotions.tenant_id and r.status = 'active'
    )
  );

create policy promotion_uses_self_read on public.promotion_uses
  for select to authenticated using (user_id = auth.uid());

-- ---------------------------------------------------------------------
-- ADMINISTRACION
-- ---------------------------------------------------------------------

create policy platform_admins_self_read on public.platform_admins
  for select to authenticated using (user_id = auth.uid());

create policy audit_admin_read on public.admin_audit_log
  for select to authenticated using (app.is_platform_admin());

do $$
declare
  t text;
  admin_tables text[] := array[
    'restaurants', 'stores', 'store_hours', 'store_pickup_config',
    'store_closures', 'app_settings', 'loyalty_programs', 'rewards',
    'promotions', 'reconciliation_runs', 'reconciliation_findings',
    'orders', 'order_items', 'payments', 'refunds', 'clover_sync_state'
  ];
begin
  foreach t in array admin_tables loop
    execute format(
      'create policy %I on public.%I for all to authenticated
         using (app.is_platform_admin()) with check (app.is_platform_admin())',
      t || '_admin_all', t
    );
  end loop;
end;
$$;

-- ---------------------------------------------------------------------
-- TABLAS SIN NINGUNA POLICY  (= solo service_role)
--   clover_connections      -> contiene referencias a secretos
--   clover_webhook_events   -> ruido operativo, datos de todos los tenants
--   checkout_attempts       -> idempotencia, no debe manipularse
--   order_counters          -> integridad de la numeracion
-- Esto es deliberado. NO agregar policies aqui sin revisar seguridad.
-- ---------------------------------------------------------------------

-- Blindaje de la vista de estado: solo admins.
revoke all on public.clover_connection_status from anon, authenticated;
grant select on public.clover_connection_status to authenticated;

-- ---------------------------------------------------------------------
-- REALTIME: la app se suscribe al estado de su pedido.
-- RLS sigue aplicando sobre el canal.
-- ---------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    execute 'alter publication supabase_realtime add table public.orders';
    execute 'alter publication supabase_realtime add table public.notifications';
  end if;
end;
$$;

$m0004$;
  insert into supabase_migrations.schema_migrations (version, name) values ('0004', 'rls');
  raise notice 'Migración 0004 aplicada.';
end
$entrega$;

-- 0005_storage.sql
do $entrega$
begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '0005') then
    raise notice 'Migración 0005 ya aplicada: se salta.';
    return;
  end if;
  execute $m0005$
-- =====================================================================
-- 0005_storage.sql
-- Buckets de Supabase Storage.
--   branding    -> logos, iconos, splash, banners (publico)
--   menu-images -> fotos de producto (publico). Ver §8.4: es el unico
--                  punto donde duplicamos catalogo a proposito, porque
--                  las imagenes de Clover no dan la calidad que queremos.
--   receipts    -> comprobantes y adjuntos de soporte (privado)
--
-- Escritura: solo administradores de plataforma. Lectura: publica en los
-- dos primeros, porque la app los consume sin sesion iniciada.
-- =====================================================================

do $$
begin
  if to_regclass('storage.buckets') is null then
    raise notice 'Esquema storage no disponible: se omite 0005 (correr en Supabase).';
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values
    ('branding',    'branding',    true,  5242880,
     array['image/png','image/jpeg','image/webp','image/svg+xml']),
    ('menu-images', 'menu-images', true,  5242880,
     array['image/png','image/jpeg','image/webp']),
    ('receipts',    'receipts',    false, 10485760,
     array['application/pdf','image/png','image/jpeg'])
  on conflict (id) do nothing;

  -- Lectura publica de branding e imagenes de menu.
  execute $p$
    create policy "public read branding assets" on storage.objects
      for select to anon, authenticated
      using (bucket_id in ('branding', 'menu-images'))
  $p$;

  -- Escritura reservada a administradores.
  execute $p$
    create policy "admins manage branding assets" on storage.objects
      for all to authenticated
      using (bucket_id in ('branding','menu-images') and app.is_platform_admin())
      with check (bucket_id in ('branding','menu-images') and app.is_platform_admin())
  $p$;

  execute $p$
    create policy "admins manage receipts" on storage.objects
      for all to authenticated
      using (bucket_id = 'receipts' and app.is_platform_admin())
      with check (bucket_id = 'receipts' and app.is_platform_admin())
  $p$;
exception
  when duplicate_object then
    raise notice 'Policies de storage ya existentes: se omiten.';
end;
$$;

-- Convencion de rutas (obligatoria, para poder limpiar por tenant):
--   branding/{restaurant_id}/logo.png
--   branding/{restaurant_id}/banners/{uuid}.webp
--   menu-images/{store_id}/{clover_item_id}.webp
--   receipts/{restaurant_id}/{order_id}.pdf

$m0005$;
  insert into supabase_migrations.schema_migrations (version, name) values ('0005', 'storage');
  raise notice 'Migración 0005 aplicada.';
end
$entrega$;

-- 0006_grants.sql
do $entrega$
begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '0006') then
    raise notice 'Migración 0006 ya aplicada: se salta.';
    return;
  end if;
  execute $m0006$
-- =====================================================================
-- 0006_grants.sql
-- Privilegios explicitos para los roles de la Data API.
--
-- POR QUE EXISTE ESTA MIGRACION
-- En Supabase hay DOS capas de control y ambas deben permitir el acceso:
--   1. GRANT  -> ¿el rol tiene permiso sobre la tabla? (nivel tabla)
--   2. RLS    -> ¿que filas puede ver? (nivel fila)
-- Las migraciones 0001-0005 configuran la capa 2 pero no la 1.
--
-- Al crear el proyecto desactivamos "Automatically expose new tables",
-- que es lo correcto por seguridad, pero implica que los privilegios ya
-- NO se conceden solos: hay que otorgarlos tabla por tabla, a proposito.
-- Sin esto la app recibe "permission denied" en todo.
--
-- Otorgar un GRANT amplio no abre la puerta: RLS sigue filtrando fila a
-- fila. Es exactamente el modelo que usa Supabase por defecto.
-- =====================================================================

grant usage on schema public to anon, authenticated;

-- Las policies llaman a estas funciones; el rol necesita poder ejecutarlas.
grant usage on schema app to anon, authenticated;
grant execute on function app.is_platform_admin()      to authenticated;
grant execute on function app.store_is_public(uuid)     to anon, authenticated;
grant execute on function app.generate_pickup_code()    to authenticated;

-- ---------------------------------------------------------------------
-- LECTURA PUBLICA: menu, sucursales y branding.
-- La app muestra el menu antes de que el usuario inicie sesion.
-- ---------------------------------------------------------------------

grant select on
  public.restaurants,
  public.stores,
  public.store_hours,
  public.store_pickup_config,
  public.store_closures,
  public.app_settings,
  public.catalog_categories,
  public.catalog_items,
  public.catalog_tax_rates,
  public.catalog_item_tax_rates,
  public.catalog_modifier_groups,
  public.catalog_modifiers,
  public.catalog_item_modifier_groups,
  public.app_item_overrides,
  public.promotions,
  public.rewards,
  public.loyalty_programs,
  public.menu_items            -- la vista que consume la app
to anon, authenticated;

-- ---------------------------------------------------------------------
-- USUARIO AUTENTICADO: sus propios datos.
-- RLS ya restringe a user_id = auth.uid().
-- ---------------------------------------------------------------------

grant select, update on public.profiles to authenticated;

grant select, insert, update, delete on
  public.addresses,
  public.favorites,
  public.push_tokens
to authenticated;

grant select on
  public.order_items,
  public.order_item_modifiers,
  public.loyalty_accounts,
  public.loyalty_transactions,
  public.reward_redemptions,
  public.promotion_uses,
  public.platform_admins,
  public.admin_audit_log
to authenticated;

-- Solo para marcarlas como leidas.
grant select, update on public.notifications to authenticated;

-- ---------------------------------------------------------------------
-- TABLAS QUE ADMINISTRA EL SUPER ADMIN.
-- El GRANT es amplio, pero las policies exigen app.is_platform_admin().
-- Un cliente autenticado que intente escribir aqui no pasa de RLS.
-- ---------------------------------------------------------------------

grant insert, update, delete on
  public.restaurants,
  public.stores,
  public.store_hours,
  public.store_pickup_config,
  public.store_closures,
  public.app_settings,
  public.loyalty_programs,
  public.rewards,
  public.promotions,
  public.app_item_overrides,
  public.clover_sync_state
to authenticated;

grant select, insert, update, delete on
  public.reconciliation_runs,
  public.reconciliation_findings
to authenticated;

-- Las ordenes y pagos los escribe el backend con service_role.
-- El cliente solo lee; el super admin lee y corrige via policy.
grant select on
  public.orders,
  public.payments,
  public.refunds
to authenticated;
grant insert, update, delete on
  public.orders,
  public.order_items,
  public.payments,
  public.refunds
to authenticated;

grant usage, select on all sequences in schema public to authenticated;

-- ---------------------------------------------------------------------
-- SIN NINGUN GRANT, A PROPOSITO  (solo service_role llega aqui)
--   clover_connections     -> referencias a tokens de Clover
--   clover_webhook_events  -> eventos de todos los tenants
--   checkout_attempts      -> idempotencia del cobro
--   order_counters         -> integridad de la numeracion
-- No agregar grants aqui sin revisar seguridad. La ausencia es la defensa.
-- ---------------------------------------------------------------------

revoke all on public.clover_connections    from anon, authenticated;
revoke all on public.clover_webhook_events from anon, authenticated;
revoke all on public.checkout_attempts     from anon, authenticated;
revoke all on public.order_counters        from anon, authenticated;
revoke all on public.clover_connection_status from anon;

$m0006$;
  insert into supabase_migrations.schema_migrations (version, name) values ('0006', 'grants');
  raise notice 'Migración 0006 aplicada.';
end
$entrega$;

-- 0007_view_security.sql
do $entrega$
begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '0007') then
    raise notice 'Migración 0007 ya aplicada: se salta.';
    return;
  end if;
  execute $m0007$
-- =====================================================================
-- 0007_view_security.sql
-- Las vistas deben respetar el RLS de sus tablas base.
--
-- EL PROBLEMA
-- Por defecto, una vista de PostgreSQL se ejecuta con los privilegios de
-- su DUEÑO, no de quien consulta. Eso hace que las policies de las tablas
-- base no se apliquen: la vista se convierte en una puerta trasera.
--
-- Reproducido antes del arreglo, con la sucursal en 'pending_setup':
--     select count(*) from catalog_items  -> 0   (RLS funciona)
--     select count(*) from menu_items     -> 50  (la vista se lo salta)
--
-- Con security_invoker la vista se ejecuta con los privilegios de quien
-- consulta y las policies vuelven a aplicar. Requiere PostgreSQL 15+;
-- Supabase corre 15 o superior.
--
-- Detectado durante la Fase 3. Es exactamente el tipo de hueco que no
-- se ve leyendo el codigo y solo aparece al probar con el rol real.
-- =====================================================================

alter view public.menu_items set (security_invoker = on);
alter view public.clover_connection_status set (security_invoker = on);

comment on view public.menu_items is
  'Menu que consume la app. security_invoker = on: respeta el RLS de '
  'catalog_items, catalog_categories y app_item_overrides, de modo que '
  'una sucursal en pending_setup o draft no expone su catalogo.';

$m0007$;
  insert into supabase_migrations.schema_migrations (version, name) values ('0007', 'view_security');
  raise notice 'Migración 0007 aplicada.';
end
$entrega$;

-- 0008_checkout.sql
do $entrega$
begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '0008') then
    raise notice 'Migración 0008 ya aplicada: se salta.';
    return;
  end if;
  execute $m0008$
-- =====================================================================
-- 0008_checkout.sql
-- Creacion de pedidos desde la app.
--
-- POR QUE UNA FUNCION Y NO UN INSERT
-- La regla critica de 0004_rls.sql dice: "el cliente NUNCA inserta ni
-- actualiza ordenes, pagos ni loyalty directamente". Por eso `orders`
-- solo tiene policy de SELECT para el cliente y `checkout_attempts` esta
-- revocada por completo.
--
-- El documento de arquitectura resuelve esto con una Edge Function
-- /checkout que usa service_role. Mientras esa infraestructura no exista,
-- el equivalente dentro de la base es una funcion SECURITY DEFINER: se
-- ejecuta con los privilegios del dueno, no con los de quien llama, asi
-- que el cliente sigue sin poder tocar la tabla. Lo unico que puede hacer
-- es pedirle a esta funcion que valide y escriba por el.
--
-- Lo que la funcion NO se cree del cliente:
--   * los precios              -> se releen del catalogo de la sucursal
--   * la disponibilidad        -> se comprueba contra menu_items
--   * los modificadores        -> tienen que pertenecer al producto
--   * el horario y la capacidad-> se validan aqui, no en el telefono
--   * el numero de pedido      -> app.next_order_number, atomico
--
-- El pedido nace en `payment_pending`. Nada dice "confirmado" hasta que
-- haya un pago de verdad (fases 6-8).
--
-- ESTA FUNCION ES TEMPORAL: EN LA FASE 8 SE MUEVE FUERA DE LA BASE
-- Cuando entre Clover, crear el pedido y cobrarlo dejan de ser dos cosas
-- separadas: tienen que ocurrir bajo una misma idempotencia, porque el
-- fallo que hay que evitar (riesgo R10) es cobrar sin pedido o pedir sin
-- cobro. Y esa unidad no cabe aqui: un RPC de Postgres no puede llamar a
-- una API externa. No es que sea mala idea hacerlo, es que no se puede
-- hacer bien; un pg_net disparado desde la transaccion no espera
-- respuesta, y sin respuesta no hay forma de decidir si el pedido vale.
--
-- Asi que en la fase 8 esta logica se muda a la Edge Function /checkout
-- con service_role, que si puede: abre la orden, llama a Clover y
-- resuelve las dos mitades con la misma `idempotency_key`.
--
-- Lo que se conserva al mudarla (son las reglas, no el envoltorio):
--   * los precios se releen de la base, nunca llegan del telefono
--   * el modificador tiene que pertenecer a un grupo de ESE producto
--   * horario, cierres y capacidad se validan en el servidor
--   * `idempotency_key` se graba antes de crear nada
--   * la misma clave devuelve el pedido anterior, no crea un segundo
--
-- Lo que se retira al mudarla: este `create_pickup_order` y su
-- `grant execute ... to authenticated`. Mientras exista, es la unica via
-- del cliente para crear un pedido; el dia que la Edge Function entre,
-- dejar las dos abiertas seria dejar una puerta que se salta a Clover.
-- =====================================================================

-- ---------------------------------------------------------------------
-- OCUPACION DE FRANJAS
-- La app necesita saber que franjas estan llenas, pero un cliente no
-- puede leer los pedidos de los demas. Esta funcion devuelve SOLO
-- recuentos: ni ids, ni nombres, ni importes.
-- ---------------------------------------------------------------------

create or replace function public.pickup_slot_counts(
  p_store_id uuid,
  p_from     timestamptz,
  p_to       timestamptz
)
returns table (slot_start timestamptz, order_count bigint)
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select
    o.pickup_at as slot_start,
    count(*)    as order_count
  from public.orders o
  where o.store_id = p_store_id
    and o.pickup_at is not null
    and o.pickup_at >= p_from
    and o.pickup_at <  p_to
    -- Un pedido cancelado o fallido libera su hueco.
    and o.status in ('payment_pending', 'confirmed', 'preparing', 'ready')
  group by o.pickup_at;
$$;

comment on function public.pickup_slot_counts is
  'Recuento de pedidos por franja. No expone ningun dato de otros clientes.';

-- ---------------------------------------------------------------------
-- ¿ESTA ABIERTA LA SUCURSAL EN ESE INSTANTE?
-- ---------------------------------------------------------------------

create or replace function app.store_accepts_pickup_at(
  p_store_id uuid,
  p_at       timestamptz
)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
declare
  v_tz        text;
  v_local     timestamp;
  v_weekday   smallint;
  v_time      time;
  v_open      boolean;
  v_closed    boolean;
begin
  select timezone into v_tz from public.stores where id = p_store_id;
  if v_tz is null then
    return false;
  end if;

  v_local   := p_at at time zone v_tz;
  v_weekday := extract(dow from v_local)::smallint;
  v_time    := v_local::time;

  select exists (
    select 1 from public.store_hours h
    where h.store_id = p_store_id
      and h.weekday  = v_weekday
      and v_time >= h.opens_at
      and v_time <  h.closes_at
  ) into v_open;

  if not v_open then
    return false;
  end if;

  select exists (
    select 1 from public.store_closures c
    where c.store_id = p_store_id
      and p_at >= c.starts_at
      and p_at <  c.ends_at
  ) into v_closed;

  return not v_closed;
end;
$$;

-- ---------------------------------------------------------------------
-- CREAR PEDIDO
--
-- p_items: [{ "clover_item_id": "...", "quantity": 2, "note": "...",
--             "modifiers": ["SEED-MOD-MILK-OAT", ...] }, ...]
--
-- Solo llegan identificadores y cantidades. Ni un precio: los precios los
-- pone la base.
-- ---------------------------------------------------------------------

create or replace function public.create_pickup_order(
  p_store_id        uuid,
  p_idempotency_key text,
  p_pickup_at       timestamptz,
  p_is_asap         boolean,
  p_customer_note   text,
  p_items           jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_catalog
as $$
declare
  v_user_id       uuid := auth.uid();
  v_store         public.stores%rowtype;
  v_config        public.store_pickup_config%rowtype;
  v_existing      public.checkout_attempts%rowtype;
  v_order_id      uuid;
  v_order_number  int;
  v_business_day  date;
  v_subtotal      bigint := 0;
  v_item          jsonb;
  v_item_row      record;
  v_order_item_id uuid;
  v_quantity      int;
  v_unit_cents    bigint;
  v_mod_id        text;
  v_mod_row       record;
  v_slot_count    bigint;
  v_sort          int := 0;
  v_result        jsonb;
begin
  if v_user_id is null then
    raise exception 'auth_required' using errcode = '28000';
  end if;

  if p_idempotency_key is null or length(p_idempotency_key) < 8 then
    raise exception 'invalid_idempotency_key' using errcode = '22023';
  end if;

  -- ---- IDEMPOTENCIA, ANTES DE TOCAR NADA ----
  -- Un reintento con la misma clave devuelve el resultado anterior y
  -- jamas crea un segundo pedido. Es la defensa contra R10.
  select * into v_existing
  from public.checkout_attempts
  where idempotency_key = p_idempotency_key;

  if found then
    if v_existing.user_id is distinct from v_user_id then
      raise exception 'idempotency_key_conflict' using errcode = '42501';
    end if;
    if v_existing.result is not null then
      return v_existing.result;
    end if;
    -- Un intento que quedo a medias se reintenta borrandolo: no hay
    -- pedido asociado, asi que no se pierde nada.
    if v_existing.order_id is null then
      delete from public.checkout_attempts where id = v_existing.id;
    else
      raise exception 'checkout_in_progress' using errcode = '55006';
    end if;
  end if;

  -- ---- SUCURSAL ----
  select * into v_store from public.stores
  where id = p_store_id and deleted_at is null and status = 'active';
  if not found then
    raise exception 'store_not_available' using errcode = '22023';
  end if;
  if not v_store.pickup_enabled then
    raise exception 'pickup_disabled' using errcode = '22023';
  end if;

  select * into v_config from public.store_pickup_config where store_id = p_store_id;
  if not found then
    raise exception 'pickup_not_configured' using errcode = '22023';
  end if;

  -- ---- HORA DE RECOGIDA ----
  if p_pickup_at is null then
    raise exception 'pickup_at_required' using errcode = '22023';
  end if;
  if p_pickup_at < now() + make_interval(mins => v_config.lead_time_minutes) then
    raise exception 'pickup_too_soon' using errcode = '22023';
  end if;
  if p_pickup_at > now() + make_interval(days => v_config.max_days_ahead + 1) then
    raise exception 'pickup_too_far' using errcode = '22023';
  end if;
  if not app.store_accepts_pickup_at(p_store_id, p_pickup_at) then
    raise exception 'store_closed_at_pickup' using errcode = '22023';
  end if;

  -- Capacidad de la franja. Se comprueba aqui aunque la app ya lo haya
  -- mirado: entre que el cliente elige y confirma, otro puede ocuparla.
  select count(*) into v_slot_count
  from public.orders o
  where o.store_id = p_store_id
    and o.pickup_at = p_pickup_at
    and o.status in ('payment_pending', 'confirmed', 'preparing', 'ready');

  if v_slot_count >= v_config.max_orders_per_slot then
    raise exception 'slot_full' using errcode = '23505';
  end if;

  -- ---- CARRITO ----
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'empty_cart' using errcode = '22023';
  end if;

  v_business_day := (now() at time zone v_store.timezone)::date;
  v_order_number := app.next_order_number(p_store_id, v_business_day);

  insert into public.orders (
    tenant_id, store_id, user_id, order_number, business_day,
    status, fulfillment, pickup_at, is_asap, customer_note,
    idempotency_key, currency
  )
  values (
    v_store.restaurant_id, p_store_id, v_user_id, v_order_number, v_business_day,
    -- Nace pendiente de pago. Nada dice "confirmado" sin un pago real.
    'payment_pending', 'pickup', p_pickup_at, coalesce(p_is_asap, false),
    nullif(btrim(coalesce(p_customer_note, '')), ''),
    p_idempotency_key, 'USD'
  )
  returning id into v_order_id;

  insert into public.checkout_attempts (idempotency_key, user_id, store_id, order_id, state, request_payload)
  values (p_idempotency_key, v_user_id, p_store_id, v_order_id, 'order_created',
          jsonb_build_object('pickup_at', p_pickup_at, 'items', p_items));

  -- ---- LINEAS ----
  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_quantity := greatest(1, least(99, coalesce((v_item ->> 'quantity')::int, 1)));

    -- El precio y la disponibilidad salen del catalogo de ESTA sucursal.
    select i.id, i.name, i.price_cents, i.clover_item_id,
           (i.available and not i.hidden) as sellable
      into v_item_row
    from public.catalog_items i
    where i.store_id = p_store_id
      and i.clover_item_id = (v_item ->> 'clover_item_id')
      and i.deleted_at is null;

    if not found then
      raise exception 'item_not_found:%', (v_item ->> 'clover_item_id') using errcode = '22023';
    end if;
    if not v_item_row.sellable then
      raise exception 'item_unavailable:%', v_item_row.name using errcode = '22023';
    end if;

    v_unit_cents := v_item_row.price_cents;

    insert into public.order_items (
      order_id, clover_item_id, name_snapshot, unit_price_snapshot_cents,
      quantity, line_total_cents, note, sort_order
    )
    values (
      v_order_id, v_item_row.clover_item_id, v_item_row.name, v_item_row.price_cents,
      v_quantity, 0, nullif(btrim(coalesce(v_item ->> 'note', '')), ''), v_sort
    )
    returning id into v_order_item_id;

    v_sort := v_sort + 1;

    -- ---- MODIFICADORES ----
    for v_mod_id in
      select jsonb_array_elements_text(coalesce(v_item -> 'modifiers', '[]'::jsonb))
    loop
      select m.clover_modifier_id, m.name, m.price_cents, m.available
        into v_mod_row
      from public.catalog_modifiers m
      join public.catalog_item_modifier_groups img
        on img.modifier_group_id = m.modifier_group_id
      where m.store_id = p_store_id
        and m.clover_modifier_id = v_mod_id
        and m.deleted_at is null
        -- El modificador tiene que pertenecer a un grupo de ESTE producto:
        -- si no, la orden no imprime bien en Clover (Variable 2).
        and img.item_id = v_item_row.id;

      if not found then
        raise exception 'modifier_not_for_item:%', v_mod_id using errcode = '22023';
      end if;
      if not v_mod_row.available then
        raise exception 'modifier_unavailable:%', v_mod_row.name using errcode = '22023';
      end if;

      insert into public.order_item_modifiers (
        order_item_id, clover_modifier_id, name_snapshot, price_snapshot_cents
      )
      values (v_order_item_id, v_mod_row.clover_modifier_id, v_mod_row.name, v_mod_row.price_cents);

      v_unit_cents := v_unit_cents + v_mod_row.price_cents;
    end loop;

    update public.order_items
       set unit_price_snapshot_cents = v_unit_cents,
           line_total_cents = v_unit_cents * v_quantity
     where id = v_order_item_id;

    v_subtotal := v_subtotal + v_unit_cents * v_quantity;
  end loop;

  -- Subtotal SOLO. Impuestos, propina y total los calcula Clover al crear
  -- la orden alli; escribir un total ahora seria inventarlo.
  update public.orders set subtotal_cents = v_subtotal where id = v_order_id;

  select jsonb_build_object(
    'order_id',      o.id,
    'order_number',  o.order_number,
    'pickup_code',   o.pickup_code,
    'status',        o.status,
    'pickup_at',     o.pickup_at,
    'business_day',  o.business_day,
    'subtotal_cents', o.subtotal_cents
  ) into v_result
  from public.orders o where o.id = v_order_id;

  update public.checkout_attempts
     set result = v_result, state = 'order_created'
   where idempotency_key = p_idempotency_key;

  return v_result;
end;
$$;

comment on function public.create_pickup_order is
  'Unica via por la que la app crea un pedido. SECURITY DEFINER: el cliente '
  'sigue sin poder escribir en orders. Precios, disponibilidad, horario y '
  'capacidad se validan aqui, nunca se creen del telefono. '
  'TEMPORAL: en la fase 8 esta logica se muda a la Edge Function /checkout, '
  'porque crear el pedido y cobrar en Clover tienen que compartir '
  'idempotencia y un RPC no puede llamar a una API externa. Al mudarla se '
  'retira esta funcion junto con su grant a authenticated.';

-- El cliente puede EJECUTAR estas funciones, que es distinto de poder
-- escribir en las tablas: sigue sin tener insert sobre orders.
grant execute on function public.pickup_slot_counts(uuid, timestamptz, timestamptz) to authenticated;
grant execute on function public.create_pickup_order(uuid, text, timestamptz, boolean, text, jsonb) to authenticated;
grant execute on function app.store_accepts_pickup_at(uuid, timestamptz) to authenticated;

$m0008$;
  insert into supabase_migrations.schema_migrations (version, name) values ('0008', 'checkout');
  raise notice 'Migración 0008 aplicada.';
end
$entrega$;

-- 0009_payments.sql
do $entrega$
begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '0009') then
    raise notice 'Migración 0009 ya aplicada: se salta.';
    return;
  end if;
  execute $m0009$
-- =====================================================================
-- 0009_payments.sql
-- Cobro simulado (fase 6).
--
-- EL PROBLEMA DE ESTE ARCHIVO
-- En la fase 6 el pago lo ejecuta `MockPaymentService`, que corre EN EL
-- TELEFONO. Si el telefono le dice a la base "esto esta pagado" y la base
-- se lo cree, hemos construido un camino por el que un cliente marca un
-- pedido como cobrado sin que se mueva un centavo. Eso no puede
-- sobrevivir a la fase 7.
--
-- Asi que esta funcion se protege con DOS condiciones independientes, la
-- misma disciplina que RLS + GRANT:
--
--   1. `stores.payments_mode` tiene que ser 'simulated'. Es una decision
--      explicita y visible en la tabla, no un flag escondido.
--   2. La sucursal NO puede tener conexion con Clover. En cuanto existe
--      un merchant de verdad, este camino se cierra solo, aunque nadie
--      se acuerde de cambiar el modo.
--
-- La segunda es la que importa: la primera se puede olvidar, la segunda
-- no depende de que nadie se acuerde.
--
-- ADEMAS, LO QUE LA FUNCION NO SE CREE DEL TELEFONO
--   * el proveedor  -> se fuerza a 'mock', nunca llega del cliente
--   * el importe    -> tiene que coincidir con el subtotal del pedido,
--                      releido aqui; si no, `amount_mismatch`
--   * el dueno      -> solo el propio cliente del pedido
--   * el estado     -> solo desde payment_pending o payment_failed
--
-- LO QUE NO SE ESCRIBE
-- `tax_cents` y `total_cents` del pedido siguen a CERO. Un cobro
-- simulado no es una autoridad fiscal: no sabe de impuestos. La
-- invariante se mantiene, `total_cents > 0` significa "lo dijo Clover".
-- Por eso el pago simulado cobra el SUBTOTAL, y la app lo ensena como
-- subtotal, no como total.
--
-- `clover_payment_state` tambien se queda en 'unknown', porque Clover no
-- ha dicho nada. Las dos capas no se mezclan (Variable 1 del addendum).
--
-- ESTE ARCHIVO SE RETIRA EN LA FASE 7
-- Cuando entre Clover, el pago lo confirma el webhook contra el
-- proveedor, nunca el telefono. Al conectar el primer merchant hay que
-- borrar `record_simulated_payment` y su grant, y poner las sucursales en
-- 'live'. La condicion 2 ya lo deja inservible antes de eso; borrarlo es
-- para que no quede ni la puerta cerrada.
-- =====================================================================

-- ---------------------------------------------------------------------
-- MODO DE COBRO POR SUCURSAL
-- Por sucursal y no por restaurante porque la conexion de Clover tambien
-- es por sucursal: un merchant, una tienda, un catalogo.
-- ---------------------------------------------------------------------

alter table public.stores
  add column if not exists payments_mode text not null default 'simulated'
    check (payments_mode in ('simulated', 'live'));

comment on column public.stores.payments_mode is
  'simulated = el cobro lo simula la app (fase 6, sin dinero real). '
  'live = solo se aceptan pagos confirmados por el proveedor. '
  'Pasa a live al conectar Clover; ver 0009_payments.sql.';

-- ---------------------------------------------------------------------
-- IDEMPOTENCIA DEL INTENTO DE PAGO
--
-- El pedido y el intento de pago tienen claves DISTINTAS, y es a
-- proposito. Con una sola clave, un rechazo se quedaria cacheado para
-- siempre: el reintento devolveria el mismo rechazo y el cliente no
-- podria pagar nunca. Por eso:
--
--   `orders.idempotency_key`   -> una por compra; reintentar no crea un
--                                 segundo pedido
--   `payments.idempotency_key` -> una por INTENTO; reintentar tras un
--                                 rechazo es un intento nuevo, pero
--                                 repetir el mismo intento (respuesta
--                                 perdida por red) no cobra dos veces
--
-- Sin `where`: en Postgres una columna unique admite tantos nulos como
-- haga falta, y los pagos que entren por webhook no traen esta clave.
-- ---------------------------------------------------------------------

alter table public.payments
  add column if not exists idempotency_key text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'payments_idempotency_key_unique'
  ) then
    alter table public.payments
      add constraint payments_idempotency_key_unique unique (idempotency_key);
  end if;
end;
$$;

comment on column public.payments.idempotency_key is
  'Clave del INTENTO de cobro, distinta de la del pedido: un reintento '
  'tras un rechazo es un intento nuevo, pero repetir el mismo intento no '
  'cobra dos veces.';

-- ---------------------------------------------------------------------
-- ¿PUEDE ESTA SUCURSAL ACEPTAR UN COBRO SIMULADO?
-- Las dos condiciones del encabezado, juntas.
-- ---------------------------------------------------------------------

create or replace function app.store_takes_simulated_payments(p_store_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, app, pg_catalog
as $$
  select
    -- 1. decision explicita
    s.payments_mode = 'simulated'
    -- 2. y ningun merchant de Clover detras: en cuanto hay uno, esto se
    --    cierra solo, sin que nadie tenga que acordarse.
    and not exists (
      select 1
      from public.clover_connections c
      where c.store_id = s.id
        and c.status <> 'not_connected'
    )
  from public.stores s
  where s.id = p_store_id;
$$;

comment on function app.store_takes_simulated_payments is
  'Falso en cuanto la sucursal tiene conexion con Clover, aunque nadie '
  'haya cambiado payments_mode. Ver 0009_payments.sql.';

-- ---------------------------------------------------------------------
-- REGISTRAR EL RESULTADO DE UN COBRO SIMULADO
--
-- Devuelve jsonb con el pago y el estado en que queda el pedido.
-- Un rechazo NO es un error: se registra y se devuelve, igual que hace
-- `MockPaymentService`. Las excepciones quedan para lo que de verdad
-- esta mal (pedido ajeno, importe que no cuadra, modo prohibido).
-- ---------------------------------------------------------------------

create or replace function public.record_simulated_payment(
  p_order_id            uuid,
  p_attempt_key         text,
  p_provider_payment_id text,
  p_status              text,
  p_amount_cents        bigint,
  p_tip_cents           bigint default 0,
  p_failure_code        text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, app, pg_catalog
as $$
declare
  v_user     uuid := auth.uid();
  v_order    public.orders%rowtype;
  v_existing public.payments%rowtype;
  v_payment  public.payments%rowtype;
  v_status   app.payment_status;
begin
  if v_user is null then
    raise exception 'auth_required';
  end if;

  if p_attempt_key is null or length(p_attempt_key) < 8 then
    raise exception 'invalid_attempt_key';
  end if;

  if p_status not in ('succeeded', 'failed') then
    raise exception 'invalid_payment_status';
  end if;

  -- ---- IDEMPOTENCIA PRIMERO, antes de mirar nada mas -----------------
  -- Si este intento ya se registro, se devuelve tal cual. Repetirlo no
  -- crea un segundo pago ni vuelve a mover el pedido.
  select * into v_existing
  from public.payments
  where idempotency_key = p_attempt_key;

  if found then
    if v_existing.order_id <> p_order_id then
      raise exception 'idempotency_key_conflict';
    end if;

    select * into v_order from public.orders where id = v_existing.order_id;
    if v_order.user_id is distinct from v_user then
      raise exception 'order_not_found';
    end if;

    return jsonb_build_object(
      'payment_id',          v_existing.id,
      'provider',            v_existing.provider,
      'provider_payment_id', v_existing.provider_payment_id,
      'status',              v_existing.status,
      'amount_cents',        v_existing.amount_cents,
      'tip_cents',           v_existing.tip_cents,
      'failure_code',        v_existing.failure_code,
      'order_status',        v_order.status,
      'simulated',           true,
      'replayed',            true
    );
  end if;

  -- ---- El pedido tiene que ser suyo ----------------------------------
  select * into v_order
  from public.orders
  where id = p_order_id and user_id = v_user;

  if not found then
    -- Mismo error para "no existe" y "no es tuyo": no se confirma la
    -- existencia de pedidos ajenos.
    raise exception 'order_not_found';
  end if;

  if v_order.status not in ('payment_pending', 'payment_failed') then
    raise exception 'order_not_payable:%', v_order.status;
  end if;

  -- ---- Las dos condiciones del encabezado ----------------------------
  if not app.store_takes_simulated_payments(v_order.store_id) then
    raise exception 'simulated_payments_disabled';
  end if;

  -- ---- El importe lo pone la base, no el telefono --------------------
  -- Se compara en vez de ignorarlo a proposito: es la misma comprobacion
  -- que hara el reconciliador contra Clover en la fase 8, y conviene que
  -- exista desde ya.
  if p_amount_cents is distinct from v_order.subtotal_cents then
    raise exception 'amount_mismatch:% vs %', p_amount_cents, v_order.subtotal_cents;
  end if;

  -- La propina necesita un total de verdad para tener sentido, y aqui no
  -- hay ninguno. Llega con Clover.
  if coalesce(p_tip_cents, 0) <> 0 then
    raise exception 'tips_not_supported_yet';
  end if;

  v_status := p_status::app.payment_status;

  insert into public.payments (
    order_id, tenant_id, provider, provider_payment_id,
    amount_cents, tip_cents, currency, status, failure_code,
    failure_message, idempotency_key
  )
  values (
    v_order.id, v_order.tenant_id,
    -- El proveedor se fuerza: si llegase del cliente, un pago simulado
    -- podria hacerse pasar por uno de Clover ante el reconciliador.
    'mock', p_provider_payment_id,
    p_amount_cents, 0, v_order.currency, v_status, p_failure_code,
    case when v_status = 'failed' then 'Simulated decline (phase 6)' else null end,
    p_attempt_key
  )
  returning * into v_payment;

  -- ---- El pedido se mueve segun el resultado -------------------------
  if v_status = 'succeeded' then
    update public.orders
       set status = 'confirmed'
     where id = v_order.id
    returning * into v_order;

    update public.checkout_attempts
       set state = 'paid'
     where order_id = v_order.id;
  else
    update public.orders
       set status = 'payment_failed'
     where id = v_order.id
    returning * into v_order;

    update public.checkout_attempts
       set state = 'failed',
           error = coalesce(p_failure_code, 'declined')
     where order_id = v_order.id;
  end if;

  return jsonb_build_object(
    'payment_id',          v_payment.id,
    'provider',            v_payment.provider,
    'provider_payment_id', v_payment.provider_payment_id,
    'status',              v_payment.status,
    'amount_cents',        v_payment.amount_cents,
    'tip_cents',           v_payment.tip_cents,
    'failure_code',        v_payment.failure_code,
    'order_status',        v_order.status,
    'simulated',           true,
    'replayed',            false
  );
end;
$$;

comment on function public.record_simulated_payment is
  'TEMPORAL, fase 6. Registra el resultado de un cobro SIMULADO. Solo '
  'funciona en sucursales con payments_mode = simulated y SIN conexion '
  'con Clover. El importe se compara con el subtotal releido aqui y el '
  'proveedor se fuerza a mock. Se retira en la fase 7, cuando el pago lo '
  'confirme el webhook del proveedor y no el telefono.';

grant execute on function public.record_simulated_payment(uuid, text, text, text, bigint, bigint, text)
  to authenticated;
grant execute on function app.store_takes_simulated_payments(uuid) to authenticated;

$m0009$;
  insert into supabase_migrations.schema_migrations (version, name) values ('0009', 'payments');
  raise notice 'Migración 0009 aplicada.';
end
$entrega$;

-- 0010_push_tokens.sql
do $entrega$
begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '0010') then
    raise notice 'Migración 0010 ya aplicada: se salta.';
    return;
  end if;
  execute $m0010$
-- =====================================================================
-- 0010_push_tokens.sql
-- Registro del token de notificaciones desde la app.
--
-- POR QUE HACE FALTA UNA FUNCION SI YA HAY POLICY
-- `push_tokens` tiene policy propia (`user_id = auth.uid()`) y grants,
-- asi que el cliente ya puede escribir sus filas. El problema es otro: la
-- columna `token` es UNIQUE GLOBAL, y un mismo telefono puede cambiar de
-- dueno. Familia que comparte movil, empleado que devuelve el equipo,
-- alguien que se registra con otro correo.
--
-- En ese caso el upsert choca con la fila del dueno anterior, y la clausula
-- USING de la policy la evalua sobre la fila EXISTENTE, que no es del que
-- llama: el insert falla. El sintoma no es un error visible, es que ese
-- usuario nunca vuelve a recibir un aviso, y nadie se entera.
--
-- Esta funcion es SECURITY DEFINER solo para poder reasignar esa fila.
--
-- LO QUE ESO CONCEDE, DICHO CLARO
-- Quien presente un token se queda con el. Es aceptable porque un token de
-- push solo existe en el dispositivo que lo genero, y el efecto de
-- reclamarlo es que el anterior deja de recibir avisos en ESE aparato: no
-- da acceso a ningun dato. No se filtra nada del dueno anterior, ni
-- siquiera si existia.
-- =====================================================================

create or replace function public.register_push_token(
  p_token        text,
  p_platform     text,
  p_device_model text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_catalog
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'auth_required';
  end if;

  -- Un token de Expo es del estilo ExponentPushToken[xxxxxxxx]; el largo
  -- minimo solo descarta basura evidente.
  if p_token is null or length(p_token) < 10 or length(p_token) > 512 then
    raise exception 'invalid_token';
  end if;

  if p_platform not in ('android', 'ios', 'web') then
    raise exception 'invalid_platform';
  end if;

  insert into public.push_tokens (user_id, token, platform, device_model)
  values (v_user, p_token, p_platform, left(p_device_model, 120))
  on conflict (token) do update
    set user_id      = v_user,
        platform     = excluded.platform,
        device_model = excluded.device_model,
        last_seen_at = now();
end;
$$;

comment on function public.register_push_token is
  'Alta del token de push del dispositivo. SECURITY DEFINER unicamente '
  'para poder reasignar un token que ya estaba a nombre de otro usuario, '
  'caso real cuando un telefono cambia de manos. Ver 0010_push_tokens.sql.';

grant execute on function public.register_push_token(text, text, text) to authenticated;

-- Dar de baja el token es un delete normal: la policy ya deja borrar solo
-- las filas propias, y ahi no hay nada que reasignar.

$m0010$;
  insert into supabase_migrations.schema_migrations (version, name) values ('0010', 'push_tokens');
  raise notice 'Migración 0010 aplicada.';
end
$entrega$;

-- 0011_recargo.sql
do $entrega$
begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '0011') then
    raise notice 'Migración 0011 ya aplicada: se salta.';
    return;
  end if;
  execute $m0011$
-- =====================================================================
-- 0011_recargo.sql
-- Que hace la app cuando el merchant cobra recargo por tarjeta.
--
-- EL PROBLEMA
-- Clover permite que un merchant aplique un RECARGO por tarjeta de
-- credito. Se lee en `GET /v3/merchants/{mId}/ecomm_payment_configs`
-- (`surcharging.supported` y su `rate`). Si esta activo, al cliente se le
-- cobra MAS de lo que le enseño la app.
--
-- Eso no es un ajuste de configuracion: es una diferencia entre el precio
-- anunciado y el cobrado, y en bastantes sitios eso tiene nombre legal.
--
-- POR QUE ES CONFIGURABLE Y NO UNA DECISION EN CODIGO
-- Porque la respuesta correcta depende del restaurante y puede cambiar sin
-- que nosotros toquemos nada. Un local puede decidir absorberlo manana. Si
-- eso viviera en una constante, cambiarlo seria recompilar y publicar.
--
-- LO QUE NO ES CONFIGURABLE
-- El AVISO. Que el super admin vea "esta sucursal tiene recargo del 3,5 %"
-- sale siempre, con cualquiera de las tres politicas. Es informacion para
-- decidir antes de firmar, no una alerta que se pueda silenciar. Por eso
-- el aviso vive en el codigo del checklist y no en una columna: no hay
-- ningun valor que se pueda poner aqui para apagarlo.
--
-- POR DEFECTO SE MUESTRA
-- Es lo mas seguro legalmente: el cliente ve lo que va a pagar antes de
-- pagarlo. Absorberlo es una decision comercial que el restaurante toma a
-- sabiendas, y bloquear es para cuando no se quiere abrir esa sucursal.
--
-- MIGRACION NUEVA, NO EDITAR LAS APLICADAS
-- Las 0001 a 0010 estan corriendo en la base de Marco.
-- =====================================================================

-- Enum en `app.`, como el resto (`app.store_status`, `app.order_status`).
-- Un enum y no un texto libre: un valor mal escrito aqui decidiria mal en
-- silencio, y lo haria sobre el precio que ve el cliente.
create type app.surcharge_policy as enum (
  -- Mostrar el recargo al cliente antes de pagar. POR DEFECTO.
  'show',
  -- El restaurante lo absorbe: el cliente paga lo anunciado.
  -- OJO: esto NO desactiva el recargo en Clover. Solo dice que el
  -- restaurante asume la diferencia. Si Clover lo sigue cobrando, la
  -- diferencia sale de su margen, no del bolsillo del cliente.
  'absorb',
  -- No activar la sucursal mientras tenga recargo.
  'block'
);

alter table public.stores
  add column surcharge_policy app.surcharge_policy not null default 'show',

  -- Lo ULTIMO que vimos en Clover, no lo que alguien tecleo. Se refresca
  -- en el alta y en cada reconciliacion. `null` = todavia no se ha
  -- consultado, que NO es lo mismo que "no hay recargo": por eso es
  -- nullable y no un 0.
  add column surcharge_rate numeric(6, 5),

  -- Cuando se leyo. Un `surcharge_rate` de hace tres meses no vale para
  -- decidir: el merchant pudo activarlo la semana pasada.
  add column surcharge_checked_at timestamptz;

-- La tasa es una FRACCION (0.035 = 3,5 %), igual que la devuelve Clover.
-- No se convierte a milesimas para no acabar con dos escalas distintas en
-- la misma base: `catalog_tax_rates.rate` ya usa milesimas de porcentaje,
-- y mezclarlas da un cobro cien veces mayor. Cada columna conserva la
-- unidad de su origen y el nombre dice cual es.
alter table public.stores
  add constraint stores_surcharge_rate_fraccion
    check (surcharge_rate is null or (surcharge_rate >= 0 and surcharge_rate < 1));

comment on column public.stores.surcharge_policy is
  'Que hacer si el merchant cobra recargo por tarjeta: mostrarlo (por '
  'defecto), que el restaurante lo absorba, o no activar la sucursal. El '
  'aviso al super admin sale siempre, con cualquiera de los tres.';

comment on column public.stores.surcharge_rate is
  'Recargo por tarjeta leido de Clover (ecomm_payment_configs), como '
  'FRACCION: 0.035 = 3,5 %. Distinto de catalog_tax_rates.rate, que va en '
  'milesimas de porcentaje. null = sin consultar todavia, que no es lo '
  'mismo que sin recargo.';

comment on column public.stores.surcharge_checked_at is
  'Cuando se leyo surcharge_rate. Un valor viejo no sirve para decidir.';

-- ---------------------------------------------------------------------
-- EL CHECKLIST DE ONBOARDING GANA UNA CASILLA
--
-- `setup_checklist` tiene default para las filas nuevas, pero las que ya
-- existen se quedaron con el objeto viejo. Sin esto, una sucursal creada
-- antes de hoy no tendria la casilla y el SaaS la pintaria como si no
-- hiciera falta.
--
-- `||` sobrescribe la clave si existe, asi que se aplica al reves para no
-- pisar el estado que ya tenga cualquier otra casilla.
--
-- CONSECUENCIA QUE HAY QUE SABER, Y QUE SALE GRATIS
-- `trg_stores_activation` (0001) cuenta CUALQUIER casilla en `false` y se
-- niega a activar la sucursal. Al anadir esta, el efecto es inmediato:
--
--   A PARTIR DE AQUI, NINGUNA SUCURSAL SE ACTIVA SIN QUE ALGUIEN HAYA
--   MIRADO EL RECARGO Y DECIDIDO QUE HACER CON EL.
--
-- No hace falta codigo nuevo para eso: el trigger ya existia y esta
-- casilla se suma a las que vigila. Probado.
--
-- Las sucursales que YA estan `active` no se tocan: el trigger salta en
-- `insert or update of status`, y esta migracion no cambia el status de
-- nadie. Nadie se queda sin servicio por esto.
-- ---------------------------------------------------------------------
update public.stores
   set setup_checklist = jsonb_build_object('surcharge_reviewed', false) || setup_checklist
 where not (setup_checklist ? 'surcharge_reviewed');

alter table public.stores
  alter column setup_checklist set default jsonb_build_object(
    'clover_connected',      false,
    'ecommerce_enabled',     false,
    'order_type_ready',      false,
    -- Renombrada de hecho, no de nombre: Viva usa KDS y no impresora, y
    -- lo que hay que verificar es QUE DISPOSITIVO recibe las ordenes.
    'order_printer_ready',   false,
    'catalog_synced',        false,
    'smoke_test_passed',     false,
    'not_using_dining',      false,
    -- Nueva: alguien miro el recargo y decidio que hacer con el.
    'surcharge_reviewed',    false
  );

-- Los grants de `stores` son de tabla, no de columna (0006_grants.sql), y
-- la policy `stores_public_read` devuelve la fila entera: las tres
-- columnas nuevas quedan visibles para la app sin tocar nada mas. Es lo
-- que se quiere: la app necesita `surcharge_policy` y `surcharge_rate`
-- para poder mostrar el recargo antes de pagar.

$m0011$;
  insert into supabase_migrations.schema_migrations (version, name) values ('0011', 'recargo');
  raise notice 'Migración 0011 aplicada.';
end
$entrega$;

-- 0012_recovery_token.sql
do $entrega$
begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '0012') then
    raise notice 'Migración 0012 ya aplicada: se salta.';
    return;
  end if;
  execute $m0012$
-- =====================================================================
-- 0012_recovery_token.sql
-- La red de seguridad del refresco de OAuth: el token de recuperacion.
--
-- EL AGUJERO QUE TAPA
-- El refresh token de Clover es de UN SOLO USO. El momento peligroso del
-- worker de refresco es este:
--
--   1. mandamos el refresh A a /oauth/v2/refresh
--   2. Clover emite el par B y en ese instante A queda invalidado
--   3. ...y si perdemos B antes de guardarlo —la Edge Function se corta,
--      la escritura en Vault falla, el proceso muere— nos quedamos sin A
--      (ya gastado) y sin B (nunca guardado).
--
-- Sin red, ahi la conexion del merchant esta MUERTA: no hay token con el
-- que hablar con Clover, y recuperarla exige que el merchant vuelva a
-- autorizar la app a mano. Para un restaurante en hora punta, eso es la
-- app caida hasta que alguien del local entre a su Clover.
--
-- LA RED
-- Al usar A para obtener B, Clover deja A vivo como TOKEN DE RECUPERACION
-- de B. Si B se pierde, se canjea A en `POST {platform}/oauth/v2/recovery`
-- con el client_secret, y sale un par nuevo. Sin tocar al merchant.
--
--   Ventana      2 semanas desde que se genero el par ACTUAL
--   Se invalida  en cuanto un refresh se usa con exito
--   Requiere     client_secret; solo apps de alta confianza (la nuestra)
--   Despues      no hay atajo: rehacer el flujo OAuth entero
--
-- Verificado en la documentacion oficial (docs.clover.com, "Use refresh
-- token to generate new expiring token", seccion "Reauthenticate with a
-- recovery token"). Ver docs/CLOVER-ENDPOINTS.md.
--
-- POR QUE NO HAY TABLA DE HISTORIAL
-- Porque Clover solo admite el refresh INMEDIATAMENTE anterior. La cadena
-- es lineal y en cada momento hay exactamente un token de recuperacion
-- activo. Guardar la cadena entera daria una lista de tokens muertos: mas
-- superficie para filtrar y ni un caso mas recuperable.
--
-- MIGRACION NUEVA. Las 0001 a 0011 estan corriendo y no se tocan.
-- =====================================================================

alter table public.clover_connections
  -- El refresh ANTERIOR, en Vault, igual que los otros dos. Aqui solo va
  -- su id de secreto: en esta tabla no hay ni un token en claro.
  add column recovery_token_secret_id  uuid,

  -- Cuando se cierra la ventana. Lo calculamos nosotros (generacion del
  -- par actual + 2 semanas); Clover NO lo devuelve en la respuesta.
  -- Por eso es una PISTA, no la verdad -- ver el aviso de abajo.
  add column recovery_token_expires_at timestamptz;

-- O estan los dos o no esta ninguno. Un id sin fecha deja al worker sin
-- saber si la red sigue viva; una fecha sin id promete una red que no
-- existe, que es peor: se descubre el dia que hace falta.
alter table public.clover_connections
  add constraint clover_connections_recovery_completo
    check ((recovery_token_secret_id is null) = (recovery_token_expires_at is null));

comment on column public.clover_connections.recovery_token_secret_id is
  'Id en Vault del refresh token ANTERIOR, que Clover mantiene vivo como '
  'token de recuperacion del actual. null = no hay red: es el estado '
  'normal justo despues del flujo OAuth inicial, porque no hubo ningun '
  'token antes que el primero.';

comment on column public.clover_connections.recovery_token_expires_at is
  'Fin estimado de la ventana de recuperacion (+2 semanas desde el '
  'refresco que genero el token de recuperacion actual). NO se renueva al '
  'recuperar: si el token de recuperacion no cambia, su reloj tampoco '
  'empieza de nuevo, y un trigger lo impide. CALCULADO POR NOSOTROS, no '
  'devuelto por Clover: sirve para avisar y para limpiar, nunca para '
  'decidir no intentarlo.';

-- ---------------------------------------------------------------------
-- TRES COSAS QUE EL WORKER DE LA PR 2 TIENE QUE HACER BIEN
-- Van aqui, y no solo en el codigo, porque son consecuencias del
-- ESQUEMA: quien lea estas columnas dentro de un ano las necesita.
--
-- 1. NO BORRAR EL SECRETO VIEJO DE VAULT AL ROTAR.
--    El reflejo natural al rotar es limpiar el secreto anterior. Hacerlo
--    aqui destruye la red en el mismo instante en que se crea, y no se
--    nota hasta el dia que hace falta. El secreto anterior se conserva y
--    solo se borra cuando deja de ser el de recuperacion.
--
-- 2. DESPUES DE UNA RECUPERACION, EL TOKEN DE RECUPERACION NO CAMBIA.
--    Es el detalle contraintuitivo, y esta escrito en la documentacion:
--
--      refresco     A -> B    la recuperacion pasa a ser A
--      recuperacion A -> C    la recuperacion SIGUE siendo A, y B muere
--
--    O sea que "el de recuperacion es siempre el refresh que acabo de
--    sustituir" es FALSO en el camino de recuperacion: ahi el que se
--    sustituye es B, que ya no vale para nada. Escribir eso deja la
--    conexion sin red justo despues del susto en el que se uso.
--
-- 3. LA VENTANA NO SE RENUEVA AL RECUPERAR. Esta es la regla mas facil
--    de pisar sin darse cuenta, porque el reflejo es "he escrito un par
--    nuevo, luego recalculo la fecha".
--
--      refresco     A -> B   recuperacion := A,  ventana := ahora + 2 sem
--      recuperacion A -> C   recuperacion := A,  ventana := SE QUEDA IGUAL
--
--    Si el token de recuperacion no cambia, su reloj tampoco empieza de
--    nuevo. Recalcular la fecha en el camino de recuperacion se inventa
--    margen que no existe, y lo hace justo despues del susto en el que se
--    uso: la conexion parece tener red hasta dentro de dos semanas y en
--    realidad le quedan dias.
--
--    LA DOCUMENTACION NO LO RESUELVE, Y CONVIENE SABERLO
--    Dice "two weeks have passed since the CURRENT access and refresh
--    token pair was generated", y despues de una recuperacion el par
--    actual es C, lo que leido al pie de la letra renovaria la ventana.
--    Pero la misma pagina dice que la cadena de recuperaciones "continues
--    until a refresh token is successfully used": si cada recuperacion
--    reiniciara el reloj, esa cadena no caducaria nunca y el limite de
--    dos semanas no limitaria nada. Las dos lecturas no pueden ser
--    ciertas a la vez.
--
--    Sin poder medirlo —haria falta perder un refresh y esperar dos
--    semanas— se toma la lectura PESIMISTA, porque los dos errores no
--    cuestan lo mismo:
--
--      creer que hay menos margen del real  -> avisamos antes de tiempo,
--                                              y como mucho rehacemos un
--                                              OAuth que no hacia falta;
--      creer que hay mas margen del real    -> creemos tener red, no la
--                                              hay, y se descubre el dia
--                                              que se necesita.
--
--    El trigger de mas abajo lo impone: mientras el token de recuperacion
--    no cambie, su fecha no puede moverse hacia adelante.
--
-- 4. LA CABECERA MANDA SOBRE ESTA FECHA.
--    Cuando un refresh falla con 401 y existe recuperacion, Clover lo
--    dice en la respuesta: `X-Clover-Recovery-Available: true`. Esa
--    cabecera es la autoridad. `recovery_token_expires_at` es una
--    estimacion nuestra con nuestro reloj, asi que nunca debe usarse
--    para NO intentar la recuperacion: se intenta, y que conteste Clover.
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- LA REGLA DE LA VENTANA, IMPUESTA Y NO SOLO ESCRITA
--
-- El punto 3 de arriba es un comentario, y un comentario no para a nadie:
-- el worker de la PR 2 lo pisaria con una sola linea bienintencionada
-- ("acabo de guardar un par nuevo, recalculo la fecha"). Esto lo convierte
-- en una regla que la base hace cumplir.
--
-- Mientras el token de recuperacion sea EL MISMO, su fecha no puede
-- moverse hacia adelante. Para renovar la ventana hay que cambiar de
-- token de recuperacion, que es exactamente lo que pasa en un refresco y
-- exactamente lo que NO pasa en una recuperacion.
--
-- Atrasarla si se permite: acortar el margen por prudencia nunca hace
-- dano. Y ponerlo todo a null tambien, que es lo que toca cuando la
-- recuperacion se consume.
--
-- SI ALGUN DIA SE CONFIRMA QUE CLOVER SI RENUEVA LA VENTANA, esto se
-- quita con un `drop trigger` en una migracion nueva. Es una linea, y
-- mientras tanto el sistema se equivoca del lado barato.
-- ---------------------------------------------------------------------
create or replace function app.enforce_recovery_window()
returns trigger
language plpgsql
as $$
begin
  if new.recovery_token_secret_id is not null
     and new.recovery_token_secret_id is not distinct from old.recovery_token_secret_id
     and new.recovery_token_expires_at > old.recovery_token_expires_at
  then
    raise exception
      'No se puede alargar la ventana de recuperacion de la conexion % sin '
      'cambiar el token de recuperacion (de % a %). Si esto viene de una '
      'RECUPERACION: el token de recuperacion no cambia, y su reloj tampoco '
      'se reinicia; deja la fecha como esta. Si viene de un REFRESCO: hay '
      'que escribir tambien el token de recuperacion nuevo, que es el '
      'refresh que se acaba de gastar.',
      new.id, old.recovery_token_expires_at, new.recovery_token_expires_at;
  end if;
  return new;
end;
$$;

create trigger trg_clover_conn_recovery_window
  before update of recovery_token_expires_at on public.clover_connections
  for each row execute function app.enforce_recovery_window();

comment on function app.enforce_recovery_window() is
  'Impide alargar la ventana de recuperacion sin cambiar el token de '
  'recuperacion. Ver 0012_recovery_token.sql para por que la lectura '
  'pesimista es la correcta mientras no se pueda medir.';

-- ---------------------------------------------------------------------
-- RLS: NO HACE FALTA TOCAR NADA, Y CONVIENE SABER POR QUE
--
-- `clover_connections` tiene RLS habilitado (0004) y CERO policies. En
-- Postgres eso no es "sin restricciones": es lo contrario. Sin ninguna
-- policy que conceda, nadie pasa, y solo `service_role` —que la salta por
-- ser BYPASSRLS— llega a la tabla.
--
-- Las policies de Postgres son por FILA, no por columna, asi que una
-- columna nueva hereda esa proteccion en el momento en que se crea. No
-- hay ninguna policy que ampliar ni ningun grant que revisar, y anadir
-- uno "por si acaso" solo podria abrir lo que ahora esta cerrado.
--
-- Y de hecho hay DOS barreras, no una. Medido con las doce migraciones
-- aplicadas sobre Postgres 16:
--
--   anon / authenticated  -> "permission denied for table": ni siquiera
--                            llegan al RLS, porque 0006_grants.sql no les
--                            concede nada sobre esta tabla;
--   service_role          -> ve la fila y la ventana.
--
-- Comprobado ejecutandolo, no leyendolo.
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- LA VISTA DEL SaaS ENSEÑA LA FECHA, NUNCA EL SECRETO
--
-- `clover_connection_status` lista sus columnas una a una, asi que las
-- dos nuevas no salian solas. La fecha si merece salir: una red que nadie
-- puede ver es una red que se pudre en silencio, y el operador necesita
-- distinguir "esta conexion tiene margen" de "si el proximo refresco
-- falla, hay que llamar al restaurante".
--
-- El id de secreto NO sale. Ni aqui ni en ninguna vista.
-- ---------------------------------------------------------------------
create or replace view public.clover_connection_status as
select
  c.store_id,
  c.restaurant_id,
  c.status,
  c.environment,
  case when c.merchant_id is null then null
       else '****' || right(c.merchant_id, 4) end as merchant_masked,
  c.ecommerce_enabled,
  (c.order_type_id is not null)                    as order_type_ready,
  cardinality(c.granted_permissions)               as permissions_granted,
  c.last_sync_at,
  c.last_webhook_at,
  c.access_token_expires_at,
  c.consecutive_failures,
  c.last_error_at,
  -- Al FINAL, y no junto a la otra fecha, donde encajaria mejor:
  -- `create or replace view` no deja renombrar ni reordenar columnas
  -- existentes, solo anadir al final. Intentar colocarla en su sitio da
  -- "cannot change name of view column". Cambiar el orden exigiria un
  -- DROP + CREATE, y eso tumbaria cualquier permiso concedido sobre la
  -- vista. No merece la pena por la estetica de una columna.
  c.recovery_token_expires_at                      as recovery_available_until
from public.clover_connections c;

-- ESTA LINEA NO ES DECORATIVA. `create or replace view` DESCARTA las
-- reloptions, asi que sin ella la vista pierde `security_invoker` y pasa
-- a ejecutarse con los permisos de su propietario: dejaria de heredar el
-- RLS de clover_connections y ensenaria TODAS las conexiones a cualquiera
-- con SELECT sobre la vista.
--
-- Medido en Postgres 16, no supuesto: se creo una vista con la opcion
-- puesta, se hizo `create or replace`, y las reloptions salieron vacias.
-- Es la razon de ser de 0007_view_security.sql, y se repite aqui porque
-- este fichero acaba de reemplazar la vista.
alter view public.clover_connection_status set (security_invoker = on);

comment on view public.clover_connection_status is
  'Resumen sin secretos para el SaaS. security_invoker = on: hereda el '
  'RLS de clover_connections, que no tiene policies, asi que solo '
  'service_role obtiene filas. Nunca expone ids de Vault.';

$m0012$;
  insert into supabase_migrations.schema_migrations (version, name) values ('0012', 'recovery_token');
  raise notice 'Migración 0012 aplicada.';
end
$entrega$;

-- 0013_refresh_lease.sql
do $entrega$
begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '0013') then
    raise notice 'Migración 0013 ya aplicada: se salta.';
    return;
  end if;
  execute $m0013$
-- =====================================================================
-- 0013_refresh_lease.sql
-- El cerrojo del worker de refresco: una conexion, un refresco a la vez.
--
-- POR QUE HACE FALTA UN CERROJO
-- El refresh token de Clover es de UN SOLO USO. Dos refrescos en paralelo
-- sobre la misma conexion no se estorban: se MATAN. El primero canjea A y
-- recibe B; el segundo llega con A ya gastado, se lleva un 401 y, si
-- alguien "arregla" ese 401 marcando la conexion como degradada, el par B
-- que si existia queda huerfano. Es el fallo mas caro que puede tener este
-- worker y no da ninguna senal hasta que el local intenta vender.
--
-- Y no hace falta un despliegue raro para que pase: basta con que una
-- ejecucion de pg_cron tarde mas que su periodo y la siguiente arranque
-- encima, o con dos instancias del worker durante un despliegue.
--
-- POR QUE UN ARRIENDO EN UNA COLUMNA Y NO UN ADVISORY LOCK
-- `pg_advisory_lock` es de SESION, y el pooler de Supabase en modo
-- transaccion recicla la sesion entre transacciones: el cerrojo se queda
-- cogido en una sesion que ya no es tuya, o se suelta sin que lo sueltes.
-- Un arriendo con fecha en la propia fila no depende de la sesion, se ve
-- desde SQL, y se cae solo si el worker muere a media faena.
--
-- EL ARRIENDO ES ADEMAS EL TEMPORIZADOR DEL BACKOFF
-- Al terminar bien, el worker lo pone a null. Al fallar, lo empuja hacia
-- adelante con el backoff que toque. Asi no hace falta ni una columna mas
-- ni una tabla de reintentos: lo que impide dos refrescos a la vez es lo
-- mismo que impide machacar a Clover con una conexion rota.
--
-- MIGRACION NUEVA. Las 0001 a 0012 estan corriendo y no se tocan.
-- =====================================================================

alter table public.clover_connections
  -- Hasta cuando esta reservada esta fila para un worker. null o pasada
  -- = libre. NO es un secreto ni un dato del merchant: es fontaneria.
  add column refresh_lease_until timestamptz;

comment on column public.clover_connections.refresh_lease_until is
  'Arriendo del worker de refresco: mientras este en el futuro, ninguna '
  'otra ejecucion toca esta conexion. Sirve tambien de temporizador del '
  'backoff tras un fallo. null = libre.';

-- El indice del claim. El de 0002 (idx_clover_conn_token_refresh) solo
-- cubre 'connected', y aqui tambien se reclaman las degradadas: una
-- conexion degradada es justo la que puede volver con el token de
-- recuperacion, y si nunca se reintenta se queda muerta para siempre.
create index idx_clover_conn_refresh_due
  on public.clover_connections (access_token_expires_at nulls first)
  where status in ('connected', 'degraded');

-- ---------------------------------------------------------------------
-- RECLAMAR LOTE
--
-- Un solo statement: seleccionar y reservar no pueden ser dos pasos, o
-- entre uno y otro se cuela la otra ejecucion. `for update skip locked`
-- hace que dos workers simultaneos se repartan filas distintas en vez de
-- pelearse por las mismas.
--
-- LA POLITICA NO VIVE AQUI. Cuando una conexion "toca" lo decide el
-- worker y entra por `p_due_before` (= ahora + margen). Repetir el margen
-- en SQL seria tener la misma regla en dos sitios, que es como se acaba
-- teniendo dos reglas distintas.
--
-- OJO AL ESCRIBIR SOBRE ESTA TABLA DESDE AQUI: este update NO menciona
-- `recovery_token_expires_at`, asi que no dispara el trigger de la 0012.
-- Si alguien anade esa columna a este SET, la ventana de recuperacion se
-- movera —o el trigger lo parara— por reservar una fila. No se anade.
-- ---------------------------------------------------------------------
create or replace function app.claim_clover_connections_for_refresh(
  p_due_before    timestamptz,
  p_lease_seconds int,
  p_limit         int
)
returns table (
  id                        uuid,
  store_id                  uuid,
  merchant_id               text,
  environment               text,
  status                    app.connection_status,
  access_token_secret_id    uuid,
  access_token_expires_at   timestamptz,
  refresh_token_secret_id   uuid,
  recovery_token_secret_id  uuid,
  recovery_token_expires_at timestamptz,
  consecutive_failures      int
)
language sql
as $$
  update public.clover_connections c
     set refresh_lease_until = now() + make_interval(secs => p_lease_seconds)
   where c.id in (
     select d.id
       from public.clover_connections d
      where d.status in ('connected', 'degraded')
        -- Sin refresh no hay nada que refrescar: una conexion a medio
        -- OAuth no es trabajo de este worker.
        and d.refresh_token_secret_id is not null
        -- null = no sabemos cuando caduca; se trata como vencida, que es
        -- el lado barato de equivocarse.
        and (d.access_token_expires_at is null or d.access_token_expires_at <= p_due_before)
        and (d.refresh_lease_until is null or d.refresh_lease_until <= now())
      order by d.access_token_expires_at asc nulls first
      limit greatest(p_limit, 0)
      for update skip locked
   )
  returning
    c.id,
    c.store_id,
    c.merchant_id,
    c.environment,
    c.status,
    c.access_token_secret_id,
    c.access_token_expires_at,
    c.refresh_token_secret_id,
    c.recovery_token_secret_id,
    c.recovery_token_expires_at,
    c.consecutive_failures;
$$;

comment on function app.claim_clover_connections_for_refresh(timestamptz, int, int) is
  'Reserva y devuelve el lote de conexiones que toca refrescar. Reservar '
  'y seleccionar van en el mismo statement a proposito: si fueran dos, '
  'entre uno y otro cabe la otra ejecucion del worker, y dos refrescos en '
  'paralelo sobre la misma conexion la dejan muerta (el refresh token es '
  'de un solo uso). No devuelve ningun token: solo ids de Vault.';

-- Sin GRANT a nadie. Solo `service_role` —que ya tiene acceso a la tabla
-- por ser BYPASSRLS— la ejecuta, y el worker corre con esa clave. Un
-- grant a `authenticated` aqui daria ids de Vault a cualquier usuario de
-- la app movil.
revoke execute on function app.claim_clover_connections_for_refresh(timestamptz, int, int)
  from public;

$m0013$;
  insert into supabase_migrations.schema_migrations (version, name) values ('0013', 'refresh_lease');
  raise notice 'Migración 0013 aplicada.';
end
$entrega$;

-- 0014_connect_link.sql
do $entrega$
begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '0014') then
    raise notice 'Migración 0014 ya aplicada: se salta.';
    return;
  end if;
  execute $m0014$
-- =====================================================================
-- 0014_connect_link.sql
-- El enlace que el operador le manda al merchant para conectar Clover.
--
-- POR QUE HACE FALTA UNA FUNCION Y NO UN UPDATE A MANO
-- La columna `connect_token` existe desde la 0002 y hasta ahora no la
-- escribia nadie: el flujo de OAuth no estaba construido. Ya lo esta
-- (`supabase/functions/oauth`), y este es el unico sitio donde nace un
-- enlace valido. Un `update` a mano en el editor de SQL parece igual y no
-- lo es: es donde se cuela un token corto, uno reutilizado, o uno sin
-- caducidad — y sin caducidad el enlace vale para siempre, que es
-- justamente lo que no queremos de la unica credencial que viaja por
-- correo.
--
-- QUE ES ESTE TOKEN, EXACTAMENTE
-- Es el `state` del flujo v2/OAuth. Es lo que ata el callback de Clover a
-- UNA sucursal: sin el, un `code` cualquiera haria que nuestro backend
-- escribiera tokens en la fila que no. Por eso es largo, aleatorio, de un
-- solo uso —la Edge Function lo borra al conectar— y caduca.
--
-- QUIEN LO USA
--   1. el operador llama a esta funcion y obtiene el enlace;
--   2. se lo manda al dueño del restaurante (§0.3: el super admin NO
--      puede autorizar por el, no tiene sus credenciales de Clover);
--   3. el merchant lo abre y aterriza en /functions/v1/oauth/start.
--
-- MIGRACION NUEVA. Las 0001 a 0013 estan corriendo y no se tocan.
-- =====================================================================

-- ---------------------------------------------------------------------
-- EMITIR UN ENLACE
--
-- Devuelve solo el token. La URL completa se arma fuera, porque el
-- dominio del proyecto no es un dato que deba vivir duplicado en la base:
-- ya vive en `SUPABASE_URL`, que es de donde la Edge Function saca tambien
-- el `redirect_uri`. Dos sitios con la misma URL es como se acaba teniendo
-- dos URLs distintas, y en este flujo eso significa un OAuth que no
-- completa nunca.
-- ---------------------------------------------------------------------
create or replace function app.issue_clover_connect_token(
  p_store_id uuid,
  p_ttl      interval default interval '7 days'
)
returns text
language plpgsql
as $$
declare
  v_token text;
begin
  -- 32 bytes de `gen_random_bytes`, en base64url para que sobreviva a un
  -- correo, a un WhatsApp y a la barra de direcciones sin que nadie tenga
  -- que escapar nada. Postgres no trae 'base64url', asi que se traduce a
  -- mano: es eso o descubrir que un '+' llego como espacio.
  v_token := rtrim(translate(encode(gen_random_bytes(32), 'base64'), '+/', '-_'), '=');

  update public.clover_connections
     set connect_token            = v_token,
         connect_token_expires_at = now() + p_ttl,
         -- OJO CON EL ESTADO: solo se mueve hacia 'pending_auth' desde
         -- una conexion que no esta sirviendo. Una sucursal 'connected'
         -- que se va a reconectar sigue vendiendo con los tokens que ya
         -- tiene hasta que el par nuevo aterrice; degradarla aqui la
         -- sacaria de la app por emitir un enlace que quiza nadie abra.
         status = case
                    when status in ('not_connected', 'revoked') then 'pending_auth'
                    else status
                  end
   where store_id = p_store_id;

  if not found then
    raise exception
      'La sucursal % no tiene fila en clover_connections. El enlace de '
      'conexion se emite sobre una conexion existente, aunque este vacia.',
      p_store_id;
  end if;

  return v_token;
end;
$$;

comment on function app.issue_clover_connect_token(uuid, interval) is
  'Emite el token del enlace de conexion de Clover (el `state` del flujo '
  'v2/OAuth) y lo deja en clover_connections.connect_token. De un solo '
  'uso: la Edge Function oauth lo borra al conectar. La URL se arma '
  'fuera: <SUPABASE_URL>/functions/v1/oauth/start?t=<token>.';

-- Sin GRANT a nadie. Solo `service_role` llega a `clover_connections`
-- (RLS sin policies desde la 0004), y un grant a `authenticated` aqui
-- dejaria a cualquier usuario de la app movil emitir enlaces de conexion
-- de cualquier restaurante.
revoke execute on function app.issue_clover_connect_token(uuid, interval) from public;

-- ---------------------------------------------------------------------
-- CADUCADO ES LO MISMO QUE NO TENER
--
-- El indice unico de `connect_token` (0002) impide dos enlaces iguales,
-- no dos enlaces vivos para la misma sucursal: emitir uno nuevo pisa el
-- anterior, que es justo lo que se quiere. Lo que si conviene es que los
-- caducados no se queden ahi para siempre ocupando el unico hueco de
-- token de su fila y confundiendo a quien mire la tabla.
--
-- No hace falta un worker: la Edge Function ya trata un enlace caducado
-- como invalido (y uno sin fecha tambien, que es el lado barato de
-- equivocarse). Esto es solo limpieza, y se puede colgar de cualquier
-- pasada de pg_cron que ya exista.
-- ---------------------------------------------------------------------
create or replace function app.purge_expired_clover_connect_tokens()
returns int
language sql
as $$
  with limpiadas as (
    update public.clover_connections
       set connect_token = null, connect_token_expires_at = null
     where connect_token is not null
       and connect_token_expires_at is not null
       and connect_token_expires_at <= now()
    returning 1
  )
  select count(*)::int from limpiadas;
$$;

comment on function app.purge_expired_clover_connect_tokens() is
  'Borra los enlaces de conexion ya caducados. No es una medida de '
  'seguridad —la Edge Function ya los rechaza— sino higiene: un enlace '
  'muerto en la fila hace dudar de si la sucursal esta a medio conectar.';

revoke execute on function app.purge_expired_clover_connect_tokens() from public;

$m0014$;
  insert into supabase_migrations.schema_migrations (version, name) values ('0014', 'connect_link');
  raise notice 'Migración 0014 aplicada.';
end
$entrega$;

-- 0015_token_refresh_cron.sql
do $entrega$
begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '0015') then
    raise notice 'Migración 0015 ya aplicada: se salta.';
    return;
  end if;
  execute $m0015$
-- =====================================================================
-- 0015_token_refresh_cron.sql
-- El disparador del worker de refresco. Sin esto, la logica de la 0013 y
-- de workers/src/token-refresh esta escrita pero no la llama nadie.
--
-- LA CADENA COMPLETA
--
--   pg_cron  --cada 5 min-->  app.run_token_refresh_worker()
--                                     | net.http_post (pg_net)
--                                     v
--                            POST /functions/v1/token-refresh
--                                     |
--                                     v
--                            runTokenRefresh(...)  ->  claim de la 0013
--
-- POR QUE UNA LLAMADA HTTP Y NO SQL A SECAS
-- Porque lo que hay que ejecutar habla con Clover: dos llamadas HTTP con
-- timeout, limitador de 50 req/s y breakers. Eso no cabe en una funcion
-- de Postgres, y meterlo ahi significaria reescribir en PL/pgSQL una
-- logica que ya esta probada sin red y sin base. pg_cron dispara, pg_net
-- llama, y la vuelta la da la Edge Function.
--
-- POR QUE LA URL Y EL SECRETO NO ESTAN EN ESTE ARCHIVO
-- Porque cambian por proyecto y uno de los dos es un secreto: escribirlos
-- aqui seria versionarlos. Viven en Supabase Vault y los pone
-- `app.configure_token_refresh_worker`, que es el UNICO paso manual de
-- todo el cableado. Ver docs/REFRESCO-TOKENS.md.
--
-- QUE SE VE DESDE SQL CUANDO ALGO NO CORRE
-- `cron.job_run_details` solo dice si el `select` salio bien, o sea si la
-- peticion se ENCOLO. No dice nada de la respuesta. Por eso esta migracion
-- apunta el id de cada peticion en `app.token_refresh_runs` y
-- `app.token_refresh_worker_status()` lo cruza con `net._http_response`:
-- sin ese cruce, una funcion que contesta 500 cada cinco minutos se ve
-- exactamente igual que una que va bien.
--
-- MIGRACION NUEVA. Las 0001 a 0014 estan corriendo y no se tocan.
-- =====================================================================


-- ---------------------------------------------------------------------
-- LAS DOS EXTENSIONES
--
-- En un proyecto de Supabase estan disponibles y se activan aqui. En el
-- harness de CI (postgres:16 pelado, ver .github/db-harness.sql) no
-- existen, y por eso el `if`: la alternativa seria que esta migracion
-- rompiera el job `database` de CI, que es el que comprueba que el
-- esquema entero se aplica limpio.
--
-- EL `if` NO ES UN INTERRUPTOR SILENCIOSO. En Supabase la rama de arriba
-- se toma SIEMPRE —pg_cron y pg_net estan en el catalogo de extensiones
-- disponibles aunque no esten instaladas—, asi que un proyecto real nunca
-- cae en el `raise notice`. Si algun dia cayera, el worker no correria y
-- `app.token_refresh_worker_status()` lo dice con esas palabras.
-- ---------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    -- Lo que documenta Supabase para que el rol `postgres` pueda
    -- programar y leer el historial de trabajos.
    execute 'grant usage on schema cron to postgres';
    execute 'grant all privileges on all tables in schema cron to postgres';
  else
    raise notice
      'pg_cron NO esta disponible en esta base: el worker de refresco no quedara programado. '
      'Es lo normal en el harness de CI. En Supabase se activa en '
      'Dashboard -> Database -> Extensions.';
  end if;

  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net;
  else
    raise notice
      'pg_net NO esta disponible en esta base: nadie podra llamar a la Edge Function. '
      'Es lo normal en el harness de CI.';
  end if;
end $$;


-- ---------------------------------------------------------------------
-- EL RASTRO DE CADA VUELTA
--
-- Una fila por peticion encolada. No guarda la respuesta —esa la guarda
-- pg_net en `net._http_response` y la borra sola a las horas—, guarda el
-- id que permite encontrarla. Es la pieza que convierte "creo que corre"
-- en "corrio a las 03:15 y contesto 200 con este recuento".
--
-- Vive en `app` y no en `public` a proposito: no es un dato del negocio,
-- no la lee la app movil y no tiene que aparecer en los tipos generados.
-- ---------------------------------------------------------------------
create table if not exists app.token_refresh_runs (
  request_id   bigint primary key,
  requested_at timestamptz not null default now()
);

comment on table app.token_refresh_runs is
  'Id de cada peticion que pg_cron encolo contra la Edge Function del '
  'worker de refresco. Se cruza con net._http_response para saber que '
  'contesto. Se poda sola a los 7 dias.';

create index if not exists idx_token_refresh_runs_requested_at
  on app.token_refresh_runs (requested_at desc);


-- ---------------------------------------------------------------------
-- LEER UN AJUSTE DE VAULT
--
-- Falta el secreto = el worker NO esta configurado, y eso tiene que doler
-- ahora. Se levanta una excepcion en vez de devolver null: asi la vuelta
-- aparece como fallida en `cron.job_run_details` cada cinco minutos, con
-- el mensaje que dice exactamente que ejecutar. Un `return null` educado
-- dejaria el trabajo "corriendo" y sin hacer nada, que es el modo de
-- fallo que esta migracion existe para evitar.
-- ---------------------------------------------------------------------
create or replace function app.token_refresh_setting(p_name text)
returns text
language plpgsql
stable
as $$
declare
  v_valor text;
begin
  select decrypted_secret into v_valor
    from vault.decrypted_secrets
   where name = p_name;

  if v_valor is null or v_valor = '' then
    raise exception
      'El worker de refresco no esta configurado: falta el secreto de Vault "%".', p_name
      using hint =
        'Ejecuta: select app.configure_token_refresh_worker(''https://<ref>.supabase.co'', '
        '''<WORKER_CRON_SECRET>''); Ver docs/REFRESCO-TOKENS.md, "Como se dispara".';
  end if;

  return v_valor;
end;
$$;


-- ---------------------------------------------------------------------
-- CONFIGURAR: el unico paso manual de todo esto
--
-- Guarda en Vault la URL del proyecto y el secreto compartido, y deja el
-- trabajo programado. Es idempotente: volver a ejecutarlo con otro
-- secreto lo rota, y `cron.schedule` con el mismo `jobname` pisa el
-- anterior en vez de duplicarlo.
--
-- EL SECRETO TIENE QUE SER EL MISMO QUE `supabase secrets set
-- WORKER_CRON_SECRET=...`. Son los dos extremos del mismo cable; si no
-- coinciden, la Edge Function contesta 401 y `status()` lo ensena.
--
-- OJO CON `vault.create_secret`: la firma es (new_secret, new_name,
-- new_description) — EL SECRETO VA PRIMERO. Cambiarlos de sitio no da
-- error: guarda el nombre como secreto. Es la misma trampa que avisa
-- workers/src/token-refresh/postgres.ts.
--
-- Y ESTO NO ES UN HELPER GENERICO DE VAULT, a proposito. Para los tokens
-- de Clover, `create` y `update` NO son intercambiables: sobrescribir el
-- secreto del refresh vigente destruye el token de recuperacion en el
-- mismo movimiento (ver worker.ts, regla 2). Un `upsert` publico seria
-- una escopeta cargada al lado de esa regla, asi que el upsert vive aqui
-- dentro y solo para estos dos ajustes, que no son tokens de nadie.
-- ---------------------------------------------------------------------
create or replace function app.configure_token_refresh_worker(
  p_project_url text,
  p_cron_secret text
)
returns text
language plpgsql
as $$
declare
  v_url    text := rtrim(btrim(coalesce(p_project_url, '')), '/');
  v_secret text := btrim(coalesce(p_cron_secret, ''));
  v_nombre text;
  v_valor  text;
  v_id     uuid;
begin
  -- Solo el origen. Si aqui entra la URL de la funcion entera, el
  -- `net.http_post` acabaria pidiendo .../token-refresh/functions/v1/...
  if v_url !~ '^https://[^/[:space:]]+$' then
    raise exception
      'p_project_url tiene que ser SOLO el origen (https://<ref>.supabase.co), sin ruta '
      'ni barra final, y llego: %', p_project_url;
  end if;

  -- El mismo minimo que comprueba `assertCronSecret` en la Edge Function.
  -- Este endpoint no tiene nada que limite intentos.
  if length(v_secret) < 32 then
    raise exception
      'El secreto del cron tiene menos de 32 caracteres.'
      using hint = 'Generalo con: openssl rand -base64 32';
  end if;

  -- Las dos extensiones. Sin esto el fallo llega mas tarde y mas feo: un
  -- "schema cron does not exist" a secas, o —peor— un `configure` que
  -- pasa y un worker que no dispara nunca porque falta pg_net.
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise exception 'pg_cron no esta activo en este proyecto.'
      using hint = 'Dashboard -> Database -> Extensions -> pg_cron, y vuelve a ejecutar esto.';
  end if;
  -- Por NOMBRES de parametro y no por firma exacta: `run_token_refresh_worker`
  -- llama con `url =>`, `body =>`, `headers =>`, `timeout_milliseconds =>`, y
  -- eso sigue funcionando aunque pg_net anada parametros con valor por
  -- defecto. Un guard atado a la firma exacta daria un falso "pg_net no esta
  -- activo" en cuanto cambie de version, que es peor que no tener guard.
  if not exists (
    select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'net'
       and p.proname = 'http_post'
       and array['url', 'body', 'headers', 'timeout_milliseconds'] <@ coalesce(p.proargnames, '{}')
  ) then
    raise exception 'pg_net no esta activo en este proyecto: nadie podria llamar a la Edge Function.'
      using hint = 'Dashboard -> Database -> Extensions -> pg_net, y vuelve a ejecutar esto.';
  end if;

  foreach v_nombre in array array['token_refresh_project_url', 'token_refresh_cron_secret']
  loop
    v_valor := case v_nombre
                 when 'token_refresh_project_url' then v_url
                 else v_secret
               end;

    select id into v_id from vault.secrets where name = v_nombre;
    if v_id is null then
      perform vault.create_secret(v_valor, v_nombre, 'Cableado del worker de refresco (0015)');
    else
      perform vault.update_secret(v_id, v_valor, v_nombre, 'Cableado del worker de refresco (0015)');
    end if;
  end loop;

  -- El periodo esta en dos idiomas: aqui y en `WORKER_PERIOD_MS`
  -- (workers/src/token-refresh/policy.ts). Hay una prueba que abre este
  -- archivo y comprueba que dicen lo mismo
  -- (supabase/functions/token-refresh/__tests__/schedule.test.ts). Si
  -- cambias uno, cambia el otro: `policy.ts` razona sobre cuantos
  -- intentos caben en el margen, y ese razonamiento es falso en cuanto
  -- el cron dispara con otro periodo.
  perform cron.schedule(
    'token-refresh',
    '*/5 * * * *',
    'select app.run_token_refresh_worker();'
  );

  return v_url || '/functions/v1/token-refresh';
end;
$$;

comment on function app.configure_token_refresh_worker(text, text) is
  'Deja el worker de refresco disparandose: guarda en Vault la URL del '
  'proyecto y el secreto compartido con la Edge Function, y programa el '
  'pg_cron. Idempotente. Devuelve la URL que se va a llamar.';


-- ---------------------------------------------------------------------
-- LO QUE EJECUTA EL CRON
--
-- `net.http_post` es ASINCRONA: encola y vuelve enseguida con un id. Por
-- eso este `select` dura milisegundos aunque la vuelta tarde un minuto, y
-- por eso dos tics del cron no se solapan aqui. Que dos VUELTAS no se
-- pisen es otra cosa, y de eso se encarga el arriendo de la 0013.
--
-- EL TIMEOUT SON 2 MINUTOS, igual que `LEASE_MS`. No es una cifra
-- decorativa: pasado el arriendo, el propio worker corta el lote (ver
-- `PER_CONNECTION_BUDGET_MS`), asi que una vuelta sana nunca llega ahi.
-- Y cortar por timeout no rompe nada: cada conexion se escribe cuando se
-- termina, y lo que quede se coge en la vuelta siguiente.
-- ---------------------------------------------------------------------
create or replace function app.run_token_refresh_worker()
returns bigint
language plpgsql
as $$
declare
  v_url        text := app.token_refresh_setting('token_refresh_project_url');
  v_secret     text := app.token_refresh_setting('token_refresh_cron_secret');
  v_request_id bigint;
begin
  select net.http_post(
           url                  => v_url || '/functions/v1/token-refresh',
           body                 => '{}'::jsonb,
           headers              => jsonb_build_object(
                                     'Content-Type', 'application/json',
                                     'Authorization', 'Bearer ' || v_secret
                                   ),
           timeout_milliseconds => 120000
         )
    into v_request_id;

  insert into app.token_refresh_runs (request_id) values (v_request_id);

  -- Podar aqui y no en otro trabajo de cron: son dos filas al dia y una
  -- tabla de fontaneria no merece su propio programador.
  delete from app.token_refresh_runs where requested_at < now() - interval '7 days';

  return v_request_id;
end;
$$;

comment on function app.run_token_refresh_worker() is
  'Lo que ejecuta pg_cron cada 5 minutos: encola un POST a la Edge '
  'Function del worker de refresco y apunta el id de la peticion. Falla '
  'con un mensaje accionable si el worker no esta configurado.';


-- ---------------------------------------------------------------------
-- ESTA CORRIENDO?
--
-- La pregunta que hay que poder contestar en diez segundos a las tres de
-- la manana. Cruza las cuatro cosas que pueden estar mal por separado:
-- la configuracion, el trabajo programado, la ultima peticion encolada y
-- lo que contesto la funcion.
--
-- No levanta excepcion si falta algo: aqui se viene justamente cuando
-- algo falta, y una excepcion en vez de una fila deja sin ver el resto.
-- ---------------------------------------------------------------------
create or replace function app.token_refresh_worker_status()
returns table (
  configurado      boolean,
  url              text,
  cron_programado  boolean,
  cron_expresion   text,
  cron_activo      boolean,
  ultima_peticion  timestamptz,
  ultimo_codigo    int,
  ultimo_error     text,
  ultima_respuesta text
)
language plpgsql
stable
as $$
declare
  v_request_id bigint;
begin
  select s.decrypted_secret into url
    from vault.decrypted_secrets s
   where s.name = 'token_refresh_project_url';

  configurado := url is not null and url <> ''
             and exists (select 1 from vault.decrypted_secrets s
                          where s.name = 'token_refresh_cron_secret'
                            and s.decrypted_secret <> '');
  if url is not null then
    url := url || '/functions/v1/token-refresh';
  end if;

  cron_programado := false;
  if to_regclass('cron.job') is not null then
    execute
      'select schedule, active from cron.job where jobname = $1'
      into cron_expresion, cron_activo
      using 'token-refresh';
    cron_programado := cron_expresion is not null;
  end if;

  select r.requested_at, r.request_id into ultima_peticion, v_request_id
    from app.token_refresh_runs r
   order by r.requested_at desc
   limit 1;

  -- pg_net borra `net._http_response` a las pocas horas, asi que esto
  -- puede venir vacio aunque la vuelta fuera bien. Vacio con
  -- `ultima_peticion` reciente = mirar los logs de la funcion.
  if ultima_peticion is not null and to_regclass('net._http_response') is not null then
    execute
      'select status_code, coalesce(error_msg, case when timed_out then ''timeout'' end), '
      '       left(content, 500) '
      '  from net._http_response where id = $1'
      into ultimo_codigo, ultimo_error, ultima_respuesta
      using v_request_id;
  end if;

  return next;
end;
$$;

comment on function app.token_refresh_worker_status() is
  'Una fila con todo lo que puede estar mal por separado en el disparador '
  'del worker de refresco: configuracion, trabajo programado, ultima '
  'peticion y lo que contesto la Edge Function.';


-- ---------------------------------------------------------------------
-- PROGRAMARLO YA, sin esperar a que alguien ejecute `configure`.
--
-- Asi el trabajo existe desde el momento en que se aplica la migracion, y
-- lo que falta —los dos secretos— se ve como un fallo cada cinco minutos
-- en `cron.job_run_details`, con el mensaje que dice que ejecutar. Al
-- reves —programarlo solo al configurar— un despliegue donde se olvide el
-- paso manual se ve exactamente igual que uno correcto: en silencio.
-- ---------------------------------------------------------------------
do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is not null then
    perform cron.schedule(
      'token-refresh',
      '*/5 * * * *',
      'select app.run_token_refresh_worker();'
    );
  else
    raise notice
      'Sin pg_cron: el worker de refresco NO queda programado. Normal en el harness de CI.';
  end if;
end $$;


-- ---------------------------------------------------------------------
-- Sin GRANT a nadie, igual que el claim de la 0013.
--
-- Estas funciones no devuelven ningun token, pero `configure` escribe en
-- Vault y `status` ensena la URL del proyecto. Solo las ejecuta
-- `service_role` —y el rol `postgres` desde el editor de SQL—, que es
-- quien ya tiene la base entera.
-- ---------------------------------------------------------------------
revoke execute on function app.token_refresh_setting(text) from public;
revoke execute on function app.configure_token_refresh_worker(text, text) from public;
revoke execute on function app.run_token_refresh_worker() from public;
revoke execute on function app.token_refresh_worker_status() from public;

revoke all on table app.token_refresh_runs from public;

$m0015$;
  insert into supabase_migrations.schema_migrations (version, name) values ('0015', 'token_refresh_cron');
  raise notice 'Migración 0015 aplicada.';
end
$entrega$;

-- 0016_recovery_window_reanclada.sql
do $entrega$
begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '0016') then
    raise notice 'Migración 0016 ya aplicada: se salta.';
    return;
  end if;
  execute $m0016$
-- =====================================================================
-- 0016_recovery_window_reanclada.sql
--
-- DOS COSAS, Y LAS DOS SOBRE LO MISMO: que la red de recuperacion siga
-- ahi cuando haga falta.
--
--   1. Se quita el trigger de la 0012. La regla que imponia resulto ser
--      falsa: la ventana SI se reancla al recuperar.
--   2. Se apunta cuando fue el ultimo refresco con exito, y se deriva de
--      ahi si una instalacion esta obsoleta. Sin esa marca, un worker
--      caido en silencio no se ve hasta que la ventana ya vencio.
--
-- MIGRACION NUEVA. Las 0001 a 0015 estan aplicadas a la base viva y no
-- se tocan.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. LA VENTANA SE REANCLA AL PAR NUEVO
--
-- La 0012 impuso con un trigger que la ventana de recuperacion NO se
-- moviera hacia adelante mientras el token de recuperacion fuera el
-- mismo. No era capricho: la documentacion publica admite dos lecturas
-- —"dos semanas desde que se genero el par actual" y "la cadena continua
-- hasta que un refresh se usa con exito"— y no se podian medir sin
-- perder un refresh a proposito y esperar dos semanas. Se eligio la
-- pesimista, que es la que se equivoca del lado barato, y se dejo escrito
-- que si algun dia se confirmaba lo contrario esto se quitaba con un
-- `drop trigger` en una migracion nueva. Esta es esa migracion.
--
-- LO QUE CONFIRMO CLOVER (Developer Relations, sobre el High-Trust App
-- Auth Flow):
--
--   - la ventana se ancla a la HORA DE CREACION de cada par nuevo
--     (access + refresh), venga del endpoint que venga;
--   - al recuperar con el refresh previo (token A) se genera el par C, la
--     ventana empieza de nuevo desde la creacion de C, A SIGUE SIENDO EL
--     TOKEN DE RECUPERACION DESIGNADO PARA C, y el token B queda
--     invalido;
--   - la ventana se cierra para siempre si pasan dos semanas sin generar
--     un par nuevo, o si un refresh token se usa con exito en el flujo
--     estandar.
--
-- O sea que de las dos reglas de la 0012, la del PUNTERO era correcta —y
-- sigue vigente, y sigue siendo lo contraintuitivo— y la de la VENTANA
-- era falsa.
--
-- CLOVER-PENDING: el tercer punto tiene una pregunta abierta con Clover.
-- "Si un refresh token se usa con exito en el flujo estandar" admite dos
-- lecturas: que se invalida ESE token como token de recuperacion (lo
-- normal, y lo que hace el resto del diseno), o que se cierra la ventana
-- entera de la conexion (que dejaria sin red a cualquier conexion sana en
-- cuanto el worker rota, que es cada cinco minutos). Nada de esta
-- migracion depende de la respuesta: el worker intenta la recuperacion
-- siempre y la autoridad es `X-Clover-Recovery-Available`.
--
-- QUE SE ROMPE AL QUITARLO: nada. El trigger solo rechazaba escrituras;
-- quitarlo no cambia ninguna fila ni relaja ningun permiso. Lo que si
-- cambia es el codigo del worker, que a partir de la 0016 escribe una
-- ventana nueva tambien al recuperar (ver workers/src/token-refresh/chain.ts).
--
-- UN COMENTARIO QUE SE QUEDA DESACTUALIZADO Y NO SE TOCA: el `claim` de
-- la 0013 avisa de que su `update` no menciona `recovery_token_expires_at`
-- "asi que no dispara el trigger de la 0012". El trigger ya no existe,
-- pero la 0013 esta aplicada a la base viva y no se edita. El consejo
-- sigue siendo bueno por otro motivo: reservar una fila no es emitir un
-- par, y no tiene por que mover ninguna ventana.
--
-- LAS FILAS QUE YA ESTAN NO SE TOCAN. Una conexion que hoy arrastre una
-- ventana vieja por haberse recuperado bajo la regla anterior se corrige
-- sola en su siguiente rotacion, que como mucho es dentro de cinco
-- minutos. Un `update` masivo inventaria margen sobre pares que quiza
-- nacieron hace dias, que es justo el error caro.
-- ---------------------------------------------------------------------
drop trigger if exists trg_clover_conn_recovery_window on public.clover_connections;
drop function if exists app.enforce_recovery_window();

comment on column public.clover_connections.recovery_token_expires_at is
  'Fin estimado de la ventana de recuperacion: +2 semanas desde que se '
  'genero el par ACTUAL. Se reancla con cada par nuevo, tambien cuando el '
  'par viene del endpoint de recuperacion (confirmado por Clover; la 0012 '
  'asumia lo contrario y la 0016 lo corrigio). CALCULADO POR NOSOTROS, no '
  'devuelto por Clover: sirve para avisar y para limpiar, nunca para '
  'decidir no intentarlo.';

comment on column public.clover_connections.recovery_token_secret_id is
  'Id en Vault del refresh token que SE MANDO a Clover para obtener el par '
  'actual, que es el que Clover mantiene vivo como token de recuperacion. '
  'Ojo: en el camino de recuperacion NO es el token al que sustituye el '
  'par nuevo. A -> C deja la recuperacion en A, y mata a B. null = no hay '
  'red: es el estado normal justo despues del flujo OAuth inicial.';


-- ---------------------------------------------------------------------
-- 2. CUANDO FUE EL ULTIMO REFRESCO CON EXITO
--
-- EL AGUJERO QUE TAPA
-- El worker de pg_cron es lo unico que impide que la ventana de 14 dias
-- venza. Si deja de correr en silencio —el proyecto de Supabase pausado,
-- pg_net fallando, el secreto del cron rotado sin avisar a la Edge
-- Function— no pasa nada visible durante dos semanas. Al dia 15 la unica
-- salida es que el merchant vuelva a autorizar la app a mano.
--
-- Y "en silencio" es literal: `cron.job_run_details` dice si el `select`
-- salio bien, o sea si la peticion se ENCOLO;
-- `app.token_refresh_worker_status()` (0015) cruza eso con la respuesta,
-- pero mira el DISPARADOR, no el resultado por conexion. Un worker que
-- corre, contesta 200 y no consigue rotar NINGUNA conexion se ve
-- exactamente igual que uno sano.
--
-- POR QUE UNA COLUMNA Y NO UN JOB QUE MARQUE
-- Porque el modo de fallo es "dejo de ejecutarse algo". Un detector que
-- tambien tenga que ejecutarse periodicamente para marcar comparte el
-- punto de fallo con lo que vigila: Supabase pausado no corre el worker,
-- y tampoco correria el detector, asi que nadie marcaria nada y la
-- ausencia de alertas se leeria como salud.
--
-- Aqui la obsolescencia se DERIVA en tiempo de consulta a partir de un
-- dato que solo se escribe cuando algo va BIEN. Nadie tiene que ejecutar
-- nada para que una instalacion aparezca obsoleta: aparece justamente
-- porque no se ejecuto nada. Es correcta aunque la base lleve meses sin
-- que corra un solo trabajo.
-- ---------------------------------------------------------------------
alter table public.clover_connections
  add column last_refresh_success_at timestamptz;

comment on column public.clover_connections.last_refresh_success_at is
  'Cuando se roto por ultima vez con exito el par de tokens de esta '
  'conexion, por refresco o por recuperacion. Lo escribe el worker con '
  'now() de la base, no con su reloj. null = nunca se ha rotado desde que '
  'existe esta columna, que en una conexion recien conectada es normal y '
  'en una vieja significa que el worker no la ha tocado.';

-- Retrato del momento en que se aplica la migracion.
--
-- Sin esto, TODAS las conexiones existentes saldrian obsoletas el primer
-- dia: `null` no se puede distinguir de "lleva un mes sin rotar" y el
-- panel arrancaria en rojo, que es la forma mas rapida de que nadie
-- vuelva a mirarlo. `access_token_expires_at` es lo mas cercano a un
-- ultimo exito que hay en la fila: lo escribio la ultima rotacion o el
-- OAuth inicial, que son exactamente los dos eventos que esta columna
-- apunta. Se resta el TTL documentado del access token para no fechar el
-- exito en el futuro.
--
-- Solo donde hay algo que copiar: una conexion sin esa fecha nunca tuvo
-- un par, y `null` es la respuesta honesta.
update public.clover_connections
   set last_refresh_success_at = access_token_expires_at - interval '30 minutes'
 where access_token_expires_at is not null
   and refresh_token_secret_id is not null;

-- Parcial y por fecha: la consulta que importa es "cuales llevan mas de
-- N dias", y solo sobre las que el worker deberia estar rotando. Una
-- conexion `not_connected` no esta obsoleta, esta sin conectar.
create index idx_clover_conn_refresh_staleness
  on public.clover_connections (last_refresh_success_at nulls first)
  where status in ('connected', 'degraded');


-- ---------------------------------------------------------------------
-- EL UMBRAL, EN UN SOLO SITIO
--
-- Siete dias: la mitad de la ventana de 14. No es una cifra redonda por
-- gusto, es el punto en el que todavia queda margen para arreglarlo sin
-- tocar al merchant. Con el worker rotando cada 5 minutos, una conexion
-- sana no se acerca ni de lejos: para llegar a 7 dias tienen que fallar
-- unas 2.000 vueltas seguidas.
--
-- Es una funcion y no un literal repetido en cada vista porque el dia que
-- se ajuste, se ajusta una vez, y las dos vistas dicen lo mismo por
-- construccion. `immutable` porque devuelve una constante: asi el
-- planificador la sustituye por su valor en vez de llamarla por fila.
--
-- CLOVER-PENDING: los 7 dias son la mitad de la ventana DOCUMENTADA de 2
-- semanas. La ventana real de produccion no esta medida —haria falta
-- perder un par a proposito y esperar—, asi que si algun dia se confirma
-- que es mas corta, este es el numero que se baja.
--
-- SIN `revoke`, al contrario que el resto de funciones de `app`. Esas
-- escriben en Vault o devuelven ids de secreto; esta devuelve la
-- constante `7 days` y no lee ni una fila. Revocarsela a PUBLIC dejaria
-- sin poder evaluar las dos vistas a cualquier rol que no sea el dueno,
-- `service_role` incluido, a cambio de esconder un numero que esta
-- escrito en esta misma linea.
-- ---------------------------------------------------------------------
create or replace function app.refresh_staleness_threshold()
returns interval
language sql
immutable
as $$ select interval '7 days' $$;

comment on function app.refresh_staleness_threshold() is
  'Cuanto puede pasar sin un refresco con exito antes de considerar '
  'obsoleta una instalacion: 7 dias, la mitad de la ventana de '
  'recuperacion de Clover. Ver 0016.';


-- ---------------------------------------------------------------------
-- LA VISTA DEL SaaS, CON LA MARCA
--
-- `create or replace view` no deja renombrar ni reordenar columnas: solo
-- anadir al final. Por eso las dos nuevas van detras de
-- `recovery_available_until` aunque encajarian mejor al lado de las otras
-- fechas. Es la misma nota que dejo la 0012, y sigue valiendo.
--
-- `refresh_stale` es la columna consultable que pide el operador: se
-- calcula, no se guarda, asi que no puede quedarse desincronizada ni
-- depende de que nadie la escriba.
-- ---------------------------------------------------------------------
create or replace view public.clover_connection_status as
select
  c.store_id,
  c.restaurant_id,
  c.status,
  c.environment,
  case when c.merchant_id is null then null
       else '****' || right(c.merchant_id, 4) end as merchant_masked,
  c.ecommerce_enabled,
  (c.order_type_id is not null)                    as order_type_ready,
  cardinality(c.granted_permissions)               as permissions_granted,
  c.last_sync_at,
  c.last_webhook_at,
  c.access_token_expires_at,
  c.consecutive_failures,
  c.last_error_at,
  c.recovery_token_expires_at                      as recovery_available_until,
  c.last_refresh_success_at,
  -- `null` cuenta como obsoleta: no saber cuando fue el ultimo exito es
  -- indistinguible de que no lo haya habido, y las dos piden lo mismo
  -- (que alguien mire). Solo se evalua sobre las conexiones que el worker
  -- deberia estar rotando; una `not_connected` no esta obsoleta.
  (
    c.status in ('connected', 'degraded')
    and c.refresh_token_secret_id is not null
    and (
      c.last_refresh_success_at is null
      or c.last_refresh_success_at < now() - app.refresh_staleness_threshold()
    )
  )                                                as refresh_stale
from public.clover_connections c;

-- ESTA LINEA NO ES DECORATIVA. `create or replace view` DESCARTA las
-- reloptions, asi que sin ella la vista pierde `security_invoker` y pasa
-- a ejecutarse con los permisos de su propietario: dejaria de heredar el
-- RLS de clover_connections y ensenaria TODAS las conexiones a cualquiera
-- con SELECT sobre la vista. Medido en Postgres 16, no supuesto. Es la
-- razon de ser de 0007_view_security.sql, y se repite cada vez que se
-- reemplaza esta vista.
alter view public.clover_connection_status set (security_invoker = on);

comment on view public.clover_connection_status is
  'Resumen sin secretos para el SaaS. security_invoker = on: hereda el '
  'RLS de clover_connections, que no tiene policies, asi que solo '
  'service_role obtiene filas. Nunca expone ids de Vault. '
  'refresh_stale se calcula en cada consulta: nadie tiene que escribirlo, '
  'asi que sigue siendo cierto aunque no corra ningun trabajo.';


-- ---------------------------------------------------------------------
-- LA VISTA DE GUARDIA
--
-- La anterior tiene una fila por conexion y hay que filtrarla. Esta tiene
-- una fila por PROBLEMA, y por eso es la que se consulta a las tres de la
-- manana y la que puede colgar de una alerta: si devuelve cero filas, no
-- hay nada que hacer.
--
-- Lleva `dias_sin_refrescar` porque "obsoleta" es un si/no y lo que se
-- necesita para decidir es cuanto queda: a los 8 dias sobran seis para
-- arreglarlo sin llamar al restaurante; a los 13 no.
-- ---------------------------------------------------------------------
create or replace view public.clover_refresh_stale as
select
  c.store_id,
  c.restaurant_id,
  c.status,
  c.environment,
  case when c.merchant_id is null then null
       else '****' || right(c.merchant_id, 4) end as merchant_masked,
  c.last_refresh_success_at,
  -- `null` = nunca. Se declara maximo para que ordene arriba: es el caso
  -- que menos sabemos y el que mas urge mirar.
  coalesce(
    extract(epoch from (now() - c.last_refresh_success_at))::double precision / 86400,
    'infinity'::double precision
  )                                                as dias_sin_refrescar,
  c.recovery_token_expires_at                      as recovery_available_until,
  c.consecutive_failures,
  c.last_error,
  c.last_error_at
from public.clover_connections c
where c.status in ('connected', 'degraded')
  and c.refresh_token_secret_id is not null
  and (
    c.last_refresh_success_at is null
    or c.last_refresh_success_at < now() - app.refresh_staleness_threshold()
  )
order by c.last_refresh_success_at asc nulls first;

alter view public.clover_refresh_stale set (security_invoker = on);

comment on view public.clover_refresh_stale is
  'Una fila por instalacion cuyo ultimo refresco con exito tiene mas de '
  'app.refresh_staleness_threshold(). Cero filas = no hay nada que hacer. '
  'A diferencia de app.token_refresh_worker_status(), que mira el '
  'DISPARADOR, esta mira el RESULTADO: un worker que corre, contesta 200 y '
  'no rota nada aparece aqui y alli no. security_invoker = on, y expone '
  'last_error pero ningun id de Vault.';

-- ---------------------------------------------------------------------
-- Y NO SE LA DAMOS A NADIE, EXPLICITAMENTE.
--
-- No basta con "no escribir un grant": en un proyecto de Supabase el
-- `postgres` que aplica las migraciones tiene ALTER DEFAULT PRIVILEGES a
-- favor de `anon` y `authenticated` sobre `public`, asi que una vista
-- nueva nace concedida. Eso no filtraria filas —`security_invoker = on`
-- sobre una tabla con RLS y sin policies devuelve cero— pero deja una
-- vista con `last_error` al alcance de cualquier usuario de la app movil
-- a un solo despiste de RLS de distancia. Se cierra aqui, que cuesta una
-- linea.
--
-- `service_role` conserva la suya por esos mismos default privileges, que
-- es como llegan tambien `clover_connection_status` y el resto: en este
-- repo no hay ni un grant explicito a `service_role`.
--
-- La otra vista NO se toca: `authenticated` tiene SELECT sobre ella desde
-- la 0004 a proposito, y quitarselo aqui seria arreglar otra cosa de
-- paso.
-- ---------------------------------------------------------------------
revoke all on public.clover_refresh_stale from anon, authenticated;

$m0016$;
  insert into supabase_migrations.schema_migrations (version, name) values ('0016', 'recovery_window_reanclada');
  raise notice 'Migración 0016 aplicada.';
end
$entrega$;

-- 0017_catalog_sync.sql
do $entrega$
begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '0017') then
    raise notice 'Migración 0017 ya aplicada: se salta.';
    return;
  end if;
  execute $m0017$
-- =====================================================================
-- 0017_catalog_sync.sql
-- Lo que el esquema le debe a la sincronizacion de catalogo.
--
-- El espejo de la 0002 ya tenia casi todo. Falta lo que aparece cuando se
-- mira el catalogo REAL de un merchant en vez del seed:
--
--   1. `price_type` deja de ser siempre FIXED, y un VARIABLE trae
--      price = 0. Sin una regla, la app enseña un producto a $0.00 y deja
--      pedirlo;
--   2. el impuesto de un item necesita distinguir EXENTO de NO LO SABEMOS.
--      En la base los dos se ven igual —cero filas de enlace— y llevan a
--      acciones opuestas;
--   3. dos barridos simultaneos sobre la misma tienda se pisan los upserts.
--
-- El mapeo entero, con el porque de cada regla, esta en
-- docs/SINCRONIZACION-CATALOGO.md. Este archivo es solo el esquema.
--
-- MIGRACION NUEVA. Las 0001 a 0016 estan aplicadas a la base viva y no
-- se tocan.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. LAS COLUMNAS NUEVAS DE `catalog_items`
-- ---------------------------------------------------------------------
alter table public.catalog_items
  -- El booleano de Clover: si el item usa las tasas POR DEFECTO del
  -- merchant en vez de unas propias. Sin el no se puede reconstruir que
  -- impuesto aplica: cero enlaces significa "exento" solo cuando esto es
  -- false. `null` = nunca se ha leido.
  add column default_tax_rates boolean,

  -- Cuando se resolvio por ultima vez la configuracion de impuesto de
  -- este item. ESTA COLUMNA EXISTE PARA DISTINGUIR DOS COSAS QUE SE VEN
  -- IGUAL:
  --
  --   exento         -> default_tax_rates = false, cero enlaces,
  --                     tax_synced_at PUESTO
  --   sin resolver   -> cero enlaces y tax_synced_at NULL
  --
  -- La expansion `taxRates` puede no llegar (Clover la omite, la
  -- respuesta se recorta, el sandbox se atraganta). Escribir cero enlaces
  -- en ese caso seria declarar exento un producto que quiza paga
  -- impuesto, y nadie lo notaria hasta cuadrar caja.
  add column tax_synced_at timestamptz;

comment on column public.catalog_items.default_tax_rates is
  'Clover `item.defaultTaxRates`: el item usa las tasas por defecto del '
  'merchant (las de catalog_tax_rates con is_default) en vez de enlaces '
  'propios. null = nunca se ha leido de Clover.';

comment on column public.catalog_items.tax_synced_at is
  'Cuando se resolvio la configuracion de impuesto de este item. null = '
  'nunca. Cero filas en catalog_item_tax_rates significa EXENTO solo si '
  'esto NO es null; con null significa que no lo sabemos, que es otra '
  'cosa y pide otra accion. Ver docs/SINCRONIZACION-CATALOGO.md.';


-- ---------------------------------------------------------------------
-- 2. `price_type` ES UN ENUM DE TRES, NO UN TEXTO LIBRE
--
-- Clover admite FIXED, VARIABLE y PER_UNIT. La columna se creo como
-- `text default 'FIXED'` sin restriccion, y mientras solo hubo seed eso
-- no importaba: todas las filas decian FIXED.
--
-- Un `check` y no un `enum` de Postgres a proposito: si Clover añade un
-- cuarto tipo, un check se amplia con un `alter ... drop constraint` y
-- otro `add constraint` en una migracion nueva, mientras que un tipo
-- enum arrastra dependencias de columnas y vistas.
--
-- QUE PASA SI CLOVER MANDA UN CUARTO TIPO: el mapeo lo detecta antes de
-- escribir y el item se ignora con motivo `price_type_desconocido`, que
-- sale en el reporte. No se escribe para que el `check` lo rechace: un
-- barrido no se aborta entero por un item raro.
-- ---------------------------------------------------------------------
alter table public.catalog_items
  add constraint catalog_items_price_type_conocido
    check (price_type in ('FIXED', 'VARIABLE', 'PER_UNIT'));

comment on column public.catalog_items.price_type is
  'FIXED = el precio del item es el precio. VARIABLE = lo teclea el '
  'cajero al vender. PER_UNIT = por unidad de medida, se pesa en caja. '
  'Solo FIXED se puede pedir desde la app: los otros dos llegan con '
  'price = 0 o con un precio que no es el que se cobra.';


-- ---------------------------------------------------------------------
-- 3. UN BARRIDO A LA VEZ POR SUCURSAL
--
-- Mismo mecanismo que el arriendo del refresco (0013) y por la misma
-- razon que alli se explica con detalle: `pg_advisory_lock` es de SESION
-- y el pooler de Supabase en modo transaccion recicla la sesion, asi que
-- el cerrojo se queda cogido en una sesion que ya no es tuya.
--
-- Aqui el daño de no tenerlo es distinto y mas silencioso que en el
-- refresco: dos barridos simultaneos no matan nada —los upserts son
-- idempotentes— pero los dos REPORTES mienten. Cada uno ve como "sin
-- cambios" lo que acaba de escribir el otro, y el reporte es justo lo
-- que se lee para validar el mapeo.
-- ---------------------------------------------------------------------
alter table public.clover_connections
  add column catalog_sweep_lease_until timestamptz;

comment on column public.clover_connections.catalog_sweep_lease_until is
  'Arriendo del barrido de catalogo: mientras este en el futuro, ninguna '
  'otra ejecucion barre esta sucursal. Independiente de '
  'refresh_lease_until: el refresco de tokens y el barrido no compiten '
  'por nada y bloquearse mutuamente solo pararia el refresco justo '
  'cuando mas trabajo hay.';

-- Tomar el arriendo. Devuelve la fila si se consiguio, cero filas si ya
-- lo tiene otro. UN SOLO STATEMENT, igual que el claim de la 0013:
-- comprobar y reservar en dos pasos deja sitio entre medias para la otra
-- ejecucion.
create or replace function app.claim_catalog_sweep(
  p_store_id      uuid,
  p_lease_seconds int
)
returns table (
  connection_id uuid,
  store_id      uuid,
  merchant_id   text,
  environment   text
)
language sql
as $$
  update public.clover_connections c
     set catalog_sweep_lease_until = now() + make_interval(secs => p_lease_seconds)
   where c.id = (
     select d.id
       from public.clover_connections d
      where d.store_id = p_store_id
        -- Sin merchant no hay a quien preguntarle el catalogo, y sin
        -- token de acceso no se puede preguntar.
        and d.merchant_id is not null
        and d.access_token_secret_id is not null
        and (d.catalog_sweep_lease_until is null or d.catalog_sweep_lease_until <= now())
      for update skip locked
   )
  returning c.id, c.store_id, c.merchant_id, c.environment;
$$;

comment on function app.claim_catalog_sweep(uuid, int) is
  'Reserva una sucursal para un barrido de catalogo y devuelve con que '
  'merchant hablar. Cero filas = ya hay un barrido en marcha, o la '
  'sucursal no esta conectada. No devuelve ningun token: solo el id del '
  'secreto lo sabe quien lee la fila entera.';

create or replace function app.release_catalog_sweep(p_connection_id uuid)
returns void
language sql
as $$
  update public.clover_connections
     set catalog_sweep_lease_until = null
   where id = p_connection_id;
$$;

revoke execute on function app.claim_catalog_sweep(uuid, int) from public;
revoke execute on function app.release_catalog_sweep(uuid) from public;


-- ---------------------------------------------------------------------
-- 4. EL RASTRO DE CADA BARRIDO
--
-- El reporte es lo que se lee para validar el mapeo, y un reporte que
-- solo existe en la respuesta de un `curl` se pierde al cerrar la
-- terminal. Aqui queda consultable, y ademas se puede comparar el barrido
-- de hoy con el de ayer, que es como se ve si algo dejo de mapearse.
--
-- Vive en `app` y no en `public`: no es un dato del negocio, no lo lee la
-- app movil y no tiene que salir en los tipos generados.
--
-- `jsonb` y no veinte columnas porque la forma del reporte va a cambiar
-- en los PR siguientes (webhooks, purgado) y una tabla de auditoria que
-- obligue a una migracion por cada campo nuevo acaba sin campos nuevos.
-- ---------------------------------------------------------------------
create table app.catalog_sync_runs (
  id            uuid primary key default gen_random_uuid(),
  store_id      uuid not null references public.stores(id) on delete cascade,
  merchant_id   text,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  -- false = alguna pagina fallo. Un barrido incompleto NO sirve para
  -- decidir borrados: "no vino" y "fallo la peticion" se ven igual.
  complete      boolean not null default false,
  report        jsonb   not null default '{}'::jsonb
);

create index idx_catalog_sync_runs_store
  on app.catalog_sync_runs (store_id, started_at desc);

comment on table app.catalog_sync_runs is
  'Un reporte por barrido de catalogo: que se creo, que se actualizo, que '
  'se ignoro y por que. `complete` en false significa que alguna pagina '
  'fallo, y entonces el reporte no sirve para decidir que falta en '
  'Clover. Ver docs/SINCRONIZACION-CATALOGO.md.';

revoke all on table app.catalog_sync_runs from public;


-- ---------------------------------------------------------------------
-- 5. QUE IMPUESTO APLICA A UN ITEM, RESUELTO EN UN SOLO SITIO
--
-- El modelo de Clover tiene dos piezas y hay que cruzarlas:
--
--   enlaces explicitos  -> catalog_item_tax_rates
--   default_tax_rates   -> las tasas del merchant con is_default
--
-- Se resuelve en LECTURA y no materializando los defaults en la tabla de
-- enlace. Materializarlos duplicaria el dato y crearia la pregunta de que
-- hacer cuando el merchant cambie su tasa por defecto: habria que
-- reescribir N filas por un cambio que ya esta en una.
--
-- `origen` no es decoracion: es lo que permite mirar una fila y saber si
-- ese impuesto se lo puso el merchant al producto o le cae por defecto.
--
-- CLOVER-PENDING: falta confirmar contra el sandbox si Clover devuelve
-- las tasas por defecto DENTRO de la expansion `taxRates` cuando
-- `defaultTaxRates = true`. Si lo hace, un item saldria aqui dos veces
-- (una por cada rama) y hay que quitar la rama de defaults. El reporte
-- del barrido trae `items_default_con_enlaces` para contestarlo con el
-- primer barrido real: si esa lista viene vacia, las ramas no se solapan.
-- ---------------------------------------------------------------------
create or replace view public.catalog_item_tax_effective as
-- Rama 1: lo que el merchant enlazo al producto.
select
  i.store_id,
  i.id                 as item_id,
  i.clover_item_id,
  t.id                 as tax_rate_id,
  t.clover_tax_rate_id,
  t.name               as tax_rate_name,
  t.rate,
  'explicito'::text    as origen
from public.catalog_items i
join public.catalog_item_tax_rates l on l.item_id = i.id
join public.catalog_tax_rates t      on t.id = l.tax_rate_id
where i.deleted_at is null
  and t.deleted_at is null

union all

-- Rama 2: lo que le cae por defecto. Solo para items que lo dicen
-- explicitamente y que NO tienen enlaces propios.
select
  i.store_id,
  i.id,
  i.clover_item_id,
  t.id,
  t.clover_tax_rate_id,
  t.name,
  t.rate,
  'por_defecto'::text
from public.catalog_items i
join public.catalog_tax_rates t
  on t.store_id = i.store_id
 and t.is_default
 and t.deleted_at is null
where i.deleted_at is null
  and i.default_tax_rates is true
  and not exists (select 1 from public.catalog_item_tax_rates l where l.item_id = i.id);

alter view public.catalog_item_tax_effective set (security_invoker = on);

comment on view public.catalog_item_tax_effective is
  'Que tasas de impuesto aplican a cada item, cruzando los enlaces '
  'explicitos con las tasas por defecto del merchant. Un item SIN filas '
  'aqui y con tax_synced_at puesto esta EXENTO; sin filas y con '
  'tax_synced_at null, no lo sabemos. NADIE DEBE DERIVAR DE AQUI UN '
  'TOTAL DE CARA AL CLIENTE: el impuesto lo calcula Clover al crear la '
  'orden, y la app enseña subtotal hasta entonces.';

-- En Supabase una vista nueva NACE CONCEDIDA a anon y authenticated por
-- los default privileges del rol que aplica migraciones: no basta con no
-- escribir el grant. Esto no es dato de la app movil —el impuesto lo
-- calcula Clover al confirmar— asi que se cierra.
revoke all on public.catalog_item_tax_effective from anon, authenticated;


-- ---------------------------------------------------------------------
-- 6. LA VISTA DEL MENU: LO UNICO QUE ESTE PR CAMBIA PARA LA APP
--
-- Antes de esta migracion `price_type` era siempre FIXED, porque lo unico
-- que habia en la tabla era el seed. En cuanto entra el catalogo real
-- pueden aparecer VARIABLE (precio tecleado en caja) y PER_UNIT (por
-- peso), y los dos llegan con `price` a 0 o con un precio que no es el
-- que se cobra.
--
-- Sin esta linea, la app enseñaria un producto a $0.00 y dejaria pedirlo.
-- No es un riesgo teorico: es la consecuencia directa de empezar a
-- sincronizar.
--
-- `create or replace view` deja cambiar las EXPRESIONES y añadir columnas
-- al final; no deja renombrar, reordenar ni quitar. Por eso `price_type`
-- y `unorderable_reason` van detras aunque encajarian mejor arriba. Misma
-- nota que dejaron la 0012 y la 0016, y sigue valiendo.
--
-- La app pide columnas por nombre (`MENU_COLUMNS` en api/menu.ts), asi
-- que añadir al final no rompe nada: las nuevas no se piden hasta que
-- alguien las pida.
-- ---------------------------------------------------------------------
create or replace view public.menu_items as
select
  i.id,
  i.store_id,
  i.clover_item_id,
  i.name,
  coalesce(o.marketing_copy, i.alternate_name) as description,
  i.price_cents,
  c.id            as category_id,
  c.name          as category_name,
  c.sort_order    as category_sort,
  o.image_url,
  coalesce(o.featured, false)   as featured,
  coalesce(o.sort_order, 0)     as sort_order,
  o.badge,
  (
    i.available
    and not i.hidden
    -- LA LINEA NUEVA. Un precio que no es el precio no se puede pedir.
    and i.price_type = 'FIXED'
    and coalesce(o.app_visible, true)
    and (o.unavailable_until is null or o.unavailable_until < now())
  ) as is_available,
  o.unavailable_reason,
  -- Desde aqui, columnas nuevas de la 0017.
  i.price_type,
  -- Por que no se puede pedir, cuando el motivo es el TIPO DE PRECIO y no
  -- la disponibilidad. Se separa de `unavailable_reason` (que es del 86
  -- manual del operador) porque son dos cosas distintas: una se arregla
  -- esperando y la otra no se arregla nunca desde la app.
  case i.price_type
    when 'FIXED'    then null
    when 'VARIABLE' then 'El precio de este producto se fija en el mostrador.'
    when 'PER_UNIT' then 'Este producto se vende por peso y se pesa en el mostrador.'
    else 'Este producto no se puede pedir desde la app.'
  end as unorderable_reason
from public.catalog_items i
left join public.catalog_categories c on c.id = i.category_id and c.deleted_at is null
left join public.app_item_overrides o
       on o.store_id = i.store_id and o.clover_item_id = i.clover_item_id
where i.deleted_at is null;

alter view public.menu_items set (security_invoker = on);

comment on view public.menu_items is
  'El menu que consume la app: el espejo de Clover mas los overrides de '
  'merchandising. Ninguna columna tiene dos dueños — la vista elige entre '
  'columnas distintas, no resuelve conflictos. is_available exige '
  'price_type = FIXED: un VARIABLE trae price = 0 y dejarlo pedible seria '
  'vender aire.';

-- `create or replace view` DESCARTA los grants? No: los conserva. Pero el
-- security_invoker de arriba si se pierde al reemplazar (medido en
-- Postgres 16, es la razon de ser de 0007_view_security.sql), y por eso
-- se vuelve a poner. Los grants de la 0004 sobre menu_items siguen en pie
-- y no se tocan aqui: quitarlos seria arreglar otra cosa de paso.


-- ---------------------------------------------------------------------
-- 7. LO QUE ESTE PR NO CAMBIA, Y CONVIENE QUE ESTE ESCRITO
--
-- `hidden` SIGUE SALIENDO EN EL MENU, atenuado. Un item oculto en el POS
-- probablemente no deberia ni listarse en la app —el merchant lo saco de
-- su propia caja, no es que se haya agotado— pero eso NO se confirmo
-- contra el catalogo real: el entorno donde se escribio esto no tiene
-- credenciales de Clover.
--
-- CLOVER-PENDING: mirar `avisos.items_ocultos` del primer barrido real
-- contra el Test Merchant RGW5JAVFT8MB1. Si son productos retirados, esta
-- vista pasa a filtrarlos con un `where not i.hidden`. Si son productos
-- que el merchant vende fuera de caja, listarlos atenuados ya era lo
-- correcto y no hay nada que cambiar. Un `where` puesto por suposicion
-- haria desaparecer productos del menu sin que nadie sepa por que.
-- ---------------------------------------------------------------------

$m0017$;
  insert into supabase_migrations.schema_migrations (version, name) values ('0017', 'catalog_sync');
  raise notice 'Migración 0017 aplicada.';
end
$entrega$;

-- 0018_checkout_edge.sql
do $entrega$
begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '0018') then
    raise notice 'Migración 0018 ya aplicada: se salta.';
    return;
  end if;
  execute $m0018$
-- =====================================================================
-- 0018_checkout_edge.sql
-- El checkout deja de ser una RPC y pasa a Edge Function.
--
-- POR QUE AHORA, Y POR QUE NO ANTES
-- Lo dejo escrito la propia 0008, en su cabecera: crear el pedido y
-- cobrarlo tienen que ocurrir bajo la MISMA idempotencia, porque el fallo
-- que hay que evitar (R10) es cobrar sin pedido o pedir sin cobro. Y esa
-- unidad no cabe en un RPC: Postgres no puede llamar a una API externa y
-- esperar la respuesta. Un pg_net disparado desde la transaccion no
-- espera, y sin respuesta no hay forma de decidir si el pedido vale.
--
-- QUE SE MUDA Y QUE SE QUEDA
-- Se queda TODA la validacion: precios releidos de la base, modificadores
-- que tienen que pertenecer al producto, horario, cierres y capacidad. Eso
-- sigue en la base, en `app.open_checkout_attempt`, porque es lo que no se
-- le puede creer al telefono y la base es donde estan los datos.
-- Se muda la SECUENCIA con Clover, que es lo que no cabia.
--
-- MIGRACION NUEVA. Las 0001 a 0017 estan aplicadas y no se tocan.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. LOS DOS ESTADOS QUE FALTABAN
--
-- La 0003 definio seis estados pensando en un flujo que no hablaba con
-- Clover. Con la secuencia real faltan dos, y los dos existen por la
-- misma razon: SE ESCRIBE ANTES DE LLAMAR.
--
--   totals_ok  los totales estan y la orden aun no. Separa "no llegue a
--              pedir totales" de "los tengo y me mori antes de crear";
--   voiding    el cobro fallo y hay una orden SIN PAGAR en el POS del
--              merchant que hay que anular. Si la anulacion tambien
--              falla, la fila se queda aqui y sale en la vista de
--              guardia de mas abajo.
--
-- Sin `voiding` no hay forma de distinguir "fallo y limpie" de "fallo y
-- deje una orden viva en la caja del restaurante".
-- ---------------------------------------------------------------------
alter table public.checkout_attempts
  drop constraint if exists checkout_attempts_state_check;

alter table public.checkout_attempts
  add constraint checkout_attempts_state_check
    check (state in ('started','totals_ok','order_created','paid','printed','done','voiding','failed'));

comment on column public.checkout_attempts.state is
  'Donde va el intento. El orden es started -> totals_ok -> order_created '
  '-> paid -> printed -> done, y la rama mala es voiding -> failed. Se '
  'escribe ANTES de cada llamada a Clover, no despues: si el proceso muere '
  'entre el update y la respuesta, el reintento tiene que saber que esa '
  'llamada PUDO haber ocurrido. Ver workers/src/checkout/maquina.ts.';


-- ---------------------------------------------------------------------
-- 2. LA MAQUINA NO ANDA HACIA ATRAS
--
-- Un intento en `paid` no puede volver a `order_created`. No es higiene:
-- retroceder al paso de cobrar es cobrar dos veces, y el codigo que lo
-- intentara seria un codigo que alguien escribio creyendo que reintentaba.
--
-- Esto lo comprueba tambien `avanza()` en el cliente. Aqui esta porque un
-- chequeo en el cliente no protege de nada: protege del cliente que lo
-- llama, no del proximo.
--
-- Se permite entrar en la rama mala (voiding, failed) desde cualquier
-- punto —fallar se puede fallar en cualquier momento— y no se permite
-- salir de ella hacia el progreso.
-- ---------------------------------------------------------------------
create or replace function app.enforce_checkout_progress()
returns trigger
language plpgsql
as $$
declare
  v_orden constant text[] := array['started','totals_ok','order_created','paid','printed','done'];
  v_desde int;
  v_hasta int;
begin
  if new.state = old.state then
    return new;
  end if;

  -- La rama mala se puede alcanzar desde cualquier sitio menos desde si
  -- misma una vez terminada.
  if new.state in ('voiding','failed') then
    if old.state = 'failed' then
      raise exception
        'El intento % ya estaba en failed y no puede volver a %.', new.id, new.state;
    end if;
    return new;
  end if;

  -- Y no se sale de ella hacia el progreso.
  if old.state in ('voiding','failed') then
    raise exception
      'El intento % esta en % y no puede volver al progreso (%). Un intento '
      'que fallo se reintenta con una clave nueva, no resucitando este.',
      new.id, old.state, new.state;
  end if;

  v_desde := array_position(v_orden, old.state);
  v_hasta := array_position(v_orden, new.state);
  if v_hasta <= v_desde then
    raise exception
      'El intento % iria de % a %, que es hacia atras. Retroceder al paso '
      'de cobrar es cobrar dos veces.', new.id, old.state, new.state;
  end if;

  return new;
end;
$$;

create trigger trg_checkout_attempts_progreso
  before update of state on public.checkout_attempts
  for each row execute function app.enforce_checkout_progress();

comment on function app.enforce_checkout_progress() is
  'Impide que un intento de checkout retroceda de estado. Retroceder al '
  'paso de cobrar es cobrar dos veces.';


-- ---------------------------------------------------------------------
-- 3. EL RECARGO QUE COBRO CLOVER, APARTE DEL TOTAL
--
-- No es adorno: el recargo por tarjeta NO esta dentro del total de la
-- orden. Va en `additionalCharges` del pago, y lo que el cliente ve en su
-- extracto es la suma de los dos:
--
--   cobrado de verdad = payments.amount_cents + payments.surcharge_cents
--
-- Sin esta columna, `amount_cents` pareceria el importe cobrado y no lo
-- es. Alguien conciliando con el extracto del banco encontraria una
-- diferencia por pedido y no sabria de donde sale.
--
-- `null` NO es `0`. null = el pago no traia `additionalCharges` y no
-- sabemos si hubo recargo; 0 = vino el campo y no hubo. Son estados
-- distintos, igual que con el impuesto de los items (0017).
--
-- Ver docs/PEDIDOS-COBRO.md, parte 1.
-- ---------------------------------------------------------------------
alter table public.payments
  add column surcharge_cents bigint check (surcharge_cents is null or surcharge_cents >= 0);

comment on column public.payments.surcharge_cents is
  'Recargo por tarjeta que aplico CLOVER, leido de additionalCharges del '
  'pago. NO esta dentro de amount_cents: el importe real cobrado es la '
  'suma de los dos. null = el pago no traia el campo, que no es lo mismo '
  'que cero.';


-- ---------------------------------------------------------------------
-- 4. ABRIR EL INTENTO: toda la validacion, sin nada de Clover
--
-- Es `create_pickup_order` de la 0008 partida por la mitad. Esta mitad se
-- queda en la base porque valida contra datos que estan aqui, y porque lo
-- que no se le puede creer al telefono no se le puede creer en ningun
-- sitio. La otra mitad —la secuencia con Clover— se la lleva la Edge
-- Function.
--
-- DEVUELVE LAS LINEAS YA RELEIDAS, con sus precios de NUESTRO catalogo.
-- La Edge Function no vuelve a mirar el cuerpo de la peticion: lo que
-- manda a Clover es lo que sale de aqui. Asi un precio del telefono no
-- tiene por donde entrar, ni siquiera por descuido.
--
-- `security definer` por lo mismo que la 0008: el cliente sigue sin poder
-- escribir en `orders`. Lo unico que puede es pedirle a esto que escriba
-- por el, y esto no le cree nada.
-- ---------------------------------------------------------------------
create or replace function app.open_checkout_attempt(
  p_user_id         uuid,
  p_store_id        uuid,
  p_idempotency_key text,
  p_pickup_at       timestamptz,
  p_is_asap         boolean,
  p_customer_note   text,
  p_items           jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_catalog
as $$
declare
  v_store         public.stores%rowtype;
  v_config        public.store_pickup_config%rowtype;
  v_conn          public.clover_connections%rowtype;
  v_existing      public.checkout_attempts%rowtype;
  v_attempt_id    uuid;
  v_order_id      uuid;
  v_order_number  int;
  v_business_day  date;
  v_subtotal      bigint := 0;
  v_item          jsonb;
  v_item_row      record;
  v_order_item_id uuid;
  v_quantity      int;
  v_unit_cents    bigint;
  v_mod_id        text;
  v_mod_row       record;
  v_slot_count    bigint;
  v_sort          int := 0;
  v_lineas        jsonb := '[]'::jsonb;
  v_mods          jsonb;
begin
  if p_user_id is null then
    raise exception 'auth_required' using errcode = '28000';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) < 8 then
    raise exception 'invalid_idempotency_key' using errcode = '22023';
  end if;

  -- ---- IDEMPOTENCIA, ANTES DE TOCAR NADA ----
  -- Un reintento con la misma clave NO crea un segundo pedido: devuelve
  -- el intento que ya hay, con su estado, para que la Edge Function
  -- retome la secuencia donde se quedo.
  select * into v_existing
  from public.checkout_attempts
  where idempotency_key = p_idempotency_key;

  if found then
    if v_existing.user_id is distinct from p_user_id then
      raise exception 'idempotency_key_conflict' using errcode = '42501';
    end if;
    -- OJO, DIFERENCIA CON LA 0008: alli un intento a medias se BORRABA
    -- para volver a empezar. Aqui no se puede — a medias puede significar
    -- "hay una orden en Clover", y borrar la fila perderia el unico
    -- puntero que tenemos hacia ella. Se devuelve para retomarla.
    return app.checkout_attempt_snapshot(v_existing.id);
  end if;

  -- ---- SUCURSAL ----
  select * into v_store from public.stores
  where id = p_store_id and deleted_at is null and status = 'active';
  if not found then
    raise exception 'store_not_available' using errcode = '22023';
  end if;
  if not v_store.pickup_enabled then
    raise exception 'pickup_disabled' using errcode = '22023';
  end if;

  -- NO HAY PUERTA PARA `absorb`, y es porque `absorb` ya no existe: la
  -- 0019 la quita del enum. Prometia que el recargo lo pagaba el
  -- restaurante y no podia cumplirlo —el endpoint de cobro no tiene campo
  -- para renunciar al recargo—, asi que el cliente lo pagaba igual y sin
  -- aviso. El porque entero esta en la 0019 y en docs/RECARGO-TARJETA.md.
  if v_store.surcharge_policy = 'block' then
    raise exception 'store_not_taking_orders' using errcode = '22023';
  end if;

  -- Sin conexion viva no hay a quien crear la orden. Se comprueba AQUI y
  -- no en la Edge Function para no llegar a crear un pedido nuestro que
  -- despues no tiene donde ir.
  select * into v_conn from public.clover_connections where store_id = p_store_id;
  if not found or v_conn.merchant_id is null or v_conn.access_token_secret_id is null then
    raise exception 'store_not_connected' using errcode = '22023';
  end if;
  if v_conn.status <> 'connected' then
    raise exception 'store_connection_degraded' using errcode = '22023';
  end if;

  select * into v_config from public.store_pickup_config where store_id = p_store_id;
  if not found then
    raise exception 'pickup_not_configured' using errcode = '22023';
  end if;

  -- ---- HORA DE RECOGIDA ----
  if p_pickup_at is null then
    raise exception 'pickup_at_required' using errcode = '22023';
  end if;
  if p_pickup_at < now() + make_interval(mins => v_config.lead_time_minutes) then
    raise exception 'pickup_too_soon' using errcode = '22023';
  end if;
  if p_pickup_at > now() + make_interval(days => v_config.max_days_ahead + 1) then
    raise exception 'pickup_too_far' using errcode = '22023';
  end if;
  if not app.store_accepts_pickup_at(p_store_id, p_pickup_at) then
    raise exception 'store_closed_at_pickup' using errcode = '22023';
  end if;

  select count(*) into v_slot_count
  from public.orders o
  where o.store_id = p_store_id
    and o.pickup_at = p_pickup_at
    and o.status in ('payment_pending', 'confirmed', 'preparing', 'ready');
  if v_slot_count >= v_config.max_orders_per_slot then
    raise exception 'slot_full' using errcode = '23505';
  end if;

  -- ---- CARRITO ----
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'empty_cart' using errcode = '22023';
  end if;

  v_business_day := (now() at time zone v_store.timezone)::date;
  v_order_number := app.next_order_number(p_store_id, v_business_day);

  insert into public.orders (
    tenant_id, store_id, user_id, order_number, business_day,
    status, fulfillment, pickup_at, is_asap, customer_note,
    idempotency_key, currency
  )
  values (
    v_store.restaurant_id, p_store_id, p_user_id, v_order_number, v_business_day,
    'payment_pending', 'pickup', p_pickup_at, coalesce(p_is_asap, false),
    nullif(btrim(coalesce(p_customer_note, '')), ''),
    p_idempotency_key, 'USD'
  )
  returning id into v_order_id;

  insert into public.checkout_attempts
    (idempotency_key, user_id, store_id, order_id, state, request_payload)
  values (p_idempotency_key, p_user_id, p_store_id, v_order_id, 'started',
          jsonb_build_object('pickup_at', p_pickup_at, 'items', p_items))
  returning id into v_attempt_id;

  -- ---- LINEAS ----
  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_quantity := greatest(1, least(99, coalesce((v_item ->> 'quantity')::int, 1)));

    -- EL PRECIO SALE DEL CATALOGO DE ESTA SUCURSAL, nunca del telefono.
    select i.id, i.name, i.price_cents, i.clover_item_id, i.price_type,
           (i.available and not i.hidden) as sellable
      into v_item_row
    from public.catalog_items i
    where i.store_id = p_store_id
      and i.clover_item_id = (v_item ->> 'clover_item_id')
      and i.deleted_at is null;

    if not found then
      raise exception 'item_not_found:%', (v_item ->> 'clover_item_id') using errcode = '22023';
    end if;
    if not v_item_row.sellable then
      raise exception 'item_unavailable:%', v_item_row.name using errcode = '22023';
    end if;
    -- NUEVO RESPECTO A LA 0008, y lo trae la 0017: un item de precio
    -- VARIABLE o PER_UNIT no tiene precio hasta el mostrador. Dejarlo
    -- pedir seria cobrar 0 por algo que cuesta dinero.
    if v_item_row.price_type <> 'FIXED' then
      raise exception 'item_not_orderable:%', v_item_row.name using errcode = '22023';
    end if;

    v_unit_cents := v_item_row.price_cents;

    insert into public.order_items (
      order_id, clover_item_id, name_snapshot, unit_price_snapshot_cents,
      quantity, line_total_cents, note, sort_order
    )
    values (
      v_order_id, v_item_row.clover_item_id, v_item_row.name, v_item_row.price_cents,
      v_quantity, 0, nullif(btrim(coalesce(v_item ->> 'note', '')), ''), v_sort
    )
    returning id into v_order_item_id;

    v_sort := v_sort + 1;
    v_mods := '[]'::jsonb;

    for v_mod_id in
      select jsonb_array_elements_text(coalesce(v_item -> 'modifiers', '[]'::jsonb))
    loop
      select m.clover_modifier_id, m.name, m.price_cents, m.available
        into v_mod_row
      from public.catalog_modifiers m
      join public.catalog_item_modifier_groups img
        on img.modifier_group_id = m.modifier_group_id
      where m.store_id = p_store_id
        and m.clover_modifier_id = v_mod_id
        and m.deleted_at is null
        -- El modificador tiene que pertenecer a un grupo de ESTE
        -- producto: si no, la orden no imprime bien (variable 2).
        and img.item_id = v_item_row.id;

      if not found then
        raise exception 'modifier_not_for_item:%', v_mod_id using errcode = '22023';
      end if;
      if not v_mod_row.available then
        raise exception 'modifier_unavailable:%', v_mod_row.name using errcode = '22023';
      end if;

      insert into public.order_item_modifiers (
        order_item_id, clover_modifier_id, name_snapshot, price_snapshot_cents
      )
      values (v_order_item_id, v_mod_row.clover_modifier_id, v_mod_row.name, v_mod_row.price_cents);

      v_unit_cents := v_unit_cents + v_mod_row.price_cents;
      v_mods := v_mods || jsonb_build_object('clover_modifier_id', v_mod_row.clover_modifier_id);
    end loop;

    update public.order_items
       set unit_price_snapshot_cents = v_unit_cents,
           line_total_cents = v_unit_cents * v_quantity
     where id = v_order_item_id;

    v_subtotal := v_subtotal + v_unit_cents * v_quantity;

    v_lineas := v_lineas || jsonb_build_object(
      'clover_item_id',   v_item_row.clover_item_id,
      'nombre',           v_item_row.name,
      'cantidad',         v_quantity,
      'unit_price_cents', v_unit_cents,
      'nota',             nullif(btrim(coalesce(v_item ->> 'note', '')), ''),
      'modificadores',    v_mods
    );
  end loop;

  -- Subtotal SOLO. Impuestos y total los pone `atomic_order/checkouts`;
  -- escribir un total ahora seria inventarlo.
  update public.orders set subtotal_cents = v_subtotal where id = v_order_id;

  return app.checkout_attempt_snapshot(v_attempt_id);
end;
$$;

comment on function app.open_checkout_attempt(uuid, uuid, text, timestamptz, boolean, text, jsonb) is
  'Abre —o recupera— un intento de checkout y devuelve TODO lo que la Edge '
  'Function necesita, con las lineas ya releidas del catalogo. Es la mitad '
  'de create_pickup_order (0008) que se queda en la base: la validacion. '
  'La otra mitad, la secuencia con Clover, no cabia en un RPC.';


-- ---------------------------------------------------------------------
-- 5. LA FOTO DEL INTENTO
--
-- Lo que la Edge Function lee para saber donde esta y con que seguir. Se
-- separa de `open_checkout_attempt` porque un reintento la necesita sin
-- volver a validar nada: el carrito ya se valido cuando se abrio el
-- intento, y revalidarlo podria rechazar un pedido YA COBRADO porque
-- mientras tanto se agoto un producto.
-- ---------------------------------------------------------------------
create or replace function app.checkout_attempt_snapshot(p_attempt_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select jsonb_build_object(
    'attempt_id',      a.id,
    'idempotency_key', a.idempotency_key,
    'state',           a.state,
    'order_id',        o.id,
    'store_id',        o.store_id,
    'merchant_id',     c.merchant_id,
    'environment',     c.environment,
    'order_number',    o.order_number,
    'pickup_code',     o.pickup_code,
    'pickup_at',       o.pickup_at,
    'subtotal_cents',  o.subtotal_cents,
    'total_cents',     o.total_cents,
    'status',          o.status,
    'clover_order_id', o.clover_order_id,
    'lineas',          coalesce(
      (select jsonb_agg(jsonb_build_object(
                'clover_item_id',   oi.clover_item_id,
                'nombre',           oi.name_snapshot,
                'cantidad',         oi.quantity,
                'unit_price_cents', oi.unit_price_snapshot_cents,
                'nota',             oi.note,
                'modificadores',    coalesce(
                  (select jsonb_agg(jsonb_build_object('clover_modifier_id', m.clover_modifier_id)
                          order by m.id)
                     from public.order_item_modifiers m
                    where m.order_item_id = oi.id),
                  '[]'::jsonb)
              ) order by oi.sort_order)
         from public.order_items oi
        where oi.order_id = o.id),
      '[]'::jsonb)
  )
  from public.checkout_attempts a
  join public.orders o on o.id = a.order_id
  left join public.clover_connections c on c.store_id = a.store_id
  where a.id = p_attempt_id;
$$;


-- ---------------------------------------------------------------------
-- 6. LA VISTA DE GUARDIA: intentos atascados
--
-- La fila que importa es la de `voiding`: el cobro fallo, hay una orden
-- SIN PAGAR viva en el POS del merchant, y la anulacion tambien fallo.
-- Eso es basura que el restaurante ve en su caja y que nadie va a pagar.
--
-- Las demas son intentos que se quedaron a medias. Un `order_created` de
-- hace media hora no es normal: o el cliente cerro la app a mitad —y
-- entonces hay un pedido nuestro sin cobrar— o algo se corto.
--
-- Cero filas = no hay nada que hacer.
-- ---------------------------------------------------------------------
create or replace view public.checkouts_atascados as
select
  a.id            as attempt_id,
  a.state,
  a.created_at,
  a.updated_at,
  a.error,
  o.id            as order_id,
  o.store_id,
  o.order_number,
  o.status        as order_status,
  -- El id de la orden EN CLOVER: es lo que hay que buscar en el POS para
  -- anularla a mano.
  o.clover_order_id,
  o.total_cents,
  (a.state = 'voiding' and o.clover_order_id is not null) as orden_viva_en_clover,
  extract(epoch from (now() - a.updated_at)) / 60 as minutos_atascado
from public.checkout_attempts a
join public.orders o on o.id = a.order_id
where a.state not in ('done', 'failed')
  and a.updated_at < now() - interval '15 minutes'
order by (a.state = 'voiding') desc, a.updated_at asc;

alter view public.checkouts_atascados set (security_invoker = on);

comment on view public.checkouts_atascados is
  'Intentos de checkout que llevan mas de 15 minutos sin moverse. La fila '
  'que urge es la de state = voiding con clover_order_id: el cobro fallo, '
  'la anulacion tambien, y hay una orden sin pagar viva en el POS del '
  'merchant. Cero filas = no hay nada que hacer.';

-- En Supabase una vista nueva NACE CONCEDIDA a anon y authenticated por
-- los default privileges del rol que aplica migraciones. Esta enseña
-- pedidos de todos los clientes: se cierra.
revoke all on public.checkouts_atascados from anon, authenticated;


-- ---------------------------------------------------------------------
-- 7. SE CIERRA LA PUERTA VIEJA
--
-- `create_pickup_order` era explicitamente temporal y su propio comentario
-- decia cuando se retiraba. Mientras siga con `execute` para
-- `authenticated`, un cliente puede crear pedidos SALTANDOSE CLOVER: sin
-- totales reales, sin orden en el POS y sin cobro. Dejar las dos puertas
-- abiertas es dejar la que se salta el dinero.
--
-- SE QUITA EL GRANT, NO LA FUNCION. El cuerpo se queda para poder volver
-- atras sin ir a buscarlo a git si la Edge Function diera guerra el primer
-- dia; sin el grant no la alcanza nadie salvo `service_role`. El
-- `drop function` va en una migracion posterior, cuando el flujo lleve
-- semanas en pie.
-- ---------------------------------------------------------------------
revoke execute on function
  public.create_pickup_order(uuid, text, timestamptz, boolean, text, jsonb)
  from authenticated, anon, public;

comment on function public.create_pickup_order is
  'RETIRADA EN LA 0018. Ya no tiene grant: el checkout pasa por la Edge '
  'Function /checkout, que crea el pedido y cobra bajo la misma '
  'idempotencia. El cuerpo se conserva para poder volver atras; el drop va '
  'en una migracion posterior. NO volver a concederla: mientras este '
  'abierta, es una via para crear pedidos saltandose Clover.';

-- Lo nuevo tampoco se concede a nadie: la Edge Function corre con
-- `service_role`. Un grant a `authenticated` aqui devolveria al cliente la
-- capacidad de abrir intentos por su cuenta, que es justo lo que se acaba
-- de cerrar.
revoke execute on function
  app.open_checkout_attempt(uuid, uuid, text, timestamptz, boolean, text, jsonb) from public;
revoke execute on function app.checkout_attempt_snapshot(uuid) from public;

$m0018$;
  insert into supabase_migrations.schema_migrations (version, name) values ('0018', 'checkout_edge');
  raise notice 'Migración 0018 aplicada.';
end
$entrega$;

-- 0019_sin_absorb.sql
do $entrega$
begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '0019') then
    raise notice 'Migración 0019 ya aplicada: se salta.';
    return;
  end if;
  execute $m0019$
-- =====================================================================
-- 0019_sin_absorb.sql
-- Se retira la politica `absorb` del recargo por tarjeta.
--
-- ─────────────────────────────────────────────────────────────────────
-- POR QUE SE QUITA: PROMETIA ALGO QUE NO PODIA CUMPLIR
-- ─────────────────────────────────────────────────────────────────────
--
-- `absorb` significaba "el restaurante asume el recargo, asi que al
-- cliente no se le enseña nada". La segunda mitad se cumplia —la app
-- callaba— y la primera no.
--
-- EL HALLAZGO QUE LO CIERRA, y es concreto: EL ENDPOINT DE COBRO NO TIENE
-- CAMPO PARA RENUNCIAR AL RECARGO. `POST /v1/orders/{id}/pay` acepta
-- `source`, `amount`, `tip_amount` y `currency`, y nada mas. El recargo lo
-- aplica Clover segun la configuracion del merchant y el BIN de la
-- tarjeta, y llega despues en `additionalCharges` del pago. No hay
-- parametro que mandar ni cabecera que poner: no es que no lo hubieramos
-- implementado, es que no se puede pedir.
--
-- Asi que una sucursal con `absorb` y recargo activo no absorbia nada:
--
--   el cliente pagaba el recargo igual...
--   ...y ademas EN SILENCIO, porque `absorb` suprimia el aviso.
--
-- Dos fallos a la vez, y el segundo es el caro:
--
--   1. faltaba un aviso obligatorio. En Nueva Jersey (P.L. 2023, c.146)
--      eso es LA infraccion, no un detalle de redaccion;
--   2. el restaurante se equivocaba sobre su propia economia, y en la
--      direccion que le hacia creer que estaba siendo generoso: creia
--      estar pagando un coste que pagaba su cliente.
--
-- Que el cliente pague el recargo en silencio es exactamente lo que el
-- aviso existe para evitar. Una politica que promete absorber y no
-- absorbe es peor que no tenerla.
--
-- LA UNICA FORMA REAL DE ABSORBER sigue existiendo y no es nuestra: que
-- el restaurante APAGUE el recargo en su cuenta de Clover. Entonces
-- `surcharge_rate` llega a 0 y no hace falta ninguna politica.
--
-- QUEDAN DOS: `show` (por defecto) y `block`.
--
-- MIGRACION NUEVA. Las 0001 a 0018 no se editan.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. LAS FILAS QUE YA ESTABAN EN `absorb` PASAN A `show`
--
-- Antes de tocar el tipo, porque despues el valor no existe.
--
-- A `show` y no a `block`: `block` dejaria esas sucursales sin vender por
-- un cambio nuestro, y el problema de `absorb` no era que vendieran — era
-- que callaban. `show` divulga, que es justo lo que faltaba.
--
-- CONSECUENCIA VISIBLE, y es la que se busca: a partir de aqui esas
-- sucursales ENSEÑAN el aviso de recargo en la app. Si alguien eligio
-- `absorb` creyendo que su local pagaba la diferencia, se va a encontrar
-- con que el cliente ve un aviso que antes no veia. Esa es la correccion,
-- no un efecto secundario.
-- ---------------------------------------------------------------------
do $$
declare
  v_afectadas int;
begin
  update public.stores set surcharge_policy = 'show'
   where surcharge_policy = 'absorb';
  get diagnostics v_afectadas = row_count;

  if v_afectadas > 0 then
    raise notice
      '% sucursal(es) pasaron de absorb a show. A partir de ahora ENSEÑAN el '
      'aviso de recargo en la app. Conviene avisar al restaurante: puede que '
      'creyera estar asumiendo un coste que en realidad pagaba su cliente.',
      v_afectadas;
  end if;
end $$;


-- ---------------------------------------------------------------------
-- 2. EL ENUM PIERDE EL VALOR
--
-- Postgres NO sabe quitar un valor de un enum: no hay `alter type ... drop
-- value`. El camino es cambiar de tipo, y son cinco pasos que hay que dar
-- en este orden.
--
-- El `using ...::text::...` pasa por texto a proposito: sin ese rodeo,
-- Postgres no sabe convertir entre dos tipos enum distintos aunque
-- compartan etiquetas. Y funciona porque el paso 1 ya dejo la tabla sin
-- ningun `absorb` — si quedara uno, esto fallaria aqui, que es donde hay
-- que fallar.
--
-- El `default` se quita y se vuelve a poner porque un default del tipo
-- viejo impide cambiar la columna de tipo.
-- ---------------------------------------------------------------------
alter type app.surcharge_policy rename to surcharge_policy_con_absorb;

create type app.surcharge_policy as enum (
  -- Mostrar el recargo al cliente antes de pagar. POR DEFECTO, y ahora
  -- ademas es la unica que deja vender: la otra no activa la sucursal.
  'show',
  -- No activar la sucursal mientras tenga recargo.
  'block'
);

alter table public.stores
  alter column surcharge_policy drop default;

alter table public.stores
  alter column surcharge_policy type app.surcharge_policy
    using surcharge_policy::text::app.surcharge_policy;

alter table public.stores
  alter column surcharge_policy set default 'show';

drop type app.surcharge_policy_con_absorb;

comment on column public.stores.surcharge_policy is
  'Que hacer si el merchant cobra recargo por tarjeta: mostrarlo al '
  'cliente (show, por defecto) o no activar la sucursal (block). Habia una '
  'tercera, absorb, y la 0019 la quito: prometia que el recargo lo asumia '
  'el restaurante y no podia cumplirlo — el endpoint de cobro de Clover no '
  'tiene campo para renunciar al recargo, asi que el cliente lo pagaba '
  'igual y sin aviso. El aviso al super admin sale con las dos.';


-- ---------------------------------------------------------------------
-- 3. LA CASILLA DEL CHECKLIST VUELVE A `false` PARA LAS AFECTADAS
--
-- Quien eligio `absorb` tomo una decision que ya no existe. Que vuelva a
-- mirarlo no es burocracia: es que su local puede estar cobrando un
-- recargo que el creia estar pagando.
--
-- NO DEJA A NADIE SIN SERVICIO, y conviene saber por que: el trigger
-- `trg_stores_activation` (0001) salta en `insert or update of status`, y
-- esta migracion no cambia el status de nadie. Una sucursal `active` sigue
-- activa y vendiendo; lo que cambia es que la proxima vez que alguien
-- toque su estado, tendra que repasar el recargo. Es la misma mecanica —y
-- la misma promesa— que uso la 0011 al crear la casilla.
--
-- Solo a las afectadas: marcar a todo el mundo convertiria un aviso en
-- ruido, y un checklist que siempre tiene casillas rojas deja de mirarse.
-- ---------------------------------------------------------------------
update public.stores
   set setup_checklist = setup_checklist || jsonb_build_object('surcharge_reviewed', false)
 where surcharge_rate > 0
   and setup_checklist ->> 'surcharge_reviewed' = 'true'
   -- La huella de haber estado en `absorb`: tiene recargo, alguien lo
   -- reviso, y sin embargo la politica es la de por defecto. Es lo mas
   -- cerca que se puede estar de "vengo de absorb" despues del paso 1.
   and surcharge_policy = 'show';


-- ---------------------------------------------------------------------
-- 4. LO QUE NO SE ARREGLA AQUI, Y HAY QUE DECIDIR ANTES DE PRODUCCION
--
-- CLOVER-PENDING (DECISION DE PRODUCTO, no de codigo ni de Clover):
-- cuando hay recargo, EL NUMERO QUE ENSEÑA LA APP NUNCA SERA EL QUE SE
-- COBRA.
--
-- El recargo cae solo sobre tarjetas de credito con BIN elegible: no
-- sobre debito, no sobre efectivo, y las reglas las ponen las redes de
-- tarjetas. Asi que el importe exacto no existe hasta conocer la tarjeta,
-- y "3,5 %" —que es divulgacion valida segun la FAQ de NJ— sigue siendo
-- un numero distinto del cobro.
--
-- Lo que hay que decidir, y no es una linea de codigo: como se le dice
-- eso al cliente sin que parezca que se le esta ocultando algo. Hoy la
-- app enseña el porcentaje y un subtotal, y dice que la caja calcula el
-- total. Falta la frase que explique que el recargo puede no aplicarse a
-- su tarjeta.
--
-- CUANDO: antes de abrir la primera sucursal con recargo activo. No
-- bloquea el sandbox, donde el recargo ni se puede encender.
-- ---------------------------------------------------------------------

$m0019$;
  insert into supabase_migrations.schema_migrations (version, name) values ('0019', 'sin_absorb');
  raise notice 'Migración 0019 aplicada.';
end
$entrega$;

-- 0020_negocio_sin_clover.sql
do $entrega$
begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '0020') then
    raise notice 'Migración 0020 ya aplicada: se salta.';
    return;
  end if;
  execute $m0020$
-- =====================================================================
-- 0020_negocio_sin_clover.sql
-- Un negocio que NO usa Clover: VIVA Jugos y Café (México).
--
-- QUE CAMBIA
-- Hasta la 0019 el catalogo era un espejo de Clover que nadie editaba a
-- mano, el pedido se creaba en el POS y el cobro pasaba por Clover. Este
-- negocio no tiene POS, asi que:
--
--   1. el catalogo es PROPIO: lo escribe el dueño desde el panel /admin
--      (`stores.catalog_source = 'own'`);
--   2. hay un rol de DUEÑO/EMPLEADO por restaurante
--      (`restaurant_members`). Hasta ahora solo existia el super admin de
--      la plataforma, que ve todos los negocios;
--   3. se paga EN MOSTRADOR (`stores.payments_mode = 'counter'`): el
--      pedido nace confirmado y el negocio cobra al entregar, en
--      efectivo, tarjeta o transferencia;
--   4. la sucursal tiene MONEDA propia (`stores.currency`).
--
-- LO QUE NO CAMBIA
-- Las sucursales con Clover siguen exactamente igual. Todo lo nuevo se
-- abre SOLO para sucursales con `catalog_source = 'own'` y sin ninguna
-- conexion de Clover. La regla de la 0018 —ningun cliente crea pedidos
-- saltandose Clover— sigue en pie para quien tiene Clover.
--
-- MIGRACION NUEVA. Las 0001 a 0019 estan aplicadas y no se tocan.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. LA SUCURSAL DICE DE DONDE SALE SU CATALOGO, COMO COBRA Y EN QUE MONEDA
-- ---------------------------------------------------------------------
alter table public.stores
  add column if not exists catalog_source text not null default 'clover'
    check (catalog_source in ('clover', 'own')),
  add column if not exists currency char(3) not null default 'USD'
    check (currency ~ '^[A-Z]{3}$');

comment on column public.stores.catalog_source is
  'clover = el catalogo es un espejo de Clover y solo lo escribe la '
  'sincronizacion. own = el negocio no tiene Clover: el catalogo lo '
  'escribe el dueño desde el panel. Ver 0020.';

-- `counter` = se paga en el mostrador al recoger.
alter table public.stores drop constraint if exists stores_payments_mode_check;
alter table public.stores
  add constraint stores_payments_mode_check
    check (payments_mode in ('simulated', 'live', 'counter'));

comment on column public.stores.payments_mode is
  'simulated = cobro simulado en la app (sin dinero). live = solo pagos '
  'confirmados por el proveedor. counter = se paga en el mostrador al '
  'recoger; el pedido nace confirmado (0020).';

-- Los ids "de Clover" del catalogo propio se generan solos. Las columnas
-- se llaman clover_* por historia; para un catalogo propio son solo un
-- identificador estable que viaja en el carrito y en el pedido.
alter table public.catalog_categories
  alter column clover_category_id set default ('own-' || gen_random_uuid()::text);
alter table public.catalog_items
  alter column clover_item_id set default ('own-' || gen_random_uuid()::text);
alter table public.catalog_modifier_groups
  alter column clover_group_id set default ('own-' || gen_random_uuid()::text);
alter table public.catalog_modifiers
  alter column clover_modifier_id set default ('own-' || gen_random_uuid()::text);

-- El checklist de alta de la 0001 es todo de Clover (conectar, imprimir,
-- sincronizar). Para un negocio sin Clover no significa nada y bloquearia
-- activar la sucursal para siempre.
create or replace function app.enforce_store_activation()
returns trigger
language plpgsql
as $$
declare
  incomplete int;
begin
  if new.status = 'active' and new.catalog_source = 'clover' then
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


-- ---------------------------------------------------------------------
-- 2. DUEÑOS Y EMPLEADOS
--
-- owner = todo lo de su negocio (menu, horarios, marca, pedidos).
-- staff = solo pedidos: verlos y moverlos de estado.
--
-- Se dan de alta por SQL o desde el panel del super admin, nunca solos:
-- no hay policy de insert para `authenticated`. Un usuario que se
-- registra en la app es un CLIENTE y no puede hacerse dueño de nada.
-- ---------------------------------------------------------------------
create table if not exists public.restaurant_members (
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  role          text not null default 'owner' check (role in ('owner', 'staff')),
  created_at    timestamptz not null default now(),
  primary key (restaurant_id, user_id)
);

create index if not exists idx_restaurant_members_user on public.restaurant_members(user_id);

alter table public.restaurant_members enable row level security;

comment on table public.restaurant_members is
  'Quien administra cada negocio. owner = todo; staff = solo pedidos. '
  'El alta la hace la plataforma, nunca el propio usuario (0020).';

-- SECURITY DEFINER por lo mismo que `app.is_platform_admin`: las
-- policies de otras tablas la llaman y no debe chocar con la RLS de
-- restaurant_members.
create or replace function app.member_role(p_restaurant_id uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select m.role
  from public.restaurant_members m
  where m.restaurant_id = p_restaurant_id
    and m.user_id = auth.uid();
$$;

-- ¿Puede el usuario actual administrar ESTE negocio (rol owner)?
create or replace function app.owns_restaurant(p_restaurant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, app, pg_catalog
as $$
  select app.member_role(p_restaurant_id) = 'owner' or app.is_platform_admin();
$$;

-- ¿Puede ver y mover los pedidos de este negocio (owner o staff)?
create or replace function app.works_at_restaurant(p_restaurant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, app, pg_catalog
as $$
  select app.member_role(p_restaurant_id) is not null or app.is_platform_admin();
$$;

-- ¿Puede el usuario actual administrar ESTA sucursal?
create or replace function app.owns_store(p_store_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, app, pg_catalog
as $$
  select exists (
    select 1 from public.stores s
    where s.id = p_store_id and app.owns_restaurant(s.restaurant_id)
  );
$$;

-- ¿Y editar su CATALOGO? Solo si es propio: el de Clover lo escribe la
-- sincronizacion y nadie mas, ni siquiera el dueño.
create or replace function app.owns_own_catalog(p_store_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, app, pg_catalog
as $$
  select exists (
    select 1 from public.stores s
    where s.id = p_store_id
      and s.catalog_source = 'own'
      and app.owns_restaurant(s.restaurant_id)
  );
$$;

create policy restaurant_members_self_read on public.restaurant_members
  for select to authenticated
  using (user_id = auth.uid() or app.owns_restaurant(restaurant_id));

grant select on public.restaurant_members to authenticated;
grant execute on function app.member_role(uuid)        to authenticated;
grant execute on function app.owns_restaurant(uuid)    to authenticated;
grant execute on function app.works_at_restaurant(uuid) to authenticated;
grant execute on function app.owns_store(uuid)         to authenticated;
grant execute on function app.owns_own_catalog(uuid)   to authenticated;


-- ---------------------------------------------------------------------
-- 3. LO QUE EL DUEÑO PUEDE EDITAR
--
-- Policies NUEVAS al lado de las del super admin (0004); en Postgres las
-- policies permisivas se suman. Cada una mira el negocio de la fila, asi
-- que un dueño nunca alcanza a otro negocio.
-- ---------------------------------------------------------------------

-- Su negocio y su sucursal: solo actualizar. Crear o borrar negocios es
-- cosa de la plataforma.
create policy restaurants_owner_update on public.restaurants
  for update to authenticated
  using (app.owns_restaurant(id)) with check (app.owns_restaurant(id));

create policy restaurants_member_read on public.restaurants
  for select to authenticated
  using (app.works_at_restaurant(id));

create policy stores_owner_update on public.stores
  for update to authenticated
  using (app.owns_restaurant(restaurant_id)) with check (app.owns_restaurant(restaurant_id));

-- Que el dueño vea su sucursal aunque este en borrador o pausada.
create policy stores_member_read on public.stores
  for select to authenticated
  using (app.works_at_restaurant(restaurant_id));

-- El dueño no puede cambiarse a si mismo el modo de cobro, la fuente del
-- catalogo ni el checklist: eso decide si se cobra de verdad y si se
-- salta Clover. Columnas protegidas con un trigger porque los grants de
-- `stores` son de tabla (0006) y una policy no ve columnas.
create or replace function app.protect_store_platform_columns()
returns trigger
language plpgsql
security definer
set search_path = public, app, pg_catalog
as $$
begin
  if app.is_platform_admin() or auth.uid() is null then
    return new;  -- plataforma o service_role / migraciones
  end if;
  if new.payments_mode   is distinct from old.payments_mode
  or new.catalog_source  is distinct from old.catalog_source
  or new.restaurant_id   is distinct from old.restaurant_id
  or new.setup_checklist is distinct from old.setup_checklist
  or new.surcharge_policy is distinct from old.surcharge_policy
  or new.surcharge_rate  is distinct from old.surcharge_rate
  or new.deleted_at      is distinct from old.deleted_at then
    raise exception 'store_platform_column' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_stores_protect_platform on public.stores;
create trigger trg_stores_protect_platform
  before update on public.stores
  for each row execute function app.protect_store_platform_columns();

-- Lo mismo para el estado del negocio y la suscripcion.
create or replace function app.protect_restaurant_platform_columns()
returns trigger
language plpgsql
security definer
set search_path = public, app, pg_catalog
as $$
begin
  if app.is_platform_admin() or auth.uid() is null then
    return new;
  end if;
  if new.status              is distinct from old.status
  or new.slug                is distinct from old.slug
  or new.subscription_status is distinct from old.subscription_status
  or new.subscription_ends_at is distinct from old.subscription_ends_at then
    raise exception 'restaurant_platform_column' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_restaurants_protect_platform on public.restaurants;
create trigger trg_restaurants_protect_platform
  before update on public.restaurants
  for each row execute function app.protect_restaurant_platform_columns();

-- Horarios, cierres y configuracion de pickup.
create policy store_hours_owner_all on public.store_hours
  for all to authenticated
  using (app.owns_store(store_id)) with check (app.owns_store(store_id));

create policy pickup_config_owner_all on public.store_pickup_config
  for all to authenticated
  using (app.owns_store(store_id)) with check (app.owns_store(store_id));

create policy closures_owner_all on public.store_closures
  for all to authenticated
  using (app.owns_store(store_id)) with check (app.owns_store(store_id));

-- Marca: nombre, logo y colores.
create policy app_settings_owner_all on public.app_settings
  for all to authenticated
  using (app.owns_restaurant(restaurant_id)) with check (app.owns_restaurant(restaurant_id));

-- Fotos, descripcion, destacados, orden y "agotado" (overrides). Valen
-- tambien para sucursales con Clover: es lo unico que alli manda el
-- negocio sobre su menu.
create policy item_overrides_owner_all on public.app_item_overrides
  for all to authenticated
  using (app.owns_store(store_id)) with check (app.owns_store(store_id));

-- Catalogo: solo si es propio.
create policy catalog_categories_owner_all on public.catalog_categories
  for all to authenticated
  using (app.owns_own_catalog(store_id)) with check (app.owns_own_catalog(store_id));

create policy catalog_items_owner_all on public.catalog_items
  for all to authenticated
  using (app.owns_own_catalog(store_id)) with check (app.owns_own_catalog(store_id));

create policy catalog_mod_groups_owner_all on public.catalog_modifier_groups
  for all to authenticated
  using (app.owns_own_catalog(store_id)) with check (app.owns_own_catalog(store_id));

create policy catalog_modifiers_owner_all on public.catalog_modifiers
  for all to authenticated
  using (app.owns_own_catalog(store_id)) with check (app.owns_own_catalog(store_id));

create policy catalog_item_mod_groups_owner_all on public.catalog_item_modifier_groups
  for all to authenticated
  using (exists (
    select 1 from public.catalog_items i
    where i.id = catalog_item_modifier_groups.item_id and app.owns_own_catalog(i.store_id)
  ))
  with check (exists (
    select 1 from public.catalog_items i
    where i.id = catalog_item_modifier_groups.item_id and app.owns_own_catalog(i.store_id)
  ));

-- El dueño ve TODO su catalogo, incluidos productos borrados o de una
-- sucursal en borrador: la lectura publica de la 0004 solo ensena lo que
-- ve el cliente.
create policy catalog_categories_owner_read on public.catalog_categories
  for select to authenticated using (app.owns_store(store_id));
create policy catalog_items_owner_read on public.catalog_items
  for select to authenticated using (app.owns_store(store_id));

grant insert, update, delete on
  public.catalog_categories,
  public.catalog_items,
  public.catalog_modifier_groups,
  public.catalog_modifiers,
  public.catalog_item_modifier_groups
to authenticated;

-- Promociones y recompensas del programa de lealtad.
create policy promotions_owner_all on public.promotions
  for all to authenticated
  using (app.owns_restaurant(tenant_id)) with check (app.owns_restaurant(tenant_id));


-- ---------------------------------------------------------------------
-- 4. PEDIDOS: EL NEGOCIO LOS VE TODOS, PERO NO LOS ESCRIBE A MANO
--
-- Lectura por policy. El cambio de estado va por `set_order_status`, que
-- valida la transicion: un update libre dejaria poner un total, borrar un
-- pedido o "completar" uno cancelado.
-- ---------------------------------------------------------------------
create policy orders_member_read on public.orders
  for select to authenticated
  using (app.works_at_restaurant(tenant_id));

create policy order_items_member_read on public.order_items
  for select to authenticated
  using (exists (
    select 1 from public.orders o
    where o.id = order_items.order_id and app.works_at_restaurant(o.tenant_id)
  ));

create policy order_item_mods_member_read on public.order_item_modifiers
  for select to authenticated
  using (exists (
    select 1 from public.order_items oi
    join public.orders o on o.id = oi.order_id
    where oi.id = order_item_modifiers.order_item_id and app.works_at_restaurant(o.tenant_id)
  ));

alter table public.orders
  add column if not exists payment_method text
    check (payment_method is null or payment_method in ('counter', 'online')),
  add column if not exists customer_name text;

comment on column public.orders.payment_method is
  'counter = se paga en el mostrador al recoger. online = cobrado en la '
  'app. null = pedidos anteriores a la 0020 (Clover o simulado).';


-- ---------------------------------------------------------------------
-- 5. PEDIR Y PAGAR EN EL MOSTRADOR
--
-- Envuelve `create_pickup_order` (0008), que tiene TODA la validacion:
-- precios releidos de la base, disponibilidad, modificadores del
-- producto, horario, cierres y capacidad. No se duplica nada de eso.
--
-- La 0018 le quito el grant a `create_pickup_order` porque para una
-- sucursal con Clover crear pedidos sin el POS es saltarse el cobro. Aqui
-- se vuelve a abrir el camino SOLO para sucursales que no tienen POS ni
-- cobran en linea: catalogo propio, cobro en mostrador y ninguna conexion
-- de Clover. Las tres condiciones, juntas, en el servidor.
-- ---------------------------------------------------------------------
create or replace function public.place_counter_order(
  p_store_id        uuid,
  p_idempotency_key text,
  p_pickup_at       timestamptz,
  p_is_asap         boolean,
  p_customer_note   text,
  p_items           jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, app, pg_catalog
as $$
declare
  v_store  public.stores%rowtype;
  v_result jsonb;
  v_order  uuid;
  v_name   text;
begin
  select * into v_store from public.stores where id = p_store_id and deleted_at is null;
  if not found then
    raise exception 'store_not_available' using errcode = '22023';
  end if;

  if v_store.catalog_source <> 'own'
     or v_store.payments_mode <> 'counter'
     or exists (
       select 1 from public.clover_connections c
       where c.store_id = p_store_id and c.status <> 'not_connected'
     ) then
    raise exception 'counter_orders_not_allowed' using errcode = '42501';
  end if;

  v_result := public.create_pickup_order(
    p_store_id, p_idempotency_key, p_pickup_at, p_is_asap, p_customer_note, p_items
  );
  v_order := (v_result ->> 'order_id')::uuid;

  select nullif(btrim(concat_ws(' ', p.first_name, p.last_name)), '')
    into v_name
  from public.profiles p where p.id = auth.uid();

  -- Sin cobro en linea no hay nada que esperar: el pedido entra directo
  -- a la cola del negocio. El total es el subtotal porque en este modo no
  -- hay impuestos aparte ni propina en la app (los precios ya incluyen
  -- IVA, como se acostumbra en Mexico).
  update public.orders
     set status         = 'confirmed',
         payment_method = 'counter',
         currency       = v_store.currency,
         total_cents    = subtotal_cents,
         customer_name  = coalesce(v_name, customer_name)
   where id = v_order
     and status = 'payment_pending';

  select v_result || jsonb_build_object(
           'status', o.status,
           'payment_method', o.payment_method,
           'total_cents', o.total_cents,
           'currency', o.currency
         )
    into v_result
  from public.orders o where o.id = v_order;

  update public.checkout_attempts
     set result = v_result
   where idempotency_key = p_idempotency_key;

  return v_result;
end;
$$;

comment on function public.place_counter_order is
  'Pedido que se paga en el mostrador. Solo para sucursales con catalogo '
  'propio, payments_mode = counter y sin Clover. Reusa toda la validacion '
  'de create_pickup_order y deja el pedido confirmado (0020).';

revoke execute on function
  public.place_counter_order(uuid, text, timestamptz, boolean, text, jsonb) from public, anon;
grant execute on function
  public.place_counter_order(uuid, text, timestamptz, boolean, text, jsonb) to authenticated;


-- ---------------------------------------------------------------------
-- 6. EL NEGOCIO MUEVE SUS PEDIDOS
--
--   confirmed -> preparing -> ready -> completed
--   cualquiera de esos -> canceled (con motivo)
--
-- No se puede volver atras ni tocar un pedido cerrado. La transicion se
-- valida aqui y no en el panel: el panel es solo uno de los clientes que
-- pueden llamar a esta funcion.
-- ---------------------------------------------------------------------
create or replace function app.order_transition_allowed(p_from app.order_status, p_to app.order_status)
returns boolean
language sql
immutable
as $$
  select case
    when p_to = 'canceled' then p_from in ('payment_pending', 'confirmed', 'preparing', 'ready')
    when p_from = 'confirmed' then p_to in ('preparing', 'ready', 'completed')
    when p_from = 'preparing' then p_to in ('ready', 'completed')
    when p_from = 'ready'     then p_to = 'completed'
    else false
  end;
$$;

create or replace function public.set_order_status(
  p_order_id uuid,
  p_status   text,
  p_reason   text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, app, pg_catalog
as $$
declare
  v_order public.orders%rowtype;
  v_to    app.order_status;
begin
  begin
    v_to := p_status::app.order_status;
  exception when invalid_text_representation then
    raise exception 'invalid_status:%', p_status using errcode = '22023';
  end;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found or not app.works_at_restaurant(v_order.tenant_id) then
    -- Mismo error para "no existe" y "no es tuyo": no se confirma a
    -- nadie que un pedido ajeno existe.
    raise exception 'order_not_found' using errcode = '42501';
  end if;

  if v_order.status = v_to then
    return jsonb_build_object('order_id', v_order.id, 'status', v_order.status);
  end if;

  -- Solo pedidos que el negocio cobra en mostrador. Los de Clover los
  -- mueve Clover (webhooks); moverlos aqui separaria las dos capas.
  if coalesce(v_order.payment_method, '') <> 'counter' then
    raise exception 'order_not_managed_here' using errcode = '42501';
  end if;

  if not app.order_transition_allowed(v_order.status, v_to) then
    raise exception 'transition_not_allowed:% -> %', v_order.status, v_to using errcode = '22023';
  end if;

  update public.orders
     set status = v_to,
         cancel_reason = case when v_to = 'canceled'
                              then nullif(btrim(coalesce(p_reason, '')), '')
                              else cancel_reason end
   where id = p_order_id;

  return jsonb_build_object('order_id', p_order_id, 'status', v_to);
end;
$$;

revoke execute on function public.set_order_status(uuid, text, text) from public, anon;
grant execute on function public.set_order_status(uuid, text, text) to authenticated;


-- ---------------------------------------------------------------------
-- 7. FOTOS: el dueño sube a la carpeta de SU sucursal o de SU marca
--
--   menu-images/{store_id}/...      fotos de producto
--   branding/{restaurant_id}/...    logo y banners
--
-- Mismo esquema de la 0005: si no hay `storage` (CI en Postgres puro) se
-- omite.
-- ---------------------------------------------------------------------
do $$
begin
  if to_regclass('storage.objects') is null then
    raise notice 'Esquema storage no disponible: se omite la parte de fotos de 0020.';
    return;
  end if;

  execute $p$
    create policy "owners manage their menu images" on storage.objects
      for all to authenticated
      using (
        bucket_id = 'menu-images'
        and exists (
          select 1 from public.stores s
          where s.id::text = (storage.foldername(name))[1]
            and app.owns_store(s.id)
        )
      )
      with check (
        bucket_id = 'menu-images'
        and exists (
          select 1 from public.stores s
          where s.id::text = (storage.foldername(name))[1]
            and app.owns_store(s.id)
        )
      )
  $p$;

  execute $p$
    create policy "owners manage their branding" on storage.objects
      for all to authenticated
      using (
        bucket_id = 'branding'
        and exists (
          select 1 from public.restaurants r
          where r.id::text = (storage.foldername(name))[1]
            and app.owns_restaurant(r.id)
        )
      )
      with check (
        bucket_id = 'branding'
        and exists (
          select 1 from public.restaurants r
          where r.id::text = (storage.foldername(name))[1]
            and app.owns_restaurant(r.id)
        )
      )
  $p$;
exception
  when duplicate_object then
    raise notice 'Policies de storage de 0020 ya existentes: se omiten.';
end;
$$;


-- ---------------------------------------------------------------------
-- 8. ALTA DE UN DUEÑO
--
-- Solo plataforma (service_role o super admin). Uso, en el SQL editor de
-- Supabase, DESPUES de que la persona se haya registrado en la app:
--
--   select app.grant_restaurant_role('dueño@correo.com', '<restaurant_id>', 'owner');
-- ---------------------------------------------------------------------
create or replace function app.grant_restaurant_role(
  p_email         text,
  p_restaurant_id uuid,
  p_role          text default 'owner'
)
returns text
language plpgsql
security definer
set search_path = public, app, pg_catalog
as $$
declare
  v_user uuid;
begin
  if auth.uid() is not null and not app.is_platform_admin() then
    raise exception 'platform_only' using errcode = '42501';
  end if;

  select id into v_user from auth.users where lower(email) = lower(btrim(p_email));
  if v_user is null then
    raise exception 'Ese correo no tiene cuenta. La persona tiene que registrarse primero en la app.';
  end if;

  insert into public.restaurant_members (restaurant_id, user_id, role)
  values (p_restaurant_id, v_user, p_role)
  on conflict (restaurant_id, user_id) do update set role = excluded.role;

  return format('%s ahora es %s del negocio %s', p_email, p_role, p_restaurant_id);
end;
$$;

revoke execute on function app.grant_restaurant_role(text, uuid, text) from public, anon, authenticated;

$m0020$;
  insert into supabase_migrations.schema_migrations (version, name) values ('0020', 'negocio_sin_clover');
  raise notice 'Migración 0020 aplicada.';
end
$entrega$;

-- 0021_lealtad_qr.sql
do $entrega$
begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '0021') then
    raise notice 'Migración 0021 ya aplicada: se salta.';
    return;
  end if;
  execute $m0021$
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

$m0021$;
  insert into supabase_migrations.schema_migrations (version, name) values ('0021', 'lealtad_qr');
  raise notice 'Migración 0021 aplicada.';
end
$entrega$;

-- 0022_historias.sql
do $entrega$
begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '0022') then
    raise notice 'Migración 0022 ya aplicada: se salta.';
    return;
  end if;
  execute $m0022$
-- =====================================================================
-- 0022_historias.sql
-- Historias tipo Instagram/TikTok: el negocio sube fotos o videos cortos
-- para ofrecer productos, y los clientes las ven en la pantalla de inicio.
--
-- Cada historia puede:
--   * ser imagen o video (`media_type`);
--   * llevar un texto corto (`caption`);
--   * apuntar a un producto del menu (`item_id`): el visor ofrece
--     "Pedir" y lleva al producto;
--   * caducar (`expires_at`, 24 h por defecto en el panel) o quedarse
--     fija como "destacada" (`expires_at` nulo);
--   * programarse (`starts_at` en el futuro).
--
-- Lectura publica solo de las vigentes de un negocio activo. Escritura
-- solo del dueño (0020). Los archivos van al bucket `stories`, en la
-- carpeta del negocio.
--
-- MIGRACION NUEVA. Las 0001 a 0021 estan aplicadas y no se tocan.
-- =====================================================================

create table if not exists public.stories (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  media_url     text not null check (media_url ~ '^https?://'),
  media_type    text not null default 'image' check (media_type in ('image', 'video')),
  caption       text check (caption is null or char_length(caption) <= 200),
  item_id       uuid references public.catalog_items(id) on delete set null,
  starts_at     timestamptz not null default now(),
  expires_at    timestamptz,
  sort_order    int not null default 0,
  created_at    timestamptz not null default now(),
  created_by    uuid references auth.users(id) on delete set null default auth.uid(),
  constraint stories_window check (expires_at is null or expires_at > starts_at)
);

create index if not exists idx_stories_restaurant
  on public.stories(restaurant_id, starts_at desc);

comment on table public.stories is
  'Historias del negocio (imagen o video). expires_at nulo = destacada, '
  'no caduca. Ver 0022.';

alter table public.stories enable row level security;

-- El cliente ve las vigentes de un negocio activo.
create policy stories_public_read on public.stories
  for select to anon, authenticated
  using (
    starts_at <= now()
    and (expires_at is null or expires_at > now())
    and exists (
      select 1 from public.restaurants r
      where r.id = stories.restaurant_id and r.status = 'active'
    )
  );

-- El dueño ve todas (tambien caducadas y programadas) y las administra.
create policy stories_owner_all on public.stories
  for all to authenticated
  using (app.owns_restaurant(restaurant_id))
  with check (app.owns_restaurant(restaurant_id));

grant select on public.stories to anon, authenticated;
grant insert, update, delete on public.stories to authenticated;


-- ---------------------------------------------------------------------
-- Archivos: bucket publico `stories`, carpeta por negocio.
--   stories/{restaurant_id}/{archivo}
-- 50 MB es el maximo por archivo del plan gratuito de Supabase; un video
-- vertical de 15-30 s en 720p queda muy por debajo.
-- ---------------------------------------------------------------------
do $$
begin
  if to_regclass('storage.buckets') is null then
    raise notice 'Esquema storage no disponible: se omite la parte de archivos de 0022.';
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('stories', 'stories', true, 52428800,
          array['image/jpeg', 'image/png', 'image/webp',
                'video/mp4', 'video/webm', 'video/quicktime'])
  on conflict (id) do nothing;

  execute $p$
    create policy "public read stories" on storage.objects
      for select to anon, authenticated
      using (bucket_id = 'stories')
  $p$;

  execute $p$
    create policy "owners manage their stories" on storage.objects
      for all to authenticated
      using (
        bucket_id = 'stories'
        and exists (
          select 1 from public.restaurants r
          where r.id::text = (storage.foldername(name))[1]
            and app.owns_restaurant(r.id)
        )
      )
      with check (
        bucket_id = 'stories'
        and exists (
          select 1 from public.restaurants r
          where r.id::text = (storage.foldername(name))[1]
            and app.owns_restaurant(r.id)
        )
      )
  $p$;
exception
  when duplicate_object then
    raise notice 'Policies de storage de 0022 ya existentes: se omiten.';
end;
$$;

$m0022$;
  insert into supabase_migrations.schema_migrations (version, name) values ('0022', 'historias');
  raise notice 'Migración 0022 aplicada.';
end
$entrega$;

-- 0023_estadisticas.sql
do $entrega$
begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '0023') then
    raise notice 'Migración 0023 ya aplicada: se salta.';
    return;
  end if;
  execute $m0023$
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

$m0023$;
  insert into supabase_migrations.schema_migrations (version, name) values ('0023', 'estadisticas');
  raise notice 'Migración 0023 aplicada.';
end
$entrega$;

-- 0024_formas_pago.sql
do $entrega$
begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '0024') then
    raise notice 'Migración 0024 ya aplicada: se salta.';
    return;
  end if;
  execute $m0024$
-- =====================================================================
-- 0024_formas_pago.sql
-- Formas de pago que el dueño prende y apaga.
--
-- EN MOSTRADOR (funcionan ya): efectivo, tarjeta en mostrador y
-- transferencia. El cliente dice al pedir como va a pagar; el cajero lo ve
-- en el pedido. No se cobra nada en la app.
--
-- EN LINEA (Mercado Pago, Stripe, Clip): el dueño puede dejarlas
-- prendidas, pero la app NO las ofrece al cliente hasta que la plataforma
-- conecte la cuenta del proveedor (`payment_provider_accounts`). Un boton
-- de "pagar en linea" que no cobra seria peor que no tenerlo.
--
-- MIGRACION NUEVA. Las 0001 a 0023 estan aplicadas y no se tocan.
-- =====================================================================

alter table public.stores
  add column if not exists payment_options jsonb not null default jsonb_build_object(
    'cash', true, 'card_counter', true, 'transfer', true,
    'mercadopago', false, 'stripe', false, 'clip', false
  ),
  add column if not exists transfer_info text
    check (transfer_info is null or char_length(transfer_info) <= 300);

comment on column public.stores.payment_options is
  'Formas de pago prendidas por el dueño. Las de linea solo se ofrecen si '
  'ademas hay cuenta conectada en payment_provider_accounts (0024).';
comment on column public.stores.transfer_info is
  'Datos para transferencia (banco, CLABE, titular) que ve el cliente al '
  'elegir pagar por transferencia.';

-- Cuentas de proveedores en linea. Solo la plataforma las escribe (al
-- guardar las llaves como secretos de Supabase). El cliente solo ve si
-- existen y estan activas, nunca un dato de la cuenta.
create table if not exists public.payment_provider_accounts (
  store_id   uuid not null references public.stores(id) on delete cascade,
  provider   text not null check (provider in ('mercadopago', 'stripe', 'clip')),
  status     text not null default 'pending' check (status in ('pending', 'active', 'disabled')),
  updated_at timestamptz not null default now(),
  primary key (store_id, provider)
);

alter table public.payment_provider_accounts enable row level security;

create policy provider_accounts_read on public.payment_provider_accounts
  for select to anon, authenticated using (true);

grant select on public.payment_provider_accounts to anon, authenticated;

-- Como dijo el cliente que pagara.
alter table public.orders
  add column if not exists pay_with text
    check (pay_with is null or pay_with in
      ('cash', 'card_counter', 'transfer', 'mercadopago', 'stripe', 'clip'));

comment on column public.orders.pay_with is
  'Forma de pago elegida por el cliente al pedir (0024).';


-- ---------------------------------------------------------------------
-- Pedido en mostrador eligiendo la forma de pago. Envuelve la version de
-- 6 parametros (0020), que sigue funcionando igual.
-- ---------------------------------------------------------------------
create or replace function public.place_counter_order(
  p_store_id        uuid,
  p_idempotency_key text,
  p_pickup_at       timestamptz,
  p_is_asap         boolean,
  p_customer_note   text,
  p_items           jsonb,
  p_pay_with        text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, app, pg_catalog
as $$
declare
  v_options jsonb;
  v_result  jsonb;
begin
  if p_pay_with not in ('cash', 'card_counter', 'transfer') then
    raise exception 'payment_method_not_available:%', p_pay_with using errcode = '22023';
  end if;

  select payment_options into v_options from public.stores where id = p_store_id;
  if coalesce((v_options ->> p_pay_with)::boolean, false) is not true then
    raise exception 'payment_method_not_available:%', p_pay_with using errcode = '22023';
  end if;

  v_result := public.place_counter_order(
    p_store_id, p_idempotency_key, p_pickup_at, p_is_asap, p_customer_note, p_items
  );

  update public.orders set pay_with = p_pay_with
   where id = (v_result ->> 'order_id')::uuid and pay_with is null;

  return v_result || jsonb_build_object('pay_with', p_pay_with);
end;
$$;

revoke execute on function
  public.place_counter_order(uuid, text, timestamptz, boolean, text, jsonb, text) from public, anon;
grant execute on function
  public.place_counter_order(uuid, text, timestamptz, boolean, text, jsonb, text) to authenticated;

$m0024$;
  insert into supabase_migrations.schema_migrations (version, name) values ('0024', 'formas_pago');
  raise notice 'Migración 0024 aplicada.';
end
$entrega$;

-- 0025_equipo.sql
do $entrega$
begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '0025') then
    raise notice 'Migración 0025 ya aplicada: se salta.';
    return;
  end if;
  execute $m0025$
-- =====================================================================
-- 0025_equipo.sql
-- El dueño administra a su equipo desde el panel: ver quien tiene
-- acceso, dar acceso de dueño o cajero a una cuenta y quitarlo.
--
-- Reglas, todas en el servidor:
--   * solo un dueño (o la plataforma) puede tocar el equipo;
--   * solo se puede dar acceso a una cuenta que ya existe (la persona se
--     registra primero en la app, como cliente);
--   * nadie se quita el acceso a si mismo ni deja el negocio sin dueño.
--
-- `app.grant_restaurant_role` (0020) sigue siendo la via de la
-- plataforma por SQL; esto es la via del dueño desde la app.
--
-- MIGRACION NUEVA. Las 0001 a 0024 estan aplicadas y no se tocan.
-- =====================================================================

create or replace function public.list_team(p_restaurant_id uuid)
returns table (user_id uuid, email text, name text, role text, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = public, app, pg_catalog
as $$
begin
  if not app.owns_restaurant(p_restaurant_id) then
    raise exception 'owner_only' using errcode = '42501';
  end if;
  return query
    select m.user_id, u.email::text,
           nullif(btrim(concat_ws(' ', p.first_name, p.last_name)), ''),
           m.role, m.created_at
      from public.restaurant_members m
      join auth.users u on u.id = m.user_id
      left join public.profiles p on p.id = m.user_id
     where m.restaurant_id = p_restaurant_id
     order by m.role, u.email;
end;
$$;

create or replace function public.add_team_member(p_restaurant_id uuid, p_email text, p_role text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, app, pg_catalog
as $$
declare
  v_user uuid;
begin
  if not app.owns_restaurant(p_restaurant_id) then
    raise exception 'owner_only' using errcode = '42501';
  end if;
  if p_role not in ('owner', 'staff') then
    raise exception 'invalid_role' using errcode = '22023';
  end if;

  select id into v_user from auth.users where lower(email) = lower(btrim(p_email));
  if v_user is null then
    raise exception 'account_not_found' using errcode = '22023';
  end if;

  insert into public.restaurant_members (restaurant_id, user_id, role)
  values (p_restaurant_id, v_user, p_role)
  on conflict (restaurant_id, user_id) do update set role = excluded.role;

  return jsonb_build_object('user_id', v_user, 'role', p_role);
end;
$$;

create or replace function public.remove_team_member(p_restaurant_id uuid, p_user_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public, app, pg_catalog
as $$
declare
  v_role text;
begin
  if not app.owns_restaurant(p_restaurant_id) then
    raise exception 'owner_only' using errcode = '42501';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'cannot_remove_self' using errcode = '22023';
  end if;

  select role into v_role from public.restaurant_members
   where restaurant_id = p_restaurant_id and user_id = p_user_id;
  if v_role is null then
    return;
  end if;
  if v_role = 'owner' and (
    select count(*) from public.restaurant_members
     where restaurant_id = p_restaurant_id and role = 'owner'
  ) <= 1 then
    raise exception 'last_owner' using errcode = '22023';
  end if;

  delete from public.restaurant_members
   where restaurant_id = p_restaurant_id and user_id = p_user_id;
end;
$$;

revoke execute on function public.list_team(uuid) from public, anon;
revoke execute on function public.add_team_member(uuid, text, text) from public, anon;
revoke execute on function public.remove_team_member(uuid, uuid) from public, anon;
grant execute on function public.list_team(uuid) to authenticated;
grant execute on function public.add_team_member(uuid, text, text) to authenticated;
grant execute on function public.remove_team_member(uuid, uuid) to authenticated;

$m0025$;
  insert into supabase_migrations.schema_migrations (version, name) values ('0025', 'equipo');
  raise notice 'Migración 0025 aplicada.';
end
$entrega$;

-- 0026_pago_liga_transferencia.sql
do $entrega$
begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '0026') then
    raise notice 'Migración 0026 ya aplicada: se salta.';
    return;
  end if;
  execute $m0026$
-- =====================================================================
-- 0026_pago_liga_transferencia.sql
-- Mercado Pago con liga de cobro y transferencia con datos completos.
--
-- MERCADO PAGO (modo "liga"): el dueño pega en el panel su liga de cobro
-- de Mercado Pago (link.mercadopago.com.mx/..., mpago.la/...). Con la
-- liga puesta y el interruptor prendido, el cliente puede elegir "Mercado
-- Pago" al pedir y ve un botón que abre esa liga con el monto a pagar.
-- No hace falta conectar llaves ni webhooks: el cajero ve el pago en su
-- app de Mercado Pago y marca el pedido como pagado. El cobro automático
-- por pedido (Checkout Pro + webhook) sigue siendo la fase 2 (0024).
--
-- TRANSFERENCIA: banco, titular y CLABE (validada con su dígito de
-- control) además de la nota libre de 0024. Solo se ofrece si hay CLABE
-- o nota.
--
-- PAGO RECIBIDO: los pedidos de transferencia y Mercado Pago quedan
-- "por confirmar" hasta que alguien del negocio marca que el dinero llegó.
--
-- MIGRACION NUEVA. Las 0001 a 0025 estan aplicadas y no se tocan.
-- =====================================================================

-- Dígito de control de una CLABE (18 dígitos, pesos 3-7-1).
create or replace function app.clabe_valid(p text)
returns boolean
language sql
immutable
as $$
  select p ~ '^[0-9]{18}$'
     and (10 - (
           (select sum(((substr(p, i, 1))::int * (array[3, 7, 1])[((i - 1) % 3) + 1]) % 10)
              from generate_series(1, 17) as i)
         ) % 10) % 10 = (substr(p, 18, 1))::int;
$$;

alter table public.stores
  add column if not exists mercadopago_link text
    check (mercadopago_link is null or (
      char_length(mercadopago_link) <= 300
      and mercadopago_link ~ '^https://(link\.mercadopago\.com\.mx|www\.mercadopago\.com\.mx|mpago\.la|mpago\.li)/'
    )),
  add column if not exists transfer_bank text
    check (transfer_bank is null or char_length(transfer_bank) between 2 and 60),
  add column if not exists transfer_holder text
    check (transfer_holder is null or char_length(transfer_holder) between 2 and 100),
  add column if not exists transfer_clabe text
    check (transfer_clabe is null or app.clabe_valid(transfer_clabe));

comment on column public.stores.mercadopago_link is
  'Liga de cobro de Mercado Pago del negocio (0026). La ve el cliente al '
  'elegir pagar con Mercado Pago.';
comment on column public.stores.transfer_clabe is
  'CLABE de 18 dígitos para transferencias (0026), validada.';

alter table public.orders
  add column if not exists paid_confirmed_at timestamptz,
  add column if not exists paid_confirmed_by uuid references auth.users(id) on delete set null;

comment on column public.orders.paid_confirmed_at is
  'Cuando alguien del negocio confirmó que llegó el pago de una '
  'transferencia o de Mercado Pago (0026).';

-- ---------------------------------------------------------------------
-- Formas de pago que de verdad se le pueden ofrecer al cliente.
-- ---------------------------------------------------------------------
create or replace function app.pay_with_available(p_store_id uuid, p_pay_with text)
returns boolean
language sql
stable
security definer
set search_path = public, app, pg_catalog
as $$
  select coalesce((
    select case p_pay_with
             when 'cash'         then coalesce((s.payment_options ->> 'cash')::boolean, false)
             when 'card_counter' then coalesce((s.payment_options ->> 'card_counter')::boolean, false)
             when 'transfer'     then coalesce((s.payment_options ->> 'transfer')::boolean, false)
                                      and (s.transfer_clabe is not null or s.transfer_info is not null)
             when 'mercadopago'  then coalesce((s.payment_options ->> 'mercadopago')::boolean, false)
                                      and s.mercadopago_link is not null
             else false
           end
      from public.stores s
     where s.id = p_store_id
  ), false);
$$;

-- Pedido eligiendo forma de pago (misma firma que 0024; ahora admite
-- Mercado Pago con liga y exige datos para transferencia).
create or replace function public.place_counter_order(
  p_store_id        uuid,
  p_idempotency_key text,
  p_pickup_at       timestamptz,
  p_is_asap         boolean,
  p_customer_note   text,
  p_items           jsonb,
  p_pay_with        text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, app, pg_catalog
as $$
declare
  v_result jsonb;
begin
  if p_pay_with is null or not app.pay_with_available(p_store_id, p_pay_with) then
    raise exception 'payment_method_not_available:%', p_pay_with using errcode = '22023';
  end if;

  v_result := public.place_counter_order(
    p_store_id, p_idempotency_key, p_pickup_at, p_is_asap, p_customer_note, p_items
  );

  update public.orders set pay_with = p_pay_with
   where id = (v_result ->> 'order_id')::uuid and pay_with is null;

  return v_result || jsonb_build_object('pay_with', p_pay_with);
end;
$$;

revoke execute on function
  public.place_counter_order(uuid, text, timestamptz, boolean, text, jsonb, text) from public, anon;
grant execute on function
  public.place_counter_order(uuid, text, timestamptz, boolean, text, jsonb, text) to authenticated;

-- ---------------------------------------------------------------------
-- El cajero o el dueño marca (o desmarca) que el pago llegó.
-- ---------------------------------------------------------------------
create or replace function public.set_order_paid(p_order_id uuid, p_paid boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, app, pg_catalog
as $$
declare
  v_order public.orders%rowtype;
  v_restaurant uuid;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'order_not_found' using errcode = 'P0002';
  end if;
  select restaurant_id into v_restaurant from public.stores where id = v_order.store_id;
  if not coalesce(app.works_at_restaurant(v_restaurant), false) then
    raise exception 'staff_only' using errcode = '42501';
  end if;

  update public.orders
     set paid_confirmed_at = case when p_paid then now() else null end,
         paid_confirmed_by = case when p_paid then auth.uid() else null end
   where id = p_order_id;

  return jsonb_build_object('order_id', p_order_id, 'paid', p_paid);
end;
$$;

revoke execute on function public.set_order_paid(uuid, boolean) from public, anon;
grant execute on function public.set_order_paid(uuid, boolean) to authenticated;

$m0026$;
  insert into supabase_migrations.schema_migrations (version, name) values ('0026', 'pago_liga_transferencia');
  raise notice 'Migración 0026 aplicada.';
end
$entrega$;

-- 0027_mpago_mx.sql
do $entrega$
begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '0027') then
    raise notice 'Migración 0027 ya aplicada: se salta.';
    return;
  end if;
  execute $m0027$
-- =====================================================================
-- 0027_mpago_mx.sql
-- Mercado Pago México también da ligas cortas en mpago.mx. Se aceptan
-- junto con las de 0026.
--
-- MIGRACION NUEVA. Las 0001 a 0026 estan aplicadas y no se tocan.
-- =====================================================================

alter table public.stores drop constraint if exists stores_mercadopago_link_check;
alter table public.stores add constraint stores_mercadopago_link_check
  check (mercadopago_link is null or (
    char_length(mercadopago_link) <= 300
    and mercadopago_link ~ '^https://(link\.mercadopago\.com\.mx|www\.mercadopago\.com\.mx|mpago\.mx|mpago\.la|mpago\.li)/[^[:space:]]+$'
  ));

$m0027$;
  insert into supabase_migrations.schema_migrations (version, name) values ('0027', 'mpago_mx');
  raise notice 'Migración 0027 aplicada.';
end
$entrega$;

-- 0028_mercadopago_auto.sql
do $entrega$
begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '0028') then
    raise notice 'Migración 0028 ya aplicada: se salta.';
    return;
  end if;
  execute $m0028$
-- =====================================================================
-- 0028_mercadopago_auto.sql
-- Mercado Pago automático: una liga por pedido con el monto exacto.
--
-- Lo hacen dos Edge Functions (supabase/functions/mp-pago y mp-webhook)
-- con el Access Token del negocio guardado como secreto de Supabase
-- (MP_ACCESS_TOKEN). La base nunca ve el token.
--
--   mp-pago     el cliente toca "Pagar": crea la preferencia de Checkout
--               Pro con el total del pedido (leído de la base, nunca del
--               teléfono) y devuelve la liga.
--   mp-webhook  Mercado Pago avisa de un pago: se consulta el pago a la
--               API de Mercado Pago (no se cree el aviso) y, si está
--               aprobado y el monto cuadra, el pedido queda pagado.
--
-- `payment_provider_accounts` (0024) marca la cuenta como conectada; la
-- escribe mp-pago cuando el dueño toca "Probar conexión" y el token
-- funciona.
--
-- MIGRACION NUEVA. Las 0001 a 0027 estan aplicadas y no se tocan.
-- =====================================================================

alter table public.orders
  add column if not exists mp_preference_id text,
  add column if not exists mp_payment_id text,
  add column if not exists mp_payment_status text,
  add column if not exists mp_paid_cents bigint;

comment on column public.orders.mp_payment_id is
  'Pago de Mercado Pago que confirmó el pedido (0028). Lo escribe mp-webhook.';

alter table public.payment_provider_accounts
  add column if not exists live_mode boolean,
  add column if not exists account_label text check (account_label is null or char_length(account_label) <= 120);

create or replace function app.mercadopago_connected(p_store_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, app, pg_catalog
as $$
  select exists (
    select 1 from public.payment_provider_accounts
     where store_id = p_store_id and provider = 'mercadopago' and status = 'active'
  );
$$;

-- Mercado Pago se ofrece si está prendido Y (la cuenta está conectada O
-- hay liga fija). El resto igual que en 0026.
create or replace function app.pay_with_available(p_store_id uuid, p_pay_with text)
returns boolean
language sql
stable
security definer
set search_path = public, app, pg_catalog
as $$
  select coalesce((
    select case p_pay_with
             when 'cash'         then coalesce((s.payment_options ->> 'cash')::boolean, false)
             when 'card_counter' then coalesce((s.payment_options ->> 'card_counter')::boolean, false)
             when 'transfer'     then coalesce((s.payment_options ->> 'transfer')::boolean, false)
                                      and (s.transfer_clabe is not null or s.transfer_info is not null)
             when 'mercadopago'  then coalesce((s.payment_options ->> 'mercadopago')::boolean, false)
                                      and (s.mercadopago_link is not null or app.mercadopago_connected(s.id))
             else false
           end
      from public.stores s
     where s.id = p_store_id
  ), false);
$$;

-- Monto a cobrar de un pedido: el total si ya lo hay, si no el subtotal
-- (mismo criterio que la pantalla del pedido).
create or replace function app.order_amount_cents(p_order_id uuid)
returns bigint
language sql
stable
security definer
set search_path = public, app, pg_catalog
as $$
  select case when total_cents > 0 and total_cents >= subtotal_cents then total_cents else subtotal_cents end
    from public.orders where id = p_order_id;
$$;

revoke execute on function app.order_amount_cents(uuid) from public, anon, authenticated;

$m0028$;
  insert into supabase_migrations.schema_migrations (version, name) values ('0028', 'mercadopago_auto');
  raise notice 'Migración 0028 aplicada.';
end
$entrega$;

-- 0029_viva_usa.sql
do $entrega$
begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '0029') then
    raise notice 'Migración 0029 ya aplicada: se salta.';
    return;
  end if;
  execute $m0029$
-- =====================================================================
-- 0029_viva_usa.sql
-- VIVA Juice and Coffee (Freehold, NJ): app bilingüe y cobro en EE. UU.
--
--  1. Sin Clover: se apaga el trabajo de pg_cron que dejó la 0015 (el
--     refresco de tokens de Clover). Aquí no hay a quién refrescar.
--  2. Menú bilingüe: columna `i18n` (jsonb) en categorías, productos,
--     grupos de opciones, opciones e historias. El texto base es el de
--     siempre (inglés); la traducción va en {"es": {"name": ..., ...}}.
--     La vista `menu_items` suma dos columnas al final.
--  3. Formas de pago de EE. UU.: Stripe y PayPal (automáticas, con Edge
--     Functions) y Zelle (manual, "pago por confirmar"). Se prenden y
--     apagan como las demás.
--
-- MIGRACION NUEVA. Las 0001 a 0028 vienen de la app de referencia y no se
-- tocan. Idempotente: se puede correr dos veces.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Sin Clover: fuera el cron de refresco de tokens.
-- ---------------------------------------------------------------------
do $$
begin
  if to_regclass('cron.job') is not null then
    perform cron.unschedule(jobid) from cron.job where jobname = 'token-refresh';
  end if;
end
$$;


-- ---------------------------------------------------------------------
-- 2. Menú bilingüe.
-- ---------------------------------------------------------------------
create or replace function app.i18n_valid(p jsonb)
returns boolean
language sql
immutable
as $$
  select jsonb_typeof(p) = 'object'
     and pg_column_size(p) <= 8192
     and not exists (
       select 1 from jsonb_each(p) e
        where e.key !~ '^[a-z]{2}$' or jsonb_typeof(e.value) <> 'object'
     );
$$;

alter table public.catalog_categories      add column if not exists i18n jsonb not null default '{}'::jsonb;
alter table public.catalog_items           add column if not exists i18n jsonb not null default '{}'::jsonb;
alter table public.catalog_modifier_groups add column if not exists i18n jsonb not null default '{}'::jsonb;
alter table public.catalog_modifiers       add column if not exists i18n jsonb not null default '{}'::jsonb;
alter table public.stories                 add column if not exists i18n jsonb not null default '{}'::jsonb;

alter table public.catalog_categories      drop constraint if exists catalog_categories_i18n_check;
alter table public.catalog_categories      add  constraint catalog_categories_i18n_check check (app.i18n_valid(i18n));
alter table public.catalog_items           drop constraint if exists catalog_items_i18n_check;
alter table public.catalog_items           add  constraint catalog_items_i18n_check check (app.i18n_valid(i18n));
alter table public.catalog_modifier_groups drop constraint if exists catalog_modifier_groups_i18n_check;
alter table public.catalog_modifier_groups add  constraint catalog_modifier_groups_i18n_check check (app.i18n_valid(i18n));
alter table public.catalog_modifiers       drop constraint if exists catalog_modifiers_i18n_check;
alter table public.catalog_modifiers       add  constraint catalog_modifiers_i18n_check check (app.i18n_valid(i18n));
alter table public.stories                 drop constraint if exists stories_i18n_check;
alter table public.stories                 add  constraint stories_i18n_check check (app.i18n_valid(i18n));

comment on column public.catalog_items.i18n is
  'Traducciones del producto (0029): {"es": {"name": "...", "description": "..."}}. '
  'Sin traducción se muestra el texto base.';

-- Misma vista que la 0017, con dos columnas nuevas AL FINAL (Postgres no
-- deja reordenar ni quitar columnas con create or replace).
create or replace view public.menu_items as
select
  i.id,
  i.store_id,
  i.clover_item_id,
  i.name,
  coalesce(o.marketing_copy, i.alternate_name) as description,
  i.price_cents,
  c.id            as category_id,
  c.name          as category_name,
  c.sort_order    as category_sort,
  o.image_url,
  coalesce(o.featured, false)   as featured,
  coalesce(o.sort_order, 0)     as sort_order,
  o.badge,
  (
    i.available
    and not i.hidden
    and i.price_type = 'FIXED'
    and coalesce(o.app_visible, true)
    and (o.unavailable_until is null or o.unavailable_until < now())
  ) as is_available,
  o.unavailable_reason,
  i.price_type,
  case i.price_type
    when 'FIXED'    then null
    when 'VARIABLE' then 'El precio de este producto se fija en el mostrador.'
    when 'PER_UNIT' then 'Este producto se vende por peso y se pesa en el mostrador.'
    else 'Este producto no se puede pedir desde la app.'
  end as unorderable_reason,
  -- 0029
  i.i18n                          as i18n,
  coalesce(c.i18n, '{}'::jsonb)   as category_i18n
from public.catalog_items i
left join public.catalog_categories c on c.id = i.category_id and c.deleted_at is null
left join public.app_item_overrides o
       on o.store_id = i.store_id and o.clover_item_id = i.clover_item_id
where i.deleted_at is null;

-- La 0007 dejó la vista con security_invoker; create or replace la
-- conserva, pero se repite por si alguien la recreó a mano.
alter view public.menu_items set (security_invoker = true);
grant select on public.menu_items to anon, authenticated;


-- ---------------------------------------------------------------------
-- 3. Formas de pago de EE. UU.
-- ---------------------------------------------------------------------

-- Zelle: correo o teléfono de EE. UU. registrado en Zelle, y el nombre
-- que el cliente verá en su banco al mandar el pago.
alter table public.stores
  add column if not exists zelle_recipient text,
  add column if not exists zelle_name text;

alter table public.stores drop constraint if exists stores_zelle_recipient_check;
alter table public.stores add constraint stores_zelle_recipient_check
  check (zelle_recipient is null or (
    char_length(zelle_recipient) <= 120
    and (
      zelle_recipient ~ '^[^@[:space:]]+@[^@[:space:]]+\.[A-Za-z]{2,}$'   -- correo
      or zelle_recipient ~ '^\+1[2-9][0-9]{9}$'                          -- teléfono de EE. UU.
    )
  ));
alter table public.stores drop constraint if exists stores_zelle_name_check;
alter table public.stores add constraint stores_zelle_name_check
  check (zelle_name is null or char_length(zelle_name) between 2 and 100);

comment on column public.stores.zelle_recipient is
  'Correo o teléfono (+1XXXXXXXXXX) registrado en Zelle (0029).';

-- Formas de pago válidas en un pedido y proveedores en línea.
alter table public.orders drop constraint if exists orders_pay_with_check;
alter table public.orders add constraint orders_pay_with_check
  check (pay_with is null or pay_with in
    ('cash', 'card_counter', 'transfer', 'mercadopago', 'stripe', 'clip', 'paypal', 'zelle'));

alter table public.payment_provider_accounts drop constraint if exists payment_provider_accounts_provider_check;
alter table public.payment_provider_accounts add constraint payment_provider_accounts_provider_check
  check (provider in ('mercadopago', 'stripe', 'clip', 'paypal'));

-- Rastro del cobro en línea (Stripe o PayPal). Lo escriben solo las Edge
-- Functions, con la conexión de servicio.
alter table public.orders
  add column if not exists online_checkout_id text,   -- Checkout Session de Stripe / orden de PayPal
  add column if not exists online_payment_id text,    -- PaymentIntent de Stripe / captura de PayPal
  add column if not exists online_status text,
  add column if not exists online_paid_cents bigint;

comment on column public.orders.online_payment_id is
  'Pago en línea que confirmó el pedido (0029): PaymentIntent de Stripe o '
  'captura de PayPal. Lo escribe la Edge Function tras consultarlo al proveedor.';

-- El cliente lee sus pedidos con select *; estas columnas no dicen nada
-- sensible (son ids del proveedor), pero nadie las escribe desde la app.
create or replace function app.protect_order_online_columns()
returns trigger
language plpgsql
security definer
set search_path = public, app, pg_catalog
as $$
begin
  if auth.uid() is null then
    return new;  -- service_role / Edge Functions / migraciones
  end if;
  if new.online_checkout_id is distinct from old.online_checkout_id
  or new.online_payment_id  is distinct from old.online_payment_id
  or new.online_status      is distinct from old.online_status
  or new.online_paid_cents  is distinct from old.online_paid_cents then
    raise exception 'order_online_column' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_orders_protect_online on public.orders;
create trigger trg_orders_protect_online
  before update on public.orders
  for each row execute function app.protect_order_online_columns();

-- ¿Cuenta conectada? La marca la Edge Function al "Probar conexión".
create or replace function app.provider_connected(p_store_id uuid, p_provider text)
returns boolean
language sql
stable
security definer
set search_path = public, app, pg_catalog
as $$
  select exists (
    select 1 from public.payment_provider_accounts
     where store_id = p_store_id and provider = p_provider and status = 'active'
  );
$$;

-- Lo que se le puede ofrecer al cliente. Mismas reglas que
-- `customerMethods` en apps/mobile/src/domain/payment-options.ts.
create or replace function app.pay_with_available(p_store_id uuid, p_pay_with text)
returns boolean
language sql
stable
security definer
set search_path = public, app, pg_catalog
as $$
  select coalesce((
    select case p_pay_with
             when 'cash'         then coalesce((s.payment_options ->> 'cash')::boolean, false)
             when 'card_counter' then coalesce((s.payment_options ->> 'card_counter')::boolean, false)
             when 'transfer'     then coalesce((s.payment_options ->> 'transfer')::boolean, false)
                                      and (s.transfer_clabe is not null or s.transfer_info is not null)
             when 'mercadopago'  then coalesce((s.payment_options ->> 'mercadopago')::boolean, false)
                                      and (s.mercadopago_link is not null or app.mercadopago_connected(s.id))
             when 'zelle'        then coalesce((s.payment_options ->> 'zelle')::boolean, false)
                                      and s.zelle_recipient is not null
             when 'stripe'       then coalesce((s.payment_options ->> 'stripe')::boolean, false)
                                      and app.provider_connected(s.id, 'stripe')
             when 'paypal'       then coalesce((s.payment_options ->> 'paypal')::boolean, false)
                                      and app.provider_connected(s.id, 'paypal')
             else false
           end
      from public.stores s
     where s.id = p_store_id
  ), false);
$$;

revoke execute on function app.provider_connected(uuid, text) from public, anon, authenticated;

$m0029$;
  insert into supabase_migrations.schema_migrations (version, name) values ('0029', 'viva_usa');
  raise notice 'Migración 0029 aplicada.';
end
$entrega$;

-- 0030_impuestos_recargos.sql
do $entrega$
begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '0030') then
    raise notice 'Migración 0030 ya aplicada: se salta.';
    return;
  end if;
  execute $m0030$
-- =====================================================================
-- 0030_impuestos_recargos.sql
-- Impuesto por producto y recargo por forma de pago. Al final, una sola
-- cantidad a pagar: total = subtotal + impuesto + recargo.
--
--  - Impuesto: una tasa de la sucursal (`stores.tax_rate`, ej. 0.06625) y
--    en cada producto "cobra impuesto" (`catalog_items.taxable`) con tasa
--    propia opcional (`tax_rate_override`). Se calcula sobre el importe de
--    cada línea (producto + opciones).
--  - Recargo: un porcentaje por forma de pago
--    (`stores.payment_surcharges`, ej. {"stripe": 0.03}), sobre
--    subtotal + impuesto. Efectivo y Zelle normalmente sin recargo.
--
-- Lo calcula la BASE al crear el pedido (`place_counter_order`), nunca el
-- teléfono; la app solo enseña un estimado con las mismas reglas
-- (apps/mobile/src/domain/totals.ts). Stripe y PayPal cobran
-- `app.order_amount_cents` = total_cents.
--
-- Redondeo: al centavo, mitad hacia arriba, una vez para el impuesto total
-- y una vez para el recargo.
--
-- MIGRACION NUEVA. Idempotente.
-- =====================================================================

alter table public.stores
  add column if not exists tax_rate numeric(6,5) not null default 0,
  add column if not exists payment_surcharges jsonb not null default '{}'::jsonb;

alter table public.stores drop constraint if exists stores_tax_rate_check;
alter table public.stores add constraint stores_tax_rate_check check (tax_rate >= 0 and tax_rate < 0.25);

create or replace function app.surcharges_valid(p jsonb)
returns boolean
language sql
immutable
as $$
  select jsonb_typeof(p) = 'object'
     and not exists (
       select 1 from jsonb_each(p) e
        where e.key not in ('cash', 'card_counter', 'zelle', 'stripe', 'paypal', 'transfer', 'mercadopago', 'clip')
           or jsonb_typeof(e.value) <> 'number'
           or (e.value)::text::numeric < 0
           or (e.value)::text::numeric > 0.1
     );
$$;

alter table public.stores drop constraint if exists stores_payment_surcharges_check;
alter table public.stores add constraint stores_payment_surcharges_check check (app.surcharges_valid(payment_surcharges));

comment on column public.stores.tax_rate is
  'Impuesto de la sucursal como fracción (0.06625 = 6.625%). 0 = no se cobra (0030).';
comment on column public.stores.payment_surcharges is
  'Recargo por forma de pago como fracción, sobre subtotal + impuesto: {"stripe": 0.03} (0030).';

alter table public.catalog_items
  add column if not exists taxable boolean not null default true,
  add column if not exists tax_rate_override numeric(6,5);

alter table public.catalog_items drop constraint if exists catalog_items_tax_rate_override_check;
alter table public.catalog_items add constraint catalog_items_tax_rate_override_check
  check (tax_rate_override is null or (tax_rate_override >= 0 and tax_rate_override < 0.25));

comment on column public.catalog_items.taxable is
  'Si el producto cobra impuesto (0030). Con tasa propia en tax_rate_override; si no, la de la sucursal.';

alter table public.orders
  add column if not exists surcharge_cents bigint not null default 0;
alter table public.orders drop constraint if exists orders_surcharge_cents_check;
alter table public.orders add constraint orders_surcharge_cents_check check (surcharge_cents >= 0);

-- Los montos y el rastro del cobro solo los escribe la base (funciones
-- SECURITY DEFINER, que corren como su dueño) o el servidor (Edge
-- Functions). Una sesión de la app (anon/authenticated) que llegara a
-- tener permiso de UPDATE sobre pedidos tampoco podría cambiarlos.
--
-- Por eso el trigger ya NO es security definer (como en 0029): necesita ver
-- el rol real de quien escribe (`current_user`), y dentro de una función
-- definer ese rol es el dueño de la función, no el cliente.
create or replace function app.protect_order_online_columns()
returns trigger
language plpgsql
set search_path = public, app, pg_catalog
as $$
begin
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;
  if new.online_checkout_id is distinct from old.online_checkout_id
  or new.online_payment_id  is distinct from old.online_payment_id
  or new.online_status      is distinct from old.online_status
  or new.online_paid_cents  is distinct from old.online_paid_cents
  or new.surcharge_cents    is distinct from old.surcharge_cents
  or new.tax_cents          is distinct from old.tax_cents
  or new.total_cents        is distinct from old.total_cents
  or new.subtotal_cents     is distinct from old.subtotal_cents then
    raise exception 'order_online_column' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- El cálculo, en un solo lugar.
-- ---------------------------------------------------------------------
create or replace function app.apply_order_charges(p_order_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public, app, pg_catalog
as $$
declare
  v_subtotal bigint;
  v_tax      bigint;
  v_pct      numeric;
  v_extra    bigint;
begin
  select o.subtotal_cents,
         coalesce(round(sum(
           case when coalesce(i.taxable, true)
                then oi.line_total_cents * coalesce(i.tax_rate_override, s.tax_rate)
                else 0 end
         )), 0)::bigint,
         coalesce((s.payment_surcharges ->> o.pay_with)::numeric, 0)
    into v_subtotal, v_tax, v_pct
    from public.orders o
    join public.stores s on s.id = o.store_id
    left join public.order_items oi on oi.order_id = o.id
    left join public.catalog_items i on i.store_id = o.store_id and i.clover_item_id = oi.clover_item_id
   where o.id = p_order_id
   group by o.id, o.subtotal_cents, s.tax_rate, s.payment_surcharges, o.pay_with;

  if v_subtotal is null then
    return;
  end if;
  v_extra := round((v_subtotal + v_tax) * v_pct)::bigint;

  update public.orders
     set tax_cents       = v_tax,
         surcharge_cents = v_extra,
         total_cents     = v_subtotal - discount_cents + v_tax + v_extra + tip_cents
   where id = p_order_id
     and paid_confirmed_at is null;
end;
$$;

revoke execute on function app.apply_order_charges(uuid) from public, anon, authenticated;

-- Pedido eligiendo forma de pago (misma firma que 0024/0026): ahora suma
-- impuesto y recargo antes de devolver.
create or replace function public.place_counter_order(
  p_store_id        uuid,
  p_idempotency_key text,
  p_pickup_at       timestamptz,
  p_is_asap         boolean,
  p_customer_note   text,
  p_items           jsonb,
  p_pay_with        text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, app, pg_catalog
as $$
declare
  v_result jsonb;
  v_order  uuid;
  v_row    record;
begin
  if p_pay_with is null or not app.pay_with_available(p_store_id, p_pay_with) then
    raise exception 'payment_method_not_available:%', p_pay_with using errcode = '22023';
  end if;

  v_result := public.place_counter_order(
    p_store_id, p_idempotency_key, p_pickup_at, p_is_asap, p_customer_note, p_items
  );
  v_order := (v_result ->> 'order_id')::uuid;

  update public.orders set pay_with = p_pay_with
   where id = v_order and pay_with is null;

  perform app.apply_order_charges(v_order);

  select subtotal_cents, tax_cents, surcharge_cents, total_cents into v_row
    from public.orders where id = v_order;

  return v_result || jsonb_build_object(
    'pay_with', p_pay_with,
    'subtotal_cents', v_row.subtotal_cents,
    'tax_cents', v_row.tax_cents,
    'surcharge_cents', v_row.surcharge_cents,
    'total_cents', v_row.total_cents
  );
end;
$$;

revoke execute on function
  public.place_counter_order(uuid, text, timestamptz, boolean, text, jsonb, text) from public, anon;
grant execute on function
  public.place_counter_order(uuid, text, timestamptz, boolean, text, jsonb, text) to authenticated;

-- Lo que cobra Stripe/PayPal: el total (que ya trae impuesto y recargo).
create or replace function app.order_amount_cents(p_order_id uuid)
returns bigint
language sql
stable
security definer
set search_path = public, app, pg_catalog
as $$
  select case when total_cents > 0 and total_cents >= subtotal_cents then total_cents else subtotal_cents end
    from public.orders where id = p_order_id;
$$;
revoke execute on function app.order_amount_cents(uuid) from public, anon, authenticated;

-- La app necesita saber qué productos cobran impuesto para el estimado.
create or replace view public.menu_items as
select
  i.id,
  i.store_id,
  i.clover_item_id,
  i.name,
  coalesce(o.marketing_copy, i.alternate_name) as description,
  i.price_cents,
  c.id            as category_id,
  c.name          as category_name,
  c.sort_order    as category_sort,
  o.image_url,
  coalesce(o.featured, false)   as featured,
  coalesce(o.sort_order, 0)     as sort_order,
  o.badge,
  (
    i.available
    and not i.hidden
    and i.price_type = 'FIXED'
    and coalesce(o.app_visible, true)
    and (o.unavailable_until is null or o.unavailable_until < now())
  ) as is_available,
  o.unavailable_reason,
  i.price_type,
  case i.price_type
    when 'FIXED'    then null
    when 'VARIABLE' then 'El precio de este producto se fija en el mostrador.'
    when 'PER_UNIT' then 'Este producto se vende por peso y se pesa en el mostrador.'
    else 'Este producto no se puede pedir desde la app.'
  end as unorderable_reason,
  i.i18n                          as i18n,
  coalesce(c.i18n, '{}'::jsonb)   as category_i18n,
  -- 0030
  i.taxable,
  i.tax_rate_override
from public.catalog_items i
left join public.catalog_categories c on c.id = i.category_id and c.deleted_at is null
left join public.app_item_overrides o
       on o.store_id = i.store_id and o.clover_item_id = i.clover_item_id
where i.deleted_at is null;

alter view public.menu_items set (security_invoker = true);
grant select on public.menu_items to anon, authenticated;

$m0030$;
  insert into supabase_migrations.schema_migrations (version, name) values ('0030', 'impuestos_recargos');
  raise notice 'Migración 0030 aplicada.';
end
$entrega$;

-- 0031_rol_tienda.sql
do $entrega$
begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '0031') then
    raise notice 'Migración 0031 ya aplicada: se salta.';
    return;
  end if;
  execute $m0031$
-- =====================================================================
-- 0031_rol_tienda.sql
-- Rol "Tienda" (el `staff` de 0020/0025): quien atiende el mostrador.
--
-- Además de lo que ya podía (ver y mover pedidos, cancelar con motivo,
-- "Pago recibido", validar canjes), ahora puede, SIN ser dueño:
--   - marcar un producto como agotado y volver a encenderlo,
--   - marcar una opción como agotada (p. ej. leche de avena),
--   - pausar y reanudar los pedidos de la app.
--
-- No puede tocar precios, nombres, fotos, horario, marca, impuestos,
-- formas de pago ni el equipo: sigue sin permiso de UPDATE en esas tablas
-- (RLS de 0020). Todo pasa por estas tres funciones, que solo cambian UNA
-- columna y dejan rastro en `admin_audit_log` (quién, qué y cuándo).
--
-- MIGRACION NUEVA. Idempotente.
-- =====================================================================

create or replace function app.log_store_action(
  p_restaurant_id uuid, p_action text, p_entity_type text, p_entity_id text, p_detail jsonb
)
returns void
language sql
volatile
security definer
set search_path = public, app, pg_catalog
as $$
  insert into public.admin_audit_log (admin_user_id, action, entity_type, entity_id, restaurant_id, detail)
  values (auth.uid(), p_action, p_entity_type, p_entity_id, p_restaurant_id, p_detail);
$$;
revoke execute on function app.log_store_action(uuid, text, text, text, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Producto agotado / disponible
-- ---------------------------------------------------------------------
create or replace function public.set_item_available(p_item_id uuid, p_available boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, app, pg_catalog
as $$
declare
  v_restaurant uuid;
  v_name text;
begin
  select s.restaurant_id, coalesce(nullif(i.i18n -> 'es' ->> 'name', ''), i.name) into v_restaurant, v_name
    from public.catalog_items i join public.stores s on s.id = i.store_id
   where i.id = p_item_id and i.deleted_at is null;
  if not found then
    raise exception 'item_not_found' using errcode = 'P0002';
  end if;
  if not coalesce(app.works_at_restaurant(v_restaurant), false) then
    raise exception 'staff_only' using errcode = '42501';
  end if;
  if p_available is null then
    raise exception 'available_required' using errcode = '22023';
  end if;

  update public.catalog_items set available = p_available where id = p_item_id;
  perform app.log_store_action(v_restaurant, case when p_available then 'item_on' else 'item_off' end,
                               'catalog_item', p_item_id::text, jsonb_build_object('name', v_name));
  return jsonb_build_object('item_id', p_item_id, 'available', p_available);
end;
$$;
revoke execute on function public.set_item_available(uuid, boolean) from public, anon;
grant execute on function public.set_item_available(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------
-- Opción agotada / disponible
-- ---------------------------------------------------------------------
create or replace function public.set_modifier_available(p_modifier_id uuid, p_available boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, app, pg_catalog
as $$
declare
  v_restaurant uuid;
  v_name text;
begin
  select s.restaurant_id, coalesce(nullif(m.i18n -> 'es' ->> 'name', ''), m.name) into v_restaurant, v_name
    from public.catalog_modifiers m join public.stores s on s.id = m.store_id
   where m.id = p_modifier_id and m.deleted_at is null;
  if not found then
    raise exception 'modifier_not_found' using errcode = 'P0002';
  end if;
  if not coalesce(app.works_at_restaurant(v_restaurant), false) then
    raise exception 'staff_only' using errcode = '42501';
  end if;
  if p_available is null then
    raise exception 'available_required' using errcode = '22023';
  end if;

  update public.catalog_modifiers set available = p_available where id = p_modifier_id;
  perform app.log_store_action(v_restaurant, case when p_available then 'modifier_on' else 'modifier_off' end,
                               'catalog_modifier', p_modifier_id::text, jsonb_build_object('name', v_name));
  return jsonb_build_object('modifier_id', p_modifier_id, 'available', p_available);
end;
$$;
revoke execute on function public.set_modifier_available(uuid, boolean) from public, anon;
grant execute on function public.set_modifier_available(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------
-- Pausar / reanudar los pedidos de la app (stores.pickup_enabled)
-- ---------------------------------------------------------------------
create or replace function public.set_store_accepting_orders(p_store_id uuid, p_accepting boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, app, pg_catalog
as $$
declare
  v_restaurant uuid;
begin
  select restaurant_id into v_restaurant from public.stores where id = p_store_id and deleted_at is null;
  if not found then
    raise exception 'store_not_found' using errcode = 'P0002';
  end if;
  if not coalesce(app.works_at_restaurant(v_restaurant), false) then
    raise exception 'staff_only' using errcode = '42501';
  end if;
  if p_accepting is null then
    raise exception 'accepting_required' using errcode = '22023';
  end if;

  update public.stores set pickup_enabled = p_accepting where id = p_store_id;
  perform app.log_store_action(v_restaurant, case when p_accepting then 'orders_on' else 'orders_off' end,
                               'store', p_store_id::text, '{}'::jsonb);
  return jsonb_build_object('store_id', p_store_id, 'accepting', p_accepting);
end;
$$;
revoke execute on function public.set_store_accepting_orders(uuid, boolean) from public, anon;
grant execute on function public.set_store_accepting_orders(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------
-- Lo que se hizo en la tienda (para dueño y tienda): quién apagó qué.
-- El nombre se guarda en español (el panel es en español).
-- ---------------------------------------------------------------------
create or replace function public.store_activity(p_restaurant_id uuid, p_limit int default 30)
returns table (created_at timestamptz, action text, entity_name text, who text)
language sql
stable
security definer
set search_path = public, app, pg_catalog
as $$
  select l.created_at, l.action, l.detail ->> 'name',
         coalesce(nullif(btrim(concat_ws(' ', p.first_name, p.last_name)), ''), u.email)
    from public.admin_audit_log l
    left join auth.users u on u.id = l.admin_user_id
    left join public.profiles p on p.id = l.admin_user_id
   where l.restaurant_id = p_restaurant_id
     and l.action in ('item_on', 'item_off', 'modifier_on', 'modifier_off', 'orders_on', 'orders_off')
     and coalesce(app.works_at_restaurant(p_restaurant_id), false)
   order by l.created_at desc
   limit least(greatest(coalesce(p_limit, 30), 1), 100);
$$;
revoke execute on function public.store_activity(uuid, int) from public, anon;
grant execute on function public.store_activity(uuid, int) to authenticated;

$m0031$;
  insert into supabase_migrations.schema_migrations (version, name) values ('0031', 'rol_tienda');
  raise notice 'Migración 0031 aplicada.';
end
$entrega$;

-- 0032_tarjeta_lealtad.sql
do $entrega$
begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '0032') then
    raise notice 'Migración 0032 ya aplicada: se salta.';
    return;
  end if;
  execute $m0032$
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

$m0032$;
  insert into supabase_migrations.schema_migrations (version, name) values ('0032', 'tarjeta_lealtad');
  raise notice 'Migración 0032 aplicada.';
end
$entrega$;

-- 0033_estadisticas_graficas.sql
do $entrega$
begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '0033') then
    raise notice 'Migración 0033 ya aplicada: se salta.';
    return;
  end if;
  execute $m0033$
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

$m0033$;
  insert into supabase_migrations.schema_migrations (version, name) values ('0033', 'estadisticas_graficas');
  raise notice 'Migración 0033 aplicada.';
end
$entrega$;

-- viva_juice_us.sql
-- =====================================================================
-- viva_juice_us.sql — Alta de VIVA Juice and Coffee (Freehold, NJ) y su
-- menú base, bilingüe (inglés de base, español en `i18n`).
--
-- Sale del menú digital del negocio (msmejoraprocesos.github.io/viva-menu)
-- y de los precios del menú vigente. Es un punto de partida: el dueño lo
-- edita desde el panel (precios, fotos, agotados, productos nuevos).
--
-- IDEMPOTENTE: se puede correr varias veces. No duplica nada y no pisa lo
-- que el dueño ya haya editado (todo es "on conflict do nothing" o "si
-- no existe").
--
-- Todo va dentro de un bloque DO: el SQL Editor de Supabase revisa todas
-- las sentencias antes de correr la primera, así que una tabla creada en
-- el mismo script "no existe" todavía. Dentro del bloque cada sentencia
-- se revisa justo antes de correr.
-- =====================================================================

do $seed$
declare
  v_restaurant constant uuid := '11111111-1111-4111-8111-111111111111';
  v_store      constant uuid := '22222222-2222-4222-8222-222222222222';
  v_img        constant text := 'https://grocerycastillo2025-spec.github.io/vivajuicebarweb/img';
begin
  -- -------------------------------------------------------------------
  -- Negocio, marca y sucursal
  -- -------------------------------------------------------------------
  -- El id coincide con `extra.restaurantId` de apps/mobile/app.json.
  insert into public.restaurants (id, name, slug, status, support_email, support_phone, subscription_status)
  values (v_restaurant, 'VIVA Juice and Coffee', 'viva-juice-coffee', 'active',
          null, '+17324968863', 'active')
  on conflict (id) do nothing;

  insert into public.app_settings (
    restaurant_id, app_display_name, logo_url, primary_color, secondary_color, accent_color, features, legal_urls
  )
  values (
    v_restaurant,
    'VIVA Juice and Coffee',
    v_img || '/logo-crema.png',   -- logo en crema, va sobre el verde
    '#0E4A2B',   -- verde del logotipo (texto blanco encima: AAA)
    '#F5F0E6',   -- crema de fondo
    '#E87722',   -- naranja de "JUICE"
    jsonb_build_object('loyalty', false, 'promotions', false, 'tips', false,
                       'favorites', true, 'scheduling', true),
    jsonb_build_object('website', 'https://vivajuicecoffee.com',
                       'instagram', 'https://www.instagram.com/vivajuicecoffee')
  )
  on conflict (restaurant_id) do nothing;

  insert into public.stores (
    id, restaurant_id, name, slug, status,
    address_line1, city, state, postal_code, country, latitude, longitude, phone,
    timezone, currency, catalog_source, payments_mode,
    surcharge_policy, surcharge_rate,
    pickup_enabled, delivery_enabled, setup_checklist,
    payment_options
  )
  values (
    v_store, v_restaurant, 'Freehold', 'freehold', 'active',
    '31 South St', 'Freehold', 'NJ', '07728', 'US', 40.259500, -74.274300, '+17324968863',
    'America/New_York', 'USD', 'own', 'counter',
    -- Sin cobro con tarjeta del POS en la app no hay recargo que divulgar.
    'show', 0,
    true, false, '{}'::jsonb,
    -- Mostrador prendido; Zelle, Stripe y PayPal los prende el dueño en el
    -- panel cuando tenga sus datos o su cuenta conectada.
    jsonb_build_object('cash', true, 'card_counter', true, 'transfer', false,
                       'mercadopago', false, 'stripe', false, 'clip', false,
                       'paypal', false, 'zelle', false)
  )
  on conflict (id) do nothing;

  -- Horario confirmado por el negocio (agosto 2026): todos los días de
  -- 6:00 a 21:00, sábado desde las 9:00. El dueño lo cambia en el panel.
  if not exists (select 1 from public.store_hours where store_id = v_store) then
    insert into public.store_hours (store_id, weekday, opens_at, closes_at)
    select v_store, d, case when d = 6 then time '09:00' else time '06:00' end, time '21:00'
      from generate_series(0, 6) as d;
  end if;

  insert into public.store_pickup_config (
    store_id, slot_minutes, lead_time_minutes, max_orders_per_slot, max_days_ahead, asap_enabled
  )
  values (v_store, 15, 10, 8, 1, true)
  on conflict (store_id) do nothing;

  -- Lealtad: apagada hasta que el dueño la configure (Panel → Lealtad).
  insert into public.loyalty_programs (
    restaurant_id, enabled, points_per_dollar, min_points_to_redeem, points_per_visit, visit_cooldown_hours
  )
  values (v_restaurant, false, 0, 0, 10, 20)
  on conflict (restaurant_id) do nothing;

  insert into public.store_visit_codes (store_id)
  values (v_store)
  on conflict (store_id) do nothing;

  -- -------------------------------------------------------------------
  -- Categorías
  -- -------------------------------------------------------------------
  insert into public.catalog_categories (store_id, clover_category_id, name, sort_order, i18n)
  select v_store, c.id, c.name, c.ord, jsonb_build_object('es', jsonb_build_object('name', c.es))
    from (values
      ('viva-cat-juices',    '🍊 Juices',           '🍊 Jugos',              10),
      ('viva-cat-smoothies', '🥤 Smoothies',        '🥤 Licuados',           20),
      ('viva-cat-bowls',     '🥣 Bowls',            '🥣 Bowls',              30),
      ('viva-cat-drinks',    '🍹 Viva Drinks',      '🍹 Bebidas Viva',       40),
      ('viva-cat-shots',     '⚡ Boost Shots',      '⚡ Shots de energía',   50),
      ('viva-cat-iced',      '🧊 Iced Coffee',      '🧊 Café frío',          60),
      ('viva-cat-hot',       '☕ Hot Coffee',       '☕ Café caliente',      70),
      ('viva-cat-bites',     '🥪 Viva Bites',       '🥪 Para comer',         80),
      ('viva-cat-crepes',    '🧇 Crepes & Waffles', '🧇 Crepas y waffles',   90),
      ('viva-cat-fruit',     '🍓 Fresh Fruit Cups', '🍓 Vasos de fruta',    100),
      ('viva-cat-treats',    '🍰 Treats',           '🍰 Postres',           110),
      ('viva-cat-icecream',  '🍦 Ice Cream',        '🍦 Helado',            120)
    ) as c(id, name, es, ord)
  on conflict (store_id, clover_category_id) do nothing;

  -- -------------------------------------------------------------------
  -- Productos (precio en centavos de dólar)
  -- -------------------------------------------------------------------
  drop table if exists _viva_p;
  create temp table _viva_p (
    item text, cat text, name text, descr text, es_name text, es_descr text,
    price bigint, img text, featured boolean, badge text, ord int
  ) on commit drop;

  insert into _viva_p values
    -- Juices · 8.50
    ('viva-juice-viva',     'viva-cat-juices', 'Viva Juice',            'Orange, carrot and beet',                          'Viva Juice',            'Naranja, zanahoria y betabel',                     850, 'viva-juice',  true,  'Popular', 10),
    ('viva-juice-green',    'viva-cat-juices', 'Green Juice',           'Cucumber, celery, kale, ginger, apple, orange',    'Jugo Verde',            'Pepino, apio, kale, jengibre, manzana y naranja',  850, 'jugo-verde',  true,  null,      20),
    ('viva-juice-detox',    'viva-cat-juices', 'Super Detox',           'Carrot, apple, celery, lime',                      'Super Detox',           'Zanahoria, manzana, apio y limón',                 850, 'super-detox', false, null,      30),
    ('viva-juice-antiflu',  'viva-cat-juices', 'Anti Flu',              'Orange, lime, ginger, raw honey',                  'Anti Flu',              'Naranja, limón, jengibre y miel cruda',            850, 'anti-flu',    false, null,      40),
    ('viva-juice-refresh',  'viva-cat-juices', 'Refresh Me',            'Watermelon, lime, mint',                           'Refresh Me',            'Sandía, limón y menta',                            850, 'refresh-me',  false, null,      50),
    ('viva-juice-custom',   'viva-cat-juices', 'Create Your Own Juice', 'Your 3 favorite fruits or veggies, juiced to order', 'Arma tu jugo',     'Tus 3 frutas o verduras favoritas, en jugo al momento',                        850, null,          false, null,      60),
    -- Smoothies · 8.50
    ('viva-smoothie-berry', 'viva-cat-smoothies', 'Viva Berry',         'Strawberry, blueberry, goji berry',                'Viva Berry',            'Fresa, arándano y goji berry',                     850, 'viva-berry',        true,  'Popular', 10),
    ('viva-smoothie-choco', 'viva-cat-smoothies', 'Chocolate Protein',  'Banana, peanut butter, chocolate whey protein',    'Chocolate Protein',     'Plátano, crema de cacahuate y proteína de chocolate', 850, 'chocolate-protein', true,  null,  20),
    ('viva-smoothie-vanil', 'viva-cat-smoothies', 'Vanilla Protein',    'Banana, strawberry, vanilla whey protein',         'Vanilla Protein',       'Plátano, fresa y proteína de vainilla',            850, 'vanilla-protein',   false, null,      30),
    ('viva-smoothie-disco', 'viva-cat-smoothies', 'Disco Duro',         'Mango, apple, raisins, mint',                      'Disco Duro',            'Mango, manzana, pasas y menta',                    850, 'disco-duro',        false, null,      40),
    ('viva-smoothie-young', 'viva-cat-smoothies', 'Forever Young',      'Mango, pineapple',                                 'Forever Young',         'Mango y piña',                                     850, 'forever-young',     false, null,      50),
    ('viva-smoothie-custom','viva-cat-smoothies', 'Create Your Own Smoothie', 'Your 3 favorite fruits or seeds, blended with your milk', 'Arma tu licuado', 'Tus 3 frutas o semillas favoritas, con la leche que elijas',                        850, null,                false, null,      60),
    -- Bowls · 12.50
    ('viva-bowl-acai',      'viva-cat-bowls', 'Acai Bowl',              'Acai, Nutella, blueberries, strawberries, banana, granola', 'Bowl de açaí',  'Açaí, Nutella, arándanos, fresas, plátano y granola', 1250, null, false, null, 10),
    ('viva-bowl-pitaya',    'viva-cat-bowls', 'Pitaya Bowl',            'Pitaya, granola, kiwi, pineapple, banana',         'Bowl de pitaya',        'Pitaya, granola, kiwi, piña y plátano',            1250, null, false, null, 20),
    ('viva-bowl-coconut',   'viva-cat-bowls', 'Coconut Bowl',           'Coconut, chia, granola, mango, blueberry, papaya', 'Bowl de coco',          'Coco, chía, granola, mango, arándano y papaya',    1250, null, false, null, 30),
    ('viva-bowl-custom',    'viva-cat-bowls', 'Create Your Own Bowl',   'Your base with 3 fruits and 2 toppings of your choice', 'Arma tu bowl',  'Tu base con 3 frutas y 2 toppings a tu gusto',                      1250, null, false, null, 40),
    -- Viva Drinks
    ('viva-drink-pina',     'viva-cat-drinks', 'Piña Colada',           'Virgin',                                           'Piña colada',           'Sin alcohol',                                       750, null, false, null, 10),
    ('viva-drink-tepache',  'viva-cat-drinks', 'Tepache',               'Virgin',                                           'Tepache',               'Sin alcohol',                                       750, null, false, null, 20),
    ('viva-drink-sangria',  'viva-cat-drinks', 'Sangria',               'Virgin',                                           'Sangría',               'Sin alcohol',                                       750, null, false, null, 30),
    ('viva-drink-agua',     'viva-cat-drinks', 'Today''s Agua Fresca',  'Ask about today''s flavor',                        'Agua fresca del día',   'Pregunta por el sabor de hoy',                      450, null, false, null, 40),
    -- Boost Shots · 3.50
    ('viva-shot-ginger',    'viva-cat-shots', 'Ginger Shot',            'Ginger, orange and lemon · 2 oz',                  'Shot de jengibre',      'Jengibre, naranja y limón · 2 oz',                  350, null, false, null, 10),
    ('viva-shot-turmeric',  'viva-cat-shots', 'Turmeric Shot',          'Turmeric, ginger, raw honey · 2 oz',               'Shot de cúrcuma',       'Cúrcuma, jengibre y miel cruda · 2 oz',             350, null, false, null, 20),
    ('viva-shot-pomegr',    'viva-cat-shots', 'Pomegranate Shot',       'Pomegranate and turmeric · 2 oz',                  'Shot de granada',       'Granada y cúrcuma · 2 oz',                          350, null, false, null, 30),
    -- Iced Coffee
    ('viva-iced-latte',     'viva-cat-iced', 'Iced Latte',              null,                                               'Latte frío',            null,                                                475, null, false, null, 10),
    ('viva-iced-americano', 'viva-cat-iced', 'Iced Americano',          null,                                               'Americano frío',        null,                                                475, null, false, null, 20),
    ('viva-iced-coldbrew',  'viva-cat-iced', 'Cold Brew',               null,                                               'Cold brew',             null,                                                599, null, false, null, 30),
    ('viva-iced-frappe',    'viva-cat-iced', 'Viva Frappé',             null,                                               'Frappé Viva',           null,                                                675, null, false, null, 40),
    ('viva-iced-matcha',    'viva-cat-iced', 'Iced Matcha',             null,                                               'Matcha frío',           null,                                                535, null, false, null, 50),
    -- Hot Coffee
    ('viva-hot-brew',       'viva-cat-hot', 'Fresh Brew Coffee',        null,                                               'Café del día',          'Café recién hecho',                                 200, 'cafe', false, null, 10),
    ('viva-hot-americano',  'viva-cat-hot', 'Americano',                null,                                               'Americano',             null,                                                450, null, false, null, 20),
    ('viva-hot-cappuccino', 'viva-cat-hot', 'Cappuccino',               null,                                               'Capuchino',             null,                                                450, null, false, null, 30),
    ('viva-hot-latte',      'viva-cat-hot', 'Latte',                    null,                                               'Latte',                 null,                                                450, null, false, null, 40),
    ('viva-hot-matcha',     'viva-cat-hot', 'Hot Matcha',               null,                                               'Matcha caliente',       null,                                                550, null, false, null, 50),
    ('viva-hot-single',     'viva-cat-hot', 'Espresso Single Shot',     null,                                               'Espresso sencillo',     null,                                                450, null, false, null, 60),
    ('viva-hot-double',     'viva-cat-hot', 'Espresso Double Shot',     null,                                               'Espresso doble',        null,                                                550, null, false, null, 70),
    ('viva-hot-affogato',   'viva-cat-hot', 'Affogato',                 'Espresso over ice cream',                          'Affogato',              'Espresso sobre helado',                             650, null, false, null, 80),
    -- Viva Bites
    ('viva-bite-tuna',      'viva-cat-bites', 'Tuna Sandwich',          'With carrot and celery sticks',                    'Sándwich de atún',      'Con palitos de zanahoria y apio',                   850, null, false, null, 10),
    ('viva-bite-salmon',    'viva-cat-bites', 'Smoked Salmon Sandwich', 'With carrot and celery sticks',                    'Sándwich de salmón ahumado', 'Con palitos de zanahoria y apio',              999, null, false, null, 20),
    ('viva-bite-guac',      'viva-cat-bites', 'Guacamole',              'With carrot and celery sticks',                    'Guacamole',             'Con palitos de zanahoria y apio',                   999, null, false, null, 30),
    -- Crepes & Waffles
    ('viva-crepe',          'viva-cat-crepes', 'Viva Crepe',            'Strawberry, banana, chocolate drizzle, whipped cream', 'Crepa Viva',        'Fresa, plátano, chocolate y crema batida',         1150, null, false, null, 10),
    ('viva-waffle',         'viva-cat-crepes', 'Viva Waffle',           'Strawberry, banana, Nutella, powdered sugar',      'Waffle Viva',           'Fresa, plátano, Nutella y azúcar glas',            1000, null, false, null, 20),
    -- Fresh Fruit Cups
    ('viva-fruit-10',       'viva-cat-fruit', 'Fresh Fruit Cup 10 oz',  null,                                               'Vaso de fruta 10 oz',   null,                                                550, null, false, null, 10),
    ('viva-fruit-12',       'viva-cat-fruit', 'Fresh Fruit Cup 12 oz',  null,                                               'Vaso de fruta 12 oz',   null,                                                650, null, false, null, 20),
    -- Treats
    ('viva-treat-gelwater', 'viva-cat-treats', 'Gelatin (Water-Based)', null,                                               'Gelatina de agua',      null,                                                200, null, false, null, 10),
    ('viva-treat-gelmilk',  'viva-cat-treats', 'Gelatin (Milk-Based)',  null,                                               'Gelatina de leche',     null,                                                300, null, false, null, 20),
    ('viva-treat-tresleche','viva-cat-treats', 'Tres Leches Cake Slice',null,                                               'Rebanada de pastel tres leches', null,                                       350, null, false, null, 30),
    ('viva-treat-carrot',   'viva-cat-treats', 'Carrot Cake Slice',     null,                                               'Rebanada de pastel de zanahoria', null,                                      350, null, false, null, 40),
    ('viva-treat-tiramisu', 'viva-cat-treats', 'Tiramisu Cake Slice',   null,                                               'Rebanada de tiramisú',  null,                                                399, null, false, null, 50),
    ('viva-treat-lemon',    'viva-cat-treats', 'Lemon Cake Slice',      null,                                               'Rebanada de pastel de limón', null,                                          300, null, false, null, 60),
    ('viva-treat-bansplit', 'viva-cat-treats', 'Banana Split',          null,                                               'Banana split',          null,                                               1050, null, false, null, 70),
    ('viva-treat-mangonada','viva-cat-treats', 'Mangonada',             'Mango chili sorbet',                               'Mangonada',             'Nieve de mango con chile',                          850, null, false, null, 80),
    -- Ice Cream
    ('viva-ice-cup',        'viva-cat-icecream', 'Ice Cream Cup',       null,                                               'Helado en vaso',        null,                                                550, null, false, null, 10),
    ('viva-ice-cone',       'viva-cat-icecream', 'Ice Cream Cone',      null,                                               'Helado en cono',        null,                                                600, null, false, null, 20);

  insert into public.catalog_items (store_id, clover_item_id, category_id, name, price_cents, i18n)
  select v_store, p.item, c.id, p.name, p.price,
         jsonb_build_object('es', jsonb_strip_nulls(jsonb_build_object('name', p.es_name, 'description', p.es_descr)))
    from _viva_p p
    join public.catalog_categories c on c.store_id = v_store and c.clover_category_id = p.cat
  on conflict (store_id, clover_item_id) do nothing;

  insert into public.app_item_overrides
    (store_id, clover_item_id, marketing_copy, image_url, featured, badge, sort_order)
  select v_store, p.item, p.descr,
         case when p.img is null then null else v_img || '/menu/' || p.img || '.jpg' end,
         p.featured, p.badge, p.ord
    from _viva_p p
  on conflict (store_id, clover_item_id) do nothing;

  -- -------------------------------------------------------------------
  -- Opciones
  -- -------------------------------------------------------------------
  insert into public.catalog_modifier_groups (store_id, clover_group_id, name, min_required, max_allowed, sort_order, i18n)
  select v_store, g.id, g.name, g.min, g.max, g.ord, jsonb_build_object('es', jsonb_build_object('name', g.es))
    from (values
      ('viva-grp-milk',        'Choose your milk',              'Elige tu leche',              1, 1, 20),
      ('viva-grp-protein',     'Add a protein scoop',           'Agrega una medida de proteína', 0, 1, 30),
      ('viva-grp-flavor',      'Add a flavor',                  'Agrega un sabor',             0, 1, 40),
      ('viva-grp-bread',       'Choose your bread',             'Elige tu pan',                1, 1, 10),
      ('viva-grp-juice-build', 'Pick 3 fruits or veggies',      'Elige 3 frutas o verduras',   3, 3, 5),
      ('viva-grp-smoothie-build', 'Pick 3 fruits or seeds',     'Elige 3 frutas o semillas',   3, 3, 5),
      ('viva-grp-bowl-fruits', 'Pick 3 fruits',                 'Elige 3 frutas',              3, 3, 5),
      ('viva-grp-bowl-toppings','Pick 2 toppings',              'Elige 2 toppings',            2, 2, 6)
    ) as g(id, name, es, min, max, ord)
  on conflict (store_id, clover_group_id) do nothing;

  insert into public.catalog_modifiers (store_id, modifier_group_id, clover_modifier_id, name, price_cents, sort_order, i18n)
  select v_store, g.id, m.id, m.name, m.price, m.ord,
         case when m.es is null or m.es = m.name then '{}'::jsonb
              else jsonb_build_object('es', jsonb_build_object('name', m.es)) end
    from (values
      -- Leche: avena y coco con recargo, como en el menú vigente.
      ('viva-grp-milk', 'viva-mod-milk-regular', 'Regular milk', 'Leche entera',  0,   10),
      ('viva-grp-milk', 'viva-mod-milk-almond',  'Almond milk',  'Leche de almendra', 0, 20),
      ('viva-grp-milk', 'viva-mod-milk-oat',     'Oat milk',     'Leche de avena', 100, 30),
      ('viva-grp-milk', 'viva-mod-milk-soy',     'Soy milk',     'Leche de soya',  0,   40),
      ('viva-grp-milk', 'viva-mod-milk-coconut', 'Coconut milk', 'Leche de coco', 100,  50),
      ('viva-grp-protein', 'viva-mod-protein-choco', 'Chocolate protein', 'Proteína de chocolate', 175, 10),
      ('viva-grp-protein', 'viva-mod-protein-vanil', 'Vanilla protein',   'Proteína de vainilla',  175, 20),
      ('viva-grp-flavor', 'viva-mod-flavor-vanilla',   'Vanilla',    'Vainilla',  0, 10),
      ('viva-grp-flavor', 'viva-mod-flavor-lavender',  'Lavender',   'Lavanda',   0, 20),
      ('viva-grp-flavor', 'viva-mod-flavor-banana',    'Banana',     'Plátano',   0, 30),
      ('viva-grp-flavor', 'viva-mod-flavor-hazelnut',  'Hazelnut',   'Avellana',  0, 40),
      ('viva-grp-flavor', 'viva-mod-flavor-almond',    'Almond',     'Almendra',  0, 50),
      ('viva-grp-flavor', 'viva-mod-flavor-strawberry','Strawberry', 'Fresa',     0, 60),
      ('viva-grp-flavor', 'viva-mod-flavor-caramel',   'Caramel',    'Caramelo',  0, 70),
      ('viva-grp-flavor', 'viva-mod-flavor-chocolate', 'Chocolate',  'Chocolate', 0, 80),
      ('viva-grp-bread', 'viva-mod-bread-croissant', 'Croissant',   'Croissant',   0, 10),
      ('viva-grp-bread', 'viva-mod-bread-wheat',     'Whole wheat', 'Pan integral', 0, 20),
      ('viva-grp-juice-build', 'viva-mod-jb-orange',     'Orange',     'Naranja',   0,  10),
      ('viva-grp-juice-build', 'viva-mod-jb-carrot',     'Carrot',     'Zanahoria', 0,  20),
      ('viva-grp-juice-build', 'viva-mod-jb-beet',       'Beet',       'Betabel',   0,  30),
      ('viva-grp-juice-build', 'viva-mod-jb-cucumber',   'Cucumber',   'Pepino',    0,  40),
      ('viva-grp-juice-build', 'viva-mod-jb-celery',     'Celery',     'Apio',      0,  50),
      ('viva-grp-juice-build', 'viva-mod-jb-kale',       'Kale',       'Kale',      0,  60),
      ('viva-grp-juice-build', 'viva-mod-jb-ginger',     'Ginger',     'Jengibre',  0,  70),
      ('viva-grp-juice-build', 'viva-mod-jb-apple',      'Apple',      'Manzana',   0,  80),
      ('viva-grp-juice-build', 'viva-mod-jb-pineapple',  'Pineapple',  'Piña',      0,  90),
      ('viva-grp-juice-build', 'viva-mod-jb-watermelon', 'Watermelon', 'Sandía',    0, 100),
      ('viva-grp-juice-build', 'viva-mod-jb-lime',       'Lime',       'Limón',     0, 110),
      ('viva-grp-juice-build', 'viva-mod-jb-mint',       'Mint',       'Menta',     0, 120),
      ('viva-grp-smoothie-build', 'viva-mod-sb-strawberry', 'Strawberry', 'Fresa',     0, 10),
      ('viva-grp-smoothie-build', 'viva-mod-sb-blueberry',  'Blueberry',  'Arándano',  0, 20),
      ('viva-grp-smoothie-build', 'viva-mod-sb-banana',     'Banana',     'Plátano',   0, 30),
      ('viva-grp-smoothie-build', 'viva-mod-sb-mango',      'Mango',      'Mango',     0, 40),
      ('viva-grp-smoothie-build', 'viva-mod-sb-pineapple',  'Pineapple',  'Piña',      0, 50),
      ('viva-grp-smoothie-build', 'viva-mod-sb-papaya',     'Papaya',     'Papaya',    0, 60),
      ('viva-grp-smoothie-build', 'viva-mod-sb-goji',       'Goji berry', 'Goji berry',0, 70),
      ('viva-grp-smoothie-build', 'viva-mod-sb-chia',       'Chia seeds', 'Chía',      0, 80),
      ('viva-grp-smoothie-build', 'viva-mod-sb-flax',       'Flax seeds', 'Linaza',    0, 90),
      ('viva-grp-bowl-fruits', 'viva-mod-bf-strawberry', 'Strawberry', 'Fresa',    0, 10),
      ('viva-grp-bowl-fruits', 'viva-mod-bf-blueberry',  'Blueberry',  'Arándano', 0, 20),
      ('viva-grp-bowl-fruits', 'viva-mod-bf-banana',     'Banana',     'Plátano',  0, 30),
      ('viva-grp-bowl-fruits', 'viva-mod-bf-mango',      'Mango',      'Mango',    0, 40),
      ('viva-grp-bowl-fruits', 'viva-mod-bf-pineapple',  'Pineapple',  'Piña',     0, 50),
      ('viva-grp-bowl-fruits', 'viva-mod-bf-kiwi',       'Kiwi',       'Kiwi',     0, 60),
      ('viva-grp-bowl-fruits', 'viva-mod-bf-papaya',     'Papaya',     'Papaya',   0, 70),
      ('viva-grp-bowl-toppings', 'viva-mod-bt-granola',  'Granola',       'Granola',        0, 10),
      ('viva-grp-bowl-toppings', 'viva-mod-bt-chia',     'Chia seeds',    'Chía',           0, 20),
      ('viva-grp-bowl-toppings', 'viva-mod-bt-coconut',  'Coconut flakes','Coco rallado',   0, 30),
      ('viva-grp-bowl-toppings', 'viva-mod-bt-nutella',  'Nutella',       'Nutella',        0, 40),
      ('viva-grp-bowl-toppings', 'viva-mod-bt-honey',    'Honey',         'Miel',           0, 50),
      ('viva-grp-bowl-toppings', 'viva-mod-bt-pb',       'Peanut butter', 'Crema de cacahuate', 0, 60)
    ) as m(grp, id, name, es, price, ord)
    join public.catalog_modifier_groups g on g.store_id = v_store and g.clover_group_id = m.grp
  on conflict (store_id, clover_modifier_id) do nothing;

  -- Qué grupo lleva cada producto.
  insert into public.catalog_item_modifier_groups (item_id, modifier_group_id, sort_order)
  select i.id, g.id, l.ord
    from (values
      ('viva-juice-custom',    'viva-grp-juice-build',    5),
      ('viva-smoothie-custom', 'viva-grp-smoothie-build', 5),
      ('viva-bowl-custom',     'viva-grp-bowl-fruits',    5),
      ('viva-bowl-custom',     'viva-grp-bowl-toppings',  6),
      ('viva-smoothie-berry',  'viva-grp-milk', 20), ('viva-smoothie-choco', 'viva-grp-milk', 20),
      ('viva-smoothie-vanil',  'viva-grp-milk', 20), ('viva-smoothie-disco', 'viva-grp-milk', 20),
      ('viva-smoothie-young',  'viva-grp-milk', 20), ('viva-smoothie-custom','viva-grp-milk', 20),
      ('viva-smoothie-berry',  'viva-grp-protein', 30), ('viva-smoothie-disco',  'viva-grp-protein', 30),
      ('viva-smoothie-young',  'viva-grp-protein', 30), ('viva-smoothie-custom', 'viva-grp-protein', 30),
      ('viva-iced-latte',  'viva-grp-milk', 20), ('viva-iced-frappe',   'viva-grp-milk', 20),
      ('viva-iced-matcha', 'viva-grp-milk', 20), ('viva-hot-cappuccino','viva-grp-milk', 20),
      ('viva-hot-latte',   'viva-grp-milk', 20), ('viva-hot-matcha',    'viva-grp-milk', 20),
      ('viva-iced-latte',  'viva-grp-flavor', 40), ('viva-iced-americano', 'viva-grp-flavor', 40),
      ('viva-iced-coldbrew','viva-grp-flavor', 40), ('viva-iced-frappe',   'viva-grp-flavor', 40),
      ('viva-hot-latte',   'viva-grp-flavor', 40), ('viva-hot-cappuccino', 'viva-grp-flavor', 40),
      ('viva-hot-americano','viva-grp-flavor', 40),
      ('viva-bite-tuna',   'viva-grp-bread', 10), ('viva-bite-salmon', 'viva-grp-bread', 10)
    ) as l(item, grp, ord)
    join public.catalog_items i on i.store_id = v_store and i.clover_item_id = l.item
    join public.catalog_modifier_groups g on g.store_id = v_store and g.clover_group_id = l.grp
  on conflict (item_id, modifier_group_id) do nothing;

  -- -------------------------------------------------------------------
  -- Historias destacadas (no caducan), una por producto con foto. El
  -- dueño las borra o agrega más desde el panel.
  -- -------------------------------------------------------------------
  insert into public.stories (restaurant_id, media_url, media_type, caption, item_id, sort_order, created_by, i18n)
  select v_restaurant,
         v_img || '/historias/' || s.img || '.jpg',
         'image', s.caption,
         (select i.id from public.catalog_items i where i.store_id = v_store and i.clover_item_id = s.item),
         s.ord, null,
         jsonb_build_object('es', jsonb_build_object('caption', s.es))
    from (values
      ('viva-juice',        'viva-juice-viva',     'Our house classic 🍊',             'El clásico de la casa 🍊',          10),
      ('viva-berry',        'viva-smoothie-berry', 'Packed with antioxidants 🍓',      'Puro antioxidante 🍓',              20),
      ('jugo-verde',        'viva-juice-green',    'Start your day green 🌿',          'Empieza el día en verde 🌿',        30),
      ('chocolate-protein', 'viva-smoothie-choco', 'Post-workout fuel 💪',             'Después del gym 💪',                40),
      ('vanilla-protein',   'viva-smoothie-vanil', 'Protein with a vanilla twist',     'Proteína con sabor a vainilla',     50),
      ('forever-young',     'viva-smoothie-young', 'Mango and pineapple, that''s it',  'Mango y piña, nada más',            60),
      ('disco-duro',        'viva-smoothie-disco', 'The study-session favorite',       'El favorito para estudiar',         70),
      ('super-detox',       'viva-juice-detox',    'Carrot, apple, celery and lime',   'Zanahoria, manzana, apio y limón',  80),
      ('anti-flu',          'viva-juice-antiflu',  'For the chilly days 🍯',           'Para los días fríos 🍯',            90),
      ('refresh-me',        'viva-juice-refresh',  'Watermelon, lime and mint 🍉',     'Sandía, limón y menta 🍉',         100),
      ('cafe',              'viva-hot-brew',       'Your morning coffee ☕',           'Tu café de cada mañana ☕',        110)
    ) as s(img, item, caption, es, ord)
   where not exists (
     select 1 from public.stories st where st.media_url = v_img || '/historias/' || s.img || '.jpg'
   );
end
$seed$;


-- Que la API (PostgREST) vea ya las tablas y columnas nuevas.
notify pgrst, 'reload schema';
