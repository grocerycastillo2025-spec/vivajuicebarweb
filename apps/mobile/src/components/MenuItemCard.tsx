/**
 * Tarjeta de producto del menu, en sus dos formas.
 *
 * FILA (`row`) — la lista del menu, patron de Uber Eats
 *   texto a la izquierda (nombre, precio, descripcion en gris a dos
 *   lineas), foto cuadrada a la derecha, un "+" redondo encima de la
 *   esquina inferior derecha de la foto, y un separador fino debajo. Sin
 *   marco ni fondo propio: la lista se lee como una carta, no como una
 *   baraja de tarjetas.
 *
 * MOSAICO (`tile`) — los destacados de la Home
 *   foto grande arriba y, debajo, nombre y precio. La foto manda.
 *
 * ALTO FIJO, A PROPOSITO
 * La lista calcula la posicion de cada categoria para poder saltar a ella
 * de un tiron (`src/domain/section-layout.ts`). Eso solo funciona si todas
 * las filas miden lo mismo, asi que el nombre ocupa una linea y la
 * descripcion dos, recortadas. Las constantes de abajo son la fuente de
 * verdad de esa medida, y viven en `domain/card-metrics.ts` para que los
 * tests puedan usar los numeros de verdad en vez de una copia.
 *
 * LA FOTO PUEDE NO ESTAR, Y ES EL CASO NORMAL
 * `image_url` viene vacio hasta que se suben las fotos, y entremedias
 * habra urls que apunten a un archivo que aun no se subio. Los tres casos
 * los resuelve `ItemPhoto`: debajo hay SIEMPRE un bloque de marca y la
 * imagen se pinta encima cuando carga. Nunca hay hueco gris ni salto de
 * maquetacion, asi que el diseno es el mismo con 0 fotos y con 50.
 *
 * EL "+" NO VA DENTRO DEL ENLACE
 * Es hermano del `Pressable` que abre el detalle, no hijo. Dos zonas
 * tactiles anidadas se disputan el toque, y el que pierde es siempre el
 * pequeno.
 *
 * POR QUE NO HAY UN <Link asChild> AQUI
 * Lo habia, y se comia la maquetacion entera. `Link asChild` usa el `Slot`
 * de Radix, que fusiona el `style` del padre con el del hijo COMO OBJETO:
 *
 *     overrideProps.style = { ...styleDelSlot, ...styleDelHijo }
 *
 * El `style` de un `Pressable` puede ser una FUNCION —`({ pressed }) =>
 * [...]`, que es como se pinta el estado pulsado— y desparramar una
 * funcion en un objeto da `{}`: las funciones no tienen propiedades
 * enumerables. Resultado: el Pressable se quedaba sin un solo estilo. Sin
 * `flexDirection: 'row'`, sin alto, sin relleno. La foto caia debajo del
 * texto en vez de al lado, se salia de su fila y tapaba el nombre y el
 * precio de la fila siguiente; de la descripcion solo asomaba la cola por
 * la derecha de la foto. Era eso, y no un desbordamiento.
 *
 * Se navega con `router.push`. Un enlace de verdad aporta semantica en
 * web, pero esto es una app nativa y no compensa pagarlo con la
 * maquetacion. Si algun dia vuelve un `Link asChild`, su hijo NO puede
 * llevar el `style` como funcion.
 */

import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { memo, useMemo, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { MenuItemRow } from '../api/types';
import type { BrandColors } from '../domain/branding';
import { CARD, ROW_HEIGHT, TILE_HEIGHT } from '../domain/card-metrics';
import { formatMoney } from '../domain/money';
import { quickAddAction } from '../domain/quick-add';
import { useColors } from '../state/branding-context';
import { strings } from '../strings';
import { radius, spacing, type as typography } from '../theme';
import { ItemPhoto } from './ItemPhoto';
import { Badge } from './ui';

/**
 * Las medidas viven en `domain/card-metrics.ts`, sin React, para que la
 * aritmetica de posiciones de la lista se pueda comprobar en un test. Se
 * reexportan aqui porque es donde se buscan.
 */
export { CARD, ROW_HEIGHT, TILE_HEIGHT } from '../domain/card-metrics';

interface MenuItemCardProps {
  readonly item: MenuItemRow;
  readonly layout?: 'row' | 'tile';
  /**
   * `true` si el producto tiene algun grupo de modificadores obligatorio.
   * Sale de la base (`catalog_modifier_groups.min_required`), no de una
   * lista en la app.
   */
  readonly requiresChoice?: boolean;
  /** Anadir al carrito. Sin esto no se pinta el "+". */
  readonly onQuickAdd?: (item: MenuItemRow) => void;
}

function MenuItemCardBase({
  item,
  layout = 'row',
  requiresChoice = false,
  onQuickAdd,
}: MenuItemCardProps): ReactNode {
  const colors = useColors();
  const router = useRouter();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const tile = layout === 'tile';
  const unavailable = !item.is_available;

  const action = quickAddAction(item, requiresChoice);
  const price = formatMoney(item.price_cents);

  const photo = (
    <ItemPhoto
      url={item.image_url}
      recyclingKey={item.id}
      glyphSize={tile ? 44 : 30}
      style={
        tile
          ? { width: '100%', height: CARD.tileImage, borderRadius: radius.lg }
          : { width: CARD.thumb, height: CARD.thumb }
      }
    />
  );

  return (
    <View style={tile ? styles.tileWrap : styles.rowWrap}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${item.name}, ${price}`}
        disabled={unavailable}
        onPress={() => router.push({ pathname: '/item/[id]', params: { id: item.id } })}
        style={({ pressed }) => [
          tile ? styles.tile : styles.row,
          pressed && styles.pressed,
          unavailable && styles.unavailable,
        ]}
      >
        {tile ? photo : null}

        <View style={tile ? styles.tileBody : styles.rowBody}>
          <View style={styles.headline}>
            <Text style={[styles.name, tile && styles.nameTile]} numberOfLines={tile ? 2 : 1}>
              {item.name}
            </Text>
            {/* Una etiqueta en blanco no es una etiqueta: sin esto queda
                una raya naranja suelta al lado del nombre. */}
            {!tile && item.badge !== null && item.badge.trim() !== '' ? (
              <View style={styles.badgeSlot}>
                <Badge label={item.badge} />
              </View>
            ) : null}
          </View>

          <Text style={styles.price}>{price}</Text>

          {tile ? null : unavailable ? (
            <Text style={styles.soldOut} numberOfLines={2}>
              {item.unavailable_reason ?? strings.item.unavailableNow}
            </Text>
          ) : (
            <Text style={styles.description} numberOfLines={2}>
              {item.description ?? ''}
            </Text>
          )}
        </View>

        {tile ? null : photo}
      </Pressable>

      {onQuickAdd === undefined || action === 'blocked' ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            action === 'choose'
              ? strings.menu.chooseOptionsFor(item.name)
              : strings.menu.addToCart(item.name)
          }
          hitSlop={8}
          onPress={() => onQuickAdd(item)}
          style={({ pressed }) => [
            styles.plus,
            tile ? styles.plusTile : styles.plusRow,
            pressed && styles.plusPressed,
          ]}
        >
          <Ionicons
            // Si hay que elegir algo, el boton no promete que ya esta:
            // lleva a la pantalla donde se elige.
            name={action === 'choose' ? 'options-outline' : 'add'}
            size={action === 'choose' ? 18 : 22}
            color={colors.primary}
          />
        </Pressable>
      )}
    </View>
  );
}

/**
 * Memoizada: al desplazar 50 tarjetas, volver a pintar las que no han
 * cambiado es la diferencia entre una lista suave y una que da tirones.
 */
export const MenuItemCard = memo(MenuItemCardBase);

function createStyles(colors: BrandColors) {
  return StyleSheet.create({
    // --- fila -----------------------------------------------------------
    rowWrap: { height: ROW_HEIGHT },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      // El alto incluye relleno y borde (Yoga mide en border-box), asi que
      // el hueco util es exactamente el lado de la foto: 125 - 28 - 1 = 96.
      height: ROW_HEIGHT,
      paddingVertical: CARD.padV,
      borderBottomWidth: CARD.separator,
      borderBottomColor: colors.border,
      // Nada puede pintarse fuera de la fila. Es el cinturon: si algun dia
      // el calculo se descuadra, se recorta en vez de irse por el borde de
      // la pantalla y dejar la carta ilegible.
      overflow: 'hidden',
    },
    // `minWidth: 0` no hace nada en Yoga (ya es su valor) pero si en la web,
    // donde los hijos de un flex traen `min-width: auto` y se niegan a
    // encoger por debajo de su contenido. Con esto el banco de pruebas mide
    // lo mismo que el telefono.
    rowBody: { flex: 1, minWidth: 0, gap: 2 },

    // --- mosaico --------------------------------------------------------
    tileWrap: { height: TILE_HEIGHT },
    tile: { height: TILE_HEIGHT - CARD.tileGap },
    tileBody: { paddingTop: spacing.sm, gap: 2 },

    pressed: { opacity: 0.7 },
    unavailable: { opacity: 0.5 },

    headline: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
    },
    // En el mosaico se reservan siempre las dos lineas, aunque el nombre
    // ocupe una: si no, el precio de la tarjeta de al lado queda a otra
    // altura y la rejilla se ve torcida.
    nameTile: { minHeight: 40 },
    // La etiqueta cede antes que el nombre: en Yoga `flexShrink` vale 0
    // por defecto, asi que sin esto una etiqueta larga se queda entera y
    // estruja el nombre hasta dejarlo en nada.
    badgeSlot: { flexShrink: 1 },
    name: {
      // NO `flex: 1`. Eso da base 0, y en Yoga —que no tiene el
      // `min-width: auto` de CSS— un hijo con base 0 puede encogerse hasta
      // desaparecer: con una etiqueta ancha al lado, el nombre del producto
      // se quedaba en cero pixeles y no se veia. Con base automatica su
      // punto de partida es su propio texto, y cede sitio sin borrarse.
      flexGrow: 1,
      flexShrink: 1,
      flexBasis: 'auto',
      color: colors.text,
      fontSize: typography.body.fontSize + 1,
      fontWeight: '700',
      lineHeight: 20,
    },
    price: {
      color: colors.text,
      fontSize: typography.body.fontSize,
      fontWeight: '600',
      lineHeight: 20,
    },
    description: {
      color: colors.textMuted,
      fontSize: typography.caption.fontSize + 1,
      lineHeight: 17,
      // Reservado siempre: sin esto, un producto sin descripcion mide
      // menos que sus vecinos y el calculo de posiciones se descuadra.
      minHeight: 34,
    },
    soldOut: {
      color: colors.danger,
      fontSize: typography.caption.fontSize + 1,
      fontWeight: '700',
      lineHeight: 17,
      minHeight: 34,
    },

    // --- boton "+" ------------------------------------------------------
    plus: {
      position: 'absolute',
      width: CARD.plus,
      height: CARD.plus,
      borderRadius: CARD.plus / 2,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      // Para que se lea igual sobre una foto oscura y sobre el bloque de
      // marca que hay debajo cuando no hay foto.
      elevation: 3,
      shadowColor: '#000000',
      shadowOpacity: 0.18,
      shadowRadius: 3,
      shadowOffset: { width: 0, height: 1 },
    },
    plusRow: { right: CARD.plusInset, bottom: CARD.padV + CARD.separator + CARD.plusInset },
    plusTile: { right: spacing.sm, top: CARD.tileImage - CARD.plus - spacing.sm },
    plusPressed: { opacity: 0.7, transform: [{ scale: 0.94 }] },
  });
}
