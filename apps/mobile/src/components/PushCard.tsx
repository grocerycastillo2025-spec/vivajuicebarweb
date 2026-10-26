/**
 * Tarjeta de notificaciones.
 *
 * Ensena el estado REAL, incluido cuando no se puede hacer nada: un
 * interruptor que no funciona y no dice por que es peor que no tenerlo.
 * Si Android ya no va a volver a preguntar, se dice y se explica donde
 * esta la opcion.
 */

import { Ionicons } from '@expo/vector-icons';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { BrandColors } from '../domain/branding';
import type { PushState } from '../domain/push';
import { useColors } from '../state/branding-context';
import { strings } from '../strings';
import { radius, spacing, type as typography } from '../theme';
import { Button } from './ui';

interface PushCardProps {
  readonly state: PushState;
  readonly onEnable: () => Promise<void>;
  readonly signedIn: boolean;
}

export function PushCard({ state, onEnable, signedIn }: PushCardProps): ReactNode {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [busy, setBusy] = useState(false);

  const enable = useCallback(() => {
    setBusy(true);
    void onEnable().finally(() => setBusy(false));
  }, [onEnable]);

  const body = ((): { icon: keyof typeof Ionicons.glyphMap; text: string; action: boolean } => {
    switch (state.kind) {
      case 'unsupported':
        return {
          icon: 'information-circle-outline',
          text: strings.push.unsupported[state.reason],
          action: false,
        };
      case 'ready':
        return { icon: 'notifications', text: strings.push.onBody, action: false };
      case 'working':
        return { icon: 'notifications-outline', text: strings.push.enabling, action: false };
      case 'error':
        return { icon: 'alert-circle-outline', text: state.message, action: true };
      case 'idle':
        if (!signedIn) {
          return {
            icon: 'notifications-off-outline',
            text: strings.push.signInFirst,
            action: false,
          };
        }
        if (state.permission === 'denied') {
          return {
            icon: 'notifications-off-outline',
            text: strings.push.blockedBody,
            action: false,
          };
        }
        return { icon: 'notifications-outline', text: strings.push.body, action: true };
    }
  })();

  const title =
    state.kind === 'ready'
      ? strings.push.on
      : state.kind === 'idle' && state.permission === 'denied'
        ? strings.push.blocked
        : state.kind === 'error'
          ? strings.push.failed
          : strings.push.title;

  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Ionicons name={body.icon} size={20} color={colors.primary} />
        <Text style={styles.title}>{title}</Text>
      </View>
      <Text style={styles.body}>{body.text}</Text>
      {body.action ? (
        <Button
          label={busy ? strings.push.enabling : strings.push.enable}
          variant="outline"
          onPress={enable}
          busy={busy}
        />
      ) : null}
    </View>
  );
}

function createStyles(colors: BrandColors) {
  return StyleSheet.create({
    card: {
      backgroundColor: colors.surface,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.border,
      padding: spacing.lg,
      gap: spacing.md,
    },
    head: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    title: { color: colors.text, fontSize: typography.section.fontSize, fontWeight: '800' },
    body: { color: colors.textMuted, fontSize: typography.body.fontSize, lineHeight: 20 },
  });
}
