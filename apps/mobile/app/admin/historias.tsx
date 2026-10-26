/**
 * Panel · Historias.
 *
 * Publicar una foto o un video corto que los clientes ven arriba en la
 * pantalla de inicio. Puede llevar texto, un producto ("Pedir") y una
 * duracion: 24 h, 3 dias, 7 dias o destacada (no caduca).
 */

import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { fetchAdminCatalog, uploadImage } from '../../src/api/admin';
import {
  createStory,
  deleteStory,
  fetchAdminStories,
  setStoryDuration,
  type StoryRow,
} from '../../src/api/stories';
import { useAdmin } from '../../src/admin/admin-context';
import { canPickImages, pickStoryMedia, type PickedStoryMedia } from '../../src/admin/pick-image';
import { adminStrings } from '../../src/admin/strings';
import { AdminShell, Card, Field, Notice, createAdminStyles } from '../../src/admin/ui';
import { DataState } from '../../src/components/DataState';
import { Button } from '../../src/components/ui';
import type { BrandColors } from '../../src/domain/branding';
import { hoursLeft, storyStatus, type StoryDuration } from '../../src/domain/stories';
import { useAsync } from '../../src/hooks/use-async';
import { useColors } from '../../src/state/branding-context';
import { radius, spacing, type as typography } from '../../src/theme';

const t = adminStrings.stories;
const DURATIONS: readonly StoryDuration[] = ['24h', '3d', '7d', 'featured'];

export default function AdminStoriesScreen(): ReactNode {
  const { restaurantId, store, isOwner } = useAdmin();
  const colors = useColors();
  const styles = useMemo(() => ({ ...createAdminStyles(colors), ...createStyles(colors) }), [colors]);

  const load = useCallback(async () => {
    const [stories, catalog] = await Promise.all([
      fetchAdminStories(restaurantId),
      fetchAdminCatalog(store.id),
    ]);
    return { stories, products: catalog.products };
  }, [restaurantId, store.id]);
  const { data, error, loading, refresh, reload } = useAsync(load, [restaurantId, store.id]);

  if (!isOwner) {
    return (
      <AdminShell>
        <Notice tone="error" text={adminStrings.ownerOnly} />
      </AdminShell>
    );
  }
  if (data === null) {
    return (
      <AdminShell scroll={false}>
        <DataState loading={loading} error={error} empty={false} onRetry={reload} emptyTitle="">
          {null}
        </DataState>
      </AdminShell>
    );
  }

  const productName = new Map(data.products.map((p) => [p.id, p.name]));

  return (
    <AdminShell>
      <View style={styles.layout}>
        <View style={styles.formCol}>
          <NewStoryCard products={data.products} onDone={refresh} />
        </View>
        <View style={styles.listCol}>
          <Card title={t.listTitle}>
            {data.stories.length === 0 ? <Text style={styles.hint}>{t.empty}</Text> : null}
            <View style={styles.grid}>
              {data.stories.map((story) => (
                <StoryTile
                  key={story.id}
                  story={story}
                  product={story.item_id === null ? null : (productName.get(story.item_id) ?? null)}
                  onChanged={refresh}
                />
              ))}
            </View>
          </Card>
        </View>
      </View>
    </AdminShell>
  );
}

function NewStoryCard({
  products,
  onDone,
}: {
  readonly products: readonly { id: string; name: string }[];
  readonly onDone: () => void;
}): ReactNode {
  const colors = useColors();
  const styles = useMemo(() => ({ ...createAdminStyles(colors), ...createStyles(colors) }), [colors]);
  const { restaurantId } = useAdmin();
  const [media, setMedia] = useState<PickedStoryMedia | null>(null);
  const [caption, setCaption] = useState('');
  const [captionEs, setCaptionEs] = useState('');
  const [itemId, setItemId] = useState<string | null>(null);
  const [duration, setDuration] = useState<StoryDuration>('24h');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const choose = async (): Promise<void> => {
    setNotice(null);
    try {
      const picked = await pickStoryMedia();
      if (picked !== null) setMedia(picked);
    } catch (cause) {
      setNotice({ tone: 'error', text: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  const publish = async (): Promise<void> => {
    if (media === null) return;
    setBusy(true);
    setNotice(null);
    try {
      const url = await uploadImage('stories', restaurantId, media.blob, media.extension);
      await createStory(restaurantId, {
        media_url: url,
        media_type: media.mediaType,
        caption,
        caption_es: captionEs,
        item_id: itemId,
        duration,
      });
      setMedia(null);
      setCaption('');
      setCaptionEs('');
      setItemId(null);
      setNotice({ tone: 'ok', text: t.published });
      onDone();
    } catch (cause) {
      setNotice({ tone: 'error', text: `${adminStrings.saveFailed}: ${cause instanceof Error ? cause.message : String(cause)}` });
    } finally {
      setBusy(false);
    }
  };

  const chip = (key: string, label: string, on: boolean, onPress: () => void): ReactNode => (
    <Pressable
      key={key}
      accessibilityRole="radio"
      accessibilityState={{ checked: on }}
      onPress={onPress}
      style={[styles.chip, on && styles.chipOn]}
    >
      <Text style={[styles.chipText, on && styles.chipTextOn]}>{label}</Text>
    </Pressable>
  );

  return (
    <Card title={t.newTitle}>
      <Text style={styles.hint}>{t.newHint}</Text>

      <Pressable
        accessibilityRole="button"
        onPress={() => void choose()}
        disabled={!canPickImages || busy}
        style={styles.picker}
      >
        {media === null ? (
          <View style={styles.pickerEmpty}>
            <Ionicons name="camera-outline" size={36} color={colors.primary} />
            <Text style={styles.pickerText}>{canPickImages ? t.choose : adminStrings.product.photoNativeOnly}</Text>
          </View>
        ) : media.mediaType === 'image' ? (
          <Image source={{ uri: media.previewUrl }} style={styles.preview} contentFit="cover" />
        ) : (
          <View style={[styles.preview, styles.videoPreview]}>
            <Ionicons name="videocam" size={40} color="#fff" />
            <Text style={styles.videoText}>{t.video}</Text>
          </View>
        )}
      </Pressable>
      {media !== null ? (
        <Pressable onPress={() => void choose()}>
          <Text style={styles.link}>{t.change}</Text>
        </Pressable>
      ) : null}

      <Field label={t.caption} value={caption} onChangeText={setCaption} placeholder={t.captionPlaceholder} />
      <Field label={t.captionEs} value={captionEs} onChangeText={setCaptionEs} placeholder={t.captionEsPlaceholder} />

      <Text style={styles.label}>{t.product}</Text>
      <View style={styles.chips}>
        {chip('none', t.noProduct, itemId === null, () => setItemId(null))}
        {products.map((p) => chip(p.id, p.name, itemId === p.id, () => setItemId(p.id)))}
      </View>

      <Text style={styles.label}>{t.duration}</Text>
      <View style={styles.chips}>
        {DURATIONS.map((d) => chip(d, t.durations[d], duration === d, () => setDuration(d)))}
      </View>

      {notice !== null ? <Notice tone={notice.tone} text={notice.text} /> : null}
      <Button
        label={busy ? t.uploading : t.publish}
        busy={busy}
        disabled={media === null}
        onPress={() => void publish()}
      />
    </Card>
  );
}

function StoryTile({
  story,
  product,
  onChanged,
}: {
  readonly story: StoryRow;
  readonly product: string | null;
  readonly onChanged: () => void;
}): ReactNode {
  const colors = useColors();
  const styles = useMemo(() => ({ ...createAdminStyles(colors), ...createStyles(colors) }), [colors]);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const status = storyStatus(story);

  const label =
    status === 'active'
      ? t.status.active(hoursLeft(story) ?? 0)
      : status === 'featured'
        ? t.status.featured
        : status === 'expired'
          ? t.status.expired
          : t.status.scheduled;

  const act = async (work: () => Promise<void>): Promise<void> => {
    setBusy(true);
    try {
      await work();
      onChanged();
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <View style={[styles.tile, status === 'expired' && styles.tileExpired]}>
      <View style={styles.tileMedia}>
        {story.media_type === 'image' ? (
          <Image source={{ uri: story.media_url }} style={styles.fill} contentFit="cover" />
        ) : (
          <View style={[styles.fill, styles.videoPreview]}>
            <Ionicons name="play-circle" size={36} color="#fff" />
          </View>
        )}
        <View style={[styles.badge, status === 'featured' && styles.badgeFeatured, status === 'expired' && styles.badgeExpired]}>
          {status === 'featured' ? <Ionicons name="star" size={11} color="#fff" /> : null}
          <Text style={styles.badgeText}>{label}</Text>
        </View>
      </View>
      <Text style={styles.tileCaption} numberOfLines={2}>
        {story.caption ?? '—'}
      </Text>
      {product !== null ? (
        <Text style={styles.tileProduct} numberOfLines={1}>
          🛍 {product}
        </Text>
      ) : null}
      {confirming ? (
        <View style={styles.tileActions}>
          <Pressable disabled={busy} onPress={() => void act(() => deleteStory(story.id))}>
            <Text style={styles.danger}>{adminStrings.confirmDelete}</Text>
          </Pressable>
          <Pressable onPress={() => setConfirming(false)}>
            <Text style={styles.link}>{adminStrings.cancel}</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.tileActions}>
          {status !== 'featured' ? (
            <Pressable disabled={busy} onPress={() => void act(() => setStoryDuration(story.id, 'featured'))}>
              <Text style={styles.link}>{t.makeFeatured}</Text>
            </Pressable>
          ) : null}
          {status === 'expired' ? (
            <Pressable disabled={busy} onPress={() => void act(() => setStoryDuration(story.id, '24h'))}>
              <Text style={styles.link}>{t.renew}</Text>
            </Pressable>
          ) : null}
          <Pressable onPress={() => setConfirming(true)}>
            <Text style={styles.danger}>{t.remove}</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

function createStyles(colors: BrandColors) {
  return StyleSheet.create({
    layout: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.lg, alignItems: 'flex-start' },
    formCol: { flexGrow: 1, flexBasis: 320, maxWidth: 460, minWidth: 0 },
    listCol: { flexGrow: 2, flexBasis: 420, minWidth: 0 },
    picker: {
      height: 260,
      borderRadius: radius.lg,
      borderWidth: 2,
      borderStyle: 'dashed',
      borderColor: colors.primary,
      overflow: 'hidden',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.background,
    },
    pickerEmpty: { alignItems: 'center', gap: spacing.sm, padding: spacing.lg },
    pickerText: { color: colors.primary, fontWeight: '800', fontSize: typography.body.fontSize, textAlign: 'center' },
    preview: { width: '100%', height: '100%' },
    videoPreview: { backgroundColor: '#111', alignItems: 'center', justifyContent: 'center', gap: 6 },
    videoText: { color: '#fff', fontWeight: '700' },
    link: { color: colors.primary, fontWeight: '700', fontSize: typography.label.fontSize },
    danger: { color: colors.danger, fontWeight: '700', fontSize: typography.label.fontSize },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    chip: {
      paddingHorizontal: spacing.md,
      paddingVertical: 7,
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.background,
    },
    chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
    chipText: { color: colors.text, fontWeight: '600', fontSize: typography.label.fontSize },
    chipTextOn: { color: colors.onPrimary },
    grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
    tile: { width: 150, gap: 4 },
    tileExpired: { opacity: 0.55 },
    tileMedia: {
      width: 150,
      height: 240,
      borderRadius: radius.md,
      overflow: 'hidden',
      backgroundColor: colors.background,
    },
    fill: { width: '100%', height: '100%' },
    badge: {
      position: 'absolute',
      left: 6,
      top: 6,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 3,
      backgroundColor: colors.primary,
      borderRadius: radius.pill,
      paddingHorizontal: 8,
      paddingVertical: 3,
    },
    badgeFeatured: { backgroundColor: colors.accent },
    badgeExpired: { backgroundColor: '#666' },
    badgeText: { color: '#fff', fontSize: 11, fontWeight: '800' },
    tileCaption: { color: colors.text, fontSize: typography.label.fontSize, fontWeight: '600' },
    tileProduct: { color: colors.textMuted, fontSize: typography.caption.fontSize },
    tileActions: { flexDirection: 'row', gap: spacing.md, flexWrap: 'wrap' },
  });
}
