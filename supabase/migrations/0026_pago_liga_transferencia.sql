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
