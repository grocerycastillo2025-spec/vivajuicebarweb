/**
 * Visor de historias a pantalla completa (/historias?id=...).
 *
 * Toques: derecha = siguiente, izquierda = anterior, mantener = pausa.
 * Las imagenes duran 5 s; los videos, lo que dure el video. Al acabar la
 * ultima se cierra. Si la historia apunta a un producto, "Pedir" lleva a
 * el.
 */

import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Animated, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { trackEvent } from '../src/analytics/track';
import { fetchStories, type StoryRow } from '../src/api/stories';
import { cachedStories, preloadStory } from '../src/state/stories-cache';
import { StoryVideo } from '../src/components/StoryVideo';
import { IMAGE_STORY_MS, orderForViewer } from '../src/domain/stories';
import { readEnv } from '../src/env';
import { useBranding } from '../src/state/branding-context';
import { markStorySeen, useSeenStories } from '../src/state/seen-stories';
import { strings } from '../src/strings';

/** Entra con un fundido corto: sin el, el negro aparece de golpe. */
export default function StoriesViewer(): ReactNode {
  const fade = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(fade, { toValue: 1, duration: 220, useNativeDriver: Platform.OS !== 'web' }).start();
  }, [fade]);
  return (
    <Animated.View style={{ flex: 1, opacity: fade, backgroundColor: '#000' }}>
      <StoriesViewerContent />
    </Animated.View>
  );
}

function StoriesViewerContent(): ReactNode {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, displayName } = useBranding();
  const seen = useSeenStories();

  // Si Inicio ya bajó las historias, el visor abre al instante con ellas.
  const initial = useMemo(() => {
    const list = cachedStories();
    if (list === null) return null;
    const ordered = orderForViewer(list, seen);
    const start = ordered.findIndex((s) => s.id === id);
    return { ordered, start: start === -1 ? 0 : start };
    // Solo al abrir: reordenar mientras se ven las moveria de sitio.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [stories, setStories] = useState<StoryRow[] | null>(initial?.ordered ?? null);
  const [index, setIndex] = useState(initial?.start ?? 0);
  const [progress, setProgress] = useState(0);
  const [paused, setPaused] = useState(false);
  // La foto de la historia actual ya se ve. El reloj de 5 s no corre antes:
  // con internet lento la historia no se salta sin haberse visto.
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const orderFixed = useRef(initial !== null);

  // Sin lista en memoria (se entró directo a /historias): se pide.
  useEffect(() => {
    if (orderFixed.current) return;
    void fetchStories(readEnv().restaurantId)
      .then((list) => {
        if (orderFixed.current) return;
        orderFixed.current = true;
        const ordered = orderForViewer(list, seen);
        setStories(ordered);
        const start = ordered.findIndex((s) => s.id === id);
        setIndex(start === -1 ? 0 : start);
      })
      .catch(() => setStories([]));
    // `seen` solo cuenta en la primera carga, a proposito.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const current = stories?.[index] ?? null;
  const loaded = current === null || current.media_type !== 'image' || loadedId === current.id;

  const close = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, [router]);

  const next = useCallback(() => {
    setProgress(0);
    setIndex((i) => {
      if (stories === null || i + 1 >= stories.length) {
        close();
        return i;
      }
      return i + 1;
    });
  }, [close, stories]);

  const prev = useCallback(() => {
    setProgress(0);
    setIndex((i) => Math.max(0, i - 1));
  }, []);

  // Vista: se marca y se cuenta al empezar cada historia; se precarga la
  // siguiente para que al pasar ya este lista.
  useEffect(() => {
    if (current === null) return;
    markStorySeen(current.id);
    trackEvent('story_view', current.id);
    preloadStory(stories?.[index + 1]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  // Reloj de las imagenes.
  useEffect(() => {
    if (current === null || current.media_type !== 'image' || paused || !loaded) return undefined;
    const startedAt = Date.now() - progress * IMAGE_STORY_MS;
    const timer = setInterval(() => {
      const fraction = (Date.now() - startedAt) / IMAGE_STORY_MS;
      if (fraction >= 1) {
        clearInterval(timer);
        next();
      } else {
        setProgress(fraction);
      }
    }, 50);
    return () => clearInterval(timer);
    // `progress` no va en dependencias: se lee al reanudar, no en cada tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, paused, loaded, next]);

  const styles = useMemo(() => createStyles(colors.primary, colors.onPrimary), [colors]);

  if (stories === null) {
    return (
      <View style={[styles.frame, styles.center]}>
        <ActivityIndicator color="#fff" />
      </View>
    );
  }

  if (current === null) {
    return (
      <View style={[styles.frame, styles.center]}>
        <Text style={styles.caption}>{strings.stories.empty}</Text>
        <Pressable onPress={close} style={styles.emptyClose}>
          <Text style={styles.ctaText}>{strings.common.close}</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.frame}>
      <View style={styles.media}>
        {current.media_type === 'image' ? (
          <Image
            key={current.id}
            source={{ uri: current.media_url }}
            style={styles.fill}
            contentFit="contain"
            onLoad={() => setLoadedId(current.id)}
            // Si la foto no carga, se cuenta como vista y el reloj sigue.
            onError={() => setLoadedId(current.id)}
          />
        ) : (
          <StoryVideo uri={current.media_url} paused={paused} onProgress={setProgress} onEnd={next} />
        )}
      </View>

      {!loaded ? (
        <View style={[styles.media, styles.center]} pointerEvents="none">
          <ActivityIndicator color="#fff" size="large" />
        </View>
      ) : null}

      {/* Zonas de toque: izquierda atras, derecha adelante, mantener pausa. */}
      <View style={styles.touch}>
        <Pressable
          accessibilityLabel={strings.stories.previous}
          style={styles.touchLeft}
          onPress={prev}
          onLongPress={() => setPaused(true)}
          onPressOut={() => setPaused(false)}
        />
        <Pressable
          accessibilityLabel={strings.stories.next}
          style={styles.touchRight}
          onPress={next}
          onLongPress={() => setPaused(true)}
          onPressOut={() => setPaused(false)}
        />
      </View>

      <View style={[styles.top, { paddingTop: insets.top + 8 }]} pointerEvents="box-none">
        <View style={styles.bars}>
          {stories.map((story, i) => (
            <View key={story.id} style={styles.bar}>
              <View
                style={[
                  styles.barFill,
                  { width: `${i < index ? 100 : i === index ? Math.round(progress * 100) : 0}%` },
                ]}
              />
            </View>
          ))}
        </View>
        <View style={styles.header}>
          <Text style={styles.brand}>{displayName}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel={strings.common.close} onPress={close} hitSlop={12}>
            <Ionicons name="close" size={28} color="#fff" />
          </Pressable>
        </View>
      </View>

      <View style={[styles.bottom, { paddingBottom: insets.bottom + 16 }]} pointerEvents="box-none">
        {current.caption !== null ? <Text style={styles.caption}>{current.caption}</Text> : null}
        {current.item_id !== null ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push({ pathname: '/item/[id]', params: { id: current.item_id ?? '' } })}
            style={({ pressed }) => [styles.cta, pressed && { opacity: 0.8 }]}
          >
            <Ionicons name="bag-add" size={20} color={colors.onPrimary} />
            <Text style={styles.ctaText}>{strings.stories.order}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

function createStyles(primary: string, onPrimary: string) {
  return StyleSheet.create({
    frame: { flex: 1, backgroundColor: '#000' },
    center: { alignItems: 'center', justifyContent: 'center', gap: 16 },
    media: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
    fill: { width: '100%', height: '100%' },
    touch: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, flexDirection: 'row' },
    touchLeft: { width: '33%', height: '100%' },
    touchRight: { flex: 1, height: '100%' },
    top: { position: 'absolute', left: 0, right: 0, top: 0, paddingHorizontal: 10, gap: 10 },
    bars: { flexDirection: 'row', gap: 4 },
    bar: { flex: 1, height: 3, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.35)', overflow: 'hidden' },
    barFill: { height: 3, backgroundColor: '#fff' },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    brand: { color: '#fff', fontWeight: '800', fontSize: 15, textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 4 },
    bottom: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 20, gap: 12, alignItems: 'center' },
    caption: {
      color: '#fff',
      fontSize: 18,
      fontWeight: '700',
      textAlign: 'center',
      textShadowColor: 'rgba(0,0,0,0.7)',
      textShadowRadius: 6,
    },
    cta: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      backgroundColor: primary,
      paddingHorizontal: 28,
      paddingVertical: 14,
      borderRadius: 999,
    },
    ctaText: { color: onPrimary, fontWeight: '800', fontSize: 16 },
    emptyClose: { backgroundColor: primary, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 999 },
  });
}
