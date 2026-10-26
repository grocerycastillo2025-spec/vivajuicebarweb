-- =====================================================================
-- 0027_mpago_mx.sql
-- Mercado Pago México también da ligas cortas en mpago.mx. Se aceptan
-- junto con las de 0026.
--
-- MIGRACION NUEVA. Las 0001 a 0026 estan aplicadas y no se tocan.
-- =====================================================================

alter table public.stores drop constraint if exists stores_mercadopago_link_check;
alter table public.stores add constraint stores_mercadopago_link_check
  check (mercadopago_link is null or (
    char_length(mercadopago_link) <= 300
    and mercadopago_link ~ '^https://(link\.mercadopago\.com\.mx|www\.mercadopago\.com\.mx|mpago\.mx|mpago\.la|mpago\.li)/[^[:space:]]+$'
  ));
