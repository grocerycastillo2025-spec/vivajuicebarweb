-- =====================================================================
-- borrar-datos-de-prueba.sql — Dejar la app en cero antes de lanzar.
--
-- Cómo correrlo: Supabase → SQL Editor → New query → pegar todo → Run.
-- Se puede correr dos veces.
--
-- BORRA (todo lo que generaron las pruebas):
--   pedidos y sus productos, pagos, intentos de pedido, devoluciones,
--   numeración de pedidos (el primero real vuelve a ser #1001),
--   estadísticas (vistas y consultas), puntos, visitas y canjes, favoritos,
--   avisos y tokens de notificaciones.
--
-- NO TOCA: el menú, las fotos, las historias, el horario, la marca, las
-- formas de pago y sus cuentas conectadas, las recompensas configuradas ni
-- las cuentas de las personas (dueño, cajeros y clientes que ya se
-- registraron siguen pudiendo entrar). Para borrar también las cuentas de
-- clientes de prueba, ver el bloque opcional al final.
-- =====================================================================

do $borrar$
declare
  v_pedidos int;
begin
  select count(*) into v_pedidos from public.orders;

  -- Lo que cuelga de los pedidos primero.
  delete from public.refunds;
  delete from public.payments;
  delete from public.order_item_modifiers;
  delete from public.order_items;
  delete from public.promotion_uses;
  delete from public.orders;
  delete from public.checkout_attempts;
  delete from public.order_counters;

  -- Estadísticas y lealtad.
  delete from public.analytics_events;
  delete from public.reward_redemptions;
  delete from public.loyalty_transactions;
  delete from public.loyalty_accounts;

  -- Del cliente.
  delete from public.favorites;
  delete from public.notifications;
  delete from public.push_tokens;

  raise notice 'Listo: se borraron % pedidos de prueba y todo lo que dependía de ellos.', v_pedidos;
end
$borrar$;

-- ---------------------------------------------------------------------
-- OPCIONAL: borrar también las cuentas de CLIENTES de prueba.
-- Quita los "--" de las 5 líneas de abajo y vuelve a correr. Nunca borra
-- a quien es dueño o cajero del negocio.
-- ---------------------------------------------------------------------
-- delete from auth.users u
--  where not exists (select 1 from public.restaurant_members m where m.user_id = u.id)
--    and not exists (select 1 from public.platform_admins a where a.user_id = u.id)
--    and u.created_at < now();
-- select 'cuentas de clientes borradas' as listo;

select
  (select count(*) from public.orders)            as pedidos,
  (select count(*) from public.analytics_events)  as eventos,
  (select count(*) from public.loyalty_accounts)  as cuentas_de_puntos,
  (select count(*) from public.catalog_items)     as productos_en_el_menu;
