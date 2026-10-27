-- =====================================================================
-- 0035_comunidad.sql
-- Comunidad VIVA: reseñas con estrellas y foto, preguntas, sugerencias a
-- la tienda, avisos de VIVA, respuestas entre clientes y de la tienda,
-- "Me sirvió", reportes, moderación con motivo y bitácora, avisos al
-- cliente y puntos por la primera reseña.
--
-- REGLAS
--   * Se publica solo el nombre y la inicial del apellido ("Ana L.").
--   * No se aceptan teléfonos, correos ni números de tarjeta/cuenta.
--   * "Cliente verificado" = ya recogió al menos un pedido en VIVA.
--   * Reseñas con N estrellas o más salen solas (N lo elige el dueño,
--     4 por defecto); las demás esperan revisión.
--   * Preguntas y respuestas salen solas; con 2 reportes de personas
--     distintas pasan a revisión.
--   * Sugerencias: solo las ven quien la escribió y el dueño.
--   * Moderar (publicar/ocultar con motivo), responder como VIVA,
--     publicar avisos y cambiar ajustes: SOLO el dueño. Todo queda en la
--     bitácora.
--
-- Todo pasa por funciones SECURITY DEFINER; las tablas no se leen ni se
-- escriben directo desde la app.
--
-- MIGRACION NUEVA. Idempotente.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Tablas
-- ---------------------------------------------------------------------
create table if not exists public.community_settings (
  restaurant_id   uuid primary key references public.restaurants(id) on delete cascade,
  enabled         boolean not null default true,
  -- Reseñas con estas estrellas o más se publican solas. 6 = ninguna.
  auto_min_stars  int not null default 4 check (auto_min_stars between 1 and 6),
  -- Puntos por la primera reseña publicada de cada cliente (0 = no).
  review_points   int not null default 10 check (review_points between 0 and 1000),
  updated_at      timestamptz not null default now()
);

create table if not exists public.community_posts (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null references public.restaurants(id) on delete cascade,
  author_id      uuid references auth.users(id) on delete set null,
  author_role    text not null check (author_role in ('customer', 'store')),
  author_name    text not null,
  kind           text not null check (kind in ('review', 'question', 'suggestion', 'announcement')),
  rating         smallint check (rating between 1 and 5),
  body           text not null check (length(btrim(body)) between 1 and 1000),
  photo_path     text check (photo_path is null or length(photo_path) <= 300),
  verified       boolean not null default false,
  status         text not null default 'published'
                 check (status in ('published', 'pending', 'reported', 'hidden')),
  hidden_reason  text,
  event_date     date,
  pinned         boolean not null default false,
  helpful_count  int not null default 0,
  reply_count    int not null default 0,
  report_count   int not null default 0,
  points_awarded int not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint community_posts_rating_for_reviews check ((kind = 'review') = (rating is not null))
);
create index if not exists idx_community_posts_feed on public.community_posts(restaurant_id, status, created_at desc);
create index if not exists idx_community_posts_author on public.community_posts(author_id, created_at desc);

create table if not exists public.community_replies (
  id             uuid primary key default gen_random_uuid(),
  post_id        uuid not null references public.community_posts(id) on delete cascade,
  author_id      uuid references auth.users(id) on delete set null,
  author_role    text not null check (author_role in ('customer', 'store')),
  author_name    text not null,
  verified       boolean not null default false,
  body           text not null check (length(btrim(body)) between 1 and 600),
  status         text not null default 'published' check (status in ('published', 'reported', 'hidden')),
  hidden_reason  text,
  report_count   int not null default 0,
  created_at     timestamptz not null default now()
);
create index if not exists idx_community_replies_post on public.community_replies(post_id, created_at);

create table if not exists public.community_helpful (
  post_id    uuid not null references public.community_posts(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

create table if not exists public.community_reports (
  id          uuid primary key default gen_random_uuid(),
  target_type text not null check (target_type in ('post', 'reply')),
  target_id   uuid not null,
  reporter_id uuid not null references auth.users(id) on delete cascade,
  reason      text not null check (length(reason) between 1 and 200),
  resolved    boolean not null default false,
  created_at  timestamptz not null default now(),
  unique (target_type, target_id, reporter_id)
);

-- Bitácora: quién hizo qué, sobre qué y por qué.
create table if not exists public.community_audit (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  actor_id      uuid references auth.users(id) on delete set null,
  action        text not null,
  target_type   text not null,
  target_id     uuid,
  reason        text,
  created_at    timestamptz not null default now()
);
create index if not exists idx_community_audit on public.community_audit(restaurant_id, created_at desc);

-- Avisos para el cliente: "VIVA te respondió", "a alguien le sirvió"…
create table if not exists public.community_notifications (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  kind          text not null check (kind in ('store_reply', 'reply', 'helpful', 'approved', 'hidden', 'points')),
  post_id       uuid references public.community_posts(id) on delete cascade,
  actor_name    text,
  points        int,
  read_at       timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists idx_community_notif_user on public.community_notifications(user_id, read_at, created_at desc);

do $$
declare t text;
begin
  foreach t in array array['community_settings', 'community_posts', 'community_replies', 'community_helpful',
                           'community_reports', 'community_audit', 'community_notifications'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 2. Ayudantes
-- ---------------------------------------------------------------------
-- "Ana L.": nombre y la inicial del apellido. Nunca el correo.
create or replace function app.public_name(p_user uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select coalesce(
    nullif(btrim(concat_ws(' ',
      nullif(btrim(split_part(coalesce(p.first_name, ''), ' ', 1)), ''),
      case when nullif(btrim(p.last_name), '') is null then null else upper(left(btrim(p.last_name), 1)) || '.' end)), ''),
    'Cliente VIVA')
  from (select 1) x left join public.profiles p on p.id = p_user;
$$;

-- ¿El texto trae datos personales? Devuelve el motivo o null.
-- Teléfonos y números de tarjeta/cuenta: 10 dígitos o más seguidos
-- (aunque lleven espacios, guiones, puntos o paréntesis). Correos.
create or replace function app.community_blocked(p_text text)
returns text
language plpgsql
immutable
as $$
declare
  m text[];
begin
  if p_text ~* '[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}' then
    return 'email';
  end if;
  for m in select regexp_matches(p_text, '[+(]?[0-9][0-9 ().-]{6,}[0-9]', 'g') loop
    if length(regexp_replace(m[1], '[^0-9]', '', 'g')) >= 10 then
      return 'number';
    end if;
  end loop;
  return null;
end;
$$;

create or replace function app.community_settings_for(p_restaurant uuid)
returns public.community_settings
language plpgsql
volatile
security definer
set search_path = public, pg_catalog
as $$
declare v public.community_settings%rowtype;
begin
  insert into public.community_settings (restaurant_id) values (p_restaurant) on conflict do nothing;
  select * into v from public.community_settings where restaurant_id = p_restaurant;
  return v;
end;
$$;

create or replace function app.community_verified(p_restaurant uuid, p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select exists (
    select 1 from public.orders o
     where o.tenant_id = p_restaurant and o.user_id = p_user and o.status in ('confirmed', 'preparing', 'ready', 'completed')
  );
$$;

create or replace function app.community_notify(
  p_user uuid, p_restaurant uuid, p_kind text, p_post uuid, p_actor text, p_points int default null
)
returns void
language sql
volatile
security definer
set search_path = public, pg_catalog
as $$
  insert into public.community_notifications (user_id, restaurant_id, kind, post_id, actor_name, points)
  select p_user, p_restaurant, p_kind, p_post, p_actor, p_points
   where p_user is not null;
$$;

create or replace function app.community_log(
  p_restaurant uuid, p_action text, p_type text, p_target uuid, p_reason text
)
returns void
language sql
volatile
security definer
set search_path = public, pg_catalog
as $$
  insert into public.community_audit (restaurant_id, actor_id, action, target_type, target_id, reason)
  values (p_restaurant, auth.uid(), p_action, p_type, p_target, p_reason);
$$;

-- Puntos por la PRIMERA reseña publicada de un cliente (si el programa
-- de puntos está activo y el dueño puso puntos).
create or replace function app.community_award(p_post uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public, app, pg_catalog
as $$
declare
  v_post    public.community_posts%rowtype;
  v_points  int;
  v_account public.loyalty_accounts%rowtype;
begin
  select * into v_post from public.community_posts where id = p_post for update;
  if not found or v_post.kind <> 'review' or v_post.status <> 'published'
     or v_post.author_role <> 'customer' or v_post.author_id is null or v_post.points_awarded > 0 then
    return;
  end if;
  if exists (select 1 from public.community_posts
              where restaurant_id = v_post.restaurant_id and author_id = v_post.author_id
                and kind = 'review' and points_awarded > 0) then
    return;
  end if;
  select review_points into v_points from app.community_settings_for(v_post.restaurant_id);
  if coalesce(v_points, 0) <= 0 then return; end if;
  if not exists (select 1 from public.loyalty_programs where restaurant_id = v_post.restaurant_id and enabled) then
    return;
  end if;

  v_account := app.loyalty_account_for(v_post.restaurant_id, v_post.author_id);
  insert into public.loyalty_transactions (account_id, delta_points, reason, source)
  values (v_account.id, v_points, 'earn', 'adjust');
  update public.loyalty_accounts
     set points_balance = points_balance + v_points, lifetime_points = lifetime_points + v_points
   where id = v_account.id;
  update public.community_posts set points_awarded = v_points where id = v_post.id;
  perform app.community_notify(v_post.author_id, v_post.restaurant_id, 'points', v_post.id, null, v_points);
end;
$$;

create or replace function app.store_display_name(p_restaurant uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select coalesce(
    (select nullif(btrim(app_display_name), '') from public.app_settings where restaurant_id = p_restaurant),
    (select name from public.restaurants where id = p_restaurant),
    'VIVA');
$$;

-- ---------------------------------------------------------------------
-- 3. Lo que ve todo el mundo
-- ---------------------------------------------------------------------
create or replace function public.community_summary(p_restaurant_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, app, pg_catalog
as $$
  select jsonb_build_object(
    'enabled', coalesce((select enabled from public.community_settings where restaurant_id = p_restaurant_id), true),
    'reviews', count(*) filter (where kind = 'review'),
    'average', round(avg(rating) filter (where kind = 'review'), 1),
    'stars', jsonb_build_object(
      '5', count(*) filter (where rating = 5), '4', count(*) filter (where rating = 4),
      '3', count(*) filter (where rating = 3), '2', count(*) filter (where rating = 2),
      '1', count(*) filter (where rating = 1))
  )
  from public.community_posts
  where restaurant_id = p_restaurant_id and status = 'published';
$$;

create or replace function public.community_feed(
  p_restaurant_id uuid, p_kind text default null, p_before timestamptz default null, p_limit int default 20,
  p_post_id uuid default null
)
returns table (
  id uuid, kind text, rating smallint, body text, photo_path text, author_name text, author_role text,
  verified boolean, status text, hidden_reason text, event_date date, pinned boolean, helpful_count int,
  reply_count int, created_at timestamptz, mine boolean, helped boolean, store_replied boolean
)
language sql
stable
security definer
set search_path = public, app, pg_catalog
as $$
  select p.id, p.kind, p.rating, p.body, p.photo_path, p.author_name, p.author_role, p.verified, p.status,
         case when p.author_id = auth.uid() then p.hidden_reason end,
         p.event_date, p.pinned, p.helpful_count, p.reply_count, p.created_at,
         coalesce(p.author_id = auth.uid(), false),
         exists (select 1 from public.community_helpful h where h.post_id = p.id and h.user_id = auth.uid()),
         exists (select 1 from public.community_replies r
                  where r.post_id = p.id and r.author_role = 'store' and r.status = 'published')
    from public.community_posts p
   where p.restaurant_id = p_restaurant_id
     and coalesce((select enabled from public.community_settings s where s.restaurant_id = p_restaurant_id), true)
     and (
       -- Lo público…
       (p.status = 'published' and p.kind <> 'suggestion')
       -- …y lo propio, en el estado que esté (para ver "En revisión").
       or (auth.uid() is not null and p.author_id = auth.uid())
       -- …y, al abrir una sola, el dueño la ve aunque esté oculta.
       or (p_post_id is not null and app.owns_restaurant(p.restaurant_id))
     )
     and (p_post_id is null or p.id = p_post_id)
     and (p_kind is null or p.kind = p_kind)
     and (p_before is null or p.created_at < p_before)
   order by (p.pinned and p_before is null) desc, p.created_at desc
   limit least(greatest(coalesce(p_limit, 20), 1), 50);
$$;

create or replace function public.community_thread(p_post_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, app, pg_catalog
as $$
declare
  v_post public.community_posts%rowtype;
  v_me   uuid := auth.uid();
begin
  select * into v_post from public.community_posts where id = p_post_id;
  if not found
     or not (
       (v_post.status = 'published' and v_post.kind <> 'suggestion')
       or (v_me is not null and v_post.author_id = v_me)
       or app.owns_restaurant(v_post.restaurant_id)
     ) then
    raise exception 'post_not_found' using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'post', (select to_jsonb(f) from public.community_feed(v_post.restaurant_id, null, null, 1, v_post.id) f),
    'replies', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', r.id, 'body', r.body, 'author_name', r.author_name, 'author_role', r.author_role,
               'verified', r.verified, 'created_at', r.created_at, 'mine', coalesce(r.author_id = v_me, false),
               'status', r.status)
             order by r.created_at)
        from public.community_replies r
       where r.post_id = v_post.id
         and (r.status = 'published' or (v_me is not null and r.author_id = v_me))), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------
-- 4. Lo que hace el cliente
-- ---------------------------------------------------------------------
create or replace function public.community_post(
  p_restaurant_id uuid, p_kind text, p_body text, p_rating int default null, p_photo_path text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, app, pg_catalog
as $$
declare
  v_me       uuid := auth.uid();
  v_settings public.community_settings%rowtype;
  v_status   text;
  v_id       uuid;
  v_blocked  text;
begin
  if v_me is null then raise exception 'auth_required' using errcode = '28000'; end if;
  if not exists (select 1 from public.restaurants where id = p_restaurant_id) then
    raise exception 'restaurant_not_found' using errcode = 'P0002';
  end if;
  v_settings := app.community_settings_for(p_restaurant_id);
  if not v_settings.enabled then raise exception 'community_disabled' using errcode = '22023'; end if;
  if p_kind not in ('review', 'question', 'suggestion') then raise exception 'invalid_kind' using errcode = '22023'; end if;
  if p_kind = 'review' and (p_rating is null or p_rating not between 1 and 5) then
    raise exception 'rating_required' using errcode = '22023';
  end if;
  if length(btrim(coalesce(p_body, ''))) not between 1 and 1000 then
    raise exception 'body_length' using errcode = '22023';
  end if;
  v_blocked := app.community_blocked(p_body);
  if v_blocked is not null then raise exception 'contact_info_blocked:%', v_blocked using errcode = '22023'; end if;
  if p_photo_path is not null and p_photo_path not like v_me::text || '/%' then
    raise exception 'invalid_photo' using errcode = '22023';
  end if;
  if (select count(*) from public.community_posts
       where author_id = v_me and created_at > now() - interval '1 day') >= 5 then
    raise exception 'too_many_posts' using errcode = '22023';
  end if;

  v_status := case
    when p_kind = 'review' and p_rating < v_settings.auto_min_stars then 'pending'
    else 'published' end;

  insert into public.community_posts
    (restaurant_id, author_id, author_role, author_name, kind, rating, body, photo_path, verified, status)
  values
    (p_restaurant_id, v_me, 'customer', app.public_name(v_me), p_kind,
     case when p_kind = 'review' then p_rating end, btrim(p_body), p_photo_path,
     app.community_verified(p_restaurant_id, v_me), v_status)
  returning id into v_id;

  perform app.community_award(v_id);
  return jsonb_build_object('id', v_id, 'status', v_status,
                            'points', (select points_awarded from public.community_posts where id = v_id));
end;
$$;

create or replace function public.community_reply(p_post_id uuid, p_body text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, app, pg_catalog
as $$
declare
  v_me      uuid := auth.uid();
  v_post    public.community_posts%rowtype;
  v_store   boolean;
  v_name    text;
  v_blocked text;
  v_id      uuid;
begin
  if v_me is null then raise exception 'auth_required' using errcode = '28000'; end if;
  select * into v_post from public.community_posts where id = p_post_id for update;
  if not found then raise exception 'post_not_found' using errcode = 'P0002'; end if;
  v_store := app.owns_restaurant(v_post.restaurant_id);
  if not v_store and not (v_post.status = 'published' and v_post.kind <> 'suggestion')
     and v_post.author_id is distinct from v_me then
    raise exception 'post_not_found' using errcode = 'P0002';
  end if;
  if not v_store and not (select enabled from app.community_settings_for(v_post.restaurant_id)) then
    raise exception 'community_disabled' using errcode = '22023';
  end if;
  if length(btrim(coalesce(p_body, ''))) not between 1 and 600 then
    raise exception 'body_length' using errcode = '22023';
  end if;
  v_blocked := app.community_blocked(p_body);
  if v_blocked is not null and not v_store then
    raise exception 'contact_info_blocked:%', v_blocked using errcode = '22023';
  end if;
  if not v_store and (select count(*) from public.community_replies
                       where author_id = v_me and created_at > now() - interval '1 day') >= 30 then
    raise exception 'too_many_posts' using errcode = '22023';
  end if;

  v_name := case when v_store then app.store_display_name(v_post.restaurant_id) else app.public_name(v_me) end;
  insert into public.community_replies (post_id, author_id, author_role, author_name, verified, body)
  values (v_post.id, v_me, case when v_store then 'store' else 'customer' end, v_name,
          case when v_store then false else app.community_verified(v_post.restaurant_id, v_me) end, btrim(p_body))
  returning id into v_id;
  update public.community_posts set reply_count = reply_count + 1, updated_at = now() where id = v_post.id;

  if v_post.author_id is distinct from v_me then
    perform app.community_notify(v_post.author_id, v_post.restaurant_id,
                                 case when v_store then 'store_reply' else 'reply' end, v_post.id, v_name);
  end if;
  if v_store then
    perform app.community_log(v_post.restaurant_id, 'reply', 'post', v_post.id, null);
  end if;
  return jsonb_build_object('id', v_id);
end;
$$;

create or replace function public.community_helpful(p_post_id uuid, p_on boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, app, pg_catalog
as $$
declare
  v_me    uuid := auth.uid();
  v_post  public.community_posts%rowtype;
  v_count int;
begin
  if v_me is null then raise exception 'auth_required' using errcode = '28000'; end if;
  select * into v_post from public.community_posts where id = p_post_id and status = 'published' for update;
  if not found then raise exception 'post_not_found' using errcode = 'P0002'; end if;

  if p_on then
    insert into public.community_helpful (post_id, user_id) values (p_post_id, v_me) on conflict do nothing;
    get diagnostics v_count = row_count;
    if v_count > 0 then
      update public.community_posts set helpful_count = helpful_count + 1 where id = p_post_id;
      if v_post.author_id is distinct from v_me then
        perform app.community_notify(v_post.author_id, v_post.restaurant_id, 'helpful', p_post_id, app.public_name(v_me));
      end if;
    end if;
  else
    delete from public.community_helpful where post_id = p_post_id and user_id = v_me;
    get diagnostics v_count = row_count;
    if v_count > 0 then
      update public.community_posts set helpful_count = greatest(helpful_count - 1, 0) where id = p_post_id;
    end if;
  end if;
  return jsonb_build_object('helpful_count', (select helpful_count from public.community_posts where id = p_post_id));
end;
$$;

-- Reportar: con 2 reportes de personas distintas pasa a revisión.
create or replace function public.community_report(p_type text, p_id uuid, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, app, pg_catalog
as $$
declare
  v_me         uuid := auth.uid();
  v_restaurant uuid;
  v_author     uuid;
  v_count      int;
begin
  if v_me is null then raise exception 'auth_required' using errcode = '28000'; end if;
  if p_type = 'post' then
    select restaurant_id, author_id into v_restaurant, v_author from public.community_posts where id = p_id;
  elsif p_type = 'reply' then
    select p.restaurant_id, r.author_id into v_restaurant, v_author
      from public.community_replies r join public.community_posts p on p.id = r.post_id where r.id = p_id;
  else
    raise exception 'invalid_target' using errcode = '22023';
  end if;
  if v_restaurant is null then raise exception 'post_not_found' using errcode = 'P0002'; end if;
  if v_author = v_me then raise exception 'own_content' using errcode = '22023'; end if;

  insert into public.community_reports (target_type, target_id, reporter_id, reason)
  values (p_type, p_id, v_me, left(coalesce(nullif(btrim(p_reason), ''), 'otro'), 200))
  on conflict do nothing;
  select count(*) into v_count from public.community_reports
   where target_type = p_type and target_id = p_id and not resolved;

  if p_type = 'post' then
    update public.community_posts
       set report_count = v_count,
           status = case when v_count >= 2 and status = 'published' then 'reported' else status end
     where id = p_id;
  else
    update public.community_replies
       set report_count = v_count,
           status = case when v_count >= 2 and status = 'published' then 'reported' else status end
     where id = p_id;
  end if;
  return jsonb_build_object('reports', v_count);
end;
$$;

create or replace function public.community_my_notifications(p_restaurant_id uuid, p_mark_read boolean default false)
returns table (id uuid, kind text, post_id uuid, actor_name text, points int, created_at timestamptz, read boolean)
language plpgsql
volatile
security definer
set search_path = public, app, pg_catalog
as $$
begin
  if auth.uid() is null then return; end if;
  return query
    select n.id, n.kind, n.post_id, n.actor_name, n.points, n.created_at, n.read_at is not null
      from public.community_notifications n
     where n.user_id = auth.uid() and n.restaurant_id = p_restaurant_id
     order by n.created_at desc
     limit 30;
  if p_mark_read then
    update public.community_notifications set read_at = now()
     where user_id = auth.uid() and restaurant_id = p_restaurant_id and read_at is null;
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- 5. Lo que hace el dueño
-- ---------------------------------------------------------------------
create or replace function public.community_admin_list(p_restaurant_id uuid, p_filter text default 'review')
returns table (
  id uuid, kind text, rating smallint, body text, photo_path text, author_name text, author_role text,
  author_email text, verified boolean, status text, hidden_reason text, event_date date, pinned boolean,
  helpful_count int, reply_count int, report_count int, report_reasons text[], created_at timestamptz,
  replies jsonb
)
language plpgsql
stable
security definer
set search_path = public, app, pg_catalog
as $$
begin
  if not app.owns_restaurant(p_restaurant_id) then raise exception 'owner_only' using errcode = '42501'; end if;
  return query
    select p.id, p.kind, p.rating, p.body, p.photo_path, p.author_name, p.author_role,
           u.email::text, p.verified, p.status, p.hidden_reason, p.event_date, p.pinned,
           p.helpful_count, p.reply_count, p.report_count,
           array(select r.reason from public.community_reports r
                  where r.target_type = 'post' and r.target_id = p.id and not r.resolved),
           p.created_at,
           coalesce((select jsonb_agg(jsonb_build_object(
                       'id', r.id, 'body', r.body, 'author_name', r.author_name, 'author_role', r.author_role,
                       'status', r.status, 'report_count', r.report_count, 'created_at', r.created_at)
                     order by r.created_at)
                       from public.community_replies r where r.post_id = p.id), '[]'::jsonb)
      from public.community_posts p
      left join auth.users u on u.id = p.author_id
     where p.restaurant_id = p_restaurant_id
       and case p_filter
             -- Por revisar: reseñas pendientes, publicaciones o respuestas reportadas.
             when 'review' then p.status in ('pending', 'reported')
                             or exists (select 1 from public.community_replies r
                                         where r.post_id = p.id and r.status = 'reported')
             when 'published' then p.status = 'published' and p.kind <> 'suggestion'
             when 'hidden' then p.status = 'hidden'
             when 'suggestion' then p.kind = 'suggestion'
             when 'announcement' then p.kind = 'announcement'
             else true
           end
     order by p.created_at desc
     limit 100;
end;
$$;

create or replace function public.community_moderate(p_type text, p_id uuid, p_action text, p_reason text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, app, pg_catalog
as $$
declare
  v_restaurant uuid;
  v_author     uuid;
  v_post       uuid;
  v_before     text;
begin
  if p_action not in ('publish', 'hide') then raise exception 'invalid_action' using errcode = '22023'; end if;
  if p_action = 'hide' and length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  if p_type = 'post' then
    select restaurant_id, author_id, id, status into v_restaurant, v_author, v_post, v_before
      from public.community_posts where id = p_id for update;
  elsif p_type = 'reply' then
    select p.restaurant_id, r.author_id, p.id, r.status into v_restaurant, v_author, v_post, v_before
      from public.community_replies r join public.community_posts p on p.id = r.post_id where r.id = p_id for update of r;
  else
    raise exception 'invalid_target' using errcode = '22023';
  end if;
  if v_restaurant is null or not app.owns_restaurant(v_restaurant) then
    raise exception 'owner_only' using errcode = '42501';
  end if;

  if p_type = 'post' then
    update public.community_posts
       set status = case when p_action = 'publish' then 'published' else 'hidden' end,
           hidden_reason = case when p_action = 'hide' then btrim(p_reason) end,
           report_count = case when p_action = 'publish' then 0 else report_count end,
           updated_at = now()
     where id = p_id;
  else
    update public.community_replies
       set status = case when p_action = 'publish' then 'published' else 'hidden' end,
           hidden_reason = case when p_action = 'hide' then btrim(p_reason) end,
           report_count = case when p_action = 'publish' then 0 else report_count end
     where id = p_id;
  end if;
  update public.community_reports set resolved = true where target_type = p_type and target_id = p_id;

  perform app.community_log(v_restaurant, p_action, p_type, p_id, nullif(btrim(coalesce(p_reason, '')), ''));
  if v_before <> 'published' and p_action = 'publish' and p_type = 'post' then
    perform app.community_notify(v_author, v_restaurant, 'approved', v_post, null);
    perform app.community_award(v_post);
  elsif p_action = 'hide' and v_before <> 'hidden' then
    perform app.community_notify(v_author, v_restaurant, 'hidden', v_post, null);
  end if;
  return jsonb_build_object('status', case when p_action = 'publish' then 'published' else 'hidden' end);
end;
$$;

-- Avisos de VIVA para la comunidad (eventos, sabor nuevo, horario de días festivos…).
create or replace function public.community_store_post(
  p_restaurant_id uuid, p_body text, p_photo_path text default null, p_event_date date default null,
  p_pinned boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, app, pg_catalog
as $$
declare v_id uuid;
begin
  if not app.owns_restaurant(p_restaurant_id) then raise exception 'owner_only' using errcode = '42501'; end if;
  if length(btrim(coalesce(p_body, ''))) not between 1 and 1000 then
    raise exception 'body_length' using errcode = '22023';
  end if;
  if p_photo_path is not null and p_photo_path not like auth.uid()::text || '/%' then
    raise exception 'invalid_photo' using errcode = '22023';
  end if;
  if coalesce(p_pinned, false) then
    update public.community_posts set pinned = false where restaurant_id = p_restaurant_id and pinned;
  end if;
  insert into public.community_posts
    (restaurant_id, author_id, author_role, author_name, kind, body, photo_path, event_date, pinned, status)
  values
    (p_restaurant_id, auth.uid(), 'store', app.store_display_name(p_restaurant_id), 'announcement',
     btrim(p_body), p_photo_path, p_event_date, coalesce(p_pinned, false), 'published')
  returning id into v_id;
  perform app.community_log(p_restaurant_id, 'announce', 'post', v_id, null);
  return jsonb_build_object('id', v_id);
end;
$$;

create or replace function public.community_delete_announcement(p_post_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public, app, pg_catalog
as $$
declare v_restaurant uuid;
begin
  select restaurant_id into v_restaurant from public.community_posts where id = p_post_id and kind = 'announcement';
  if v_restaurant is null or not app.owns_restaurant(v_restaurant) then
    raise exception 'owner_only' using errcode = '42501';
  end if;
  delete from public.community_posts where id = p_post_id;
  perform app.community_log(v_restaurant, 'delete_announcement', 'post', p_post_id, null);
end;
$$;

create or replace function public.community_get_settings(p_restaurant_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, app, pg_catalog
as $$
declare v public.community_settings%rowtype;
begin
  if not app.owns_restaurant(p_restaurant_id) then raise exception 'owner_only' using errcode = '42501'; end if;
  v := app.community_settings_for(p_restaurant_id);
  return jsonb_build_object('enabled', v.enabled, 'auto_min_stars', v.auto_min_stars, 'review_points', v.review_points,
    'pending', (select count(*) from public.community_posts
                 where restaurant_id = p_restaurant_id and status in ('pending', 'reported'))
             + (select count(*) from public.community_replies r join public.community_posts p on p.id = r.post_id
                 where p.restaurant_id = p_restaurant_id and r.status = 'reported'));
end;
$$;

create or replace function public.community_save_settings(
  p_restaurant_id uuid, p_enabled boolean, p_auto_min_stars int, p_review_points int
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, app, pg_catalog
as $$
begin
  if not app.owns_restaurant(p_restaurant_id) then raise exception 'owner_only' using errcode = '42501'; end if;
  perform app.community_settings_for(p_restaurant_id);
  update public.community_settings
     set enabled = coalesce(p_enabled, enabled),
         auto_min_stars = coalesce(p_auto_min_stars, auto_min_stars),
         review_points = coalesce(p_review_points, review_points),
         updated_at = now()
   where restaurant_id = p_restaurant_id;
  -- La pestaña Comunidad de la app sigue a este interruptor.
  update public.app_settings
     set features = coalesce(features, '{}'::jsonb) || jsonb_build_object('community', coalesce(p_enabled, true))
   where restaurant_id = p_restaurant_id;
  perform app.community_log(p_restaurant_id, 'settings', 'settings', null,
    format('activa=%s estrellas=%s puntos=%s', p_enabled, p_auto_min_stars, p_review_points));
  return public.community_get_settings(p_restaurant_id);
end;
$$;

create or replace function public.community_audit_list(p_restaurant_id uuid)
returns table (created_at timestamptz, who text, action text, target_type text, reason text, excerpt text)
language plpgsql
stable
security definer
set search_path = public, app, pg_catalog
as $$
begin
  if not app.owns_restaurant(p_restaurant_id) then raise exception 'owner_only' using errcode = '42501'; end if;
  return query
    select a.created_at,
           coalesce(nullif(btrim(concat_ws(' ', pr.first_name, pr.last_name)), ''), u.email::text),
           a.action, a.target_type, a.reason,
           left(coalesce((select p.body from public.community_posts p where p.id = a.target_id),
                         (select r.body from public.community_replies r where r.id = a.target_id), ''), 80)
      from public.community_audit a
      left join auth.users u on u.id = a.actor_id
      left join public.profiles pr on pr.id = a.actor_id
     where a.restaurant_id = p_restaurant_id
     order by a.created_at desc
     limit 100;
end;
$$;

-- ---------------------------------------------------------------------
-- 6. Fotos de la comunidad: bucket público; cada quien sube a su carpeta.
-- ---------------------------------------------------------------------
do $$
begin
  if to_regclass('storage.objects') is null then
    raise notice 'Esquema storage no disponible: se omite la parte de fotos de 0035.';
    return;
  end if;
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('community', 'community', true, 3145728, array['image/jpeg', 'image/png', 'image/webp'])
  on conflict (id) do update set public = true, file_size_limit = 3145728,
    allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

  drop policy if exists "people upload community photos" on storage.objects;
  create policy "people upload community photos" on storage.objects
    for insert to authenticated
    with check (bucket_id = 'community' and (storage.foldername(name))[1] = auth.uid()::text);
  drop policy if exists "people manage their community photos" on storage.objects;
  create policy "people manage their community photos" on storage.objects
    for delete to authenticated
    using (bucket_id = 'community' and (storage.foldername(name))[1] = auth.uid()::text);
end;
$$;

-- ---------------------------------------------------------------------
-- 7. Permisos
-- ---------------------------------------------------------------------
do $$
declare f text;
begin
  -- Leer: también sin sesión (la comunidad se ve antes de crear cuenta).
  foreach f in array array[
    'public.community_summary(uuid)',
    'public.community_feed(uuid, text, timestamptz, int, uuid)',
    'public.community_thread(uuid)'
  ] loop
    execute format('revoke execute on function %s from public', f);
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
  foreach f in array array[
    'public.community_post(uuid, text, text, int, text)',
    'public.community_reply(uuid, text)',
    'public.community_helpful(uuid, boolean)',
    'public.community_report(text, uuid, text)',
    'public.community_my_notifications(uuid, boolean)',
    'public.community_admin_list(uuid, text)',
    'public.community_moderate(text, uuid, text, text)',
    'public.community_store_post(uuid, text, text, date, boolean)',
    'public.community_delete_announcement(uuid)',
    'public.community_get_settings(uuid)',
    'public.community_save_settings(uuid, boolean, int, int)',
    'public.community_audit_list(uuid)'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'app.community_settings_for(uuid)', 'app.community_verified(uuid, uuid)',
    'app.community_notify(uuid, uuid, text, uuid, text, int)', 'app.community_log(uuid, text, text, uuid, text)',
    'app.community_award(uuid)', 'app.public_name(uuid)', 'app.store_display_name(uuid)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;
end;
$$;
