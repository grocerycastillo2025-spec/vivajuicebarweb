-- =====================================================================
-- viva_menu_base.sql — Menú base de VIVA Jugos y Café (Pie de la Cuesta, Qro.)
--
-- Sale del menú impreso del negocio. Es un punto de partida: el dueño lo
-- edita desde el panel (precios, fotos, agotados, nuevos productos).
--
--   Jugos naturales        500 ml $35 · 1 litro $50
--   Licuados               500 ml $40 · 1 litro $55   + elige tu leche
--   Licuados con proteína  500 ml $45 · 1 litro $60   + elige tu leche
--   Café                   $30
--
-- El precio del producto es el de 500 ml; "1 litro" es una opción del
-- grupo Tamaño (+$15, igual en las tres categorías).
--
-- Fotos e historias: las imágenes viven en la app web publicada
-- (apps/mobile/public/img). El dueño puede cambiarlas desde el panel.
--
-- IDEMPOTENTE: se puede correr varias veces. No duplica nada y no pisa lo
-- que el dueño ya haya editado (todo es "on conflict do nothing").
-- Requiere las migraciones hasta la 0022 y viva_jugos_mx.sql.
-- =====================================================================


-- Todo va dentro de un solo bloque DO: el SQL Editor de Supabase revisa
-- todas las sentencias antes de correr la primera, así que una tabla de
-- trabajo creada en el mismo script "no existe" todavía. Dentro del bloque
-- cada sentencia se revisa justo antes de correr.
do $seed$
begin
  -- Ubicación del menú impreso (solo si el dueño no la ha llenado).
  update public.stores
     set city = coalesce(city, 'Pie de la Cuesta'),
         state = coalesce(state, 'Querétaro')
   where id = '33333333-3333-4333-8333-333333333333';

  -- Colores de marca: naranja como principal y el verde del logo de acento.
  -- Solo si siguen los de la primera alta (no pisa lo que elija el dueño).
  update public.app_settings
     set primary_color = '#C9480F', secondary_color = '#FFF7EF', accent_color = '#0E5B3A'
   where restaurant_id = '11111111-1111-4111-8111-111111111111'
     and primary_color = '#0E4A2B';

  drop table if exists public._viva_seed_img;
  drop table if exists public._viva_seed_p;
  create table public._viva_seed_img (base text);
  insert into public._viva_seed_img values ('https://grocerycastillo2025-spec.github.io/viva-jugos-y-caf-web/img');

  -- ---------------------------------------------------------------------
  -- Categorías
  -- ---------------------------------------------------------------------
  insert into public.catalog_categories (store_id, clover_category_id, name, sort_order)
  values
    ('33333333-3333-4333-8333-333333333333', 'viva-cat-jugos',     '🍊 Jugos naturales',       10),
    ('33333333-3333-4333-8333-333333333333', 'viva-cat-licuados',  '🥤 Licuados',              20),
    ('33333333-3333-4333-8333-333333333333', 'viva-cat-proteina',  '💪 Licuados con proteína', 30),
    ('33333333-3333-4333-8333-333333333333', 'viva-cat-cafe',      '☕ Café',                  40)
  on conflict (store_id, clover_category_id) do nothing;

  -- ---------------------------------------------------------------------
  -- Productos (precio = 500 ml)
  -- ---------------------------------------------------------------------
  create table public._viva_seed_p (
    item text, cat text, name text, descr text, price bigint, img text,
    featured boolean, badge text, ord int
  );

  insert into public._viva_seed_p values
    ('viva-viva-juice',    'viva-cat-jugos',    'Viva Juice',        'Naranja, zanahoria y betabel',                    3500, 'viva-juice',        true,  'Popular', 10),
    ('viva-jugo-verde',    'viva-cat-jugos',    'Jugo Verde',        'Pepino, apio, kale, jengibre, manzana y naranja', 3500, 'jugo-verde',        true,  null,      20),
    ('viva-super-detox',   'viva-cat-jugos',    'Super Detox',       'Zanahoria, manzana, apio y limón',                3500, 'super-detox',       false, null,      30),
    ('viva-anti-flu',      'viva-cat-jugos',    'Anti Flu',          'Naranja, limón, jengibre y miel',                 3500, 'anti-flu',          false, null,      40),
    ('viva-refresh-me',    'viva-cat-jugos',    'Refresh Me',        'Sandía, limón y menta',                           3500, 'refresh-me',        false, null,      50),
    ('viva-crea-el-tuyo',  'viva-cat-jugos',    'Crea el tuyo',      'Elige 3 frutas o verduras',                       3500, null,                false, null,      60),
    ('viva-viva-berry',    'viva-cat-licuados', 'Viva Berry',        'Fresa, arándano y goji berry',                    4000, 'viva-berry',        true,  'Popular', 10),
    ('viva-disco-duro',    'viva-cat-licuados', 'Disco Duro',        'Mango, manzana, pasas y menta',                   4000, 'disco-duro',        false, null,      20),
    ('viva-forever-young', 'viva-cat-licuados', 'Forever Young',     'Mango y piña',                                    4000, 'forever-young',     false, null,      30),
    ('viva-choco-protein', 'viva-cat-proteina', 'Chocolate Protein', 'Plátano, mantequilla de maní y proteína de chocolate', 4500, 'chocolate-protein', true, null,   10),
    ('viva-vanilla-protein','viva-cat-proteina','Vanilla Protein',   'Plátano, fresa y proteína de vainilla',           4500, 'vanilla-protein',   false, null,      20),
    ('viva-cafe',          'viva-cat-cafe',     'Café',              'Café de grano recién preparado',                  3000, 'cafe',              false, null,      10);

  insert into public.catalog_items (store_id, clover_item_id, category_id, name, price_cents)
  select '33333333-3333-4333-8333-333333333333', p.item, c.id, p.name, p.price
    from public._viva_seed_p p
    join public.catalog_categories c
      on c.store_id = '33333333-3333-4333-8333-333333333333' and c.clover_category_id = p.cat
  on conflict (store_id, clover_item_id) do nothing;

  insert into public.app_item_overrides
    (store_id, clover_item_id, marketing_copy, image_url, featured, badge, sort_order)
  select '33333333-3333-4333-8333-333333333333', p.item, p.descr,
         case when p.img is null then null else (select base from public._viva_seed_img) || '/menu/' || p.img || '.jpg' end,
         p.featured, p.badge, p.ord
    from public._viva_seed_p p
  on conflict (store_id, clover_item_id) do nothing;

  -- ---------------------------------------------------------------------
  -- Opciones: Tamaño, Leche y "Crea el tuyo"
  -- ---------------------------------------------------------------------
  insert into public.catalog_modifier_groups (store_id, clover_group_id, name, min_required, max_allowed, sort_order)
  values
    ('33333333-3333-4333-8333-333333333333', 'viva-grp-tamano', 'Tamaño',                       1, 1, 10),
    ('33333333-3333-4333-8333-333333333333', 'viva-grp-leche',  'Elige tu leche',               1, 1, 20),
    ('33333333-3333-4333-8333-333333333333', 'viva-grp-crea',   'Elige 3 frutas o verduras',    3, 3, 10)
  on conflict (store_id, clover_group_id) do nothing;

  insert into public.catalog_modifiers (store_id, modifier_group_id, clover_modifier_id, name, price_cents, sort_order)
  select '33333333-3333-4333-8333-333333333333', g.id, m.mod, m.name, m.price, m.ord
    from (values
      ('viva-grp-tamano', 'viva-mod-500ml',    '500 ml',     0,    10),
      ('viva-grp-tamano', 'viva-mod-1l',       '1 litro',    1500, 20),
      ('viva-grp-leche',  'viva-mod-entera',   'Entera',     0,    10),
      ('viva-grp-leche',  'viva-mod-almendra', 'Almendra',   0,    20),
      ('viva-grp-leche',  'viva-mod-avena',    'Avena',      0,    30),
      ('viva-grp-leche',  'viva-mod-soya',     'Soya',       0,    40),
      ('viva-grp-crea',   'viva-mod-naranja',  'Naranja',    0,    10),
      ('viva-grp-crea',   'viva-mod-zanahoria','Zanahoria',  0,    20),
      ('viva-grp-crea',   'viva-mod-betabel',  'Betabel',    0,    30),
      ('viva-grp-crea',   'viva-mod-pepino',   'Pepino',     0,    40),
      ('viva-grp-crea',   'viva-mod-apio',     'Apio',       0,    50),
      ('viva-grp-crea',   'viva-mod-kale',     'Kale',       0,    60),
      ('viva-grp-crea',   'viva-mod-jengibre', 'Jengibre',   0,    70),
      ('viva-grp-crea',   'viva-mod-manzana',  'Manzana',    0,    80),
      ('viva-grp-crea',   'viva-mod-pina',     'Piña',       0,    90),
      ('viva-grp-crea',   'viva-mod-mango',    'Mango',      0,   100),
      ('viva-grp-crea',   'viva-mod-sandia',   'Sandía',     0,   110),
      ('viva-grp-crea',   'viva-mod-limon',    'Limón',      0,   120)
    ) as m(grp, mod, name, price, ord)
    join public.catalog_modifier_groups g
      on g.store_id = '33333333-3333-4333-8333-333333333333' and g.clover_group_id = m.grp
  on conflict (store_id, clover_modifier_id) do nothing;

  -- Qué grupo lleva cada producto.
  insert into public.catalog_item_modifier_groups (item_id, modifier_group_id, sort_order)
  select i.id, g.id, l.ord
    from (
      -- Tamaño: todo menos el café.
      select item, 'viva-grp-tamano' as grp, 10 as ord from public._viva_seed_p where cat <> 'viva-cat-cafe'
      union all
      -- Leche: licuados y licuados con proteína.
      select item, 'viva-grp-leche', 20 from public._viva_seed_p where cat in ('viva-cat-licuados', 'viva-cat-proteina')
      union all
      select 'viva-crea-el-tuyo', 'viva-grp-crea', 5
    ) as l
    join public.catalog_items i
      on i.store_id = '33333333-3333-4333-8333-333333333333' and i.clover_item_id = l.item
    join public.catalog_modifier_groups g
      on g.store_id = '33333333-3333-4333-8333-333333333333' and g.clover_group_id = l.grp
  on conflict (item_id, modifier_group_id) do nothing;

  -- ---------------------------------------------------------------------
  -- Historias destacadas (no caducan): una por producto con foto, más el
  -- menú completo. El dueño las borra o agrega más desde el panel.
  -- ---------------------------------------------------------------------
  insert into public.stories (restaurant_id, media_url, media_type, caption, item_id, sort_order, created_by)
  select '11111111-1111-4111-8111-111111111111',
         (select base from public._viva_seed_img) || '/historias/' || s.img || '.jpg',
         'image', s.caption,
         (select i.id from public.catalog_items i
           where i.store_id = '33333333-3333-4333-8333-333333333333' and i.clover_item_id = s.item),
         s.ord, null
    from (values
      ('menu',              null,                  'Nuestro menú · Pie de la Cuesta',  10),
      ('viva-juice',        'viva-viva-juice',     'El clásico de la casa 🍊',          20),
      ('viva-berry',        'viva-viva-berry',     'Puro antioxidante 🍓',              30),
      ('jugo-verde',        'viva-jugo-verde',     'Empieza el día en verde 🌿',        40),
      ('chocolate-protein', 'viva-choco-protein',  'Después del gym 💪',                50),
      ('vanilla-protein',   'viva-vanilla-protein','Proteína con sabor a vainilla',     60),
      ('forever-young',     'viva-forever-young',  'Mango y piña, nada más',            70),
      ('disco-duro',        'viva-disco-duro',     'El favorito de los que estudian',   80),
      ('super-detox',       'viva-super-detox',    'Zanahoria, manzana, apio y limón',  90),
      ('anti-flu',          'viva-anti-flu',       'Para los días fríos 🍯',           100),
      ('refresh-me',        'viva-refresh-me',     'Sandía, limón y menta 🍉',         110),
      ('cafe',              'viva-cafe',           'Tu café de cada mañana ☕',         120)
    ) as s(img, item, caption, ord)
   where not exists (
     select 1 from public.stories st
      where st.media_url = (select base from public._viva_seed_img) || '/historias/' || s.img || '.jpg'
   );

  drop table if exists public._viva_seed_img;
  drop table if exists public._viva_seed_p;
end
$seed$;
