/**
 * Una publicación de la Comunidad VIVA con sus respuestas. Cualquier
 * cliente con sesión puede responder; la respuesta de la tienda se marca.
 */

import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { fetchThread, replyTo, setHelpful } from '../../src/api/community';
import { PostCard, ReportSheet, problemText } from '../../src/components/community/parts';
import { DataState } from '../../src/components/DataState';
import { Screen } from '../../src/components/Screen';
import { Button } from '../../src/components/ui';
import type { BrandColors } from '../../src/domain/branding';
import { contactInfo, timeAgo } from '../../src/domain/community';
import { useAsync } from '../../src/hooks/use-async';
import { getLanguage, localeFor } from '../../src/i18n';
import { useColors } from '../../src/state/branding-context';
import { useSession } from '../../src/state/session-context';
import { strings } from '../../src/strings';
import { radius, spacing, type as typography } from '../../src/theme';

export default function ThreadScreen(): ReactNode {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { user } = useSession();
  const c = strings.community;
  const lang = getLanguage();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [reporting, setReporting] = useState<{ type: 'post' | 'reply'; id: string } | null>(null);

  const load = useCallback(() => fetchThread(id), [id]);
  const { data, error, loading, refresh, reload } = useAsync(load, [id, user?.id]);

  const blocked = contactInfo(text);
  const send = async (): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      await replyTo(id, text.trim());
      setText('');
      refresh();
    } catch (cause) {
      setMessage(problemText(cause));
    } finally {
      setBusy(false);
    }
  };

  const back = (
    <Pressable
      accessibilityRole="button"
      onPress={() => (router.canGoBack() ? router.back() : router.replace('/comunidad'))}
      style={styles.back}
      hitSlop={10}
    >
      <Ionicons name="arrow-back" size={22} color={colors.text} />
      <Text style={styles.backText}>{c.back}</Text>
    </Pressable>
  );

  if (data === null || data.post === null) {
    return (
      <Screen scroll={false}>
        {back}
        <DataState
          loading={loading}
          error={error}
          empty={!loading && error === null}
          emptyTitle={c.problems['not_found'] ?? ''}
          onRetry={reload}
        >
          {null}
        </DataState>
      </Screen>
    );
  }
  const post = data.post;

  return (
    <Screen contentStyle={styles.content} refreshing={false} onRefresh={refresh}>
      {back}
      <PostCard
        post={post}
        onHelpful={
          user === null
            ? undefined
            : () => void setHelpful(post.id, !post.helped).then(refresh).catch((e: unknown) => setMessage(problemText(e)))
        }
        onReport={user === null ? undefined : () => setReporting({ type: 'post', id: post.id })}
      />

      {data.replies.map((r) => {
        const store = r.author_role === 'store';
        return (
          <View key={r.id} style={[styles.reply, store && styles.replyStore]} testID={store ? 'respuesta-tienda' : 'respuesta'}>
            <View style={styles.replyHead}>
              <Text style={styles.replyName}>{r.author_name}</Text>
              {store ? <Text style={styles.storeTag}>{c.storeReply}</Text> : null}
              {!store && r.verified === true ? <Ionicons name="checkmark-circle" size={14} color={colors.primary} /> : null}
              <Text style={styles.replyWhen}>{timeAgo(r.created_at, new Date(), lang, localeFor(lang))}</Text>
              {user !== null && !store && r.mine !== true ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={c.report}
                  onPress={() => setReporting({ type: 'reply', id: r.id })}
                  hitSlop={8}
                  style={styles.flag}
                >
                  <Ionicons name="flag-outline" size={14} color={colors.textFaint} />
                </Pressable>
              ) : null}
            </View>
            <Text style={styles.replyBody}>{r.body}</Text>
            {r.status !== 'published' ? <Text style={styles.status}>{c.reported}</Text> : null}
          </View>
        );
      })}

      {message !== null ? <Text style={styles.message}>{message}</Text> : null}

      {post.kind !== 'suggestion' && post.status === 'published' ? (
        user === null ? (
          <Button label={c.signInToWrite} variant="outline" onPress={() => router.push('/profile')} />
        ) : (
          <View style={styles.composer}>
            <TextInput
              value={text}
              onChangeText={setText}
              placeholder={c.replyPlaceholder}
              placeholderTextColor={colors.textFaint}
              multiline
              maxLength={600}
              style={styles.input}
              accessibilityLabel={c.replyPlaceholder}
              testID="texto-respuesta"
            />
            {blocked !== null ? (
              <Text style={styles.warn}>{c.problems[blocked === 'email' ? 'contact_email' : 'contact_number']}</Text>
            ) : null}
            <Button
              label={c.send}
              busy={busy}
              disabled={text.trim() === '' || blocked !== null}
              onPress={() => void send()}
              testID="enviar-respuesta"
            />
          </View>
        )
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
    back: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.lg, paddingBottom: 0 },
    backText: { color: colors.text, fontWeight: '800', fontSize: typography.body.fontSize },
    reply: {
      marginLeft: spacing.xl,
      backgroundColor: colors.surface,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      padding: spacing.md,
      gap: 4,
    },
    replyStore: { borderColor: colors.primary, backgroundColor: colors.background, borderLeftWidth: 4 },
    replyHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, flexWrap: 'wrap' },
    replyName: { color: colors.text, fontWeight: '800', fontSize: typography.label.fontSize + 1 },
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
    replyWhen: { color: colors.textFaint, fontSize: typography.caption.fontSize },
    replyBody: { color: colors.text, fontSize: typography.body.fontSize, lineHeight: 21 },
    flag: { marginLeft: 'auto', padding: 4 },
    status: { color: colors.textMuted, fontSize: typography.caption.fontSize, fontStyle: 'italic' },
    message: { color: colors.primary, fontWeight: '700', fontSize: typography.label.fontSize },
    composer: { gap: spacing.sm },
    input: {
      minHeight: 80,
      textAlignVertical: 'top',
      backgroundColor: colors.surface,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      padding: spacing.md,
      color: colors.text,
      fontSize: typography.body.fontSize,
    },
    warn: { color: colors.danger, fontWeight: '700', fontSize: typography.label.fontSize },
  });
}
