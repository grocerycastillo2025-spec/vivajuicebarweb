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
