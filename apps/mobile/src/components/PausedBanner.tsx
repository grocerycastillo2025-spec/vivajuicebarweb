/**
 * Aviso de "Pedidos en pausa" (la tienda lo prende desde Panel → Tienda).
 * No ocupa espacio si la tienda está recibiendo pedidos.
 */

import { Ionicons } from '@expo/vector-icons';
import type { ReactNode } from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import type { StoreRow } from '../api/types';
import { useColors } from '../state/branding-context';
import { strings } from '../strings';
import { radius, spacing, type as typography } from '../theme';

export function PausedBanner({
  store,
  style,
}: {
  readonly store: Pick<StoreRow, 'pickup_enabled'> | null;
  readonly style?: StyleProp<ViewStyle> | undefined;
}): ReactNode {
  const colors = useColors();
  if (store === null || store.pickup_enabled !== false) return null;
  return (
    <View
      accessibilityRole="alert"
      testID="pedidos-en-pausa"
      style={[styles.box, { backgroundColor: colors.surface, borderColor: colors.danger }, style]}
    >
      <Ionicons name="pause-circle" size={26} color={colors.danger} />
      <View style={styles.text}>
        <Text style={[styles.title, { color: colors.text }]}>{strings.home.pausedTitle}</Text>
        <Text style={[styles.body, { color: colors.textMuted }]}>{strings.home.pausedBody}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 2,
  },
  text: { flex: 1, gap: 2 },
  title: { fontSize: typography.body.fontSize, fontWeight: '800' },
  body: { fontSize: typography.label.fontSize, lineHeight: 19 },
});
