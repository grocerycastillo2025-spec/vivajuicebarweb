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
