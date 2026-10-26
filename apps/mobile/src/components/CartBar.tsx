/** Barra flotante con el carrito. Se esconde cuando no hay nada dentro. */

import { useRouter } from 'expo-router';
import { useMemo, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { formatMoney } from '../domain/money';
import { useCart } from '../state/cart-context';
import type { BrandColors } from '../domain/branding';
import { useColors } from '../state/branding-context';
import { radius, spacing, type as typography } from '../theme';
import { strings } from '../strings';

export function CartBar({ bottomOffset = 0 }: { readonly bottomOffset?: number }): ReactNode {
  const { itemCount, subtotalCents, isEmpty } = useCart();
  const router = useRouter();
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);

  // Los hooks van antes de cualquier salida temprana.
  if (isEmpty) return null;

  const units = strings.cart.itemCount(itemCount);

  return (
    <View style={[styles.wrapper, { bottom: bottomOffset + spacing.lg }]} pointerEvents="box-none">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${strings.cart.viewCart}, ${units}, ${formatMoney(subtotalCents)}`}
        onPress={() => router.push('/cart')}
        style={({ pressed }) => [styles.bar, pressed && styles.pressed]}
      >
        <Text style={styles.count}>{units}</Text>
        <Text style={styles.label}>{strings.cart.viewCart}</Text>
        <Text style={styles.total}>{formatMoney(subtotalCents)}</Text>
      </Pressable>
    </View>
  );
}

function createStyles(colors: BrandColors) {
  return StyleSheet.create({
    wrapper: {
      position: 'absolute',
      left: spacing.lg,
      right: spacing.lg,
    },
    bar: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.md,
      backgroundColor: colors.primary,
      borderRadius: radius.pill,
      paddingVertical: spacing.md + 2,
      paddingHorizontal: spacing.xl,
      shadowColor: '#000',
      shadowOpacity: 0.2,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: 4 },
      elevation: 6,
    },
    pressed: { opacity: 0.85 },
    count: {
      color: colors.onPrimary,
      fontSize: typography.caption.fontSize,
      fontWeight: '600',
      opacity: 0.85,
      minWidth: 84,
    },
    label: {
      color: colors.onPrimary,
      fontSize: typography.body.fontSize,
      fontWeight: '800',
    },
    total: {
      color: colors.onPrimary,
      fontSize: typography.body.fontSize,
      fontWeight: '800',
      minWidth: 84,
      textAlign: 'right',
    },
  });
}
