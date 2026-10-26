-- =====================================================================
-- 0007_view_security.sql
-- Las vistas deben respetar el RLS de sus tablas base.
--
-- EL PROBLEMA
-- Por defecto, una vista de PostgreSQL se ejecuta con los privilegios de
-- su DUEÑO, no de quien consulta. Eso hace que las policies de las tablas
-- base no se apliquen: la vista se convierte en una puerta trasera.
--
-- Reproducido antes del arreglo, con la sucursal en 'pending_setup':
--     select count(*) from catalog_items  -> 0   (RLS funciona)
--     select count(*) from menu_items     -> 50  (la vista se lo salta)
--
-- Con security_invoker la vista se ejecuta con los privilegios de quien
-- consulta y las policies vuelven a aplicar. Requiere PostgreSQL 15+;
-- Supabase corre 15 o superior.
--
-- Detectado durante la Fase 3. Es exactamente el tipo de hueco que no
-- se ve leyendo el codigo y solo aparece al probar con el rol real.
-- =====================================================================

alter view public.menu_items set (security_invoker = on);
alter view public.clover_connection_status set (security_invoker = on);

comment on view public.menu_items is
  'Menu que consume la app. security_invoker = on: respeta el RLS de '
  'catalog_items, catalog_categories y app_item_overrides, de modo que '
  'una sucursal en pending_setup o draft no expone su catalogo.';
