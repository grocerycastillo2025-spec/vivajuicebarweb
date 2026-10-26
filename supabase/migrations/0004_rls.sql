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
