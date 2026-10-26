-- =====================================================================
-- 0030_impuestos_recargos.sql
-- Impuesto por producto y recargo por forma de pago. Al final, una sola
-- cantidad a pagar: total = subtotal + impuesto + recargo.
--
--  - Impuesto: una tasa de la sucursal (`stores.tax_rate`, ej. 0.06625) y
--    en cada producto "cobra impuesto" (`catalog_items.taxable`) con tasa
--    propia opcional (`tax_rate_override`). Se calcula sobre el importe de
--    cada línea (producto + opciones).
--  - Recargo: un porcentaje por forma de pago
--    (`stores.payment_surcharges`, ej. {"stripe": 0.03}), sobre
--    subtotal + impuesto. Efectivo y Zelle normalmente sin recargo.
--
-- Lo calcula la BASE al crear el pedido (`place_counter_order`), nunca el
-- teléfono; la app solo enseña un estimado con las mismas reglas
-- (apps/mobile/src/domain/totals.ts). Stripe y PayPal cobran
-- `app.order_amount_cents` = total_cents.
--
-- Redondeo: al centavo, mitad hacia arriba, una vez para el impuesto total
-- y una vez para el recargo.
--
-- MIGRACION NUEVA. Idempotente.
-- =====================================================================

alter table public.stores
  add column if not exists tax_rate numeric(6,5) not null default 0,
  add column if not exists payment_surcharges jsonb not null default '{}'::jsonb;

alter table public.stores drop constraint if exists stores_tax_rate_check;
alter table public.stores add constraint stores_tax_rate_check check (tax_rate >= 0 and tax_rate < 0.25);

create or replace function app.surcharges_valid(p jsonb)
returns boolean
language sql
immutable
as $$
  select jsonb_typeof(p) = 'object'
     and not exists (
       select 1 from jsonb_each(p) e
        where e.key not in ('cash', 'card_counter', 'zelle', 'stripe', 'paypal', 'transfer', 'mercadopago', 'clip')
           or jsonb_typeof(e.value) <> 'number'
           or (e.value)::text::numeric < 0
           or (e.value)::text::numeric > 0.1
     );
$$;

alter table public.stores drop constraint if exists stores_payment_surcharges_check;
alter table public.stores add constraint stores_payment_surcharges_check check (app.surcharges_valid(payment_surcharges));

comment on column public.stores.tax_rate is
  'Impuesto de la sucursal como fracción (0.06625 = 6.625%). 0 = no se cobra (0030).';
comment on column public.stores.payment_surcharges is
  'Recargo por forma de pago como fracción, sobre subtotal + impuesto: {"stripe": 0.03} (0030).';

alter table public.catalog_items
  add column if not exists taxable boolean not null default true,
  add column if not exists tax_rate_override numeric(6,5);

alter table public.catalog_items drop constraint if exists catalog_items_tax_rate_override_check;
alter table public.catalog_items add constraint catalog_items_tax_rate_override_check
  check (tax_rate_override is null or (tax_rate_override >= 0 and tax_rate_override < 0.25));

comment on column public.catalog_items.taxable is
  'Si el producto cobra impuesto (0030). Con tasa propia en tax_rate_override; si no, la de la sucursal.';

alter table public.orders
  add column if not exists surcharge_cents bigint not null default 0;
alter table public.orders drop constraint if exists orders_surcharge_cents_check;
alter table public.orders add constraint orders_surcharge_cents_check check (surcharge_cents >= 0);

-- Los montos y el rastro del cobro solo los escribe la base (funciones
-- SECURITY DEFINER, que corren como su dueño) o el servidor (Edge
-- Functions). Una sesión de la app (anon/authenticated) que llegara a
-- tener permiso de UPDATE sobre pedidos tampoco podría cambiarlos.
--
-- Por eso el trigger ya NO es security definer (como en 0029): necesita ver
-- el rol real de quien escribe (`current_user`), y dentro de una función
-- definer ese rol es el dueño de la función, no el cliente.
create or replace function app.protect_order_online_columns()
returns trigger
language plpgsql
set search_path = public, app, pg_catalog
as $$
begin
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;
  if new.online_checkout_id is distinct from old.online_checkout_id
  or new.online_payment_id  is distinct from old.online_payment_id
  or new.online_status      is distinct from old.online_status
  or new.online_paid_cents  is distinct from old.online_paid_cents
  or new.surcharge_cents    is distinct from old.surcharge_cents
  or new.tax_cents          is distinct from old.tax_cents
  or new.total_cents        is distinct from old.total_cents
  or new.subtotal_cents     is distinct from old.subtotal_cents then
    raise exception 'order_online_column' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- El cálculo, en un solo lugar.
-- ---------------------------------------------------------------------
create or replace function app.apply_order_charges(p_order_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public, app, pg_catalog
as $$
declare
  v_subtotal bigint;
  v_tax      bigint;
  v_pct      numeric;
  v_extra    bigint;
begin
  select o.subtotal_cents,
         coalesce(round(sum(
           case when coalesce(i.taxable, true)
                then oi.line_total_cents * coalesce(i.tax_rate_override, s.tax_rate)
                else 0 end
         )), 0)::bigint,
         coalesce((s.payment_surcharges ->> o.pay_with)::numeric, 0)
    into v_subtotal, v_tax, v_pct
    from public.orders o
    join public.stores s on s.id = o.store_id
    left join public.order_items oi on oi.order_id = o.id
    left join public.catalog_items i on i.store_id = o.store_id and i.clover_item_id = oi.clover_item_id
   where o.id = p_order_id
   group by o.id, o.subtotal_cents, s.tax_rate, s.payment_surcharges, o.pay_with;

  if v_subtotal is null then
    return;
  end if;
  v_extra := round((v_subtotal + v_tax) * v_pct)::bigint;

  update public.orders
     set tax_cents       = v_tax,
         surcharge_cents = v_extra,
         total_cents     = v_subtotal - discount_cents + v_tax + v_extra + tip_cents
   where id = p_order_id
     and paid_confirmed_at is null;
end;
$$;

revoke execute on function app.apply_order_charges(uuid) from public, anon, authenticated;

-- Pedido eligiendo forma de pago (misma firma que 0024/0026): ahora suma
-- impuesto y recargo antes de devolver.
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
  v_order  uuid;
  v_row    record;
begin
  if p_pay_with is null or not app.pay_with_available(p_store_id, p_pay_with) then
    raise exception 'payment_method_not_available:%', p_pay_with using errcode = '22023';
  end if;

  v_result := public.place_counter_order(
    p_store_id, p_idempotency_key, p_pickup_at, p_is_asap, p_customer_note, p_items
  );
  v_order := (v_result ->> 'order_id')::uuid;

  update public.orders set pay_with = p_pay_with
   where id = v_order and pay_with is null;

  perform app.apply_order_charges(v_order);

  select subtotal_cents, tax_cents, surcharge_cents, total_cents into v_row
    from public.orders where id = v_order;

  return v_result || jsonb_build_object(
    'pay_with', p_pay_with,
    'subtotal_cents', v_row.subtotal_cents,
    'tax_cents', v_row.tax_cents,
    'surcharge_cents', v_row.surcharge_cents,
    'total_cents', v_row.total_cents
  );
end;
$$;

revoke execute on function
  public.place_counter_order(uuid, text, timestamptz, boolean, text, jsonb, text) from public, anon;
grant execute on function
  public.place_counter_order(uuid, text, timestamptz, boolean, text, jsonb, text) to authenticated;

-- Lo que cobra Stripe/PayPal: el total (que ya trae impuesto y recargo).
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

-- La app necesita saber qué productos cobran impuesto para el estimado.
create or replace view public.menu_items as
select
  i.id,
  i.store_id,
  i.clover_item_id,
  i.name,
  coalesce(o.marketing_copy, i.alternate_name) as description,
  i.price_cents,
  c.id            as category_id,
  c.name          as category_name,
  c.sort_order    as category_sort,
  o.image_url,
  coalesce(o.featured, false)   as featured,
  coalesce(o.sort_order, 0)     as sort_order,
  o.badge,
  (
    i.available
    and not i.hidden
    and i.price_type = 'FIXED'
    and coalesce(o.app_visible, true)
    and (o.unavailable_until is null or o.unavailable_until < now())
  ) as is_available,
  o.unavailable_reason,
  i.price_type,
  case i.price_type
    when 'FIXED'    then null
    when 'VARIABLE' then 'El precio de este producto se fija en el mostrador.'
    when 'PER_UNIT' then 'Este producto se vende por peso y se pesa en el mostrador.'
    else 'Este producto no se puede pedir desde la app.'
  end as unorderable_reason,
  i.i18n                          as i18n,
  coalesce(c.i18n, '{}'::jsonb)   as category_i18n,
  -- 0030
  i.taxable,
  i.tax_rate_override
from public.catalog_items i
left join public.catalog_categories c on c.id = i.category_id and c.deleted_at is null
left join public.app_item_overrides o
       on o.store_id = i.store_id and o.clover_item_id = i.clover_item_id
where i.deleted_at is null;

alter view public.menu_items set (security_invoker = true);
grant select on public.menu_items to anon, authenticated;
