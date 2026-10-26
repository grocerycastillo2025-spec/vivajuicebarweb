-- Lo que tiene que quedar después de correr la entrega (dos veces).
do $$
declare
  n int;
  sin_rls text;
begin
  select count(*) into n from supabase_migrations.schema_migrations;
  if n < 29 then raise exception 'Migraciones anotadas: % (se esperaban al menos 29)', n; end if;

  select string_agg(c.relname, ', ') into sin_rls
    from pg_class c join pg_namespace s on s.oid = c.relnamespace
   where s.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
  if sin_rls is not null then raise exception 'Tablas públicas sin RLS: %', sin_rls; end if;

  select count(*) into n from public.restaurants;               if n <> 1  then raise exception 'restaurants: %', n; end if;
  select count(*) into n from public.stores;                    if n <> 1  then raise exception 'stores: %', n; end if;
  select count(*) into n from public.catalog_categories;        if n <> 12 then raise exception 'categorías: %', n; end if;
  select count(*) into n from public.catalog_items;             if n <> 53 then raise exception 'productos: %', n; end if;
  select count(*) into n from public.catalog_modifier_groups;   if n <> 8  then raise exception 'grupos: %', n; end if;
  select count(*) into n from public.catalog_modifiers;         if n <> 51 then raise exception 'opciones: %', n; end if;
  select count(*) into n from public.catalog_item_modifier_groups; if n <> 29 then raise exception 'producto-grupo: %', n; end if;
  select count(*) into n from public.stories;                   if n <> 11 then raise exception 'historias: %', n; end if;
  select count(*) into n from public.store_hours;               if n <> 7  then raise exception 'horario: %', n; end if;
  select count(*) into n from public.catalog_items where i18n -> 'es' ->> 'name' is null;
  if n <> 0 then raise exception 'productos sin nombre en español: %', n; end if;
  select count(*) into n from storage.buckets where id in ('menu-images', 'branding', 'stories');
  if n <> 3 then raise exception 'buckets: %', n; end if;
end
$$;

-- El cliente anónimo ve el menú (RLS + grants), en dólares y bilingüe.
set role anon;
do $$
declare
  n int;
begin
  select count(*) into n from public.menu_items where is_available;
  if n <> 53 then raise exception 'anon ve % productos disponibles (se esperaban 53)', n; end if;
  select count(*) into n from public.menu_items where i18n -> 'es' ->> 'name' is not null and category_i18n -> 'es' ->> 'name' is not null;
  if n <> 53 then raise exception 'anon ve % productos traducidos', n; end if;
  select count(*) into n from public.stories;
  if n <> 11 then raise exception 'anon ve % historias', n; end if;
  begin
    perform 1 from public.orders limit 1;
    select count(*) into n from public.orders;
    if n <> 0 then raise exception 'anon ve pedidos'; end if;
  exception when insufficient_privilege then null;
  end;
end
$$;
reset role;

select 'categorías' as que, count(*) from public.catalog_categories
union all select 'productos', count(*) from public.catalog_items
union all select 'opciones', count(*) from public.catalog_modifiers
union all select 'historias', count(*) from public.stories;
