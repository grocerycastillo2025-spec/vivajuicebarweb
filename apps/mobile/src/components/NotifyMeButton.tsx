/**
 * "Avisarme en este teléfono cuando esté listo": pide permiso de avisos y
 * desbloquea el sonido (el navegador solo deja hacerlo con un toque).
 */

import { Ionicons } from '@expo/vector-icons';
import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { askNotificationPermission, notificationPermission, unlockSound } from '../lib/alerts';
import { useColors } from '../state/branding-context';
import { strings } from '../strings';
import { radius, spacing, type as typography } from '../theme';

export function NotifyMeButton(): ReactNode {
  const colors = useColors();
  const [state, setState] = useState<'idle' | 'on' | 'blocked'>(() =>
    notificationPermission() === 'granted' ? 'on' : 'idle',
  );
  if (state === 'on' && notificationPermission() === 'granted') {
    return (
      <View style={styles.row}>
        <Ionicons name="notifications" size={18} color={colors.success} />
        <Text style={[styles.text, { color: colors.textMuted }]}>{strings.order.notifyOn}</Text>
      </View>
    );
  }
  if (state === 'blocked') {
    return <Text style={[styles.text, { color: colors.textMuted }]}>{strings.order.notifyBlocked}</Text>;
  }
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => {
        void unlockSound();
        void askNotificationPermission().then((p) => setState(p === 'granted' ? 'on' : p === 'unsupported' ? 'on' : 'blocked'));
      }}
      style={[styles.button, { borderColor: colors.primary }]}
      testID="avisarme"
    >
      <Ionicons name="notifications-outline" size={20} color={colors.primary} />
      <Text style={[styles.buttonText, { color: colors.primary }]}>{strings.order.notifyMe}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  text: { flex: 1, fontSize: typography.label.fontSize, lineHeight: 19 },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    borderWidth: 1.5,
    borderRadius: radius.pill,
    minHeight: 46,
    paddingHorizontal: spacing.lg,
  },
  buttonText: { fontWeight: '800', fontSize: typography.body.fontSize },
});
