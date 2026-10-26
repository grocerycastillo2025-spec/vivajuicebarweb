/**
 * QR rotativo a pantalla completa, para una tablet en el mostrador.
 *
 * El codigo cambia cada minuto en la base (0021). Esta pantalla pide el
 * vigente y vuelve a pedirlo cuando caduca; la base acepta el actual y el
 * anterior, asi que el cliente que escanea justo en el cambio no pierde
 * la visita.
 */

import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { fetchVisitQr, type VisitQr } from '../../src/api/loyalty';
import { useAdmin } from '../../src/admin/admin-context';
import { appPublicUrl, qrDataUrl } from '../../src/admin/qr';
import { adminStrings } from '../../src/admin/strings';
import { buildVisitUrl } from '../../src/domain/visit';
import { useBranding } from '../../src/state/branding-context';

const t = adminStrings.loyalty;

export default function RotatingQrScreen(): ReactNode {
  const router = useRouter();
  const { store } = useAdmin();
  const { colors, displayName } = useBranding();
  const [qr, setQr] = useState<VisitQr | null>(null);
  const [now, setNow] = useState(Date.now());
  const [failed, setFailed] = useState(false);

  const load = useCallback(() => {
    fetchVisitQr(store.id)
      .then((next) => {
        setQr(next);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, [store.id]);

  useEffect(load, [load]);

  // Reloj de un segundo: cuenta atras y recarga al caducar (o cada 10 s
  // si la ultima carga fallo, por ejemplo sin internet un momento).
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const expiresAt = qr?.expires_at === undefined ? null : Date.parse(qr.expires_at);
  const seconds = expiresAt === null ? 0 : Math.max(0, Math.ceil((expiresAt - now) / 1000));

  useEffect(() => {
    if (qr === null) return;
    if ((expiresAt !== null && seconds === 0) || (failed && now % 10_000 < 1000)) load();
  }, [expiresAt, failed, load, now, qr, seconds]);

  const url = qr === null ? null : buildVisitUrl(appPublicUrl(), { storeId: store.id, code: qr.code });

  return (
    <View style={[styles.frame, { backgroundColor: colors.primary }]}>
      <Text style={[styles.brand, { color: colors.onPrimary }]}>{displayName}</Text>
      <Text style={[styles.title, { color: colors.onPrimary }]}>{t.screenTitle}</Text>
      <View style={styles.qrBox}>
        {url !== null ? (
          <Image source={{ uri: qrDataUrl(url, 10) }} style={styles.qr} resizeMode="contain" />
        ) : null}
      </View>
      <Text style={[styles.body, { color: colors.onPrimary }]}>{t.screenBody}</Text>
      {qr?.mode === 'rotating' ? (
        <Text style={[styles.timer, { color: colors.onPrimary }]}>{t.screenExpires(seconds)}</Text>
      ) : null}
      <Pressable onPress={() => router.replace('/admin/lealtad')} style={styles.exit}>
        <Text style={[styles.exitText, { color: colors.onPrimary }]}>{t.exitScreen}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 16 },
  brand: { fontSize: 16, fontWeight: '800', letterSpacing: 2, textTransform: 'uppercase' },
  title: { fontSize: 32, fontWeight: '800', textAlign: 'center' },
  qrBox: {
    backgroundColor: '#FFFFFF',
    borderRadius: 24,
    padding: 16,
    width: '80%',
    maxWidth: 460,
    aspectRatio: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qr: { width: '100%', height: '100%' },
  body: { fontSize: 18, textAlign: 'center', opacity: 0.9 },
  timer: { fontSize: 14, opacity: 0.7 },
  exit: { position: 'absolute', top: 16, right: 16, padding: 8 },
  exitText: { fontWeight: '700', opacity: 0.7 },
});
