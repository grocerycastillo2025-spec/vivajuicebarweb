-- =====================================================================
-- 0029_viva_usa.sql
-- VIVA Juice and Coffee (Freehold, NJ): app bilingüe y cobro en EE. UU.
--
--  1. Sin Clover: se apaga el trabajo de pg_cron que dejó la 0015 (el
--     refresco de tokens de Clover). Aquí no hay a quién refrescar.
--  2. Menú bilingüe: columna `i18n` (jsonb) en categorías, productos,
--     grupos de opciones, opciones e historias. El texto base es el de
--     siempre (inglés); la traducción va en {"es": {"name": ..., ...}}.
--     La vista `menu_items` suma dos columnas al final.
--  3. Formas de pago de EE. UU.: Stripe y PayPal (automáticas, con Edge
--     Functions) y Zelle (manual, "pago por confirmar"). Se prenden y
--     apagan como las demás.
--
-- MIGRACION NUEVA. Las 0001 a 0028 vienen de la app de referencia y no se
-- tocan. Idempotente: se puede correr dos veces.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Sin Clover: fuera el cron de refresco de tokens.
-- ---------------------------------------------------------------------
do $$
begin
  if to_regclass('cron.job') is not null then
    perform cron.unschedule(jobid) from cron.job where jobname = 'token-refresh';
  end if;
end
$$;


-- ---------------------------------------------------------------------
-- 2. Menú bilingüe.
-- ---------------------------------------------------------------------
create or replace function app.i18n_valid(p jsonb)
returns boolean
language sql
immutable
as $$
  select jsonb_typeof(p) = 'object'
     and pg_column_size(p) <= 8192
     and not exists (
       select 1 from jsonb_each(p) e
        where e.key !~ '^[a-z]{2}$' or jsonb_typeof(e.value) <> 'object'
     );
$$;

alter table public.catalog_categories      add column if not exists i18n jsonb not null default '{}'::jsonb;
alter table public.catalog_items           add column if not exists i18n jsonb not null default '{}'::jsonb;
alter table public.catalog_modifier_groups add column if not exists i18n jsonb not null default '{}'::jsonb;
alter table public.catalog_modifiers       add column if not exists i18n jsonb not null default '{}'::jsonb;
alter table public.stories                 add column if not exists i18n jsonb not null default '{}'::jsonb;

alter table public.catalog_categories      drop constraint if exists catalog_categories_i18n_check;
alter table public.catalog_categories      add  constraint catalog_categories_i18n_check check (app.i18n_valid(i18n));
alter table public.catalog_items           drop constraint if exists catalog_items_i18n_check;
alter table public.catalog_items           add  constraint catalog_items_i18n_check check (app.i18n_valid(i18n));
alter table public.catalog_modifier_groups drop constraint if exists catalog_modifier_groups_i18n_check;
alter table public.catalog_modifier_groups add  constraint catalog_modifier_groups_i18n_check check (app.i18n_valid(i18n));
alter table public.catalog_modifiers       drop constraint if exists catalog_modifiers_i18n_check;
alter table public.catalog_modifiers       add  constraint catalog_modifiers_i18n_check check (app.i18n_valid(i18n));
alter table public.stories                 drop constraint if exists stories_i18n_check;
alter table public.stories                 add  constraint stories_i18n_check check (app.i18n_valid(i18n));

comment on column public.catalog_items.i18n is
  'Traducciones del producto (0029): {"es": {"name": "...", "description": "..."}}. '
  'Sin traducción se muestra el texto base.';

-- Misma vista que la 0017, con dos columnas nuevas AL FINAL (Postgres no
-- deja reordenar ni quitar columnas con create or replace).
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
  -- 0029
  i.i18n                          as i18n,
  coalesce(c.i18n, '{}'::jsonb)   as category_i18n
from public.catalog_items i
left join public.catalog_categories c on c.id = i.category_id and c.deleted_at is null
left join public.app_item_overrides o
       on o.store_id = i.store_id and o.clover_item_id = i.clover_item_id
where i.deleted_at is null;

-- La 0007 dejó la vista con security_invoker; create or replace la
-- conserva, pero se repite por si alguien la recreó a mano.
alter view public.menu_items set (security_invoker = true);
grant select on public.menu_items to anon, authenticated;


-- ---------------------------------------------------------------------
-- 3. Formas de pago de EE. UU.
-- ---------------------------------------------------------------------

-- Zelle: correo o teléfono de EE. UU. registrado en Zelle, y el nombre
-- que el cliente verá en su banco al mandar el pago.
alter table public.stores
  add column if not exists zelle_recipient text,
  add column if not exists zelle_name text;

alter table public.stores drop constraint if exists stores_zelle_recipient_check;
alter table public.stores add constraint stores_zelle_recipient_check
  check (zelle_recipient is null or (
    char_length(zelle_recipient) <= 120
    and (
      zelle_recipient ~ '^[^@[:space:]]+@[^@[:space:]]+\.[A-Za-z]{2,}$'   -- correo
      or zelle_recipient ~ '^\+1[2-9][0-9]{9}$'                          -- teléfono de EE. UU.
    )
  ));
alter table public.stores drop constraint if exists stores_zelle_name_check;
alter table public.stores add constraint stores_zelle_name_check
  check (zelle_name is null or char_length(zelle_name) between 2 and 100);

comment on column public.stores.zelle_recipient is
  'Correo o teléfono (+1XXXXXXXXXX) registrado en Zelle (0029).';

-- Formas de pago válidas en un pedido y proveedores en línea.
alter table public.orders drop constraint if exists orders_pay_with_check;
alter table public.orders add constraint orders_pay_with_check
  check (pay_with is null or pay_with in
    ('cash', 'card_counter', 'transfer', 'mercadopago', 'stripe', 'clip', 'paypal', 'zelle'));

alter table public.payment_provider_accounts drop constraint if exists payment_provider_accounts_provider_check;
alter table public.payment_provider_accounts add constraint payment_provider_accounts_provider_check
  check (provider in ('mercadopago', 'stripe', 'clip', 'paypal'));

-- Rastro del cobro en línea (Stripe o PayPal). Lo escriben solo las Edge
-- Functions, con la conexión de servicio.
alter table public.orders
  add column if not exists online_checkout_id text,   -- Checkout Session de Stripe / orden de PayPal
  add column if not exists online_payment_id text,    -- PaymentIntent de Stripe / captura de PayPal
  add column if not exists online_status text,
  add column if not exists online_paid_cents bigint;

comment on column public.orders.online_payment_id is
  'Pago en línea que confirmó el pedido (0029): PaymentIntent de Stripe o '
  'captura de PayPal. Lo escribe la Edge Function tras consultarlo al proveedor.';

-- El cliente lee sus pedidos con select *; estas columnas no dicen nada
-- sensible (son ids del proveedor), pero nadie las escribe desde la app.
create or replace function app.protect_order_online_columns()
returns trigger
language plpgsql
security definer
set search_path = public, app, pg_catalog
as $$
begin
  if auth.uid() is null then
    return new;  -- service_role / Edge Functions / migraciones
  end if;
  if new.online_checkout_id is distinct from old.online_checkout_id
  or new.online_payment_id  is distinct from old.online_payment_id
  or new.online_status      is distinct from old.online_status
  or new.online_paid_cents  is distinct from old.online_paid_cents then
    raise exception 'order_online_column' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_orders_protect_online on public.orders;
create trigger trg_orders_protect_online
  before update on public.orders
  for each row execute function app.protect_order_online_columns();

-- ¿Cuenta conectada? La marca la Edge Function al "Probar conexión".
create or replace function app.provider_connected(p_store_id uuid, p_provider text)
returns boolean
language sql
stable
security definer
set search_path = public, app, pg_catalog
as $$
  select exists (
    select 1 from public.payment_provider_accounts
     where store_id = p_store_id and provider = p_provider and status = 'active'
  );
$$;

-- Lo que se le puede ofrecer al cliente. Mismas reglas que
-- `customerMethods` en apps/mobile/src/domain/payment-options.ts.
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
             when 'zelle'        then coalesce((s.payment_options ->> 'zelle')::boolean, false)
                                      and s.zelle_recipient is not null
             when 'stripe'       then coalesce((s.payment_options ->> 'stripe')::boolean, false)
                                      and app.provider_connected(s.id, 'stripe')
             when 'paypal'       then coalesce((s.payment_options ->> 'paypal')::boolean, false)
                                      and app.provider_connected(s.id, 'paypal')
             else false
           end
      from public.stores s
     where s.id = p_store_id
  ), false);
$$;

revoke execute on function app.provider_connected(uuid, text) from public, anon, authenticated;
