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
