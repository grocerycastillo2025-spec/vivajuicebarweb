/**
 * Menu: una sola lista continua, con las categorias como secciones.
 *
 * NO ES UN FILTRO
 * Los chips de arriba no esconden nada: son atajos. El cliente baja y va
 * pasando por Juices, Smoothies, Bowls… igual que en la carta de papel.
 * Un filtro excluyente obliga a saber lo que se busca antes de mirar, y
 * en una carta de 50 productos eso es justo lo que no se tiene.
 *
 * EL FALLO DE "UN PASO ATRASADO"
 * Tocar el chip de la ultima categoria dejaba la pantalla en la anterior.
 * No era un error de calculo: la lista no puede subir una categoria
 * arriba del todo si no tiene una ventana entera de contenido POR DEBAJO,
 * y la ultima no la tiene. El sistema recortaba el desplazamiento y la
 * lista se quedaba corta, mientras el chip —marcado al tocarlo— decia
 * otra cosa. Se arregla dando ese sitio: `tailPadding`.
 *
 * La segunda mitad era el chip. Un salto atraviesa todas las categorias
 * intermedias y cada una avisa de que esta a la vista; si esos avisos
 * pueden escribir, el chip va cambiando durante el viaje. Antes se
 * silenciaban 600 ms con un cronometro, que no sabe cuando termina un
 * scroll. Ahora la regla vive en `src/domain/menu-nav.ts` y la guardia se
 * levanta por un hecho: llegar, pararse, o que el cliente toque la lista.
 *
 * UNA SOLA FORMA DE FILA, A CUALQUIER ANCHO
 * Antes la lista cambiaba a mosaico de dos columnas por encima de 500 dp
 * de ancho. Eso lo puse yo, no se pidio, y rompia la pantalla en cualquier
 * aparato que declare ese ancho —una tablet, un plegable, o un telefono
 * con el zoom de pantalla al minimo—: el "+" se despegaba al borde, la
 * descripcion desaparecia y las filas pasaban a medir 238 px. La carta se
 * lee igual de bien en una columna en una tablet, asi que hay una sola
 * forma: texto a la izquierda, foto a la derecha. Sin ramas por ancho no
 * hay una version que nadie mire.
 *
 * RENDIMIENTO
 * `SectionList` ya virtualiza. Lo que se anade es `getItemLayout`, para
 * que saltar a una categoria lejana sea instantaneo en vez de un tiron
 * mientras mide; las fotos las gestiona `expo-image` con cache en disco
 * y carga diferida.
 *
 * El orden sale de la base (`catalog_categories.sort_order` y
 * `app_item_overrides.sort_order`). Aqui no se ordena nada.
 *
 * EL RECARGO POR TARJETA VA EN LA CABECERA, NO AL FINAL
 * Nueva Jersey (P.L. 2023, c.146) pide el aviso en el checkout, y a los
 * RESTAURANTES les pide ademas el importe EN LA CARTA, incluidas las
 * cartas en linea o por QR. Esta pestana es esa carta. Un pie de lista lo
 * cumpliria de boquilla —nadie baja cincuenta productos para leerlo—, asi
 * que va en la cabecera fija, pegado a los precios que no lo llevan
 * dentro. Ocupa una linea, y solo cuando la sucursal tiene recargo: hoy,
 * con `surcharge_rate` sin consultar, no ocupa nada.
 */

import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  Pressable,
  RefreshControl,
  ScrollView,
  SectionList,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  type ViewToken,
} from 'react-native';

import { fetchItemsRequiringChoice, fetchMenu } from '../../src/api/menu';
import type { MenuCategory, MenuItemRow } from '../../src/api/types';
import { CartBar } from '../../src/components/CartBar';
import { DataState } from '../../src/components/DataState';
import { MenuItemCard } from '../../src/components/MenuItemCard';
import { Screen, useScreenInsets } from '../../src/components/Screen';
import { SurchargeNotice } from '../../src/components/SurchargeNotice';
import type { BrandColors } from '../../src/domain/branding';
import { HEADER_HEIGHT, ROW_HEIGHT } from '../../src/domain/card-metrics';
import { initialNavState, menuNav } from '../../src/domain/menu-nav';
import {
  makeSectionLayout,
  sectionOfFlatIndex,
  tailPadding,
  type SectionSizes,
} from '../../src/domain/section-layout';
import { useAsync } from '../../src/hooks/use-async';
import { needsChoice, useQuickAdd } from '../../src/hooks/use-quick-add';
import { useSurcharge } from '../../src/hooks/use-surcharge';
import { useColors } from '../../src/state/branding-context';
import { useStores } from '../../src/state/store-context';
import { strings } from '../../src/strings';
import { radius, spacing, type as typography } from '../../src/theme';

interface Section {
  readonly id: string;
  readonly title: string;
  readonly data: readonly MenuItemRow[];
}

interface MenuData {
  readonly categories: readonly MenuCategory[];
  /** `null` = no se pudo averiguar; se trata como "todo pide eleccion". */
  readonly requiresChoice: ReadonlySet<string> | null;
}

export default function MenuScreen(): ReactNode {
  const insets = useScreenInsets();
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const router = useRouter();

  const {
    selectedStore,
    selectedStoreId,
    hasChoice,
    loading: storesLoading,
    error: storesError,
    reload: reloadStores,
  } = useStores();

  const surcharge = useSurcharge();

  const load = useCallback(async (): Promise<MenuData> => {
    if (selectedStoreId === null) return { categories: [], requiresChoice: new Set() };
    const [categories, requiresChoice] = await Promise.all([
      fetchMenu(selectedStoreId),
      fetchItemsRequiringChoice(selectedStoreId),
    ]);
    return { categories, requiresChoice };
  }, [selectedStoreId]);

  const { data, error, loading, refreshing, refresh, reload } = useAsync(load, [selectedStoreId]);

  const listRef = useRef<SectionList<MenuItemRow, Section>>(null);
  const chipsRef = useRef<ScrollView>(null);
  const chipLayout = useRef<Record<string, { x: number; width: number }>>({});

  const requiresChoice = data?.requiresChoice ?? null;
  const onQuickAdd = useQuickAdd(requiresChoice);

  const [nav, dispatchNav] = useReducer(menuNav, initialNavState);
  /** Alto util de la lista, medido. Hasta tenerlo no se reserva cola. */
  const [viewport, setViewport] = useState(0);

  const sections = useMemo<Section[]>(
    () =>
      (data?.categories ?? []).map((category) => ({
        id: category.id,
        title: category.name,
        data: category.items,
      })),
    [data],
  );

  const counts = useMemo(() => sections.map((section) => section.data.length), [sections]);
  const sizes = useMemo<SectionSizes>(
    () => ({ header: HEADER_HEIGHT, row: ROW_HEIGHT, footer: 0 }),
    [],
  );

  // Al cargar, el activo es la primera categoria. Recargar no devuelve al
  // cliente al principio de la carta.
  useEffect(() => {
    dispatchNav({ type: 'load', firstId: sections[0]?.id ?? null });
  }, [sections]);

  const getItemLayout = useMemo(() => makeSectionLayout(counts, sizes), [counts, sizes]);

  /**
   * Hueco de siempre: area segura, barra de pestanas y el carrito flotante.
   * Encima va lo que le falte a la ultima categoria para poder subir.
   */
  const baseBottom = insets.bottom + 96;
  const paddingBottom = tailPadding(counts, sizes, viewport, baseBottom);

  const onListLayout = useCallback((event: LayoutChangeEvent) => {
    setViewport(event.nativeEvent.layout.height);
  }, []);

  // --- Marcar el chip segun el scroll ------------------------------------
  const onViewable = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    // Los tokens llegan en orden, asi que el primero es lo mas alto de la
    // ventana. Las cabeceras tambien traen su seccion.
    const first = viewableItems.find((token) => token.section !== undefined);
    const section = first?.section as Section | undefined;
    dispatchNav({ type: 'scrolled', topId: section?.id ?? null });
  }).current;

  const viewabilityConfig = useRef({
    // Basta con que asome: el encabezado de la categoria entrante manda en
    // cuanto aparece, que es lo que espera quien esta bajando.
    itemVisiblePercentThreshold: 10,
    minimumViewTime: 60,
  }).current;

  // --- Mantener el chip activo a la vista --------------------------------
  useEffect(() => {
    if (nav.activeId === null) return;
    const layout = chipLayout.current[nav.activeId];
    if (layout === undefined) return;
    chipsRef.current?.scrollTo({ x: Math.max(0, layout.x - spacing.lg), animated: true });
  }, [nav.activeId]);

  const jumpTo = useCallback((index: number, id: string) => {
    dispatchNav({ type: 'tap', id });
    listRef.current?.scrollToLocation({
      sectionIndex: index,
      itemIndex: 0,
      // 0 y no el alto del encabezado: al estar fijado arriba, se queda
      // pegado sobre la primera fila igualmente.
      viewOffset: 0,
      animated: true,
    });
  }, []);

  const activeError = storesError ?? error;
  const activeLoading = storesLoading || loading;
  const isEmpty = !activeLoading && activeError === null && sections.length === 0;

  const header = (
    <View style={styles.titleRow}>
      <Text style={styles.title}>{strings.menu.title}</Text>
      {hasChoice && selectedStore !== null ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={strings.menu.changeStoreHint(selectedStore.name)}
          onPress={() => router.push('/store-picker')}
          hitSlop={8}
          style={({ pressed }) => [styles.storeChip, pressed && styles.chipPressed]}
        >
          <Text style={styles.storeChipText} numberOfLines={1}>
            {selectedStore.name}
          </Text>
          <Ionicons name="chevron-down" size={14} color={colors.primary} />
        </Pressable>
      ) : null}
    </View>
  );

  if (activeError !== null || activeLoading || isEmpty) {
    return (
      <Screen scroll={false} withTabBar>
        <View style={styles.headerBar}>{header}</View>
        <DataState
          loading={activeLoading}
          error={activeError}
          empty={isEmpty}
          onRetry={storesError !== null ? reloadStores : reload}
          loadingLabel={strings.menu.loading}
          emptyTitle={strings.menu.emptyTitle}
          emptyBody={
            selectedStore === null
              ? strings.menu.emptyPickStore
              : strings.menu.emptyBody(selectedStore.name)
          }
        >
          {null}
        </DataState>
      </Screen>
    );
  }

  return (
    <Screen scroll={false} withTabBar>
      <View style={styles.headerBar}>
        {header}
        <SurchargeNotice disclosure={surcharge} variant="line" tone="menu" style={styles.notice} />
        <ScrollView
          ref={chipsRef}
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chips}
        >
          {sections.map((section, index) => {
            const active = nav.activeId === section.id;
            return (
              <Pressable
                key={section.id}
                accessibilityRole="tab"
                accessibilityState={{ selected: active }}
                onLayout={(event) => {
                  const { x, width: chipWidth } = event.nativeEvent.layout;
                  chipLayout.current[section.id] = { x, width: chipWidth };
                }}
                onPress={() => jumpTo(index, section.id)}
                style={({ pressed }) => [
                  styles.chip,
                  active && styles.chipActive,
                  pressed && styles.chipPressed,
                ]}
              >
                <Text style={[styles.chipText, active && styles.chipTextActive]}>
                  {section.title}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      <SectionList
        ref={listRef}
        sections={sections}
        keyExtractor={(item) => item.id}
        onLayout={onListLayout}
        // Pegajosos: al bajar por una categoria larga, saber en cual se
        // esta sin subir a mirar.
        stickySectionHeadersEnabled
        getItemLayout={getItemLayout}
        onViewableItemsChanged={onViewable}
        viewabilityConfig={viewabilityConfig}
        contentContainerStyle={[styles.listContent, { paddingBottom }]}
        // El dedo manda sobre un salto en vuelo.
        onScrollBeginDrag={() => dispatchNav({ type: 'touched' })}
        // La guardia del chip se levanta al PARAR, no a los 600 ms: un
        // cronometro no sabe cuanto dura un salto de seis mil pixeles.
        onMomentumScrollEnd={() => dispatchNav({ type: 'settled' })}
        onScrollEndDrag={() => dispatchNav({ type: 'settled' })}
        // Desactivado a proposito: en Android deja celdas recortadas sin
        // repintar tras un salto largo, y se ve la categoria de la que
        // vienes debajo de la cabecera de la nueva. `getItemLayout` y
        // `windowSize` ya acotan el trabajo.
        removeClippedSubviews={false}
        initialNumToRender={8}
        maxToRenderPerBatch={8}
        windowSize={9}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={refresh}
            tintColor={colors.primary}
            colors={[colors.primary]}
          />
        }
        renderSectionHeader={({ section }) => (
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>{section.title}</Text>
          </View>
        )}
        renderItem={({ item }) => (
          <MenuItemCard
            item={item}
            requiresChoice={needsChoice(requiresChoice, item.id)}
            onQuickAdd={onQuickAdd}
          />
        )}
        // Con getItemLayout no deberia fallar; si pasa, se reintenta sin
        // animacion. `info.index` es el indice PLANO (cabeceras y pies
        // incluidos) y `scrollToLocation` pide el de SECCION: pasar uno
        // por el otro manda la lista a una categoria cualquiera.
        onScrollToIndexFailed={(info) => {
          const sectionIndex = sectionOfFlatIndex(counts, info.index);
          setTimeout(() => {
            listRef.current?.scrollToLocation({ sectionIndex, itemIndex: 0, animated: false });
          }, 80);
        }}
      />

      <CartBar bottomOffset={0} />
    </Screen>
  );
}

function createStyles(colors: BrandColors) {
  return StyleSheet.create({
    headerBar: {
      paddingTop: spacing.md,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      backgroundColor: colors.background,
    },
    title: { color: colors.text, fontSize: typography.display.fontSize, fontWeight: '800' },
    titleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
      marginBottom: spacing.md,
    },
    storeChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: colors.primary,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs,
      maxWidth: '55%',
    },
    storeChipText: {
      color: colors.primary,
      fontSize: typography.label.fontSize,
      fontWeight: '700',
      flexShrink: 1,
    },

    notice: { paddingHorizontal: spacing.lg, marginBottom: spacing.md },

    chips: { paddingHorizontal: spacing.lg, paddingBottom: spacing.md, gap: spacing.sm },
    chip: {
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
    },
    chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
    chipPressed: { opacity: 0.7 },
    chipText: { color: colors.textMuted, fontSize: typography.label.fontSize, fontWeight: '600' },
    chipTextActive: { color: colors.onPrimary },

    listContent: { paddingHorizontal: spacing.lg },
    sectionHeader: {
      height: HEADER_HEIGHT,
      justifyContent: 'flex-end',
      paddingBottom: spacing.sm,
      backgroundColor: colors.background,
    },
    sectionTitle: { color: colors.text, fontSize: typography.title.fontSize, fontWeight: '800' },
  });
}
