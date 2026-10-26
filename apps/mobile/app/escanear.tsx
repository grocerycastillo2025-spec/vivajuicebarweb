/**
 * Escanear el QR del local desde la app. Al leer un QR de visita valido,
 * se pasa a /visita con sus datos; cualquier otro QR se ignora (no se
 * navega a enlaces ajenos).
 */

import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { QrScanner } from '../src/components/QrScanner';
import { Screen } from '../src/components/Screen';
import type { BrandColors } from '../src/domain/branding';
import { parseVisitPayload } from '../src/domain/visit';
import { useColors } from '../src/state/branding-context';
import { strings } from '../src/strings';
import { spacing, type as typography } from '../src/theme';

export default function ScanScreen(): ReactNode {
  const router = useRouter();
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [notice, setNotice] = useState<string | null>(null);

  const onResult = useCallback(
    (text: string): boolean => {
      const payload = parseVisitPayload(text);
      if (payload === null) {
        setNotice(strings.scanner.notVisit);
        return false;
      }
      router.replace({ pathname: '/visita', params: { s: payload.storeId, c: payload.code } });
      return true;
    },
    [router],
  );

  return (
    <Screen contentStyle={styles.content}>
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={strings.common.back}
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/rewards'))}
          hitSlop={12}
        >
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </Pressable>
        <Text style={styles.title}>{strings.scanner.title}</Text>
      </View>
      <QrScanner onResult={onResult} />
      <Text style={styles.hint}>{notice ?? strings.scanner.hint}</Text>
    </Screen>
  );
}

function createStyles(colors: BrandColors) {
  return StyleSheet.create({
    content: { padding: spacing.lg, gap: spacing.lg },
    header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    title: { color: colors.text, fontSize: typography.title.fontSize, fontWeight: '800' },
    hint: { color: colors.textMuted, fontSize: typography.body.fontSize, textAlign: 'center' },
  });
}
