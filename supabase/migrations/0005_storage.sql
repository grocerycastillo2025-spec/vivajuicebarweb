-- =====================================================================
-- 0005_storage.sql
-- Buckets de Supabase Storage.
--   branding    -> logos, iconos, splash, banners (publico)
--   menu-images -> fotos de producto (publico). Ver §8.4: es el unico
--                  punto donde duplicamos catalogo a proposito, porque
--                  las imagenes de Clover no dan la calidad que queremos.
--   receipts    -> comprobantes y adjuntos de soporte (privado)
--
-- Escritura: solo administradores de plataforma. Lectura: publica en los
-- dos primeros, porque la app los consume sin sesion iniciada.
-- =====================================================================

do $$
begin
  if to_regclass('storage.buckets') is null then
    raise notice 'Esquema storage no disponible: se omite 0005 (correr en Supabase).';
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values
    ('branding',    'branding',    true,  5242880,
     array['image/png','image/jpeg','image/webp','image/svg+xml']),
    ('menu-images', 'menu-images', true,  5242880,
     array['image/png','image/jpeg','image/webp']),
    ('receipts',    'receipts',    false, 10485760,
     array['application/pdf','image/png','image/jpeg'])
  on conflict (id) do nothing;

  -- Lectura publica de branding e imagenes de menu.
  execute $p$
    create policy "public read branding assets" on storage.objects
      for select to anon, authenticated
      using (bucket_id in ('branding', 'menu-images'))
  $p$;

  -- Escritura reservada a administradores.
  execute $p$
    create policy "admins manage branding assets" on storage.objects
      for all to authenticated
      using (bucket_id in ('branding','menu-images') and app.is_platform_admin())
      with check (bucket_id in ('branding','menu-images') and app.is_platform_admin())
  $p$;

  execute $p$
    create policy "admins manage receipts" on storage.objects
      for all to authenticated
      using (bucket_id = 'receipts' and app.is_platform_admin())
      with check (bucket_id = 'receipts' and app.is_platform_admin())
  $p$;
exception
  when duplicate_object then
    raise notice 'Policies de storage ya existentes: se omiten.';
end;
$$;

-- Convencion de rutas (obligatoria, para poder limpiar por tenant):
--   branding/{restaurant_id}/logo.png
--   branding/{restaurant_id}/banners/{uuid}.webp
--   menu-images/{store_id}/{clover_item_id}.webp
--   receipts/{restaurant_id}/{order_id}.pdf
