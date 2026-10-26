/**
 * Botón para cambiar entre español e inglés.
 *
 *  - `pill`: chico, para ir encima del color principal (Inicio). Dice el
 *    idioma AL QUE se cambia ("ES" / "EN") con un globo, que se entiende
 *    sin leer.
 *  - `row`: las dos opciones lado a lado, para Perfil.
 */

import { Ionicons } from '@expo/vector-icons';
import { useMemo, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import type { BrandColors } from '../domain/branding';
import { getLanguage, LANGS, setLanguage, type Lang } from '../i18n';
import { useColors } from '../state/branding-context';
import { strings } from '../strings';
import { radius, spacing, type as typography } from '../theme';

export function LanguageToggle({
  variant = 'pill',
  style,
}: {
  readonly variant?: 'pill' | 'row';
  readonly style?: StyleProp<ViewStyle>;
}): ReactNode {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const current = getLanguage();
  const other: Lang = current === 'es' ? 'en' : 'es';

  if (variant === 'pill') {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={strings.language.switchTo}
        onPress={() => setLanguage(other)}
        hitSlop={8}
        testID="cambiar-idioma"
        style={({ pressed }) => [styles.pill, pressed && styles.pressed, style]}
      >
        <Ionicons name="globe-outline" size={16} color={colors.onPrimary} />
        <Text style={styles.pillText}>{strings.language.short}</Text>
      </Pressable>
    );
  }

  return (
    <View style={[styles.row, style]} accessibilityRole="radiogroup" accessibilityLabel={strings.language.title}>
      {LANGS.map((lang) => {
        const on = lang === current;
        return (
          <Pressable
            key={lang}
            accessibilityRole="radio"
            accessibilityState={{ checked: on }}
            onPress={() => setLanguage(lang)}
            style={({ pressed }) => [styles.option, on && styles.optionOn, pressed && styles.pressed]}
          >
            <Text style={[styles.optionText, on && styles.optionTextOn]}>{strings.language[lang]}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function createStyles(colors: BrandColors) {
  return StyleSheet.create({
    pill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: spacing.sm + 2,
      paddingVertical: 6,
      borderRadius: 999,
      borderWidth: 1.5,
      borderColor: colors.onPrimary,
      minHeight: 32,
    },
    pillText: { color: colors.onPrimary, fontSize: typography.caption.fontSize, fontWeight: '800', letterSpacing: 0.5 },
    pressed: { opacity: 0.7 },
    row: { flexDirection: 'row', gap: spacing.sm },
    option: {
      flex: 1,
      alignItems: 'center',
      paddingVertical: spacing.md,
      borderRadius: radius.md,
      borderWidth: 1.5,
      borderColor: colors.border,
      backgroundColor: colors.surface,
    },
    optionOn: { borderColor: colors.primary, backgroundColor: colors.primary },
    optionText: { color: colors.text, fontSize: typography.body.fontSize, fontWeight: '700' },
    optionTextOn: { color: colors.onPrimary },
  });
}
