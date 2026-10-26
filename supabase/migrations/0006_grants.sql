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
