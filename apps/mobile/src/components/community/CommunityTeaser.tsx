/**
 * Inicio: "Lo que dicen en VIVA" — promedio de estrellas y las últimas
 * publicaciones, para que la comunidad se vea sin ir a buscarla.
 */

import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useCallback, useMemo, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { fetchCommunitySummary, fetchFeed } from '../../api/community';
import type { BrandColors } from '../../domain/branding';
import { readEnv } from '../../env';
import { useAsync } from '../../hooks/use-async';
import { useColors } from '../../state/branding-context';
import { strings } from '../../strings';
import { spacing, type as typography } from '../../theme';
import { SectionTitle } from '../ui';
import { PostCard, Stars } from './parts';

/** "★ 4.8 (23 reseñas)" junto al nombre de la tienda. */
export function StoreRating(): ReactNode {
  const colors = useColors();
  const load = useCallback(() => fetchCommunitySummary(readEnv().restaurantId).catch(() => null), []);
  const { data } = useAsync(load, []);
  const router = useRouter();
  if (data === null || data === undefined || !data.enabled || data.reviews === 0 || data.average === null) return null;
  return (
    <Pressable accessibilityRole="link" onPress={() => router.push('/comunidad')} style={localStyles.rating} testID="estrellas-tienda">
      <Ionicons name="star" size={14} color="#F5A623" />
      <Text style={[localStyles.ratingText, { color: colors.text }]}>
        {data.average.toFixed(1)} <Text style={{ color: colors.textMuted, fontWeight: '600' }}>({strings.community.reviewsCount(data.reviews)})</Text>
      </Text>
    </Pressable>
  );
}

export function CommunityTeaser(): ReactNode {
  const router = useRouter();
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const load = useCallback(async () => {
    const id = readEnv().restaurantId;
    const [summary, posts] = await Promise.all([
      fetchCommunitySummary(id).catch(() => null),
      fetchFeed(id, { limit: 6 }).catch(() => []),
    ]);
    // Solo lo público y lo más reciente (sin lo propio en revisión ni sugerencias).
    const shown = posts.filter((p) => p.status === 'published' && p.kind !== 'suggestion').slice(0, 3);
    return { summary, shown };
  }, []);
  const { data } = useAsync(load, []);

  if (data === null || data.summary === null || !data.summary.enabled || data.shown.length === 0) return null;
  const { summary, shown } = data;

  return (
    <View style={styles.section} testID="comunidad-inicio">
      <View style={styles.head}>
        <SectionTitle>{strings.community.homeTitle}</SectionTitle>
        {summary.average !== null ? (
          <View style={styles.avg}>
            <Stars value={summary.average} size={14} />
            <Text style={styles.avgText}>{summary.average.toFixed(1)}</Text>
          </View>
        ) : null}
      </View>
      {shown.map((post) => (
        <PostCard key={post.id} post={post} compact onOpen={() => router.push(`/comunidad/${post.id}`)} />
      ))}
      <Pressable accessibilityRole="link" onPress={() => router.push('/comunidad')} style={styles.more}>
        <Text style={styles.moreText}>{strings.community.seeAll}</Text>
        <Ionicons name="chevron-forward" size={18} color={colors.primary} />
      </Pressable>
    </View>
  );
}

const localStyles = StyleSheet.create({
  rating: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  ratingText: { fontWeight: '800', fontSize: typography.label.fontSize },
});

function createStyles(colors: BrandColors) {
  return StyleSheet.create({
    section: { gap: spacing.sm },
    head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
    avg: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    avgText: { color: colors.text, fontWeight: '800', fontSize: typography.label.fontSize },
    more: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, paddingVertical: spacing.sm },
    moreText: { color: colors.primary, fontWeight: '800', fontSize: typography.body.fontSize },
  });
}
