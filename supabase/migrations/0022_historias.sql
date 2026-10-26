-- =====================================================================
-- 0022_historias.sql
-- Historias tipo Instagram/TikTok: el negocio sube fotos o videos cortos
-- para ofrecer productos, y los clientes las ven en la pantalla de inicio.
--
-- Cada historia puede:
--   * ser imagen o video (`media_type`);
--   * llevar un texto corto (`caption`);
--   * apuntar a un producto del menu (`item_id`): el visor ofrece
--     "Pedir" y lleva al producto;
--   * caducar (`expires_at`, 24 h por defecto en el panel) o quedarse
--     fija como "destacada" (`expires_at` nulo);
--   * programarse (`starts_at` en el futuro).
--
-- Lectura publica solo de las vigentes de un negocio activo. Escritura
-- solo del dueño (0020). Los archivos van al bucket `stories`, en la
-- carpeta del negocio.
--
-- MIGRACION NUEVA. Las 0001 a 0021 estan aplicadas y no se tocan.
-- =====================================================================

create table if not exists public.stories (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  media_url     text not null check (media_url ~ '^https?://'),
  media_type    text not null default 'image' check (media_type in ('image', 'video')),
  caption       text check (caption is null or char_length(caption) <= 200),
  item_id       uuid references public.catalog_items(id) on delete set null,
  starts_at     timestamptz not null default now(),
  expires_at    timestamptz,
  sort_order    int not null default 0,
  created_at    timestamptz not null default now(),
  created_by    uuid references auth.users(id) on delete set null default auth.uid(),
  constraint stories_window check (expires_at is null or expires_at > starts_at)
);

create index if not exists idx_stories_restaurant
  on public.stories(restaurant_id, starts_at desc);

comment on table public.stories is
  'Historias del negocio (imagen o video). expires_at nulo = destacada, '
  'no caduca. Ver 0022.';

alter table public.stories enable row level security;

-- El cliente ve las vigentes de un negocio activo.
create policy stories_public_read on public.stories
  for select to anon, authenticated
  using (
    starts_at <= now()
    and (expires_at is null or expires_at > now())
    and exists (
      select 1 from public.restaurants r
      where r.id = stories.restaurant_id and r.status = 'active'
    )
  );

-- El dueño ve todas (tambien caducadas y programadas) y las administra.
create policy stories_owner_all on public.stories
  for all to authenticated
  using (app.owns_restaurant(restaurant_id))
  with check (app.owns_restaurant(restaurant_id));

grant select on public.stories to anon, authenticated;
grant insert, update, delete on public.stories to authenticated;


-- ---------------------------------------------------------------------
-- Archivos: bucket publico `stories`, carpeta por negocio.
--   stories/{restaurant_id}/{archivo}
-- 50 MB es el maximo por archivo del plan gratuito de Supabase; un video
-- vertical de 15-30 s en 720p queda muy por debajo.
-- ---------------------------------------------------------------------
do $$
begin
  if to_regclass('storage.buckets') is null then
    raise notice 'Esquema storage no disponible: se omite la parte de archivos de 0022.';
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('stories', 'stories', true, 52428800,
          array['image/jpeg', 'image/png', 'image/webp',
                'video/mp4', 'video/webm', 'video/quicktime'])
  on conflict (id) do nothing;

  execute $p$
    create policy "public read stories" on storage.objects
      for select to anon, authenticated
      using (bucket_id = 'stories')
  $p$;

  execute $p$
    create policy "owners manage their stories" on storage.objects
      for all to authenticated
      using (
        bucket_id = 'stories'
        and exists (
          select 1 from public.restaurants r
          where r.id::text = (storage.foldername(name))[1]
            and app.owns_restaurant(r.id)
        )
      )
      with check (
        bucket_id = 'stories'
        and exists (
          select 1 from public.restaurants r
          where r.id::text = (storage.foldername(name))[1]
            and app.owns_restaurant(r.id)
        )
      )
  $p$;
exception
  when duplicate_object then
    raise notice 'Policies de storage de 0022 ya existentes: se omiten.';
end;
$$;
