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
