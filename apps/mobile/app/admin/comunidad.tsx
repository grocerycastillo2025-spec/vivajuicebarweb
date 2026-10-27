/**
 * Panel · Comunidad (solo dueño).
 *
 * Configuración (activa, qué se publica sola, puntos por la primera
 * reseña), "Por revisar" con aprobar / ocultar con motivo, responder como
 * VIVA, ocultar o mostrar respuestas, avisos de la tienda y la bitácora de
 * quién hizo qué.
 */

import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import {
  deleteAnnouncement,
  fetchAdminCommunity,
  fetchCommunityAudit,
  fetchCommunitySettings,
  moderate,
  replyTo,
  saveCommunitySettings,
  storePost,
  uploadCommunityPhoto,
  type AdminCommunityPost,
  type AdminFilter,
  type AuditRow,
  type CommunitySettings,
} from '../../src/api/community';
import { useAdmin } from '../../src/admin/admin-context';
import { adminLocale } from '../../src/admin/language';
import { canPickImages, pickProductPhoto, type PickedImage } from '../../src/admin/pick-image';
import { adminStrings } from '../../src/admin/strings';
import { AdminShell, Card, Field, Notice, Toggle, createAdminStyles } from '../../src/admin/ui';
import { communityPhoto, Stars } from '../../src/components/community/parts';
import { DataState } from '../../src/components/DataState';
import { Button } from '../../src/components/ui';
import type { BrandColors } from '../../src/domain/branding';
import type { CommunityReply } from '../../src/domain/community';
import { useAsync } from '../../src/hooks/use-async';
import { useColors } from '../../src/state/branding-context';
import { useSession } from '../../src/state/session-context';
import { radius, spacing, type as typography } from '../../src/theme';

const t = adminStrings.community;
type View_ = AdminFilter | 'audit';
const VIEWS: readonly View_[] = ['review', 'published', 'hidden', 'suggestion', 'announcement', 'audit'];
const AUTO = ['4', '5', '6', '1'] as const;

function errorText(cause: unknown): string {
  const msg = cause instanceof Error ? cause.message : String(cause);
  if (/community_|PGRST202|42883|does not exist|Could not find/i.test(msg) && !/owner_only/.test(msg)) return t.notReady;
  return msg;
}

function when(iso: string): string {
  return new Date(iso).toLocaleString(adminLocale(), { dateStyle: 'medium', timeStyle: 'short' });
}

export default function AdminCommunityScreen(): ReactNode {
  const { restaurantId, isOwner } = useAdmin();
  const colors = useColors();
  const styles = useMemo(() => ({ ...createAdminStyles(colors), ...createStyles(colors) }), [colors]);
  const [view, setView] = useState<View_>('review');

  const loadSettings = useCallback(() => fetchCommunitySettings(restaurantId), [restaurantId]);
  const settings = useAsync(loadSettings, [restaurantId]);

  const loadList = useCallback(async (): Promise<{ posts: AdminCommunityPost[]; audit: AuditRow[] }> => {
    if (view === 'audit') return { posts: [], audit: await fetchCommunityAudit(restaurantId) };
    return { posts: await fetchAdminCommunity(restaurantId, view), audit: [] };
  }, [restaurantId, view]);
  const list = useAsync(loadList, [restaurantId, view]);

  const changed = useCallback(() => {
    list.refresh();
    settings.refresh();
  }, [list, settings]);

  if (!isOwner) {
    return (
      <AdminShell>
        <Notice tone="error" text={adminStrings.ownerOnly} />
      </AdminShell>
    );
  }
  if (settings.error !== null && settings.data === null) {
    return (
      <AdminShell>
        <Notice tone="error" text={errorText(settings.error)} />
      </AdminShell>
    );
  }
  if (settings.data === null) {
    return (
      <AdminShell scroll={false}>
        <DataState loading={settings.loading} error={null} empty={false} onRetry={settings.reload} emptyTitle="">
          {null}
        </DataState>
      </AdminShell>
    );
  }

  return (
    <AdminShell>
      <View style={styles.layout}>
        <View style={styles.formCol}>
          <SettingsCard initial={settings.data} onSaved={changed} />
          <View style={{ height: spacing.lg }} />
          <AnnouncementCard onDone={() => (view === 'announcement' ? list.refresh() : setView('announcement'))} />
        </View>
        <View style={styles.listCol}>
          <View style={styles.chips}>
            {VIEWS.map((v) => (
              <Pressable
                key={v}
                accessibilityRole="tab"
                accessibilityState={{ selected: view === v }}
                onPress={() => setView(v)}
                style={[styles.chip, view === v && styles.chipOn]}
                testID={`filtro-${v}`}
              >
                <Text style={[styles.chipText, view === v && styles.chipTextOn]}>
                  {t.filters[v]}
                  {v === 'review' && settings.data !== null && settings.data.pending > 0 ? ` (${settings.data.pending})` : ''}
                </Text>
              </Pressable>
            ))}
          </View>
          <View style={{ height: spacing.md }} />
          {list.data === null ? (
            list.error !== null ? (
              <Notice tone="error" text={errorText(list.error)} />
            ) : (
              <DataState loading error={null} empty={false} onRetry={list.reload} emptyTitle="">
                {null}
              </DataState>
            )
          ) : view === 'audit' ? (
            <Card title={t.filters.audit}>
              {list.data.audit.length === 0 ? <Text style={styles.hint}>{t.empty['audit']}</Text> : null}
              {list.data.audit.map((a, i) => (
                <View key={`${a.created_at}-${i}`} style={styles.auditRow}>
                  <Text style={styles.auditWhen}>{when(a.created_at)}</Text>
                  <Text style={styles.auditText}>
                    <Text style={{ fontWeight: '800' }}>{a.who ?? '—'}</Text> · {t.actions[a.action] ?? a.action}
                    {a.reason !== null ? ` — “${a.reason}”` : ''}
                  </Text>
                  {a.excerpt !== null && a.excerpt !== '' ? <Text style={styles.hint}>{a.excerpt}</Text> : null}
                </View>
              ))}
            </Card>
          ) : (
            <View style={{ gap: spacing.md }}>
              {list.data.posts.length === 0 ? <Notice tone="info" text={t.empty[view] ?? ''} /> : null}
              {list.data.posts.map((post) => (
                <AdminPostCard key={post.id} post={post} onChanged={changed} />
              ))}
            </View>
          )}
        </View>
      </View>
    </AdminShell>
  );
}

function SettingsCard({ initial, onSaved }: { readonly initial: CommunitySettings; readonly onSaved: () => void }): ReactNode {
  const { restaurantId } = useAdmin();
  const colors = useColors();
  const styles = useMemo(() => ({ ...createAdminStyles(colors), ...createStyles(colors) }), [colors]);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [auto, setAuto] = useState(String(initial.auto_min_stars));
  const [points, setPoints] = useState(String(initial.review_points));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const save = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      const n = Math.max(0, Math.min(1000, Number.parseInt(points, 10) || 0));
      await saveCommunitySettings(restaurantId, { enabled, autoMinStars: Number(auto), reviewPoints: n });
      setPoints(String(n));
      setNotice({ tone: 'ok', text: t.saved });
      onSaved();
    } catch (cause) {
      setNotice({ tone: 'error', text: errorText(cause) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title={t.settingsTitle}
      right={initial.pending > 0 ? <Text style={styles.badge}>{t.pending(initial.pending)}</Text> : undefined}
    >
      <Text style={styles.hint}>{t.settingsHint}</Text>
      <Toggle label={t.enabled} hint={t.enabledHint} value={enabled} onValueChange={setEnabled} />
      <Text style={styles.label}>{t.autoTitle}</Text>
      <View style={styles.chips}>
        {AUTO.map((a) => (
          <Pressable
            key={a}
            accessibilityRole="radio"
            accessibilityState={{ selected: auto === a }}
            onPress={() => setAuto(a)}
            style={[styles.chip, auto === a && styles.chipOn]}
          >
            <Text style={[styles.chipText, auto === a && styles.chipTextOn]}>{t.autoOptions[a]}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={styles.hint}>{t.autoHint}</Text>
      <Field label={t.points} hint={t.pointsHint} value={points} onChangeText={setPoints} keyboardType="number-pad" />
      {notice !== null ? <Notice tone={notice.tone} text={notice.text} /> : null}
      <Button label={t.save} busy={busy} onPress={() => void save()} testID="guardar-comunidad" />
    </Card>
  );
}

function AnnouncementCard({ onDone }: { readonly onDone: () => void }): ReactNode {
  const { restaurantId } = useAdmin();
  const { user } = useSession();
  const colors = useColors();
  const styles = useMemo(() => ({ ...createAdminStyles(colors), ...createStyles(colors) }), [colors]);
  const [body, setBody] = useState('');
  const [date, setDate] = useState('');
  const [pinned, setPinned] = useState(false);
  const [photo, setPhoto] = useState<PickedImage | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const badDate = date.trim() !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(date.trim());

  const publish = async (): Promise<void> => {
    if (user === null) return;
    setBusy(true);
    setNotice(null);
    try {
      const path = photo === null ? null : await uploadCommunityPhoto(user.id, photo.blob);
      await storePost(restaurantId, { body: body.trim(), photoPath: path, eventDate: date.trim() || null, pinned });
      setBody('');
      setDate('');
      setPinned(false);
      setPhoto(null);
      setNotice({ tone: 'ok', text: t.announced });
      onDone();
    } catch (cause) {
      setNotice({ tone: 'error', text: errorText(cause) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={t.announceTitle}>
      <Text style={styles.hint}>{t.announceHint}</Text>
      <Field label={t.announceBody} value={body} onChangeText={setBody} multiline />
      <Field
        label={t.eventDate}
        hint={t.eventDateHint}
        value={date}
        onChangeText={setDate}
        error={badDate ? t.badDate : null}
        autoCapitalize="none"
      />
      <Toggle label={t.pinned} value={pinned} onValueChange={setPinned} />
      {canPickImages ? (
        <View style={styles.photoRow}>
          {photo !== null ? <Image source={{ uri: photo.previewUrl }} style={styles.thumb} contentFit="cover" /> : null}
          <Button
            label={photo === null ? t.photo : t.changePhoto}
            variant="outline"
            onPress={() => void pickProductPhoto().then((p) => p !== null && setPhoto(p)).catch(() => undefined)}
          />
          {photo !== null ? (
            <Pressable onPress={() => setPhoto(null)} accessibilityRole="button">
              <Text style={styles.link}>{t.removePhoto}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {notice !== null ? <Notice tone={notice.tone} text={notice.text} /> : null}
      <Button
        label={t.announce}
        busy={busy}
        disabled={body.trim() === '' || badDate}
        onPress={() => void publish()}
        testID="publicar-aviso"
      />
    </Card>
  );
}

function AdminPostCard({ post, onChanged }: { readonly post: AdminCommunityPost; readonly onChanged: () => void }): ReactNode {
  const colors = useColors();
  const styles = useMemo(() => ({ ...createAdminStyles(colors), ...createStyles(colors) }), [colors]);
  const [hiding, setHiding] = useState<{ type: 'post' | 'reply'; id: string } | null>(null);
  const [reply, setReply] = useState('');
  const [replying, setReplying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const photo = communityPhoto(post.photo_path);
  const isAnnouncement = post.kind === 'announcement';

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      await fn();
      onChanged();
    } catch (cause) {
      setProblem(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const statusTone =
    post.status === 'published' ? colors.success : post.status === 'hidden' ? colors.textMuted : colors.danger;

  return (
    <View style={[styles.post, isAnnouncement && styles.postStore]} testID="publicacion-panel">
      <View style={styles.postHead}>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text style={styles.author}>
            {post.author_name}
            {post.verified ? <Text style={styles.verified}>{`  ✓ ${t.verified}`}</Text> : null}
          </Text>
          {post.author_email !== null && !isAnnouncement ? (
            <Text style={styles.hint}>
              {t.email}: {post.author_email}
            </Text>
          ) : null}
          <Text style={styles.hint}>
            {t.kinds[post.kind]} · {when(post.created_at)}
          </Text>
        </View>
        <Text style={[styles.status, { color: statusTone, borderColor: statusTone }]}>{t.status[post.status]}</Text>
      </View>

      {post.rating !== null ? <Stars value={post.rating} size={18} /> : null}
      <Text style={styles.body}>{post.body}</Text>
      {post.event_date !== null ? (
        <Text style={styles.hint}>
          <Ionicons name="calendar-outline" size={13} /> {post.event_date}
          {post.pinned ? ` · 📌 ${t.pinned}` : ''}
        </Text>
      ) : post.pinned ? (
        <Text style={styles.hint}>📌 {t.pinned}</Text>
      ) : null}
      {photo !== null ? <Image source={{ uri: photo }} style={styles.photo} contentFit="cover" /> : null}
      {post.hidden_reason !== null ? <Text style={styles.reason}>{post.hidden_reason}</Text> : null}
      {post.report_count > 0 ? (
        <Text style={styles.reports}>
          <Ionicons name="flag" size={13} /> {t.reports(post.report_count)}
          {post.report_reasons.length > 0 ? ` — ${post.report_reasons.join(', ')}` : ''}
        </Text>
      ) : null}

      <View style={styles.actions}>
        {isAnnouncement ? (
          <Button
            label={t.deleteAnnouncement}
            variant="outline"
            busy={busy}
            onPress={() => void run(() => deleteAnnouncement(post.id))}
          />
        ) : (
          <>
            {post.status !== 'published' ? (
              <Button
                label={post.status === 'hidden' ? t.show : t.publish}
                busy={busy}
                onPress={() => void run(() => moderate('post', post.id, 'publish'))}
                testID="aprobar"
              />
            ) : null}
            {post.status !== 'hidden' ? (
              <Button label={t.hide} variant="outline" onPress={() => setHiding({ type: 'post', id: post.id })} testID="ocultar" />
            ) : null}
            {post.kind !== 'suggestion' ? (
              <Button label={t.reply} variant="outline" onPress={() => setReplying((r) => !r)} testID="responder-viva" />
            ) : null}
          </>
        )}
      </View>

      {replying ? (
        <View style={{ gap: spacing.sm }}>
          <TextInput
            value={reply}
            onChangeText={setReply}
            placeholder={t.replyPlaceholder}
            placeholderTextColor={colors.textFaint}
            multiline
            maxLength={600}
            style={[styles.input, styles.inputMultiline]}
            accessibilityLabel={t.replyPlaceholder}
            testID="texto-respuesta-viva"
          />
          <Button
            label={t.send}
            busy={busy}
            disabled={reply.trim() === ''}
            onPress={() =>
              void run(async () => {
                await replyTo(post.id, reply.trim());
                setReply('');
                setReplying(false);
              })
            }
            testID="enviar-respuesta-viva"
          />
        </View>
      ) : null}

      {post.replies.length > 0 ? (
        <View style={styles.replies}>
          <Text style={styles.label}>{t.replies}</Text>
          {post.replies.map((r) => (
            <ReplyRow
              key={r.id}
              reply={r}
              busy={busy}
              onShow={() => void run(() => moderate('reply', r.id, 'publish'))}
              onHide={() => setHiding({ type: 'reply', id: r.id })}
            />
          ))}
        </View>
      ) : null}

      {problem !== null ? <Notice tone="error" text={problem} /> : null}

      <HideSheet
        target={hiding}
        onClose={(reason) => {
          const target = hiding;
          setHiding(null);
          if (reason !== null && target !== null) void run(() => moderate(target.type, target.id, 'hide', reason));
        }}
      />
    </View>
  );
}

function ReplyRow({
  reply,
  busy,
  onShow,
  onHide,
}: {
  readonly reply: CommunityReply;
  readonly busy: boolean;
  readonly onShow: () => void;
  readonly onHide: () => void;
}): ReactNode {
  const colors = useColors();
  const styles = useMemo(() => ({ ...createAdminStyles(colors), ...createStyles(colors) }), [colors]);
  const store = reply.author_role === 'store';
  return (
    <View style={[styles.reply, store && styles.replyStore]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.xs, flexWrap: 'wrap' }}>
        <Text style={styles.author}>{reply.author_name}</Text>
        {store ? <Text style={styles.storeTag}>{t.storeTag}</Text> : null}
        {reply.status !== 'published' ? <Text style={styles.reports}>{t.status[reply.status]}</Text> : null}
        {(reply.report_count ?? 0) > 0 ? <Text style={styles.reports}>· {t.reports(reply.report_count ?? 0)}</Text> : null}
        <View style={{ marginLeft: 'auto' }}>
          {reply.status === 'published' ? (
            <Pressable onPress={onHide} disabled={busy} accessibilityRole="button" testID="ocultar-respuesta">
              <Text style={styles.link}>{t.hide}</Text>
            </Pressable>
          ) : (
            <Pressable onPress={onShow} disabled={busy} accessibilityRole="button">
              <Text style={styles.link}>{t.show}</Text>
            </Pressable>
          )}
        </View>
      </View>
      <Text style={[styles.body, reply.status === 'hidden' && { color: colors.textFaint }]}>{reply.body}</Text>
    </View>
  );
}

/** Motivo para ocultar: frases listas u "Otro motivo". El cliente lo ve. */
function HideSheet({
  target,
  onClose,
}: {
  readonly target: { type: 'post' | 'reply'; id: string } | null;
  readonly onClose: (reason: string | null) => void;
}): ReactNode {
  const colors = useColors();
  const styles = useMemo(() => ({ ...createAdminStyles(colors), ...createStyles(colors) }), [colors]);
  const [choice, setChoice] = useState<string | null>(null);
  const [other, setOther] = useState('');
  const reason = choice === '__other' ? other.trim() : choice;
  const close = (value: string | null): void => {
    setChoice(null);
    setOther('');
    onClose(value);
  };
  return (
    <Modal visible={target !== null} transparent animationType="fade" onRequestClose={() => close(null)}>
      <View style={styles.backdrop}>
        <View style={styles.sheet} testID="motivo-ocultar">
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Text style={[styles.cardTitle, { flex: 1 }]}>{t.hideTitle}</Text>
            <Pressable onPress={() => close(null)} accessibilityRole="button" accessibilityLabel={t.cancel} hitSlop={10}>
              <Ionicons name="close" size={24} color={colors.text} />
            </Pressable>
          </View>
          <Text style={styles.hint}>{t.hideHint}</Text>
          <View style={styles.chips}>
            {[...t.reasons, '__other'].map((r) => (
              <Pressable
                key={r}
                accessibilityRole="radio"
                accessibilityState={{ selected: choice === r }}
                onPress={() => setChoice(r)}
                style={[styles.chip, choice === r && styles.chipOn]}
              >
                <Text style={[styles.chipText, choice === r && styles.chipTextOn]}>{r === '__other' ? t.otherReason : r}</Text>
              </Pressable>
            ))}
          </View>
          {choice === '__other' ? (
            <TextInput
              value={other}
              onChangeText={setOther}
              maxLength={200}
              style={styles.input}
              placeholder={t.otherReason}
              placeholderTextColor={colors.textFaint}
              accessibilityLabel={t.otherReason}
            />
          ) : null}
          <View style={styles.actions}>
            <Button label={t.cancel} variant="outline" onPress={() => close(null)} />
            <Button
              label={t.confirmHide}
              disabled={reason === null || reason === ''}
              onPress={() => close(reason)}
              testID="confirmar-ocultar"
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}

function createStyles(colors: BrandColors) {
  return StyleSheet.create({
    layout: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.lg, alignItems: 'flex-start' },
    formCol: { flexGrow: 1, flexBasis: 320, maxWidth: 460, minWidth: 0 },
    listCol: { flexGrow: 2, flexBasis: 420, minWidth: 0 },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    chip: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.pill,
      paddingHorizontal: spacing.md,
      paddingVertical: 8,
      backgroundColor: colors.surface,
    },
    chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
    chipText: { color: colors.text, fontWeight: '600', fontSize: typography.label.fontSize },
    chipTextOn: { color: colors.onPrimary },
    badge: {
      marginLeft: 'auto',
      color: '#FFFFFF',
      backgroundColor: colors.danger,
      borderRadius: radius.pill,
      paddingHorizontal: 10,
      paddingVertical: 2,
      fontWeight: '800',
      fontSize: typography.caption.fontSize,
      overflow: 'hidden',
    },
    photoRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, flexWrap: 'wrap' },
    thumb: { width: 64, height: 64, borderRadius: radius.md },
    link: { color: colors.primary, fontWeight: '700', fontSize: typography.label.fontSize },
    post: {
      backgroundColor: colors.surface,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.border,
      padding: spacing.lg,
      gap: spacing.sm,
    },
    postStore: { borderColor: colors.primary, borderWidth: 2 },
    postHead: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
    author: { color: colors.text, fontWeight: '800', fontSize: typography.body.fontSize },
    verified: { color: colors.primary, fontWeight: '700', fontSize: typography.caption.fontSize },
    status: {
      borderWidth: 1,
      borderRadius: radius.pill,
      paddingHorizontal: 10,
      paddingVertical: 2,
      fontWeight: '800',
      fontSize: typography.caption.fontSize,
    },
    body: { color: colors.text, fontSize: typography.body.fontSize, lineHeight: 21 },
    photo: { width: '100%', maxWidth: 360, aspectRatio: 4 / 3, borderRadius: radius.md },
    reason: { color: colors.textMuted, fontStyle: 'italic', fontSize: typography.label.fontSize },
    reports: { color: colors.danger, fontWeight: '700', fontSize: typography.caption.fontSize + 1 },
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    replies: { gap: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.sm },
    reply: { backgroundColor: colors.background, borderRadius: radius.md, padding: spacing.md, gap: 4 },
    replyStore: { borderLeftWidth: 4, borderLeftColor: colors.primary },
    storeTag: {
      color: colors.onPrimary,
      backgroundColor: colors.primary,
      borderRadius: radius.pill,
      paddingHorizontal: 8,
      paddingVertical: 1,
      fontSize: typography.caption.fontSize,
      fontWeight: '800',
      overflow: 'hidden',
    },
    auditRow: { gap: 2, paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.border },
    auditWhen: { color: colors.textFaint, fontSize: typography.caption.fontSize },
    auditText: { color: colors.text, fontSize: typography.label.fontSize + 1 },
    backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center', padding: spacing.lg },
    sheet: {
      width: '100%',
      maxWidth: 480,
      backgroundColor: colors.surface,
      borderRadius: radius.lg,
      padding: spacing.lg,
      gap: spacing.md,
    },
  });
}
