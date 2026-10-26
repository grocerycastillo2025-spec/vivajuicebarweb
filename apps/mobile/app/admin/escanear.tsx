/**
 * Panel · Escanear la tarjeta del cliente (0032).
 *
 * Lee el QR de "Mi tarjeta" y abre /admin/cliente con ese código. Cualquier
 * otro QR se ignora. Si la cámara no está, se puede teclear el código.
 */

import { useRouter } from 'expo-router';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { adminStrings } from '../../src/admin/strings';
import { AdminShell, Card, createAdminStyles } from '../../src/admin/ui';
import { CardCodeInput } from '../../src/admin/CardCodeInput';
import { QrScanner } from '../../src/components/QrScanner';
import { parseCardPayload } from '../../src/domain/loyalty-card';
import { useColors } from '../../src/state/branding-context';
import { spacing, type as typography } from '../../src/theme';

const t = adminStrings.loyalty;

export default function AdminScanCardScreen(): ReactNode {
  const router = useRouter();
  const colors = useColors();
  const styles = useMemo(() => ({ ...createAdminStyles(colors), ...local }), [colors]);
  const [notice, setNotice] = useState<string | null>(null);

  const onResult = useCallback(
    (text: string): boolean => {
      const card = parseCardPayload(text);
      if (card === null) {
        setNotice(t.notCard);
        return false;
      }
      router.replace({ pathname: '/admin/cliente', params: { c: card } });
      return true;
    },
    [router],
  );

  return (
    <AdminShell>
      <Card title={t.scanTitle}>
        <View style={styles.scanner}>
          <QrScanner onResult={onResult} />
        </View>
        <Text style={[styles.hint, styles.center]}>{notice ?? t.scanHint}</Text>
        <CardCodeInput />
      </Card>
    </AdminShell>
  );
}

const local = StyleSheet.create({
  scanner: { width: '100%', maxWidth: 480, alignSelf: 'center' },
  center: { textAlign: 'center', fontSize: typography.body.fontSize, marginVertical: spacing.sm },
});
