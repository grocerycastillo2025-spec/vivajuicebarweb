/**
 * Home: marca, sucursal y destacados.
 *
 * LA CABECERA ES EL LOGO, Y EL LOGO SALE DE LA BASE
 * `app_settings.logo_url`, no un archivo empotrado. La plataforma es
 * multi-marca (§19): cambiar el logo no puede exigir una release, y el
 * logo de Viva no puede estar dentro del binario de nadie mas. Si la base
 * no trae logo, se cae al nombre escrito, que es lo que se veia antes.
 *
 * LA SUCURSAL ES UNA LINEA, NO UNA FICHA
 * Una direccion no necesita un recuadro: necesita poder tocarse y abrir
 * el mapa. Debajo queda una linea tenue con el horario, porque saber si
 * esta abierto es lo unico mas util que la direccion — y quitarlo para
 * ganar cuatro pixeles seria cambiar diseno por informacion.
 *
 * DESTACADOS EN REJILLA DE DOS
 * La foto manda. Un carrusel horizontal ensena tres productos y esconde
 * el resto detras de un gesto que mucha gente no hace.
 */

import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import { fetchFeaturedItems, fetchItemsRequiringChoice } from '../../src/api/menu';
import { fetchStoreHours, formatClock, todayHours } from '../../src/api/store';
import type { MenuItemRow, StoreHoursRow, StoreRow } from '../../src/api/types';
import { CartBar } from '../../src/components/CartBar';
import { LanguageToggle } from '../../src/components/LanguageToggle';
import { InstallBanner } from '../../src/components/InstallBanner';
import { StoriesRow } from '../../src/components/StoriesRow';
import { readEnv } from '../../src/env';
import { DataState } from '../../src/components/DataState';
import { MenuItemCard } from '../../src/components/MenuItemCard';
import { Screen } from '../../src/components/Screen';
import { Button, SectionTitle } from '../../src/components/ui';
import type { BrandColors } from '../../src/domain/branding';
import { shortAddress, storeMapsUrl, type MapsTarget } from '../../src/domain/maps';
import { useAsync } from '../../src/hooks/use-async';
import { useContentWidth } from '../../src/hooks/use-content-width';
import { needsChoice, useQuickAdd } from '../../src/hooks/use-quick-add';
import { useBranding } from '../../src/state/branding-context';
import { autoOpenDecided, loadStories, takeAutoOpen } from '../../src/state/stories-cache';
import { useStores } from '../../src/state/store-context';
import { gridColumns, radius, spacing, type as typography } from '../../src/theme';
import { strings } from '../../src/strings';

interface HomeData {
  readonly hours: readonly StoreHoursRow[];
  readonly featured: readonly MenuItemRow[];
  readonly requiresChoice: ReadonlySet<string> | null;
}

/** La fila de `stores` en la forma que entiende el modulo de mapas. */
function toMapsTarget(store: StoreRow): MapsTarget {
  return {
    name: store.name,
    latitude: store.latitude,
    longitude: store.longitude,
    addressLine1: store.address_line1,
    city: store.city,
    state: store.state,
    postalCode: store.postal_code,
  };
}

export default function HomeScreen(): ReactNode {
  const router = useRouter();
  const width = useContentWidth();
  // En la Home siempre dos por fila como minimo: es lo que pide la foto.
  const columns = Math.max(2, gridColumns(width));
  const { colors, displayName, logoUrl } = useBranding();
  const styles = useMemo(() => createStyles(colors), [colors]);

  // Historias (0022). Van aparte del resto de Inicio: si fallan, no
  // tumban la pantalla; simplemente no sale la fila.
  const getStories = useCallback(() => loadStories(readEnv().restaurantId).catch(() => []), []);
  const { data: stories } = useAsync(getStories, []);

  // Al abrir la app, las historias salen solas (como en Instagram): una
  // vez por visita, empezando por las nuevas. Ver `autoOpenStart`.
  //
  // Mientras se decide, Inicio sigue con "Cargando": si se pintara y
  // enseguida lo tapara el visor negro, se veria un parpadeo. Si las
  // historias tardan mas de 3 s, se ensena Inicio igual.
  const [covering, setCovering] = useState(() => !autoOpenDecided());
  useEffect(() => {
    if (!covering) return undefined;
    const timer = setTimeout(() => setCovering(false), 3000);
    return () => clearTimeout(timer);
  }, [covering]);
  useEffect(() => {
    if (stories == null) return undefined;
    if (stories.length === 0) {
      setCovering(false);
      return undefined;
    }
    let alive = true;
    let reveal: ReturnType<typeof setTimeout> | undefined;
    void takeAutoOpen(stories).then((id) => {
      if (!alive) return;
      if (id === null) {
        setCovering(false);
        return;
      }
      router.push({ pathname: '/historias', params: { id } });
      // Inicio aparece ya debajo del visor, sin verse.
      reveal = setTimeout(() => setCovering(false), 600);
    });
    return () => {
      alive = false;
      if (reveal !== undefined) clearTimeout(reveal);
    };
  }, [router, stories]);

  const {
    selectedStore,
    selectedStoreId,
    hasChoice,
    loading: storesLoading,
    error: storesError,
    reload: reloadStores,
  } = useStores();

  const load = useCallback(async (): Promise<HomeData> => {
    if (selectedStoreId === null) return { hours: [], featured: [], requiresChoice: new Set() };
    const [hours, featured, requiresChoice] = await Promise.all([
      fetchStoreHours(selectedStoreId),
      fetchFeaturedItems(selectedStoreId),
      fetchItemsRequiringChoice(selectedStoreId),
    ]);
    return { hours, featured, requiresChoice };
  }, [selectedStoreId]);

  const { data, error, loading, refreshing, refresh, reload } = useAsync(load, [selectedStoreId]);

  const requiresChoice = data?.requiresChoice ?? null;
  const onQuickAdd = useQuickAdd(requiresChoice);

  const openMaps = useCallback((store: StoreRow) => {
    const url = storeMapsUrl(toMapsTarget(store));
    if (url === null) return;
    // Si no hay con que abrirlo, no pasa nada: la direccion sigue escrita.
    void Linking.openURL(url).catch(() => undefined);
  }, []);

  // El fallo de sucursales manda: sin sucursal no hay nada que ensenar.
  const activeError = storesError ?? error;
  const activeLoading = storesLoading || loading || covering;

  if (activeError !== null || activeLoading || selectedStore === null) {
    return (
      <Screen scroll={false} withTabBar>
        <DataState
          loading={activeLoading}
          error={activeError}
          empty={!activeLoading && selectedStore === null}
          onRetry={storesError !== null ? reloadStores : reload}
          emptyTitle={strings.home.noStoreTitle}
          emptyBody={strings.home.noStoreBody(displayName)}
        >
          {null}
        </DataState>
      </Screen>
    );
  }

  const today = todayHours(data?.hours ?? [], selectedStore.timezone);
  const address = shortAddress(toMapsTarget(selectedStore));
  const mapsUrl = storeMapsUrl(toMapsTarget(selectedStore));
  const featured = data?.featured ?? [];
  const hoursLabel =
    today === null
      ? strings.home.closedToday
      : strings.home.hoursToday(formatClock(today.opens_at), formatClock(today.closes_at));

  return (
    <>
      <Screen withTabBar refreshing={refreshing} onRefresh={refresh} contentStyle={styles.content}>
        <InstallBanner />
        <StoriesRow stories={stories ?? []} />

        <View style={styles.hero}>
          <LanguageToggle style={styles.language} />
          {logoUrl === null ? (
            <Text style={styles.kicker}>{displayName}</Text>
          ) : (
            <Image
              source={logoUrl}
              style={styles.logo}
              contentFit="contain"
              contentPosition="center"
              transition={200}
              cachePolicy="memory-disk"
              accessibilityLabel={displayName}
              accessibilityIgnoresInvertColors
            />
          )}
          <Text style={styles.heroTitle}>{strings.home.heroTitle}</Text>
          <Text style={styles.heroBody}>{strings.home.heroBody}</Text>
          <Button
            label={strings.home.seeMenu}
            variant="accent"
            onPress={() => router.push('/menu')}
            style={styles.heroButton}
          />
        </View>

        <View style={styles.place}>
          {address === '' ? null : (
            <Pressable
              accessibilityRole="link"
              accessibilityLabel={strings.home.directions(address)}
              disabled={mapsUrl === null}
              onPress={() => openMaps(selectedStore)}
              style={({ pressed }) => [styles.addressRow, pressed && styles.pressed]}
            >
              <Ionicons name="location-sharp" size={18} color={colors.primary} />
              <Text style={styles.address} numberOfLines={1}>
                {address}
              </Text>
              <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />
            </Pressable>
          )}

          <View style={styles.metaRow}>
            <Text style={styles.meta} numberOfLines={1}>
              {selectedStore.name} · {hoursLabel}
            </Text>
            {hasChoice ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => router.push('/store-picker')}
                hitSlop={8}
                style={({ pressed }) => [pressed && styles.pressed]}
              >
                <Text style={styles.change}>{strings.home.change}</Text>
              </Pressable>
            ) : null}
          </View>
        </View>

        <View style={styles.section}>
          <SectionTitle>{strings.home.featured}</SectionTitle>
          {featured.length === 0 ? (
            <Text style={styles.emptyFeatured}>{strings.home.noFeatured}</Text>
          ) : (
            <View style={styles.grid}>
              {featured.map((item) => (
                <View key={item.id} style={{ width: `${100 / columns}%`, padding: spacing.xs }}>
                  <MenuItemCard
                    item={item}
                    layout="tile"
                    requiresChoice={needsChoice(requiresChoice, item.id)}
                    onQuickAdd={onQuickAdd}
                  />
                </View>
              ))}
            </View>
          )}
        </View>
      </Screen>
      <CartBar />
    </>
  );
}

function createStyles(colors: BrandColors) {
  return StyleSheet.create({
    content: { padding: spacing.lg, gap: spacing.lg },

    hero: {
      backgroundColor: colors.primary,
      borderRadius: radius.lg,
      padding: spacing.xl,
      gap: spacing.sm,
    },
    // Arriba a la derecha, sin empujar el logo (va encima, no en la fila).
    language: { position: 'absolute', top: spacing.md, right: spacing.md, zIndex: 1 },
    // Sobre el verde va la version en crema del logotipo, que es la que se
    // sube a `app_settings.logo_url`. El seed lo carga desde public/img/logo-crema.png.
    //
    // El hueco lleva la proporcion del logotipo de Viva y el ancho en
    // porcentaje, no en pixeles: asi ocupa lo mismo en un telefono
    // estrecho que en una tablet. Otra marca con otra proporcion se
    // ajusta dentro con `contain` en vez de deformarse.
    logo: {
      width: '62%',
      aspectRatio: 1036 / 630,
      alignSelf: 'center',
      marginBottom: spacing.sm,
    },
    // El texto es el MISMO hueco que el logo cuando la base no trae uno,
    // asi que va centrado igual. Si no, la cabecera se movia sola segun
    // hubiera logo o no.
    kicker: {
      // Sobre el color principal: tinta legible, no el acento (que puede
      // no contrastar, p. ej. verde sobre naranja).
      color: colors.onPrimary,
      opacity: 0.85,
      fontSize: typography.caption.fontSize,
      fontWeight: '800',
      letterSpacing: 1.2,
      textTransform: 'uppercase',
      alignSelf: 'center',
      textAlign: 'center',
      marginBottom: spacing.xs,
    },
    heroTitle: {
      color: colors.onPrimary,
      fontSize: typography.display.fontSize,
      fontWeight: '800',
      lineHeight: 34,
    },
    heroBody: {
      color: colors.onPrimary,
      opacity: 0.85,
      fontSize: typography.body.fontSize,
      lineHeight: 21,
    },
    heroButton: { marginTop: spacing.md, alignSelf: 'flex-start' },

    // --- sucursal en una linea -----------------------------------------
    place: { gap: spacing.xs },
    addressRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingVertical: spacing.xs,
    },
    address: {
      flex: 1,
      color: colors.text,
      fontSize: typography.body.fontSize,
      fontWeight: '600',
    },
    metaRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
      paddingLeft: 26, // alineado con el texto de la direccion, no con el pin
    },
    meta: { flex: 1, color: colors.textMuted, fontSize: typography.caption.fontSize + 1 },
    change: { color: colors.accent, fontSize: typography.label.fontSize, fontWeight: '700' },
    pressed: { opacity: 0.6 },

    section: { gap: spacing.sm },
    grid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      marginHorizontal: -spacing.xs,
    },
    emptyFeatured: { color: colors.textMuted, fontSize: typography.body.fontSize, lineHeight: 21 },
  });
}
