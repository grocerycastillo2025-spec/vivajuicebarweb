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
