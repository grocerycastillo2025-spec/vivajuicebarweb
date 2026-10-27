/**
 * Comunidad VIVA: promedio de estrellas, reseñas, preguntas, avisos de la
 * tienda y "Escribir". Se ve sin sesión; para escribir hay que entrar.
 */

import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { fetchCommunitySummary, fetchFeed, setHelpful } from '../../src/api/community';
import { Composer, PostCard, ReportSheet, Stars, problemText } from '../../src/components/community/parts';
import { DataState } from '../../src/components/DataState';
import { Screen } from '../../src/components/Screen';
import { Button } from '../../src/components/ui';
import type { BrandColors } from '../../src/domain/branding';
import { starBars, type CommunityPost, type PostKind } from '../../src/domain/community';
import { readEnv } from '../../src/env';
import { useAsync } from '../../src/hooks/use-async';
import { useColors } from '../../src/state/branding-context';
import { useSession } from '../../src/state/session-context';
import { strings } from '../../src/strings';
import { radius, spacing, type as typography } from '../../src/theme';

type Filter = 'all' | Exclude<PostKind, 'suggestion'>;

export default function CommunityScreen(): ReactNode {
  const router = useRouter();
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { user } = useSession();
  const restaurantId = readEnv().restaurantId;
  const c = strings.community;
  const [filter, setFilter] = useState<Filter>('all');
  const [composing, setComposing] = useState(false);
  const [reporting, setReporting] = useState<{ type: 'post' | 'reply'; id: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<Record<string, Partial<CommunityPost>>>({});
  const [more, setMore] = useState<CommunityPost[]>([]);
  const [noMore, setNoMore] = useState(false);

  const load = useCallback(async () => {
    const [summary, posts] = await Promise.all([
      fetchCommunitySummary(restaurantId),
      fetchFeed(restaurantId, { kind: filter === 'all' ? null : filter }),
    ]);
    setMore([]);
    setNoMore(posts.length < 20);
    setOverrides({});
    return { summary, posts };
  }, [restaurantId, filter]);
  const { data, error, loading, refreshing, refresh, reload } = useAsync(load, [restaurantId, filter, user?.id]);

  const posts = [...(data?.posts ?? []), ...more].map((p) => ({ ...p, ...(overrides[p.id] ?? {}) }) as CommunityPost);

  const toggleHelpful = async (post: CommunityPost): Promise<void> => {
    if (user === null) {
      setMessage(c.signInToWrite);
      return;
    }
    const on = !post.helped;
    setOverrides((o) => ({ ...o, [post.id]: { helped: on, helpful_count: post.helpful_count + (on ? 1 : -1) } }));
    try {
      const r = await setHelpful(post.id, on);
      setOverrides((o) => ({ ...o, [post.id]: { helped: on, helpful_count: r.helpful_count } }));
    } catch (cause) {
      setOverrides((o) => ({ ...o, [post.id]: { helped: post.helped, helpful_count: post.helpful_count } }));
      setMessage(problemText(cause));
    }
  };

  const loadMore = async (): Promise<void> => {
    const last = posts[posts.length - 1];
    if (last === undefined) return;
    const next = await fetchFeed(restaurantId, { kind: filter === 'all' ? null : filter, before: last.created_at });
    setMore((m) => [...m, ...next]);
    if (next.length < 20) setNoMore(true);
  };

  if (data === null) {
    return (
      <Screen withTabBar scroll={false}>
        <DataState loading={loading} error={error} empty={false} onRetry={reload} emptyTitle="">
          {null}
        </DataState>
      </Screen>
    );
  }

  const summary = data.summary;
  const average = summary?.average ?? null;

  return (
    <Screen withTabBar refreshing={refreshing} onRefresh={refresh} contentStyle={styles.content}>
      <View style={styles.titleRow}>
        <View style={styles.grow}>
          <Text style={styles.title}>{c.title}</Text>
          <Text style={styles.subtitle}>{c.subtitle}</Text>
        </View>
      </View>

      <View style={styles.summary} testID="resumen-estrellas">
        <View style={styles.avgBox}>
          <Text style={styles.avg}>{average === null ? '—' : average.toFixed(1)}</Text>
          <Stars value={average ?? 0} size={18} />
          <Text style={styles.count}>{summary === null || summary.reviews === 0 ? c.noReviews : c.reviewsCount(summary.reviews)}</Text>
        </View>
        {summary !== null && summary.reviews > 0 ? (
          <View style={styles.bars}>
            {starBars(summary).map((b) => (
              <View key={b.star} style={styles.barRow}>
                <Text style={styles.barLabel}>{b.star}</Text>
                <View style={styles.barTrack}>
                  <View style={[styles.barFill, { width: `${b.pct}%` }]} />
                </View>
                <Text style={styles.barCount}>{b.count}</Text>
              </View>
            ))}
          </View>
        ) : null}
      </View>

      <Button
        label={user === null ? c.signInToWrite : c.write}
        variant={user === null ? 'outline' : 'primary'}
        onPress={() => (user === null ? router.push('/profile') : setComposing(true))}
        testID="escribir-comunidad"
      />

      {message !== null ? (
        <Pressable onPress={() => setMessage(null)} style={styles.message} accessibilityRole="alert">
          <Ionicons name="information-circle" size={20} color={colors.primary} />
          <Text style={styles.messageText}>{message}</Text>
        </Pressable>
      ) : null}

      <View style={styles.filters}>
        {(['all', 'review', 'question', 'announcement'] as const).map((f) => (
          <Pressable
            key={f}
            accessibilityRole="tab"
            accessibilityState={{ selected: filter === f }}
            onPress={() => setFilter(f)}
            style={[styles.filter, filter === f && styles.filterOn]}
          >
            <Text style={[styles.filterText, filter === f && styles.filterTextOn]}>{c.filters[f]}</Text>
          </Pressable>
        ))}
      </View>

      {posts.length === 0 ? <Text style={styles.empty}>{c.empty}</Text> : null}
      {posts.map((post) => (
        <PostCard
          key={post.id}
          post={post}
          onOpen={() => router.push(`/comunidad/${post.id}`)}
          onHelpful={() => void toggleHelpful(post)}
          onReport={user === null ? undefined : () => setReporting({ type: 'post', id: post.id })}
        />
      ))}
      {!noMore && posts.length > 0 ? <Button label={c.loadMore} variant="outline" onPress={() => void loadMore()} /> : null}

      {user !== null ? (
        <Composer
          visible={composing}
          restaurantId={restaurantId}
          userId={user.id}
          onClose={(result) => {
            setComposing(false);
            if (result !== null) {
              setMessage(result.message);
              refresh();
            }
          }}
        />
      ) : null}
      <ReportSheet
        target={reporting}
        onClose={(msg) => {
          setReporting(null);
          if (msg !== null) setMessage(msg);
        }}
      />
    </Screen>
  );
}

function createStyles(colors: BrandColors) {
  return StyleSheet.create({
    content: { padding: spacing.lg, gap: spacing.md },
    titleRow: { flexDirection: 'row', alignItems: 'flex-start' },
    grow: { flex: 1, minWidth: 0, gap: 4 },
    title: { color: colors.text, fontSize: typography.display.fontSize, fontWeight: '800' },
    subtitle: { color: colors.textMuted, fontSize: typography.body.fontSize, lineHeight: 21 },
    summary: {
      flexDirection: 'row',
      gap: spacing.lg,
      alignItems: 'center',
      backgroundColor: colors.surface,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.border,
      padding: spacing.lg,
    },
    avgBox: { alignItems: 'center', gap: 4, minWidth: 96 },
    avg: { color: colors.text, fontSize: 40, fontWeight: '800' },
    count: { color: colors.textMuted, fontSize: typography.caption.fontSize + 1, textAlign: 'center' },
    bars: { flex: 1, gap: 4 },
    barRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
    barLabel: { width: 12, color: colors.textMuted, fontSize: typography.caption.fontSize, fontWeight: '700' },
    barTrack: { flex: 1, height: 8, borderRadius: 4, backgroundColor: colors.background, overflow: 'hidden' },
    barFill: { height: 8, borderRadius: 4, backgroundColor: '#F5A623' },
    barCount: { width: 24, color: colors.textFaint, fontSize: typography.caption.fontSize, textAlign: 'right' },
    message: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      borderWidth: 1,
      borderColor: colors.primary,
      borderRadius: radius.md,
      padding: spacing.md,
      backgroundColor: colors.surface,
    },
    messageText: { flex: 1, color: colors.text, fontWeight: '700', fontSize: typography.label.fontSize },
    filters: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    filter: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.pill,
      paddingHorizontal: spacing.md,
      paddingVertical: 6,
      backgroundColor: colors.surface,
    },
    filterOn: { backgroundColor: colors.primary, borderColor: colors.primary },
    filterText: { color: colors.text, fontWeight: '700', fontSize: typography.label.fontSize },
    filterTextOn: { color: colors.onPrimary },
    empty: { color: colors.textMuted, fontSize: typography.body.fontSize, textAlign: 'center', paddingVertical: spacing.xl },
  });
}
