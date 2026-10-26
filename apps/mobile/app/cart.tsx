/**
 * Carrito. Estado local, sin servidor.
 *
 * Aqui solo se muestra el SUBTOTAL. Los impuestos, propina y total los
 * calcula Clover al crear el pedido, en la fase 5: inventarlos ahora daria
 * un numero que despues no cuadraria con el ticket del restaurante.
 *
 * Y por la misma razon sale el aviso del recargo por tarjeta con su
 * porcentaje: este subtotal tampoco lo lleva dentro. Es la misma promesa
 * que la nota de impuestos, y va al lado (P.L. 2023, c.146).
 */

import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useMemo, type ReactNode } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { Screen, useScreenInsets } from '../src/components/Screen';
import { SurchargeNotice } from '../src/components/SurchargeNotice';
import { Button, EmptyState } from '../src/components/ui';
import { lineTotalCents, lineUnitPriceCents, MAX_LINE_QUANTITY } from '../src/domain/cart';
import { formatMoney } from '../src/domain/money';
import type { BrandColors } from '../src/domain/branding';
import { useSurcharge } from '../src/hooks/use-surcharge';
import { useColors } from '../src/state/branding-context';
import { useCart } from '../src/state/cart-context';
import { useStores } from '../src/state/store-context';
import { radius, spacing, type as typography } from '../src/theme';
import { strings } from '../src/strings';

export default function CartScreen(): ReactNode {
  const router = useRouter();
  const insets = useScreenInsets();
  const { lines, itemCount, subtotalCents, isEmpty, setQuantity, removeLine, clear } = useCart();
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { selectedStore, hasChoice } = useStores();
  const surcharge = useSurcharge();

  return (
    <Screen scroll={false}>
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>{strings.cart.title}</Text>
          {selectedStore !== null ? (
            <Text style={styles.storeLine}>
              {selectedStore.name}
              {hasChoice ? strings.cart.storePrices : ''}
            </Text>
          ) : null}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={strings.common.close}
          onPress={() => router.back()}
          hitSlop={12}
          style={({ pressed }) => [styles.close, pressed && styles.pressed]}
        >
          <Ionicons name="close" size={22} color={colors.text} />
        </Pressable>
      </View>

      {isEmpty ? (
        <EmptyState
          title={strings.cart.emptyTitle}
          body={strings.cart.emptyBody}
          action={
            <Button
              label={strings.cart.goToMenu}
              variant="outline"
              onPress={() => {
                router.back();
                router.push('/menu');
              }}
            />
          }
        />
      ) : (
        <>
          <FlatList
            data={lines}
            keyExtractor={(line) => line.id}
            contentContainerStyle={[styles.list, { paddingBottom: spacing.xl }]}
            renderItem={({ item: line }) => (
              <View style={styles.line}>
                <View style={styles.lineBody}>
                  <Text style={styles.lineName}>{line.name}</Text>

                  {line.modifiers.map((modifier) => (
                    <Text key={modifier.modifierId} style={styles.lineModifier}>
                      {modifier.name}
                      {modifier.priceCents === 0 ? '' : ` (${formatMoney(modifier.priceCents)})`}
                    </Text>
                  ))}

                  {line.note !== '' ? <Text style={styles.lineNote}>“{line.note}”</Text> : null}

                  <Text style={styles.lineUnit}>
                    {strings.cart.each(formatMoney(lineUnitPriceCents(line)))}
                  </Text>
                </View>

                <View style={styles.lineSide}>
                  <Text style={styles.lineTotal}>{formatMoney(lineTotalCents(line))}</Text>

                  <View style={styles.stepper}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`${strings.item.removeOne}: ${line.name}`}
                      onPress={() => setQuantity(line.id, line.quantity - 1)}
                      hitSlop={8}
                      style={({ pressed }) => [styles.stepperButton, pressed && styles.pressed]}
                    >
                      <Ionicons
                        name={line.quantity === 1 ? 'trash-outline' : 'remove'}
                        size={18}
                        color={line.quantity === 1 ? colors.danger : colors.primary}
                      />
                    </Pressable>

                    <Text style={styles.quantity}>{line.quantity}</Text>

                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`${strings.item.addOne}: ${line.name}`}
                      onPress={() => setQuantity(line.id, line.quantity + 1)}
                      disabled={line.quantity >= MAX_LINE_QUANTITY}
                      hitSlop={8}
                      style={({ pressed }) => [
                        styles.stepperButton,
                        pressed && styles.pressed,
                        line.quantity >= MAX_LINE_QUANTITY && styles.disabled,
                      ]}
                    >
                      <Ionicons name="add" size={18} color={colors.primary} />
                    </Pressable>
                  </View>

                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${strings.common.remove}: ${line.name}`}
                    onPress={() => removeLine(line.id)}
                    hitSlop={8}
                  >
                    <Text style={styles.remove}>{strings.common.remove}</Text>
                  </Pressable>
                </View>
              </View>
            )}
            ListFooterComponent={
              <Pressable
                accessibilityRole="button"
                onPress={clear}
                style={({ pressed }) => [styles.clear, pressed && styles.pressed]}
              >
                <Text style={styles.clearText}>{strings.cart.clear}</Text>
              </Pressable>
            }
          />

          <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.lg }]}>
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>{strings.cart.subtotal(itemCount)}</Text>
              <Text style={styles.summaryValue}>{formatMoney(subtotalCents)}</Text>
            </View>

            <SurchargeNotice disclosure={surcharge} variant="line" />

            <Text style={styles.disclaimer}>
              {strings.cart.taxNote}
              {hasChoice ? strings.cart.changeStoreNote : ''}
            </Text>

            <Button
              label={strings.cart.checkout}
              onPress={() => router.push('/checkout')}
              style={styles.checkout}
            />
          </View>
        </>
      )}
    </Screen>
  );
}

function createStyles(colors: BrandColors) {
  return StyleSheet.create({
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
    },
    title: {
      color: colors.text,
      fontSize: typography.title.fontSize,
      fontWeight: '800',
    },
    storeLine: {
      color: colors.textMuted,
      fontSize: typography.caption.fontSize,
      marginTop: 2,
    },
    close: {
      width: 36,
      height: 36,
      borderRadius: radius.pill,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
    },
    pressed: { opacity: 0.7 },
    disabled: { opacity: 0.35 },

    list: { padding: spacing.lg, gap: spacing.md },
    line: {
      flexDirection: 'row',
      gap: spacing.lg,
      backgroundColor: colors.surface,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.border,
      padding: spacing.lg,
      marginBottom: spacing.md,
    },
    lineBody: { flex: 1, gap: 2 },
    lineName: {
      color: colors.text,
      fontSize: typography.body.fontSize + 1,
      fontWeight: '700',
    },
    lineModifier: {
      color: colors.textMuted,
      fontSize: typography.caption.fontSize + 1,
    },
    lineNote: {
      color: colors.accent,
      fontSize: typography.caption.fontSize,
      fontStyle: 'italic',
      marginTop: 2,
    },
    lineUnit: {
      color: colors.textFaint,
      fontSize: typography.caption.fontSize,
      marginTop: spacing.xs,
    },

    lineSide: { alignItems: 'flex-end', gap: spacing.sm },
    lineTotal: {
      color: colors.primary,
      fontSize: typography.body.fontSize + 1,
      fontWeight: '800',
    },
    stepper: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.pill,
      paddingHorizontal: spacing.sm,
    },
    stepperButton: {
      width: 32,
      height: 32,
      alignItems: 'center',
      justifyContent: 'center',
    },
    quantity: {
      color: colors.text,
      fontSize: typography.body.fontSize,
      fontWeight: '800',
      minWidth: 20,
      textAlign: 'center',
    },
    remove: {
      color: colors.textFaint,
      fontSize: typography.caption.fontSize,
      fontWeight: '600',
    },

    clear: { alignSelf: 'center', padding: spacing.md },
    clearText: {
      color: colors.danger,
      fontSize: typography.label.fontSize,
      fontWeight: '700',
    },

    footer: {
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.lg,
      borderTopWidth: 1,
      borderTopColor: colors.border,
      backgroundColor: colors.background,
      gap: spacing.xs,
    },
    summaryRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    summaryLabel: {
      color: colors.textMuted,
      fontSize: typography.body.fontSize,
    },
    summaryValue: {
      color: colors.text,
      fontSize: typography.title.fontSize,
      fontWeight: '800',
    },
    disclaimer: {
      color: colors.textFaint,
      fontSize: typography.caption.fontSize,
    },
    checkout: { marginTop: spacing.md },
  });
}
