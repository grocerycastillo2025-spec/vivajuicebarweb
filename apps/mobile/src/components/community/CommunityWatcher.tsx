/**
 * Avisos de la Comunidad VIVA en cualquier pantalla: "VIVA respondió tu
 * reseña", "Tu reseña ya está publicada", "Ganaste 10 puntos"… Franja
 * arriba + sonido suave. Solo con la app abierta (sin push todavía).
 */

import { Ionicons } from '@expo/vector-icons';
import { usePathname, useRouter } from 'expo-router';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { fetchMyNotices, type CommunityNotice } from '../../api/community';
import { readEnv } from '../../env';
import { useInterval } from '../../hooks/use-interval';
import { playSound, vibrate } from '../../lib/alerts';
import { useBranding } from '../../state/branding-context';
import { useSession } from '../../state/session-context';
import { strings } from '../../strings';
import { radius, spacing, type as typography } from '../../theme';

export function noticeText(n: CommunityNotice): string {
  const who = n.actor_name ?? strings.community.storeReply;
  const fn = strings.community.notices[n.kind] as (who: string, points?: number) => string;
  return fn(who, n.points ?? undefined);
}

export function CommunityWatcher(): ReactNode {
  const { user } = useSession();
  const { colors, features } = useBranding();
  const pathname = usePathname();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [toast, setToast] = useState<CommunityNotice | null>(null);
  const inPanel = pathname.startsWith('/admin');
  const active = user !== null && features.community && !inPanel;

  const check = useCallback(async () => {
    if (user === null) return;
    // Mirar la comunidad cuenta como "visto".
    const viewing = pathname.startsWith('/comunidad');
    let rows: CommunityNotice[];
    try {
      rows = await fetchMyNotices(readEnv().restaurantId, viewing);
    } catch {
      return;
    }
    const unread = rows.filter((r) => !r.read);
    const latest = unread[0];
    if (latest === undefined || viewing) return;
    setToast((current) => (current?.id === latest.id ? current : latest));
  }, [user, pathname]);

  useEffect(() => {
    if (active) void check();
  }, [active, check]);
  useInterval(() => void check(), 30_000, active, true);

  // Sonido una vez por aviso nuevo.
  useEffect(() => {
    if (toast === null) return undefined;
    void playSound('campana', 'medio', null);
    vibrate([200, 80, 200]);
    const id = setTimeout(() => setToast(null), 12_000);
    return () => clearTimeout(id);
  }, [toast?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (toast === null || !active) return null;
  const close = (open: boolean): void => {
    const n = toast;
    setToast(null);
    // Se marcan leídos para que no vuelvan a salir.
    void fetchMyNotices(readEnv().restaurantId, true).catch(() => undefined);
    if (open) router.push(n.post_id !== null ? `/comunidad/${n.post_id}` : '/comunidad');
  };
  return (
    <View pointerEvents="box-none" style={[styles.wrap, { top: insets.top + spacing.sm }]}>
      <View style={[styles.toast, { backgroundColor: colors.primary }]} accessibilityRole="alert" testID="aviso-comunidad">
        <Ionicons name={toast.kind === 'points' ? 'gift' : toast.kind === 'hidden' ? 'eye-off' : 'chatbubbles'} size={24} color="#FFFFFF" />
        <Text style={styles.text}>{noticeText(toast)}</Text>
        <Pressable accessibilityRole="button" onPress={() => close(true)} style={styles.open}>
          <Text style={styles.openText}>{strings.community.noticeOpen}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={strings.common.close} onPress={() => close(false)} hitSlop={10}>
          <Ionicons name="close" size={22} color="#FFFFFF" />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center', paddingHorizontal: spacing.md, zIndex: 999 },
  toast: {
    width: '100%',
    maxWidth: 560,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.lg,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  text: { flex: 1, color: '#FFFFFF', fontSize: typography.body.fontSize, fontWeight: '800', lineHeight: 21 },
  open: { borderWidth: 1, borderColor: 'rgba(255,255,255,0.8)', borderRadius: radius.pill, paddingHorizontal: spacing.md, paddingVertical: 6 },
  openText: { color: '#FFFFFF', fontWeight: '800', fontSize: typography.label.fontSize },
});
