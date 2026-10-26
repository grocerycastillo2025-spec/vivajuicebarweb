-- =====================================================================
-- Pruebas de 0028: Mercado Pago automático (lado base).
-- El flujo completo con las Edge Functions se prueba en Node contra una
-- base real y un Mercado Pago falso (supabase/functions/_shared/__tests__).
-- =====================================================================

\set ON_ERROR_STOP on

\i supabase/tests/fixtures/viva_jugos_mx.sql
\i supabase/tests/fixtures/viva_menu_base.sql
begin;

update public.stores set payment_options = payment_options || jsonb_build_object('mercadopago', true),
       mercadopago_link = null
 where id = '33333333-3333-4333-8333-333333333333';

do $$ begin
  if app.pay_with_available('33333333-3333-4333-8333-333333333333', 'mercadopago') then
    raise exception 'Sin cuenta ni liga, Mercado Pago no debe ofrecerse';
  end if;
end $$;

insert into public.payment_provider_accounts (store_id, provider, status, live_mode, account_label)
values ('33333333-3333-4333-8333-333333333333', 'mercadopago', 'active', false, 'PRUEBA');

do $$ begin
  if not app.pay_with_available('33333333-3333-4333-8333-333333333333', 'mercadopago') then
    raise exception 'Con la cuenta conectada, Mercado Pago debe ofrecerse';
  end if;
end $$;

-- Apagado por el dueño gana a la cuenta conectada.
update public.stores set payment_options = payment_options || jsonb_build_object('mercadopago', false)
 where id = '33333333-3333-4333-8333-333333333333';
do $$ begin
  if app.pay_with_available('33333333-3333-4333-8333-333333333333', 'mercadopago') then
    raise exception 'Apagado debe ganar';
  end if;
end $$;

-- Nadie fuera del servidor calcula montos con la función interna.
set local role authenticated;
do $$ begin
  perform app.order_amount_cents(gen_random_uuid());
  raise exception 'authenticated no debe poder llamar order_amount_cents';
exception when insufficient_privilege then null;
end $$;
reset role;

rollback;
\echo 'OK 0028: Mercado Pago automático'
