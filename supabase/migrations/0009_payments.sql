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
