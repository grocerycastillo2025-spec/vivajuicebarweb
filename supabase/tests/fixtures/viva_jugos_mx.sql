-- =====================================================================
-- viva_jugos_mx.sql — Alta de VIVA Jugos y Café (México, sin Clover)
--
-- Se corre UNA VEZ en el SQL editor del proyecto de Supabase de VIVA,
-- despues de aplicar las migraciones. Es idempotente: correrlo otra vez
-- no duplica nada ni pisa lo que el dueño ya edito en el panel (solo
-- crea lo que falte).
--
-- No crea productos: el menu lo da de alta el dueño desde /admin.
--
-- Despues de correrlo:
--   1. El dueño se registra en la app web con su correo.
--   2. Aqui mismo:
--        select app.grant_restaurant_role('correo-del-dueño@ejemplo.com',
--               '11111111-1111-4111-8111-111111111111', 'owner');
--   3. El dueño entra a Perfil -> "Panel del negocio".
-- =====================================================================

begin;

-- El id coincide con `extra.restaurantId` de apps/mobile/app.json, asi la
-- app web no necesita el secreto EXPO_PUBLIC_RESTAURANT_ID.
insert into public.restaurants (id, name, slug, status, subscription_status)
values (
  '11111111-1111-4111-8111-111111111111',
  'VIVA Jugos y Café',
  'viva-jugos-y-cafe',
  'active',
  'active'
)
on conflict (id) do nothing;

insert into public.app_settings (
  restaurant_id, app_display_name, primary_color, secondary_color, accent_color, features
)
values (
  '11111111-1111-4111-8111-111111111111',
  'VIVA Jugos y Café',
  '#C9480F',   -- naranja de "Jugos naturales" (texto blanco encima: AA)
  '#FFF7EF',   -- crema de fondo
  '#0E5B3A',   -- verde del logotipo
  jsonb_build_object(
    'loyalty', false, 'promotions', false, 'tips', false,
    'favorites', true, 'scheduling', true
  )
)
on conflict (restaurant_id) do nothing;

insert into public.stores (
  id, restaurant_id, name, slug, status,
  country, timezone, currency,
  catalog_source, payments_mode,
  surcharge_policy, surcharge_rate,
  pickup_enabled, delivery_enabled, setup_checklist
)
values (
  '33333333-3333-4333-8333-333333333333',
  '11111111-1111-4111-8111-111111111111',
  'VIVA Jugos y Café',
  'principal',
  'active',
  'MX', 'America/Mexico_City', 'MXN',
  'own', 'counter',
  -- Sin cobro con tarjeta en la app no hay recargo que divulgar.
  'show', 0,
  true, false, '{}'::jsonb
)
on conflict (id) do nothing;

-- Horario inicial: 8:00 a 20:00 todos los dias. El dueño lo cambia en
-- el panel.
insert into public.store_hours (store_id, weekday, opens_at, closes_at)
select '33333333-3333-4333-8333-333333333333', d, time '08:00', time '20:00'
from generate_series(0, 6) as d
where not exists (
  select 1 from public.store_hours h
  where h.store_id = '33333333-3333-4333-8333-333333333333'
);

insert into public.store_pickup_config (
  store_id, slot_minutes, lead_time_minutes, max_orders_per_slot, max_days_ahead, asap_enabled
)
values ('33333333-3333-4333-8333-333333333333', 15, 10, 8, 1, true)
on conflict (store_id) do nothing;

-- Lealtad: apagada hasta que el dueño la configure en el panel
-- (Lealtad -> Programa). 10 puntos por visita, una visita cada 20 h.
insert into public.loyalty_programs (
  restaurant_id, enabled, points_per_dollar, min_points_to_redeem, points_per_visit, visit_cooldown_hours
)
values ('11111111-1111-4111-8111-111111111111', false, 0, 0, 10, 20)
on conflict (restaurant_id) do nothing;

insert into public.store_visit_codes (store_id)
values ('33333333-3333-4333-8333-333333333333')
on conflict (store_id) do nothing;

commit;
