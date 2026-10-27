-- =====================================================================
-- Pruebas de 0035: Comunidad VIVA.
-- =====================================================================

\set ON_ERROR_STOP on

\i supabase/seed/viva_juice_us.sql
begin;

insert into auth.users (id, email) values
  ('c5c5c5c5-0000-4000-8000-000000000001', 'owner35@vivajuice.test'),
  ('c5c5c5c5-0000-4000-8000-000000000002', 'tienda35@vivajuice.test'),
  ('c5c5c5c5-0000-4000-8000-000000000003', 'ana35@example.test'),
  ('c5c5c5c5-0000-4000-8000-000000000004', 'beto35@example.test'),
  ('c5c5c5c5-0000-4000-8000-000000000005', 'caro35@example.test');
insert into public.profiles (id, first_name, last_name) values
  ('c5c5c5c5-0000-4000-8000-000000000003', 'Ana María', 'López'),
  ('c5c5c5c5-0000-4000-8000-000000000004', 'Beto', null)
on conflict (id) do update set first_name = excluded.first_name, last_name = excluded.last_name;
select app.grant_restaurant_role('owner35@vivajuice.test', '11111111-1111-4111-8111-111111111111', 'owner');
select app.grant_restaurant_role('tienda35@vivajuice.test', '11111111-1111-4111-8111-111111111111', 'staff');
insert into public.loyalty_programs (restaurant_id, enabled) values ('11111111-1111-4111-8111-111111111111', true)
on conflict (restaurant_id) do update set enabled = true;
-- Ana ya recogió un pedido: cliente verificado.
insert into public.orders (tenant_id, store_id, order_number, user_id, status, subtotal_cents, total_cents)
values ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 9351,
        'c5c5c5c5-0000-4000-8000-000000000003', 'completed', 850, 850);

create or replace function pg_temp.como(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
  if p_user is null then execute 'set local role anon'; else execute 'set local role authenticated'; end if;
end $$;

create or replace function pg_temp.esperar_error(p_sql text, p_contiene text) returns void language plpgsql as $$
begin
  execute p_sql;
  raise exception 'SE ESPERABA ERROR (%): %', p_contiene, p_sql;
exception when others then
  if sqlerrm like 'SE ESPERABA ERROR%' then raise; end if;
  if p_contiene is not null and position(p_contiene in sqlerrm) = 0 then
    raise exception 'Error distinto al esperado (%): %', p_contiene, sqlerrm;
  end if;
end $$;

create temp table _t (k text primary key, v text);
grant all on _t to anon, authenticated;

-- Datos personales: bloqueados.
do $$ begin
  if app.community_blocked('llámame al (732) 555-0142') is distinct from 'number' then raise exception 'teléfono'; end if;
  if app.community_blocked('escríbeme a ana@gmail.com') is distinct from 'email' then raise exception 'correo'; end if;
  if app.community_blocked('mi tarjeta 4242 4242 4242 4242') is distinct from 'number' then raise exception 'tarjeta'; end if;
  if app.community_blocked('El Viva Berry de 16 oz por $8.50 está buenísimo, 10/10') is not null then
    raise exception 'Bloqueó un comentario normal';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Ana: reseña de 5 estrellas → sale sola, verificada, "Ana L.", 10 puntos.
-- ---------------------------------------------------------------------
select pg_temp.como('c5c5c5c5-0000-4000-8000-000000000003');
insert into _t select 'r5', (public.community_post('11111111-1111-4111-8111-111111111111', 'review',
  'El Viva Berry está buenísimo', 5, 'c5c5c5c5-0000-4000-8000-000000000003/foto.jpg')) ->> 'id';
-- 2 estrellas → en revisión; solo ella la ve.
insert into _t select 'r2', (public.community_post('11111111-1111-4111-8111-111111111111', 'review',
  'Tardaron mucho hoy', 2)) ->> 'id';
-- Sugerencia: privada.
insert into _t select 'sug', (public.community_post('11111111-1111-4111-8111-111111111111', 'suggestion',
  'Pongan leche de almendra sin azúcar')) ->> 'id';
select pg_temp.esperar_error($q$select public.community_post('11111111-1111-4111-8111-111111111111', 'question', 'Mi cel 7325550142')$q$, 'contact_info_blocked');
select pg_temp.esperar_error($q$select public.community_post('11111111-1111-4111-8111-111111111111', 'review', 'sin estrellas')$q$, 'rating_required');
select pg_temp.esperar_error($q$select public.community_post('11111111-1111-4111-8111-111111111111', 'review', 'foto ajena', 5, 'otro/foto.jpg')$q$, 'invalid_photo');
select pg_temp.esperar_error($q$select public.community_post('11111111-1111-4111-8111-111111111111', 'announcement', 'me hago pasar por la tienda')$q$, 'invalid_kind');
do $$ begin
  if (select count(*) from public.community_feed('11111111-1111-4111-8111-111111111111')) <> 3 then
    raise exception 'Ana debe ver sus 3 (pública, en revisión y sugerencia)';
  end if;
end $$;
reset role;

do $$ begin
  if (select author_name || verified::text || status || points_awarded from public.community_posts
       where id = (select v::uuid from _t where k = 'r5')) <> 'Ana L.truepublished10' then
    raise exception 'Reseña 5: %', (select row(author_name, verified, status, points_awarded) from public.community_posts
       where id = (select v::uuid from _t where k = 'r5'));
  end if;
  if (select status from public.community_posts where id = (select v::uuid from _t where k = 'r2')) <> 'pending' then
    raise exception 'La de 2 estrellas no quedó en revisión';
  end if;
  if not exists (select 1 from public.community_notifications
                  where user_id = 'c5c5c5c5-0000-4000-8000-000000000003' and kind = 'points' and points = 10) then
    raise exception 'No se avisó de los puntos';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Beto (sin pedidos, sin apellido): ve solo lo público; pregunta; responde;
-- "Me sirvió" a Ana; reporta.
-- ---------------------------------------------------------------------
select pg_temp.como('c5c5c5c5-0000-4000-8000-000000000004');
do $$ begin
  if (select count(*) from public.community_feed('11111111-1111-4111-8111-111111111111')) <> 1 then
    raise exception 'Beto ve lo que no debe: %', (select count(*) from public.community_feed('11111111-1111-4111-8111-111111111111'));
  end if;
end $$;
insert into _t select 'q', (public.community_post('11111111-1111-4111-8111-111111111111', 'question',
  '¿Alguien ha probado el Arma tu jugo con piña y jengibre?')) ->> 'id';
select public.community_reply((select v::uuid from _t where k = 'r5'), 'Sí, el Viva Berry es mi favorito');
select public.community_helpful((select v::uuid from _t where k = 'r5'), true);
select public.community_helpful((select v::uuid from _t where k = 'r5'), true); -- 2 veces = 1
select pg_temp.esperar_error($q$select public.community_thread((select v::uuid from _t where k = 'sug'))$q$, 'post_not_found');
reset role;

do $$ begin
  if (select helpful_count || '/' || reply_count from public.community_posts where id = (select v::uuid from _t where k = 'r5')) <> '1/1' then
    raise exception 'Conteos de Me sirvió/respuestas';
  end if;
  if (select author_name || verified::text from public.community_posts where id = (select v::uuid from _t where k = 'q')) <> 'Betofalse' then
    raise exception 'Nombre de Beto';
  end if;
  if (select count(*) from public.community_notifications
       where user_id = 'c5c5c5c5-0000-4000-8000-000000000003' and kind in ('reply', 'helpful')) <> 2 then
    raise exception 'Ana debió recibir 2 avisos (respuesta y me sirvió)';
  end if;
end $$;

-- Anónimo: ve el resumen y lo público, no puede escribir.
select pg_temp.como(null);
do $$ begin
  if (public.community_summary('11111111-1111-4111-8111-111111111111') ->> 'average')::numeric <> 5 then
    raise exception 'Promedio: %', public.community_summary('11111111-1111-4111-8111-111111111111');
  end if;
  if (select count(*) from public.community_feed('11111111-1111-4111-8111-111111111111')) <> 2 then
    raise exception 'Anónimo debe ver 2 (reseña y pregunta)';
  end if;
end $$;
select pg_temp.esperar_error($q$select public.community_post('11111111-1111-4111-8111-111111111111', 'question', 'hola')$q$, null);
reset role;

-- Reportes: 1 no oculta; 2 de personas distintas → a revisión.
select pg_temp.como('c5c5c5c5-0000-4000-8000-000000000003');
select public.community_report('post', (select v::uuid from _t where k = 'q'), 'Spam');
select public.community_report('post', (select v::uuid from _t where k = 'q'), 'Spam'); -- repetido no cuenta
reset role;
do $$ begin
  if (select status from public.community_posts where id = (select v::uuid from _t where k = 'q')) <> 'published' then
    raise exception 'Un solo reporte no debe ocultar';
  end if;
end $$;
select pg_temp.como('c5c5c5c5-0000-4000-8000-000000000005');
select public.community_report('post', (select v::uuid from _t where k = 'q'), 'Ofensivo');
reset role;
do $$ begin
  if (select status from public.community_posts where id = (select v::uuid from _t where k = 'q')) <> 'reported' then
    raise exception 'Con 2 reportes debe pasar a revisión';
  end if;
end $$;

-- La tienda (staff) no modera ni responde como VIVA.
select pg_temp.como('c5c5c5c5-0000-4000-8000-000000000002');
select pg_temp.esperar_error($q$select public.community_moderate('post', (select v::uuid from _t where k = 'r2'), 'publish')$q$, 'owner_only');
select pg_temp.esperar_error($q$select * from public.community_admin_list('11111111-1111-4111-8111-111111111111')$q$, 'owner_only');
select pg_temp.esperar_error($q$select public.community_store_post('11111111-1111-4111-8111-111111111111', 'aviso')$q$, 'owner_only');
reset role;

-- ---------------------------------------------------------------------
-- Dueño: revisa, publica, oculta con motivo, responde como VIVA, avisa.
-- ---------------------------------------------------------------------
select pg_temp.como('c5c5c5c5-0000-4000-8000-000000000001');
do $$ begin
  if (select count(*) from public.community_admin_list('11111111-1111-4111-8111-111111111111', 'review')) <> 2 then
    raise exception 'Por revisar: %', (select count(*) from public.community_admin_list('11111111-1111-4111-8111-111111111111', 'review'));
  end if;
  if (select count(*) from public.community_admin_list('11111111-1111-4111-8111-111111111111', 'suggestion')) <> 1 then
    raise exception 'Sugerencias';
  end if;
  if (public.community_get_settings('11111111-1111-4111-8111-111111111111') ->> 'pending')::int <> 2 then
    raise exception 'Contador por revisar';
  end if;
end $$;
select public.community_moderate('post', (select v::uuid from _t where k = 'r2'), 'publish');
select pg_temp.esperar_error($q$select public.community_moderate('post', (select v::uuid from _t where k = 'q'), 'hide')$q$, 'reason_required');
select public.community_moderate('post', (select v::uuid from _t where k = 'q'), 'hide', 'No es sobre VIVA');
select public.community_reply((select v::uuid from _t where k = 'r2'), 'Gracias Ana, ya reforzamos el turno de la mañana.');
insert into _t select 'aviso', (public.community_store_post('11111111-1111-4111-8111-111111111111',
  'Nuevo sabor de temporada: Pumpkin Spice Smoothie', null, '2026-11-01', true)) ->> 'id';
do $$ begin
  if (select count(*) from public.community_audit_list('11111111-1111-4111-8111-111111111111')) < 4 then
    raise exception 'Bitácora incompleta';
  end if;
end $$;
-- Ajustes: apagar la comunidad.
select public.community_save_settings('11111111-1111-4111-8111-111111111111', false, 5, 0);
reset role;

do $$ begin
  -- La segunda reseña aprobada NO da puntos otra vez (solo la primera).
  if (select points_awarded from public.community_posts where id = (select v::uuid from _t where k = 'r2')) <> 0 then
    raise exception 'Dio puntos dos veces';
  end if;
  if (select author_role || author_name from public.community_replies
       where post_id = (select v::uuid from _t where k = 'r2')) not like 'store%' then
    raise exception 'La respuesta no salió como la tienda';
  end if;
  if not exists (select 1 from public.community_notifications
                  where user_id = 'c5c5c5c5-0000-4000-8000-000000000003' and kind = 'store_reply') then
    raise exception 'Ana no recibió el aviso de la respuesta de VIVA';
  end if;
  if not exists (select 1 from public.community_notifications
                  where user_id = 'c5c5c5c5-0000-4000-8000-000000000004' and kind = 'hidden') then
    raise exception 'Beto no recibió aviso de que se ocultó';
  end if;
  if (select features ->> 'community' from public.app_settings
       where restaurant_id = '11111111-1111-4111-8111-111111111111') <> 'false' then
    raise exception 'La pestaña no se apagó';
  end if;
end $$;

-- Apagada: no se puede publicar y el feed sale vacío.
select pg_temp.como('c5c5c5c5-0000-4000-8000-000000000003');
select pg_temp.esperar_error($q$select public.community_post('11111111-1111-4111-8111-111111111111', 'question', 'hola?')$q$, 'community_disabled');
do $$ begin
  if exists (select 1 from public.community_feed('11111111-1111-4111-8111-111111111111')) then
    raise exception 'Con la comunidad apagada se ve el feed';
  end if;
end $$;
-- Sus avisos: se marcan leídos.
do $$ begin
  if (select count(*) from public.community_my_notifications('11111111-1111-4111-8111-111111111111', true) where not read) < 4 then
    raise exception 'Avisos de Ana';
  end if;
  if exists (select 1 from public.community_my_notifications('11111111-1111-4111-8111-111111111111') where not read) then
    raise exception 'No se marcaron leídos';
  end if;
end $$;
reset role;

rollback;
\echo 'OK 0035: comunidad con reseñas, preguntas, respuestas, reportes, moderación, avisos y puntos'
