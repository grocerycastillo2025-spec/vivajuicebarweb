/**
 * Fila de historias en Inicio, como en Instagram: circulos con aro de
 * color si no se han visto. Al tocar una se abre el visor en esa.
 */

import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { useMemo, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { StoryRow } from '../api/stories';
import type { BrandColors } from '../domain/branding';
import { orderForViewer } from '../domain/stories';
import { useColors } from '../state/branding-context';
import { useSeenStories } from '../state/seen-stories';
import { strings } from '../strings';
import { spacing, type as typography } from '../theme';

export function StoriesRow({ stories }: { readonly stories: readonly StoryRow[] }): ReactNode {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const router = useRouter();
  const seen = useSeenStories();
  const ordered = useMemo(() => orderForViewer(stories, seen), [stories, seen]);

  if (ordered.length === 0) return null;

  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>{strings.stories.title}</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
        {ordered.map((story) => {
          const isNew = !seen.has(story.id);
          return (
            <Pressable
              key={story.id}
              accessibilityRole="button"
              accessibilityLabel={strings.stories.open(story.caption ?? '')}
              onPress={() => router.push({ pathname: '/historias', params: { id: story.id } })}
              style={({ pressed }) => [styles.item, pressed && styles.pressed]}
            >
              <View style={[styles.ring, isNew ? styles.ringNew : styles.ringSeen]}>
                <View style={styles.inner}>
                  {story.media_type === 'image' ? (
                    <Image source={{ uri: story.media_url }} style={styles.thumb} contentFit="cover" />
                  ) : (
                    <View style={[styles.thumb, styles.videoThumb]}>
                      <Text style={styles.play}>▶</Text>
                    </View>
                  )}
                </View>
              </View>
              <Text style={[styles.label, !isNew && styles.labelSeen]} numberOfLines={1}>
                {story.caption ?? strings.stories.untitled}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const SIZE = 72;

function createStyles(colors: BrandColors) {
  return StyleSheet.create({
    wrap: { gap: spacing.sm },
    title: { color: colors.text, fontSize: typography.section.fontSize, fontWeight: '800' },
    row: { gap: spacing.md, paddingRight: spacing.lg },
    item: { width: SIZE + 8, alignItems: 'center', gap: 4 },
    pressed: { opacity: 0.7 },
    ring: {
      width: SIZE + 8,
      height: SIZE + 8,
      borderRadius: (SIZE + 8) / 2,
      padding: 3,
      alignItems: 'center',
      justifyContent: 'center',
    },
    ringNew: { backgroundColor: colors.primary },
    ringSeen: { backgroundColor: colors.border },
    inner: {
      width: SIZE + 2,
      height: SIZE + 2,
      borderRadius: (SIZE + 2) / 2,
      backgroundColor: colors.background,
      alignItems: 'center',
      justifyContent: 'center',
    },
    thumb: { width: SIZE - 2, height: SIZE - 2, borderRadius: (SIZE - 2) / 2 },
    videoThumb: { backgroundColor: colors.text, alignItems: 'center', justifyContent: 'center' },
    play: { color: '#fff', fontSize: 22 },
    label: { color: colors.text, fontSize: typography.caption.fontSize, fontWeight: '600', maxWidth: SIZE + 8 },
    labelSeen: { color: colors.textMuted, fontWeight: '400' },
  });
}
