/**
 * Piezas de la Comunidad VIVA: estrellas, tarjeta de publicación,
 * reportar y escribir.
 */

import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useMemo, useState, type ReactNode } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { canPickImages, pickProductPhoto, type PickedImage } from '../../admin/pick-image';
import { createPost, report, uploadCommunityPhoto } from '../../api/community';
import type { BrandColors } from '../../domain/branding';
import { communityProblem, contactInfo, photoUrl, timeAgo, type CommunityPost, type PostKind } from '../../domain/community';
import { readEnv } from '../../env';
import { getLanguage, localeFor } from '../../i18n';
import { useColors } from '../../state/branding-context';
import { strings } from '../../strings';
import { radius, spacing, type as typography } from '../../theme';
import { Button } from '../ui';

const STAR = '#F5A623';

export function Stars({
  value,
  size = 16,
  onChange,
}: {
  readonly value: number;
  readonly size?: number;
  readonly onChange?: (n: number) => void;
}): ReactNode {
  const colors = useColors();
  return (
    <View style={{ flexDirection: 'row', gap: onChange ? 6 : 1 }} accessibilityLabel={strings.community.starLabel(Math.round(value))}>
      {[1, 2, 3, 4, 5].map((n) => {
        const icon = value >= n ? 'star' : value >= n - 0.5 ? 'star-half' : 'star-outline';
        const star = <Ionicons name={icon} size={size} color={value >= n - 0.5 ? STAR : colors.textFaint} />;
        return onChange ? (
          <Pressable
            key={n}
            accessibilityRole="radio"
            accessibilityState={{ checked: Math.round(value) === n }}
            accessibilityLabel={strings.community.starLabel(n)}
            onPress={() => onChange(n)}
            hitSlop={6}
            testID={`estrella-${n}`}
          >
            {star}
          </Pressable>
        ) : (
          <View key={n}>{star}</View>
        );
      })}
    </View>
  );
}

export function communityPhoto(path: string | null): string | null {
  return photoUrl(readEnv().supabaseUrl, path);
}

export function problemText(cause: unknown): string {
  const p = communityProblem(cause instanceof Error ? cause.message : String(cause));
  return strings.community.problems[p] ?? strings.community.problems['other'] ?? '';
}

export function PostCard({
  post,
  onOpen,
  onHelpful,
  onReport,
  compact = false,
}: {
  readonly post: CommunityPost;
  readonly onOpen?: (() => void) | undefined;
  readonly onHelpful?: (() => void) | undefined;
  readonly onReport?: (() => void) | undefined;
  readonly compact?: boolean;
}): ReactNode {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const lang = getLanguage();
  const store = post.author_role === 'store';
  const photo = communityPhoto(post.photo_path);
  const c = strings.community;

  return (
    <View style={[styles.card, store && styles.cardStore]} testID={`publicacion-${post.kind}`}>
      {post.pinned ? (
        <View style={styles.pinRow}>
          <Ionicons name="pin" size={14} color={colors.accent} />
          <Text style={styles.pinText}>{c.pinned}</Text>
        </View>
      ) : null}
      <View style={styles.head}>
        <View style={[styles.avatar, store && styles.avatarStore]}>
          {store ? (
            <Ionicons name="leaf" size={18} color={colors.onPrimary} />
          ) : (
            <Text style={styles.avatarText}>{post.author_name.slice(0, 1).toUpperCase()}</Text>
          )}
        </View>
        <View style={styles.headText}>
          <View style={styles.nameRow}>
            <Text style={styles.name} numberOfLines={1}>
              {post.author_name}
            </Text>
            {post.verified ? (
              <View style={styles.badge}>
                <Ionicons name="checkmark-circle" size={13} color={colors.primary} />
                <Text style={styles.badgeText}>{c.verified}</Text>
              </View>
            ) : null}
          </View>
          <Text style={styles.when}>{timeAgo(post.created_at, new Date(), lang, localeFor(lang))}</Text>
        </View>
        {post.kind === 'review' && post.rating !== null ? <Stars value={post.rating} /> : null}
        {post.kind === 'question' ? <Ionicons name="help-circle-outline" size={20} color={colors.textMuted} /> : null}
      </View>

      {post.event_date !== null ? <Text style={styles.event}>{c.event(post.event_date)}</Text> : null}
      <Pressable onPress={onOpen} disabled={onOpen === undefined}>
        <Text style={styles.body} numberOfLines={compact ? 3 : undefined}>
          {post.body}
        </Text>
      </Pressable>
      {photo !== null ? (
        <Pressable onPress={onOpen} disabled={onOpen === undefined}>
          <Image source={{ uri: photo }} style={[styles.photo, compact && styles.photoCompact]} contentFit="cover" />
        </Pressable>
      ) : null}

      {post.mine && post.status !== 'published' ? (
        <Text style={styles.status}>
          {post.status === 'pending' ? c.pending : post.status === 'reported' ? c.reported : c.hidden(post.hidden_reason)}
        </Text>
      ) : null}
      {post.kind === 'suggestion' ? <Text style={styles.status}>{c.privateSuggestion}</Text> : null}

      {!compact && post.kind !== 'suggestion' && post.status === 'published' ? (
        <View style={styles.actions}>
          {post.kind === 'review' ? (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: post.helped }}
              onPress={onHelpful}
              disabled={post.mine || onHelpful === undefined}
              style={[styles.action, post.helped && styles.actionOn]}
              testID="me-sirvio"
            >
              <Ionicons name={post.helped ? 'thumbs-up' : 'thumbs-up-outline'} size={16} color={post.helped ? colors.onPrimary : colors.primary} />
              <Text style={[styles.actionText, post.helped && styles.actionTextOn]}>
                {c.helpful}
                {post.helpful_count > 0 ? ` · ${post.helpful_count}` : ''}
              </Text>
            </Pressable>
          ) : null}
          <Pressable accessibilityRole="button" onPress={onOpen} style={styles.action} testID="ver-respuestas">
            <Ionicons name="chatbubble-outline" size={16} color={colors.primary} />
            <Text style={styles.actionText}>{c.replies(post.reply_count)}</Text>
          </Pressable>
          {post.store_replied ? <Text style={styles.replied}>✓ {c.storeReplied}</Text> : null}
          {!post.mine && !store && onReport !== undefined ? (
            <Pressable accessibilityRole="button" accessibilityLabel={c.report} onPress={onReport} hitSlop={8} style={styles.flag}>
              <Ionicons name="flag-outline" size={16} color={colors.textFaint} />
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

export function ReportSheet({
  target,
  onClose,
}: {
  readonly target: { type: 'post' | 'reply'; id: string } | null;
  readonly onClose: (message: string | null) => void;
}): ReactNode {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [busy, setBusy] = useState(false);
  const send = async (reason: string): Promise<void> => {
    if (target === null) return;
    setBusy(true);
    try {
      await report(target.type, target.id, reason);
      onClose(strings.community.reported_ok);
    } catch (cause) {
      onClose(problemText(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal visible={target !== null} transparent animationType="fade" onRequestClose={() => onClose(null)}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.sheetHead}>
            <Text style={styles.sheetTitle}>{strings.community.reportTitle}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel={strings.community.cancel} onPress={() => onClose(null)} hitSlop={10}>
              <Ionicons name="close" size={24} color={colors.textMuted} />
            </Pressable>
          </View>
          {strings.community.reportReasons.map((reason) => (
            <Pressable key={reason} accessibilityRole="button" disabled={busy} onPress={() => void send(reason)} style={styles.reason}>
              <Text style={styles.reasonText}>{reason}</Text>
              <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />
            </Pressable>
          ))}
        </View>
      </View>
    </Modal>
  );
}

export function Composer({
  visible,
  restaurantId,
  userId,
  onClose,
}: {
  readonly visible: boolean;
  readonly restaurantId: string;
  readonly userId: string;
  readonly onClose: (result: { message: string } | null) => void;
}): ReactNode {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const c = strings.community;
  const [kind, setKind] = useState<Exclude<PostKind, 'announcement'>>('review');
  const [rating, setRating] = useState(0);
  const [body, setBody] = useState('');
  const [photo, setPhoto] = useState<PickedImage | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const blocked = contactInfo(body);
  const live = blocked === 'email' ? c.problems['contact_email'] : blocked === 'number' ? c.problems['contact_number'] : null;
  const ready = body.trim().length > 0 && blocked === null && (kind !== 'review' || rating > 0);

  const reset = (): void => {
    setKind('review');
    setRating(0);
    setBody('');
    setPhoto(null);
    setProblem(null);
  };

  const publish = async (): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      const path = photo === null ? null : await uploadCommunityPhoto(userId, photo.blob);
      const done = await createPost(restaurantId, { kind, body: body.trim(), rating, photoPath: path });
      const message =
        kind === 'suggestion'
          ? c.suggestionSent
          : done.status === 'pending'
            ? c.sentForReview
            : done.points > 0
              ? `${c.published} ${c.pointsEarned(done.points)}`
              : c.published;
      reset();
      onClose({ message });
    } catch (cause) {
      setProblem(problemText(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={() => onClose(null)}>
      <View style={styles.backdrop}>
        <View style={[styles.sheet, styles.sheetTall]} testID="escribir">
          <View style={styles.sheetHead}>
            <Text style={styles.sheetTitle}>{c.composeTitle}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel={c.cancel} onPress={() => onClose(null)} hitSlop={10}>
              <Ionicons name="close" size={24} color={colors.textMuted} />
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.form} keyboardShouldPersistTaps="handled">
            <View style={styles.kinds}>
              {(['review', 'question', 'suggestion'] as const).map((k) => (
                <Pressable
                  key={k}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: kind === k }}
                  onPress={() => setKind(k)}
                  style={[styles.kind, kind === k && styles.kindOn]}
                  testID={`tipo-${k}`}
                >
                  <Text style={[styles.kindText, kind === k && styles.kindTextOn]}>{c.kinds[k]}</Text>
                </Pressable>
              ))}
            </View>
            <Text style={styles.hint}>{c.kindHints[kind]}</Text>
            {kind === 'review' ? (
              <View style={styles.starsRow}>
                <Text style={styles.label}>{c.stars}</Text>
                <Stars value={rating} size={34} onChange={setRating} />
              </View>
            ) : null}
            <TextInput
              value={body}
              onChangeText={setBody}
              placeholder={c.placeholder[kind]}
              placeholderTextColor={colors.textFaint}
              multiline
              maxLength={1000}
              style={styles.textarea}
              accessibilityLabel={c.composeTitle}
              testID="texto-publicacion"
            />
            {live !== null && live !== undefined ? <Text style={styles.warn}>{live}</Text> : null}
            {kind !== 'suggestion' && canPickImages ? (
              <View style={styles.photoRow}>
                {photo !== null ? <Image source={{ uri: photo.previewUrl }} style={styles.thumb} contentFit="cover" /> : null}
                <Button
                  label={photo === null ? c.addPhoto : c.changePhoto}
                  variant="outline"
                  onPress={() => void pickProductPhoto().then((p) => p !== null && setPhoto(p)).catch(() => undefined)}
                  testID="agregar-foto"
                />
                {photo !== null ? (
                  <Pressable onPress={() => setPhoto(null)}>
                    <Text style={styles.remove}>{c.removePhoto}</Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}
            <Text style={styles.rules}>{c.rules}</Text>
            {problem !== null ? <Text style={styles.warn}>{problem}</Text> : null}
          </ScrollView>
          <Button label={c.publish} busy={busy} disabled={!ready} onPress={() => void publish()} testID="publicar" />
        </View>
      </View>
    </Modal>
  );
}

export function createStyles(colors: BrandColors) {
  return StyleSheet.create({
    card: {
      backgroundColor: colors.surface,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.border,
      padding: spacing.lg,
      gap: spacing.sm,
    },
    cardStore: { borderColor: colors.primary, borderWidth: 2 },
    pinRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    pinText: { color: colors.accent, fontSize: typography.caption.fontSize, fontWeight: '800', textTransform: 'uppercase' },
    head: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    avatar: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: colors.background,
      alignItems: 'center',
      justifyContent: 'center',
    },
    avatarStore: { backgroundColor: colors.primary },
    avatarText: { color: colors.primary, fontWeight: '800', fontSize: typography.body.fontSize },
    headText: { flex: 1, minWidth: 0 },
    nameRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, flexWrap: 'wrap' },
    name: { color: colors.text, fontWeight: '800', fontSize: typography.body.fontSize },
    badge: { flexDirection: 'row', alignItems: 'center', gap: 2 },
    badgeText: { color: colors.primary, fontSize: typography.caption.fontSize, fontWeight: '700' },
    when: { color: colors.textFaint, fontSize: typography.caption.fontSize },
    event: { color: colors.accent, fontWeight: '800', fontSize: typography.label.fontSize },
    body: { color: colors.text, fontSize: typography.body.fontSize, lineHeight: 22 },
    photo: { width: '100%', aspectRatio: 4 / 3, borderRadius: radius.md, backgroundColor: colors.background },
    photoCompact: { aspectRatio: 16 / 9 },
    status: { color: colors.textMuted, fontSize: typography.label.fontSize, fontStyle: 'italic' },
    actions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap', marginTop: spacing.xs },
    action: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.pill,
      paddingHorizontal: spacing.md,
      paddingVertical: 6,
      minHeight: 36,
    },
    actionOn: { backgroundColor: colors.primary, borderColor: colors.primary },
    actionText: { color: colors.primary, fontWeight: '700', fontSize: typography.label.fontSize },
    actionTextOn: { color: colors.onPrimary },
    replied: { color: colors.success, fontWeight: '700', fontSize: typography.caption.fontSize + 1 },
    flag: { marginLeft: 'auto', padding: 6 },

    backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center', padding: spacing.lg },
    sheet: {
      width: '100%',
      maxWidth: 520,
      maxHeight: '92%',
      backgroundColor: colors.surface,
      borderRadius: radius.lg,
      padding: spacing.lg,
      gap: spacing.sm,
    },
    sheetTall: { maxHeight: '96%' },
    sheetHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    sheetTitle: { flex: 1, color: colors.text, fontSize: typography.section.fontSize, fontWeight: '800' },
    reason: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      minHeight: 48,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    reasonText: { color: colors.text, fontSize: typography.body.fontSize, fontWeight: '600' },
    form: { gap: spacing.sm, paddingBottom: spacing.sm },
    kinds: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    kind: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.pill,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      backgroundColor: colors.background,
    },
    kindOn: { backgroundColor: colors.primary, borderColor: colors.primary },
    kindText: { color: colors.text, fontWeight: '700', fontSize: typography.label.fontSize },
    kindTextOn: { color: colors.onPrimary },
    hint: { color: colors.textMuted, fontSize: typography.label.fontSize, lineHeight: 19 },
    label: { color: colors.text, fontWeight: '800', fontSize: typography.body.fontSize },
    starsRow: { gap: spacing.xs, alignItems: 'flex-start' },
    textarea: {
      minHeight: 120,
      textAlignVertical: 'top',
      backgroundColor: colors.background,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      padding: spacing.md,
      color: colors.text,
      fontSize: typography.body.fontSize,
    },
    warn: { color: colors.danger, fontWeight: '700', fontSize: typography.label.fontSize },
    photoRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
    thumb: { width: 64, height: 64, borderRadius: radius.md },
    remove: { color: colors.danger, fontWeight: '700', fontSize: typography.label.fontSize },
    rules: { color: colors.textFaint, fontSize: typography.caption.fontSize + 1, lineHeight: 18 },
  });
}
