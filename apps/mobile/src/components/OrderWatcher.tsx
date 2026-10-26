/**
 * Avisos al cliente cuando cambia su pedido ("ya se está preparando",
 * "¡está listo!", "fue cancelado"), en cualquier pantalla de la app:
 * franja arriba + sonido suave + vibración, y aviso del teléfono si dio
 * permiso y la app está en segundo plano.
 *
 * Con la app CERRADA no hay aviso (eso necesita notificaciones push).
 */

import { Ionicons } from '@expo/vector-icons';
import { usePathname, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { appPublicUrl } from '../admin/qr';
import { fetchMyOrderStatuses } from '../api/orders';
import { statusNotice, type CustomerNotice } from '../domain/alerts';
import { useInterval } from '../hooks/use-interval';
import { playSound, systemNotice, vibrate } from '../lib/alerts';
import { useColors } from '../state/branding-context';
import { useSession } from '../state/session-context';
import { strings } from '../strings';
import { radius, spacing, type as typography } from '../theme';

// Las pantallas abiertas (el detalle del pedido) se enteran del cambio al
// mismo tiempo que el aviso, para no enseñar un estado viejo.
const changeListeners = new Set<(orderId: string) => void>();
export function onOrderChange(listener: (orderId: string) => void): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}

const ACTIVE = new Set(['confirmed', 'preparing', 'ready', 'payment_pending']);

function noticeText(kind: CustomerNotice, n: number): string {
  return kind === 'preparing'
    ? strings.order.noticePreparing(n)
    : kind === 'ready'
      ? strings.order.noticeReady(n)
      : strings.order.noticeCanceled(n);
}

export function OrderWatcher(): ReactNode {
  const { user } = useSession();
  const pathname = usePathname();
  const router = useRouter();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const known = useRef<Map<string, string> | null>(null);
  const [hasActive, setHasActive] = useState(false);
  const [toast, setToast] = useState<{ id: string; kind: CustomerNotice; text: string } | null>(null);

  const inPanel = pathname.startsWith('/admin');

  const check = useCallback(async () => {
    if (user === null) return;
    let rows: { id: string; order_number: number; status: string }[];
    try {
      rows = await fetchMyOrderStatuses();
    } catch {
      return;
    }
    const before = known.current;
    known.current = new Map(rows.map((r) => [r.id, r.status]));
    setHasActive(rows.some((r) => ACTIVE.has(r.status)));
    if (before === null) return; // primera carga: no se avisa nada
    for (const row of rows) {
      const kind = statusNotice(before.get(row.id), row.status);
      if (kind === null) continue;
      for (const listener of changeListeners) listener(row.id);
      const text = noticeText(kind, row.order_number);
      setToast({ id: row.id, kind, text });
      void playSound(kind === 'canceled' ? 'timbre' : 'campana', 'alto', null);
      vibrate(kind === 'ready' ? [400, 120, 400, 120, 700] : [250, 100, 250]);
      if (typeof document !== 'undefined' && document.hidden) {
        void systemNotice({
          title: text,
          body: '',
          tag: `pedido-${row.id}`,
          url: `${appPublicUrl()}/order/${row.id}`,
          insist: kind === 'ready',
        });
      }
    }
  }, [user]);

  useEffect(() => {
    known.current = null;
    void check();
  }, [check]);

  // Al cambiar de pantalla (por ejemplo, al terminar de pedir) se revisa
  // enseguida: así el pedido recién hecho queda vigilado desde el inicio.
  useEffect(() => {
    if (!inPanel) void check();
  }, [pathname, inPanel, check]);

  // Rápido mientras hay un pedido en curso; despacio si no (por si hace uno).
  useInterval(() => void check(), hasActive ? 10_000 : 45_000, user !== null && !inPanel, true);

  useEffect(() => {
    if (toast === null) return;
    const id = setTimeout(() => setToast(null), toast.kind === 'ready' ? 30_000 : 10_000);
    return () => clearTimeout(id);
  }, [toast]);

  if (toast === null || inPanel) return null;
  const tone = toast.kind === 'canceled' ? colors.danger : toast.kind === 'ready' ? colors.accent : colors.primary;
  return (
    <View pointerEvents="box-none" style={[styles.wrap, { top: insets.top + spacing.sm }]}>
      <View style={[styles.toast, { backgroundColor: tone }]} accessibilityRole="alert" testID="aviso-pedido">
        <Ionicons
          name={toast.kind === 'ready' ? 'bag-check' : toast.kind === 'canceled' ? 'close-circle' : 'time'}
          size={26}
          color="#FFFFFF"
        />
        <Text style={styles.text}>{toast.text}</Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            setToast(null);
            router.push(`/order/${toast.id}`);
          }}
          style={styles.open}
        >
          <Text style={styles.openText}>{strings.order.noticeOpen}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={strings.common.close} onPress={() => setToast(null)} hitSlop={10}>
          <Ionicons name="close" size={22} color="#FFFFFF" />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center', paddingHorizontal: spacing.md, zIndex: 1000 },
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
  open: {
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.8)',
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
  },
  openText: { color: '#FFFFFF', fontWeight: '800', fontSize: typography.label.fontSize },
});
