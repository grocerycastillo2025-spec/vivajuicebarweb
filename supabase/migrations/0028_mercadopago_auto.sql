-- =====================================================================
-- 0028_mercadopago_auto.sql
-- Mercado Pago automático: una liga por pedido con el monto exacto.
--
-- Lo hacen dos Edge Functions (supabase/functions/mp-pago y mp-webhook)
-- con el Access Token del negocio guardado como secreto de Supabase
-- (MP_ACCESS_TOKEN). La base nunca ve el token.
--
--   mp-pago     el cliente toca "Pagar": crea la preferencia de Checkout
--               Pro con el total del pedido (leído de la base, nunca del
--               teléfono) y devuelve la liga.
--   mp-webhook  Mercado Pago avisa de un pago: se consulta el pago a la
--               API de Mercado Pago (no se cree el aviso) y, si está
--               aprobado y el monto cuadra, el pedido queda pagado.
--
-- `payment_provider_accounts` (0024) marca la cuenta como conectada; la
-- escribe mp-pago cuando el dueño toca "Probar conexión" y el token
-- funciona.
--
-- MIGRACION NUEVA. Las 0001 a 0027 estan aplicadas y no se tocan.
-- =====================================================================

alter table public.orders
  add column if not exists mp_preference_id text,
  add column if not exists mp_payment_id text,
  add column if not exists mp_payment_status text,
  add column if not exists mp_paid_cents bigint;

comment on column public.orders.mp_payment_id is
  'Pago de Mercado Pago que confirmó el pedido (0028). Lo escribe mp-webhook.';

alter table public.payment_provider_accounts
  add column if not exists live_mode boolean,
  add column if not exists account_label text check (account_label is null or char_length(account_label) <= 120);

create or replace function app.mercadopago_connected(p_store_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, app, pg_catalog
as $$
  select exists (
    select 1 from public.payment_provider_accounts
     where store_id = p_store_id and provider = 'mercadopago' and status = 'active'
  );
$$;

-- Mercado Pago se ofrece si está prendido Y (la cuenta está conectada O
-- hay liga fija). El resto igual que en 0026.
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
                                      and (s.mercadopago_link is not null or app.mercadopago_connected(s.id))
             else false
           end
      from public.stores s
     where s.id = p_store_id
  ), false);
$$;

-- Monto a cobrar de un pedido: el total si ya lo hay, si no el subtotal
-- (mismo criterio que la pantalla del pedido).
create or replace function app.order_amount_cents(p_order_id uuid)
returns bigint
language sql
stable
security definer
set search_path = public, app, pg_catalog
as $$
  select case when total_cents > 0 and total_cents >= subtotal_cents then total_cents else subtotal_cents end
    from public.orders where id = p_order_id;
$$;

revoke execute on function app.order_amount_cents(uuid) from public, anon, authenticated;
