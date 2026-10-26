/**
 * Piezas de interfaz compartidas.
 *
 * Las hojas de estilo son fabricas `createStyles(colors)` y no constantes
 * de modulo: los colores vienen de `app_settings`, asi que solo se
 * conocen en tiempo de ejecucion.
 */

import { useMemo, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import type { BrandColors } from '../domain/branding';
import { useColors } from '../state/branding-context';
import { strings } from '../strings';
import { radius, spacing, type as typography } from '../theme';

interface ButtonProps {
  /** Para las pruebas en navegador (data-testid en la web). */
  readonly testID?: string;
  readonly label: string;
  readonly onPress: () => void;
  readonly variant?: 'primary' | 'accent' | 'outline';
  readonly disabled?: boolean;
  readonly busy?: boolean;
  readonly style?: StyleProp<ViewStyle>;
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  busy = false,
  style,
  testID,
}: ButtonProps): ReactNode {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const inert = disabled || busy;

  const labelColor =
    variant === 'outline'
      ? colors.primary
      : variant === 'accent'
        ? colors.onAccent
        : colors.onPrimary;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: inert, busy }}
      onPress={onPress}
      disabled={inert}
      testID={testID}
      style={({ pressed }) => [
        styles.button,
        variant === 'primary' && styles.buttonPrimary,
        variant === 'accent' && styles.buttonAccent,
        variant === 'outline' && styles.buttonOutline,
        pressed && styles.pressed,
        inert && styles.disabled,
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={labelColor} />
      ) : (
        <Text style={[styles.buttonLabel, { color: labelColor }]}>{label}</Text>
      )}
    </Pressable>
  );
}

export function Loading({
  label = strings.common.loading,
}: {
  readonly label?: string;
}): ReactNode {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);

  return (
    <View style={styles.center}>
      <ActivityIndicator size="large" color={colors.primary} />
      <Text style={styles.centerText}>{label}</Text>
    </View>
  );
}

interface EmptyStateProps {
  readonly title: string;
  readonly body?: string;
  readonly action?: ReactNode;
}

export function EmptyState({ title, body, action }: EmptyStateProps): ReactNode {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);

  return (
    <View style={styles.center}>
      <Text style={styles.emptyTitle}>{title}</Text>
      {body !== undefined ? <Text style={styles.centerText}>{body}</Text> : null}
      {action}
    </View>
  );
}

export function Badge({
  label,
  tone = 'accent',
}: {
  readonly label: string;
  readonly tone?: 'accent' | 'muted';
}): ReactNode {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);

  return (
    <View style={[styles.badge, tone === 'muted' && styles.badgeMuted]}>
      <Text style={[styles.badgeText, tone === 'muted' && styles.badgeTextMuted]}>{label}</Text>
    </View>
  );
}

export function SectionTitle({ children }: { readonly children: ReactNode }): ReactNode {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return <Text style={styles.sectionTitle}>{children}</Text>;
}

export function Divider(): ReactNode {
  const colors = useColors();
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.border }} />;
}

export function createStyles(colors: BrandColors) {
  return StyleSheet.create({
    button: {
      minHeight: 48,
      borderRadius: radius.pill,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: spacing.xl,
    },
    buttonPrimary: { backgroundColor: colors.primary },
    buttonAccent: { backgroundColor: colors.accent },
    buttonOutline: {
      backgroundColor: 'transparent',
      borderWidth: 1.5,
      borderColor: colors.primary,
    },
    pressed: { opacity: 0.75 },
    disabled: { opacity: 0.45 },
    buttonLabel: {
      fontSize: typography.label.fontSize,
      fontWeight: '700',
      letterSpacing: 0.3,
    },

    center: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: spacing.xl,
      gap: spacing.sm,
    },
    centerText: {
      color: colors.textMuted,
      fontSize: typography.body.fontSize,
      textAlign: 'center',
    },
    emptyTitle: {
      color: colors.text,
      fontSize: typography.section.fontSize,
      fontWeight: '700',
      textAlign: 'center',
    },

    badge: {
      alignSelf: 'flex-start',
      backgroundColor: colors.accent,
      borderRadius: radius.pill,
      paddingHorizontal: spacing.md,
      paddingVertical: 3,
    },
    badgeMuted: { backgroundColor: colors.border },
    badgeText: {
      color: colors.onAccent,
      fontSize: typography.caption.fontSize,
      fontWeight: '700',
    },
    badgeTextMuted: { color: colors.textMuted },

    sectionTitle: {
      color: colors.text,
      fontSize: typography.section.fontSize,
      fontWeight: '700',
      marginBottom: spacing.md,
    },
  });
}
