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
