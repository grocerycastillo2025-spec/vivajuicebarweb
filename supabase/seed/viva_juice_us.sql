-- =====================================================================
-- viva_juice_us.sql — Alta de VIVA Juice and Coffee (Freehold, NJ) y su
-- menú base, bilingüe (inglés de base, español en `i18n`).
--
-- Sale del menú digital del negocio (msmejoraprocesos.github.io/viva-menu)
-- y de los precios del menú vigente. Es un punto de partida: el dueño lo
-- edita desde el panel (precios, fotos, agotados, productos nuevos).
--
-- IDEMPOTENTE: se puede correr varias veces. No duplica nada y no pisa lo
-- que el dueño ya haya editado (todo es "on conflict do nothing" o "si
-- no existe").
--
-- Todo va dentro de un bloque DO: el SQL Editor de Supabase revisa todas
-- las sentencias antes de correr la primera, así que una tabla creada en
-- el mismo script "no existe" todavía. Dentro del bloque cada sentencia
-- se revisa justo antes de correr.
-- =====================================================================

do $seed$
declare
  v_restaurant constant uuid := '11111111-1111-4111-8111-111111111111';
  v_store      constant uuid := '22222222-2222-4222-8222-222222222222';
  v_img        constant text := 'https://grocerycastillo2025-spec.github.io/vivajuicebarweb/img';
begin
  -- -------------------------------------------------------------------
  -- Negocio, marca y sucursal
  -- -------------------------------------------------------------------
  -- El id coincide con `extra.restaurantId` de apps/mobile/app.json.
  insert into public.restaurants (id, name, slug, status, support_email, support_phone, subscription_status)
  values (v_restaurant, 'VIVA Juice and Coffee', 'viva-juice-coffee', 'active',
          null, '+17324968863', 'active')
  on conflict (id) do nothing;

  insert into public.app_settings (
    restaurant_id, app_display_name, logo_url, primary_color, secondary_color, accent_color, features, legal_urls
  )
  values (
    v_restaurant,
    'VIVA Juice and Coffee',
    v_img || '/logo-crema.png',   -- logo en crema, va sobre el verde
    '#0E4A2B',   -- verde del logotipo (texto blanco encima: AAA)
    '#F5F0E6',   -- crema de fondo
    '#E87722',   -- naranja de "JUICE"
    jsonb_build_object('loyalty', false, 'promotions', false, 'tips', false,
                       'favorites', true, 'scheduling', true),
    jsonb_build_object('website', 'https://vivajuicecoffee.com',
                       'instagram', 'https://www.instagram.com/vivajuicecoffee')
  )
  on conflict (restaurant_id) do nothing;

  insert into public.stores (
    id, restaurant_id, name, slug, status,
    address_line1, city, state, postal_code, country, latitude, longitude, phone,
    timezone, currency, catalog_source, payments_mode,
    surcharge_policy, surcharge_rate,
    pickup_enabled, delivery_enabled, setup_checklist,
    payment_options
  )
  values (
    v_store, v_restaurant, 'Freehold', 'freehold', 'active',
    '31 South St', 'Freehold', 'NJ', '07728', 'US', 40.259500, -74.274300, '+17324968863',
    'America/New_York', 'USD', 'own', 'counter',
    -- Sin cobro con tarjeta del POS en la app no hay recargo que divulgar.
    'show', 0,
    true, false, '{}'::jsonb,
    -- Mostrador prendido; Zelle, Stripe y PayPal los prende el dueño en el
    -- panel cuando tenga sus datos o su cuenta conectada.
    jsonb_build_object('cash', true, 'card_counter', true, 'transfer', false,
                       'mercadopago', false, 'stripe', false, 'clip', false,
                       'paypal', false, 'zelle', false)
  )
  on conflict (id) do nothing;

  -- Horario confirmado por el negocio (agosto 2026): todos los días de
  -- 6:00 a 21:00, sábado desde las 9:00. El dueño lo cambia en el panel.
  if not exists (select 1 from public.store_hours where store_id = v_store) then
    insert into public.store_hours (store_id, weekday, opens_at, closes_at)
    select v_store, d, case when d = 6 then time '09:00' else time '06:00' end, time '21:00'
      from generate_series(0, 6) as d;
  end if;

  insert into public.store_pickup_config (
    store_id, slot_minutes, lead_time_minutes, max_orders_per_slot, max_days_ahead, asap_enabled
  )
  values (v_store, 15, 10, 8, 1, true)
  on conflict (store_id) do nothing;

  -- Lealtad: apagada hasta que el dueño la configure (Panel → Lealtad).
  insert into public.loyalty_programs (
    restaurant_id, enabled, points_per_dollar, min_points_to_redeem, points_per_visit, visit_cooldown_hours
  )
  values (v_restaurant, false, 0, 0, 10, 20)
  on conflict (restaurant_id) do nothing;

  insert into public.store_visit_codes (store_id)
  values (v_store)
  on conflict (store_id) do nothing;

  -- -------------------------------------------------------------------
  -- Categorías
  -- -------------------------------------------------------------------
  insert into public.catalog_categories (store_id, clover_category_id, name, sort_order, i18n)
  select v_store, c.id, c.name, c.ord, jsonb_build_object('es', jsonb_build_object('name', c.es))
    from (values
      ('viva-cat-juices',    '🍊 Juices',           '🍊 Jugos',              10),
      ('viva-cat-smoothies', '🥤 Smoothies',        '🥤 Licuados',           20),
      ('viva-cat-bowls',     '🥣 Bowls',            '🥣 Bowls',              30),
      ('viva-cat-drinks',    '🍹 Viva Drinks',      '🍹 Bebidas Viva',       40),
      ('viva-cat-shots',     '⚡ Boost Shots',      '⚡ Shots de energía',   50),
      ('viva-cat-iced',      '🧊 Iced Coffee',      '🧊 Café frío',          60),
      ('viva-cat-hot',       '☕ Hot Coffee',       '☕ Café caliente',      70),
      ('viva-cat-bites',     '🥪 Viva Bites',       '🥪 Para comer',         80),
      ('viva-cat-crepes',    '🧇 Crepes & Waffles', '🧇 Crepas y waffles',   90),
      ('viva-cat-fruit',     '🍓 Fresh Fruit Cups', '🍓 Vasos de fruta',    100),
      ('viva-cat-treats',    '🍰 Treats',           '🍰 Postres',           110),
      ('viva-cat-icecream',  '🍦 Ice Cream',        '🍦 Helado',            120)
    ) as c(id, name, es, ord)
  on conflict (store_id, clover_category_id) do nothing;

  -- -------------------------------------------------------------------
  -- Productos (precio en centavos de dólar)
  -- -------------------------------------------------------------------
  drop table if exists _viva_p;
  create temp table _viva_p (
    item text, cat text, name text, descr text, es_name text, es_descr text,
    price bigint, img text, featured boolean, badge text, ord int
  ) on commit drop;

  insert into _viva_p values
    -- Juices · 8.50
    ('viva-juice-viva',     'viva-cat-juices', 'Viva Juice',            'Orange, carrot and beet',                          'Viva Juice',            'Naranja, zanahoria y betabel',                     850, 'viva-juice',  true,  'Popular', 10),
    ('viva-juice-green',    'viva-cat-juices', 'Green Juice',           'Cucumber, celery, kale, ginger, apple, orange',    'Jugo Verde',            'Pepino, apio, kale, jengibre, manzana y naranja',  850, 'jugo-verde',  true,  null,      20),
    ('viva-juice-detox',    'viva-cat-juices', 'Super Detox',           'Carrot, apple, celery, lime',                      'Super Detox',           'Zanahoria, manzana, apio y limón',                 850, 'super-detox', false, null,      30),
    ('viva-juice-antiflu',  'viva-cat-juices', 'Anti Flu',              'Orange, lime, ginger, raw honey',                  'Anti Flu',              'Naranja, limón, jengibre y miel cruda',            850, 'anti-flu',    false, null,      40),
    ('viva-juice-refresh',  'viva-cat-juices', 'Refresh Me',            'Watermelon, lime, mint',                           'Refresh Me',            'Sandía, limón y menta',                            850, 'refresh-me',  false, null,      50),
    ('viva-juice-custom',   'viva-cat-juices', 'Create Your Own Juice', 'Your 3 favorite fruits or veggies, juiced to order', 'Arma tu jugo',     'Tus 3 frutas o verduras favoritas, en jugo al momento',                        850, null,          false, null,      60),
    -- Smoothies · 8.50
    ('viva-smoothie-berry', 'viva-cat-smoothies', 'Viva Berry',         'Strawberry, blueberry, goji berry',                'Viva Berry',            'Fresa, arándano y goji berry',                     850, 'viva-berry',        true,  'Popular', 10),
    ('viva-smoothie-choco', 'viva-cat-smoothies', 'Chocolate Protein',  'Banana, peanut butter, chocolate whey protein',    'Chocolate Protein',     'Plátano, crema de cacahuate y proteína de chocolate', 850, 'chocolate-protein', true,  null,  20),
    ('viva-smoothie-vanil', 'viva-cat-smoothies', 'Vanilla Protein',    'Banana, strawberry, vanilla whey protein',         'Vanilla Protein',       'Plátano, fresa y proteína de vainilla',            850, 'vanilla-protein',   false, null,      30),
    ('viva-smoothie-disco', 'viva-cat-smoothies', 'Disco Duro',         'Mango, apple, raisins, mint',                      'Disco Duro',            'Mango, manzana, pasas y menta',                    850, 'disco-duro',        false, null,      40),
    ('viva-smoothie-young', 'viva-cat-smoothies', 'Forever Young',      'Mango, pineapple',                                 'Forever Young',         'Mango y piña',                                     850, 'forever-young',     false, null,      50),
    ('viva-smoothie-custom','viva-cat-smoothies', 'Create Your Own Smoothie', 'Your 3 favorite fruits or seeds, blended with your milk', 'Arma tu licuado', 'Tus 3 frutas o semillas favoritas, con la leche que elijas',                        850, null,                false, null,      60),
    -- Bowls · 12.50
    ('viva-bowl-acai',      'viva-cat-bowls', 'Acai Bowl',              'Acai, Nutella, blueberries, strawberries, banana, granola', 'Bowl de açaí',  'Açaí, Nutella, arándanos, fresas, plátano y granola', 1250, null, false, null, 10),
    ('viva-bowl-pitaya',    'viva-cat-bowls', 'Pitaya Bowl',            'Pitaya, granola, kiwi, pineapple, banana',         'Bowl de pitaya',        'Pitaya, granola, kiwi, piña y plátano',            1250, null, false, null, 20),
    ('viva-bowl-coconut',   'viva-cat-bowls', 'Coconut Bowl',           'Coconut, chia, granola, mango, blueberry, papaya', 'Bowl de coco',          'Coco, chía, granola, mango, arándano y papaya',    1250, null, false, null, 30),
    ('viva-bowl-custom',    'viva-cat-bowls', 'Create Your Own Bowl',   'Your base with 3 fruits and 2 toppings of your choice', 'Arma tu bowl',  'Tu base con 3 frutas y 2 toppings a tu gusto',                      1250, null, false, null, 40),
    -- Viva Drinks
    ('viva-drink-pina',     'viva-cat-drinks', 'Piña Colada',           'Virgin',                                           'Piña colada',           'Sin alcohol',                                       750, null, false, null, 10),
    ('viva-drink-tepache',  'viva-cat-drinks', 'Tepache',               'Virgin',                                           'Tepache',               'Sin alcohol',                                       750, null, false, null, 20),
    ('viva-drink-sangria',  'viva-cat-drinks', 'Sangria',               'Virgin',                                           'Sangría',               'Sin alcohol',                                       750, null, false, null, 30),
    ('viva-drink-agua',     'viva-cat-drinks', 'Today''s Agua Fresca',  'Ask about today''s flavor',                        'Agua fresca del día',   'Pregunta por el sabor de hoy',                      450, null, false, null, 40),
    -- Boost Shots · 3.50
    ('viva-shot-ginger',    'viva-cat-shots', 'Ginger Shot',            'Ginger, orange and lemon · 2 oz',                  'Shot de jengibre',      'Jengibre, naranja y limón · 2 oz',                  350, null, false, null, 10),
    ('viva-shot-turmeric',  'viva-cat-shots', 'Turmeric Shot',          'Turmeric, ginger, raw honey · 2 oz',               'Shot de cúrcuma',       'Cúrcuma, jengibre y miel cruda · 2 oz',             350, null, false, null, 20),
    ('viva-shot-pomegr',    'viva-cat-shots', 'Pomegranate Shot',       'Pomegranate and turmeric · 2 oz',                  'Shot de granada',       'Granada y cúrcuma · 2 oz',                          350, null, false, null, 30),
    -- Iced Coffee
    ('viva-iced-latte',     'viva-cat-iced', 'Iced Latte',              null,                                               'Latte frío',            null,                                                475, null, false, null, 10),
    ('viva-iced-americano', 'viva-cat-iced', 'Iced Americano',          null,                                               'Americano frío',        null,                                                475, null, false, null, 20),
    ('viva-iced-coldbrew',  'viva-cat-iced', 'Cold Brew',               null,                                               'Cold brew',             null,                                                599, null, false, null, 30),
    ('viva-iced-frappe',    'viva-cat-iced', 'Viva Frappé',             null,                                               'Frappé Viva',           null,                                                675, null, false, null, 40),
    ('viva-iced-matcha',    'viva-cat-iced', 'Iced Matcha',             null,                                               'Matcha frío',           null,                                                535, null, false, null, 50),
    -- Hot Coffee
    ('viva-hot-brew',       'viva-cat-hot', 'Fresh Brew Coffee',        null,                                               'Café del día',          'Café recién hecho',                                 200, 'cafe', false, null, 10),
    ('viva-hot-americano',  'viva-cat-hot', 'Americano',                null,                                               'Americano',             null,                                                450, null, false, null, 20),
    ('viva-hot-cappuccino', 'viva-cat-hot', 'Cappuccino',               null,                                               'Capuchino',             null,                                                450, null, false, null, 30),
    ('viva-hot-latte',      'viva-cat-hot', 'Latte',                    null,                                               'Latte',                 null,                                                450, null, false, null, 40),
    ('viva-hot-matcha',     'viva-cat-hot', 'Hot Matcha',               null,                                               'Matcha caliente',       null,                                                550, null, false, null, 50),
    ('viva-hot-single',     'viva-cat-hot', 'Espresso Single Shot',     null,                                               'Espresso sencillo',     null,                                                450, null, false, null, 60),
    ('viva-hot-double',     'viva-cat-hot', 'Espresso Double Shot',     null,                                               'Espresso doble',        null,                                                550, null, false, null, 70),
    ('viva-hot-affogato',   'viva-cat-hot', 'Affogato',                 'Espresso over ice cream',                          'Affogato',              'Espresso sobre helado',                             650, null, false, null, 80),
    -- Viva Bites
    ('viva-bite-tuna',      'viva-cat-bites', 'Tuna Sandwich',          'With carrot and celery sticks',                    'Sándwich de atún',      'Con palitos de zanahoria y apio',                   850, null, false, null, 10),
    ('viva-bite-salmon',    'viva-cat-bites', 'Smoked Salmon Sandwich', 'With carrot and celery sticks',                    'Sándwich de salmón ahumado', 'Con palitos de zanahoria y apio',              999, null, false, null, 20),
    ('viva-bite-guac',      'viva-cat-bites', 'Guacamole',              'With carrot and celery sticks',                    'Guacamole',             'Con palitos de zanahoria y apio',                   999, null, false, null, 30),
    -- Crepes & Waffles
    ('viva-crepe',          'viva-cat-crepes', 'Viva Crepe',            'Strawberry, banana, chocolate drizzle, whipped cream', 'Crepa Viva',        'Fresa, plátano, chocolate y crema batida',         1150, null, false, null, 10),
    ('viva-waffle',         'viva-cat-crepes', 'Viva Waffle',           'Strawberry, banana, Nutella, powdered sugar',      'Waffle Viva',           'Fresa, plátano, Nutella y azúcar glas',            1000, null, false, null, 20),
    -- Fresh Fruit Cups
    ('viva-fruit-10',       'viva-cat-fruit', 'Fresh Fruit Cup 10 oz',  null,                                               'Vaso de fruta 10 oz',   null,                                                550, null, false, null, 10),
    ('viva-fruit-12',       'viva-cat-fruit', 'Fresh Fruit Cup 12 oz',  null,                                               'Vaso de fruta 12 oz',   null,                                                650, null, false, null, 20),
    -- Treats
    ('viva-treat-gelwater', 'viva-cat-treats', 'Gelatin (Water-Based)', null,                                               'Gelatina de agua',      null,                                                200, null, false, null, 10),
    ('viva-treat-gelmilk',  'viva-cat-treats', 'Gelatin (Milk-Based)',  null,                                               'Gelatina de leche',     null,                                                300, null, false, null, 20),
    ('viva-treat-tresleche','viva-cat-treats', 'Tres Leches Cake Slice',null,                                               'Rebanada de pastel tres leches', null,                                       350, null, false, null, 30),
    ('viva-treat-carrot',   'viva-cat-treats', 'Carrot Cake Slice',     null,                                               'Rebanada de pastel de zanahoria', null,                                      350, null, false, null, 40),
    ('viva-treat-tiramisu', 'viva-cat-treats', 'Tiramisu Cake Slice',   null,                                               'Rebanada de tiramisú',  null,                                                399, null, false, null, 50),
    ('viva-treat-lemon',    'viva-cat-treats', 'Lemon Cake Slice',      null,                                               'Rebanada de pastel de limón', null,                                          300, null, false, null, 60),
    ('viva-treat-bansplit', 'viva-cat-treats', 'Banana Split',          null,                                               'Banana split',          null,                                               1050, null, false, null, 70),
    ('viva-treat-mangonada','viva-cat-treats', 'Mangonada',             'Mango chili sorbet',                               'Mangonada',             'Nieve de mango con chile',                          850, null, false, null, 80),
    -- Ice Cream
    ('viva-ice-cup',        'viva-cat-icecream', 'Ice Cream Cup',       null,                                               'Helado en vaso',        null,                                                550, null, false, null, 10),
    ('viva-ice-cone',       'viva-cat-icecream', 'Ice Cream Cone',      null,                                               'Helado en cono',        null,                                                600, null, false, null, 20);

  insert into public.catalog_items (store_id, clover_item_id, category_id, name, price_cents, i18n)
  select v_store, p.item, c.id, p.name, p.price,
         jsonb_build_object('es', jsonb_strip_nulls(jsonb_build_object('name', p.es_name, 'description', p.es_descr)))
    from _viva_p p
    join public.catalog_categories c on c.store_id = v_store and c.clover_category_id = p.cat
  on conflict (store_id, clover_item_id) do nothing;

  insert into public.app_item_overrides
    (store_id, clover_item_id, marketing_copy, image_url, featured, badge, sort_order)
  select v_store, p.item, p.descr,
         case when p.img is null then null else v_img || '/menu/' || p.img || '.jpg' end,
         p.featured, p.badge, p.ord
    from _viva_p p
  on conflict (store_id, clover_item_id) do nothing;

  -- -------------------------------------------------------------------
  -- Opciones
  -- -------------------------------------------------------------------
  insert into public.catalog_modifier_groups (store_id, clover_group_id, name, min_required, max_allowed, sort_order, i18n)
  select v_store, g.id, g.name, g.min, g.max, g.ord, jsonb_build_object('es', jsonb_build_object('name', g.es))
    from (values
      ('viva-grp-milk',        'Choose your milk',              'Elige tu leche',              1, 1, 20),
      ('viva-grp-protein',     'Add a protein scoop',           'Agrega una medida de proteína', 0, 1, 30),
      ('viva-grp-flavor',      'Add a flavor',                  'Agrega un sabor',             0, 1, 40),
      ('viva-grp-bread',       'Choose your bread',             'Elige tu pan',                1, 1, 10),
      ('viva-grp-juice-build', 'Pick 3 fruits or veggies',      'Elige 3 frutas o verduras',   3, 3, 5),
      ('viva-grp-smoothie-build', 'Pick 3 fruits or seeds',     'Elige 3 frutas o semillas',   3, 3, 5),
      ('viva-grp-bowl-fruits', 'Pick 3 fruits',                 'Elige 3 frutas',              3, 3, 5),
      ('viva-grp-bowl-toppings','Pick 2 toppings',              'Elige 2 toppings',            2, 2, 6)
    ) as g(id, name, es, min, max, ord)
  on conflict (store_id, clover_group_id) do nothing;

  insert into public.catalog_modifiers (store_id, modifier_group_id, clover_modifier_id, name, price_cents, sort_order, i18n)
  select v_store, g.id, m.id, m.name, m.price, m.ord,
         case when m.es is null or m.es = m.name then '{}'::jsonb
              else jsonb_build_object('es', jsonb_build_object('name', m.es)) end
    from (values
      -- Leche: avena y coco con recargo, como en el menú vigente.
      ('viva-grp-milk', 'viva-mod-milk-regular', 'Regular milk', 'Leche entera',  0,   10),
      ('viva-grp-milk', 'viva-mod-milk-almond',  'Almond milk',  'Leche de almendra', 0, 20),
      ('viva-grp-milk', 'viva-mod-milk-oat',     'Oat milk',     'Leche de avena', 100, 30),
      ('viva-grp-milk', 'viva-mod-milk-soy',     'Soy milk',     'Leche de soya',  0,   40),
      ('viva-grp-milk', 'viva-mod-milk-coconut', 'Coconut milk', 'Leche de coco', 100,  50),
      ('viva-grp-protein', 'viva-mod-protein-choco', 'Chocolate protein', 'Proteína de chocolate', 175, 10),
      ('viva-grp-protein', 'viva-mod-protein-vanil', 'Vanilla protein',   'Proteína de vainilla',  175, 20),
      ('viva-grp-flavor', 'viva-mod-flavor-vanilla',   'Vanilla',    'Vainilla',  0, 10),
      ('viva-grp-flavor', 'viva-mod-flavor-lavender',  'Lavender',   'Lavanda',   0, 20),
      ('viva-grp-flavor', 'viva-mod-flavor-banana',    'Banana',     'Plátano',   0, 30),
      ('viva-grp-flavor', 'viva-mod-flavor-hazelnut',  'Hazelnut',   'Avellana',  0, 40),
      ('viva-grp-flavor', 'viva-mod-flavor-almond',    'Almond',     'Almendra',  0, 50),
      ('viva-grp-flavor', 'viva-mod-flavor-strawberry','Strawberry', 'Fresa',     0, 60),
      ('viva-grp-flavor', 'viva-mod-flavor-caramel',   'Caramel',    'Caramelo',  0, 70),
      ('viva-grp-flavor', 'viva-mod-flavor-chocolate', 'Chocolate',  'Chocolate', 0, 80),
      ('viva-grp-bread', 'viva-mod-bread-croissant', 'Croissant',   'Croissant',   0, 10),
      ('viva-grp-bread', 'viva-mod-bread-wheat',     'Whole wheat', 'Pan integral', 0, 20),
      ('viva-grp-juice-build', 'viva-mod-jb-orange',     'Orange',     'Naranja',   0,  10),
      ('viva-grp-juice-build', 'viva-mod-jb-carrot',     'Carrot',     'Zanahoria', 0,  20),
      ('viva-grp-juice-build', 'viva-mod-jb-beet',       'Beet',       'Betabel',   0,  30),
      ('viva-grp-juice-build', 'viva-mod-jb-cucumber',   'Cucumber',   'Pepino',    0,  40),
      ('viva-grp-juice-build', 'viva-mod-jb-celery',     'Celery',     'Apio',      0,  50),
      ('viva-grp-juice-build', 'viva-mod-jb-kale',       'Kale',       'Kale',      0,  60),
      ('viva-grp-juice-build', 'viva-mod-jb-ginger',     'Ginger',     'Jengibre',  0,  70),
      ('viva-grp-juice-build', 'viva-mod-jb-apple',      'Apple',      'Manzana',   0,  80),
      ('viva-grp-juice-build', 'viva-mod-jb-pineapple',  'Pineapple',  'Piña',      0,  90),
      ('viva-grp-juice-build', 'viva-mod-jb-watermelon', 'Watermelon', 'Sandía',    0, 100),
      ('viva-grp-juice-build', 'viva-mod-jb-lime',       'Lime',       'Limón',     0, 110),
      ('viva-grp-juice-build', 'viva-mod-jb-mint',       'Mint',       'Menta',     0, 120),
      ('viva-grp-smoothie-build', 'viva-mod-sb-strawberry', 'Strawberry', 'Fresa',     0, 10),
      ('viva-grp-smoothie-build', 'viva-mod-sb-blueberry',  'Blueberry',  'Arándano',  0, 20),
      ('viva-grp-smoothie-build', 'viva-mod-sb-banana',     'Banana',     'Plátano',   0, 30),
      ('viva-grp-smoothie-build', 'viva-mod-sb-mango',      'Mango',      'Mango',     0, 40),
      ('viva-grp-smoothie-build', 'viva-mod-sb-pineapple',  'Pineapple',  'Piña',      0, 50),
      ('viva-grp-smoothie-build', 'viva-mod-sb-papaya',     'Papaya',     'Papaya',    0, 60),
      ('viva-grp-smoothie-build', 'viva-mod-sb-goji',       'Goji berry', 'Goji berry',0, 70),
      ('viva-grp-smoothie-build', 'viva-mod-sb-chia',       'Chia seeds', 'Chía',      0, 80),
      ('viva-grp-smoothie-build', 'viva-mod-sb-flax',       'Flax seeds', 'Linaza',    0, 90),
      ('viva-grp-bowl-fruits', 'viva-mod-bf-strawberry', 'Strawberry', 'Fresa',    0, 10),
      ('viva-grp-bowl-fruits', 'viva-mod-bf-blueberry',  'Blueberry',  'Arándano', 0, 20),
      ('viva-grp-bowl-fruits', 'viva-mod-bf-banana',     'Banana',     'Plátano',  0, 30),
      ('viva-grp-bowl-fruits', 'viva-mod-bf-mango',      'Mango',      'Mango',    0, 40),
      ('viva-grp-bowl-fruits', 'viva-mod-bf-pineapple',  'Pineapple',  'Piña',     0, 50),
      ('viva-grp-bowl-fruits', 'viva-mod-bf-kiwi',       'Kiwi',       'Kiwi',     0, 60),
      ('viva-grp-bowl-fruits', 'viva-mod-bf-papaya',     'Papaya',     'Papaya',   0, 70),
      ('viva-grp-bowl-toppings', 'viva-mod-bt-granola',  'Granola',       'Granola',        0, 10),
      ('viva-grp-bowl-toppings', 'viva-mod-bt-chia',     'Chia seeds',    'Chía',           0, 20),
      ('viva-grp-bowl-toppings', 'viva-mod-bt-coconut',  'Coconut flakes','Coco rallado',   0, 30),
      ('viva-grp-bowl-toppings', 'viva-mod-bt-nutella',  'Nutella',       'Nutella',        0, 40),
      ('viva-grp-bowl-toppings', 'viva-mod-bt-honey',    'Honey',         'Miel',           0, 50),
      ('viva-grp-bowl-toppings', 'viva-mod-bt-pb',       'Peanut butter', 'Crema de cacahuate', 0, 60)
    ) as m(grp, id, name, es, price, ord)
    join public.catalog_modifier_groups g on g.store_id = v_store and g.clover_group_id = m.grp
  on conflict (store_id, clover_modifier_id) do nothing;

  -- Qué grupo lleva cada producto.
  insert into public.catalog_item_modifier_groups (item_id, modifier_group_id, sort_order)
  select i.id, g.id, l.ord
    from (values
      ('viva-juice-custom',    'viva-grp-juice-build',    5),
      ('viva-smoothie-custom', 'viva-grp-smoothie-build', 5),
      ('viva-bowl-custom',     'viva-grp-bowl-fruits',    5),
      ('viva-bowl-custom',     'viva-grp-bowl-toppings',  6),
      ('viva-smoothie-berry',  'viva-grp-milk', 20), ('viva-smoothie-choco', 'viva-grp-milk', 20),
      ('viva-smoothie-vanil',  'viva-grp-milk', 20), ('viva-smoothie-disco', 'viva-grp-milk', 20),
      ('viva-smoothie-young',  'viva-grp-milk', 20), ('viva-smoothie-custom','viva-grp-milk', 20),
      ('viva-smoothie-berry',  'viva-grp-protein', 30), ('viva-smoothie-disco',  'viva-grp-protein', 30),
      ('viva-smoothie-young',  'viva-grp-protein', 30), ('viva-smoothie-custom', 'viva-grp-protein', 30),
      ('viva-iced-latte',  'viva-grp-milk', 20), ('viva-iced-frappe',   'viva-grp-milk', 20),
      ('viva-iced-matcha', 'viva-grp-milk', 20), ('viva-hot-cappuccino','viva-grp-milk', 20),
      ('viva-hot-latte',   'viva-grp-milk', 20), ('viva-hot-matcha',    'viva-grp-milk', 20),
      ('viva-iced-latte',  'viva-grp-flavor', 40), ('viva-iced-americano', 'viva-grp-flavor', 40),
      ('viva-iced-coldbrew','viva-grp-flavor', 40), ('viva-iced-frappe',   'viva-grp-flavor', 40),
      ('viva-hot-latte',   'viva-grp-flavor', 40), ('viva-hot-cappuccino', 'viva-grp-flavor', 40),
      ('viva-hot-americano','viva-grp-flavor', 40),
      ('viva-bite-tuna',   'viva-grp-bread', 10), ('viva-bite-salmon', 'viva-grp-bread', 10)
    ) as l(item, grp, ord)
    join public.catalog_items i on i.store_id = v_store and i.clover_item_id = l.item
    join public.catalog_modifier_groups g on g.store_id = v_store and g.clover_group_id = l.grp
  on conflict (item_id, modifier_group_id) do nothing;

  -- -------------------------------------------------------------------
  -- Historias destacadas (no caducan), una por producto con foto. El
  -- dueño las borra o agrega más desde el panel.
  -- -------------------------------------------------------------------
  insert into public.stories (restaurant_id, media_url, media_type, caption, item_id, sort_order, created_by, i18n)
  select v_restaurant,
         v_img || '/historias/' || s.img || '.jpg',
         'image', s.caption,
         (select i.id from public.catalog_items i where i.store_id = v_store and i.clover_item_id = s.item),
         s.ord, null,
         jsonb_build_object('es', jsonb_build_object('caption', s.es))
    from (values
      ('viva-juice',        'viva-juice-viva',     'Our house classic 🍊',             'El clásico de la casa 🍊',          10),
      ('viva-berry',        'viva-smoothie-berry', 'Packed with antioxidants 🍓',      'Puro antioxidante 🍓',              20),
      ('jugo-verde',        'viva-juice-green',    'Start your day green 🌿',          'Empieza el día en verde 🌿',        30),
      ('chocolate-protein', 'viva-smoothie-choco', 'Post-workout fuel 💪',             'Después del gym 💪',                40),
      ('vanilla-protein',   'viva-smoothie-vanil', 'Protein with a vanilla twist',     'Proteína con sabor a vainilla',     50),
      ('forever-young',     'viva-smoothie-young', 'Mango and pineapple, that''s it',  'Mango y piña, nada más',            60),
      ('disco-duro',        'viva-smoothie-disco', 'The study-session favorite',       'El favorito para estudiar',         70),
      ('super-detox',       'viva-juice-detox',    'Carrot, apple, celery and lime',   'Zanahoria, manzana, apio y limón',  80),
      ('anti-flu',          'viva-juice-antiflu',  'For the chilly days 🍯',           'Para los días fríos 🍯',            90),
      ('refresh-me',        'viva-juice-refresh',  'Watermelon, lime and mint 🍉',     'Sandía, limón y menta 🍉',         100),
      ('cafe',              'viva-hot-brew',       'Your morning coffee ☕',           'Tu café de cada mañana ☕',        110)
    ) as s(img, item, caption, es, ord)
   where not exists (
     select 1 from public.stories st where st.media_url = v_img || '/historias/' || s.img || '.jpg'
   );
end
$seed$;
