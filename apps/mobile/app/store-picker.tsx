/**
 * Selector de sucursal, con re-validacion del carrito.
 *
 * Variable 6 del addendum: "si el cliente cambia de sucursal con el
 * carrito lleno, hay que re-validar cada item contra el catalogo de la
 * nueva y avisar de las diferencias, no fallar en silencio".
 *
 * Aqui eso significa releer de la sucursal destino el precio del producto
 * Y el recargo de cada modificador, ensenar todo lo que cambia y esperar a
 * que el cliente confirme. Lo que no existe alli se dice con su nombre:
 * jamas se elimina callado.
 */

import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { fetchCatalogSnapshot } from '../src/api/menu';
import { formatAddress } from '../src/api/store';
import type { StoreRow } from '../src/api/types';
import { Screen, useScreenInsets } from '../src/components/Screen';
import { ErrorState } from '../src/components/DataState';
import { Button, Loading } from '../src/components/ui';
import type { BrandColors } from '../src/domain/branding';
import {
  groupIssuesByLine,
  revalidateCart,
  type LineIssue,
  type RevalidationResult,
} from '../src/domain/cart';
import { formatMoney } from '../src/domain/money';
import { useColors } from '../src/state/branding-context';
import { useCart } from '../src/state/cart-context';
import { useStores } from '../src/state/store-context';
import { radius, spacing, type as typography } from '../src/theme';
import { strings } from '../src/strings';

/** Una frase por aviso, en el idioma del cliente y no del esquema. */
function describeIssue(issue: LineIssue): string {
  switch (issue.kind) {
    case 'item-missing':
      return strings.storePicker.notOnMenu;
    case 'item-unavailable':
      return strings.storePicker.notAvailableHere;
    case 'item-price-changed':
      return strings.storePicker.priceWas(
        formatMoney(issue.beforeCents ?? 0),
        formatMoney(issue.afterCents ?? 0),
      );
    case 'modifier-missing':
      return strings.storePicker.modifierGone(issue.modifierName ?? '');
    case 'modifier-unavailable':
      return strings.storePicker.modifierOut(issue.modifierName ?? '');
    case 'modifier-price-changed':
      return strings.storePicker.modifierPrice(
        issue.modifierName ?? '',
        formatMoney(issue.beforeCents ?? 0),
        formatMoney(issue.afterCents ?? 0),
      );
  }
}

export default function StorePickerScreen(): ReactNode {
  const router = useRouter();
  const colors = useColors();
  const insets = useScreenInsets();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const { stores, selectedStoreId, selectStore, loading, error, reload } = useStores();
  const { cart, isEmpty, replaceCart } = useCart();

  const [checking, setChecking] = useState<string | null>(null);
  const [checkError, setCheckError] = useState<unknown>(null);
  const [review, setReview] = useState<{ store: StoreRow; result: RevalidationResult } | null>(
    null,
  );

  const apply = useCallback(
    (storeId: string, result: RevalidationResult) => {
      replaceCart(result.cart);
      selectStore(storeId);
      router.back();
    },
    [replaceCart, selectStore, router],
  );

  const onPick = useCallback(
    async (store: StoreRow) => {
      if (store.id === selectedStoreId) {
        router.back();
        return;
      }

      // Carrito vacio: no hay nada que re-validar.
      if (isEmpty) {
        selectStore(store.id);
        router.back();
        return;
      }

      setChecking(store.id);
      setCheckError(null);

      try {
        const cloverItemIds = [...new Set(cart.lines.map((line) => line.cloverItemId))];
        const cloverModifierIds = [
          ...new Set(cart.lines.flatMap((line) => line.modifiers.map((m) => m.cloverModifierId))),
        ];

        const snapshot = await fetchCatalogSnapshot(store.id, cloverItemIds, cloverModifierIds);
        const result = revalidateCart(cart, snapshot);

        if (result.needsReview) {
          setReview({ store, result });
        } else {
          apply(store.id, result);
        }
      } catch (cause) {
        setCheckError(cause);
      } finally {
        setChecking(null);
      }
    },
    [apply, cart, isEmpty, router, selectStore, selectedStoreId],
  );

  // ---- Pantalla de revision de diferencias ----
  if (review !== null) {
    const { store, result } = review;
    const groups = groupIssuesByLine(result.issues);
    const removedCount = result.removed.length;

    return (
      <Screen scroll={false}>
        <View style={styles.header}>
          <Text style={styles.title}>{strings.storePicker.reviewTitle}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={strings.common.cancel}
            onPress={() => setReview(null)}
            hitSlop={12}
            style={({ pressed }) => [styles.close, pressed && styles.pressed]}
          >
            <Ionicons name="close" size={22} color={colors.text} />
          </Pressable>
        </View>

        <ScrollView
          contentContainerStyle={[styles.reviewBody, { paddingBottom: insets.bottom + 160 }]}
        >
          <Text style={styles.lead}>{strings.storePicker.lead(store.name)}</Text>

          {removedCount > 0 ? (
            <View style={styles.warning}>
              <Ionicons name="alert-circle" size={20} color={colors.danger} />
              <Text style={styles.warningText}>
                {removedCount === 1
                  ? strings.storePicker.removedOne
                  : strings.storePicker.removedMany(removedCount)}
              </Text>
            </View>
          ) : null}

          {groups.map((group) => {
            const blocking = group.issues.some((issue) => issue.blocking);
            return (
              <View
                key={group.lineId}
                style={[styles.issueCard, blocking && styles.issueCardBlocking]}
              >
                <View style={styles.issueHeader}>
                  <Text style={styles.issueName}>{group.itemName}</Text>
                  {blocking ? (
                    <Text style={styles.issueTag}>{strings.storePicker.willBeRemoved}</Text>
                  ) : (
                    <Text style={[styles.issueTag, styles.issueTagSoft]}>
                      {strings.storePicker.priceChanges}
                    </Text>
                  )}
                </View>
                {group.issues.map((issue, index) => (
                  <Text key={`${issue.kind}-${index}`} style={styles.issueLine}>
                    · {describeIssue(issue)}
                  </Text>
                ))}
              </View>
            );
          })}

          <View style={styles.totals}>
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>{strings.storePicker.subtotalNow}</Text>
              <Text style={styles.totalValue}>{formatMoney(result.subtotalBeforeCents)}</Text>
            </View>
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>{strings.storePicker.subtotalAt(store.name)}</Text>
              <Text style={[styles.totalValue, styles.totalValueStrong]}>
                {formatMoney(result.subtotalAfterCents)}
              </Text>
            </View>
            <Text style={styles.totalsNote}>{strings.storePicker.taxNote}</Text>
          </View>
        </ScrollView>

        <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.lg }]}>
          <Button
            label={
              result.cart.lines.length === 0
                ? strings.storePicker.switchAndEmpty(store.name)
                : strings.storePicker.switchTo(store.name)
            }
            onPress={() => apply(store.id, result)}
          />
          <Button
            label={strings.storePicker.stayHere}
            variant="outline"
            onPress={() => setReview(null)}
          />
        </View>
      </Screen>
    );
  }

  // ---- Lista de sucursales ----
  return (
    <Screen scroll={false}>
      <View style={styles.header}>
        <Text style={styles.title}>{strings.storePicker.title}</Text>
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

      {checkError !== null ? (
        <ErrorState error={checkError} onRetry={() => setCheckError(null)} />
      ) : error !== null ? (
        <ErrorState error={error} onRetry={reload} />
      ) : loading ? (
        <Loading label={strings.storePicker.searching} />
      ) : stores.length === 0 ? (
        <View style={styles.emptyBox}>
          <Text style={styles.emptyTitle}>{strings.storePicker.noneTitle}</Text>
          <Text style={styles.emptyBody}>{strings.storePicker.noneBody}</Text>
          <Button label={strings.common.retry} variant="outline" onPress={reload} />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + spacing.xl }]}
        >
          {!isEmpty ? <Text style={styles.lead}>{strings.storePicker.cartWarning}</Text> : null}

          {stores.map((store) => {
            const selected = store.id === selectedStoreId;
            const busy = checking === store.id;

            return (
              <Pressable
                key={store.id}
                accessibilityRole="button"
                accessibilityState={{ selected, busy }}
                disabled={checking !== null}
                onPress={() => void onPick(store)}
                style={({ pressed }) => [
                  styles.storeCard,
                  selected && styles.storeCardSelected,
                  pressed && styles.pressed,
                  checking !== null && !busy && styles.dimmed,
                ]}
              >
                <View style={styles.storeBody}>
                  <Text style={styles.storeName}>{store.name}</Text>
                  <Text style={styles.storeAddress}>{formatAddress(store)}</Text>
                  <Text style={styles.storeMeta}>
                    {store.status === 'paused' ? strings.storePicker.paused : null}
                    {store.status !== 'paused' && store.pickup_enabled ? strings.home.pickup : null}
                  </Text>
                </View>

                {busy ? (
                  <Text style={styles.checking}>{strings.storePicker.checking}</Text>
                ) : selected ? (
                  <Ionicons name="checkmark-circle" size={24} color={colors.primary} />
                ) : (
                  <Ionicons name="chevron-forward" size={22} color={colors.textFaint} />
                )}
              </Pressable>
            );
          })}
        </ScrollView>
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
    title: { color: colors.text, fontSize: typography.title.fontSize, fontWeight: '800' },
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
    dimmed: { opacity: 0.4 },

    list: { padding: spacing.lg, gap: spacing.md },
    lead: {
      color: colors.textMuted,
      fontSize: typography.body.fontSize,
      lineHeight: 21,
      marginBottom: spacing.sm,
    },

    storeCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      backgroundColor: colors.surface,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.border,
      padding: spacing.lg,
    },
    storeCardSelected: { borderColor: colors.primary, borderWidth: 2 },
    storeBody: { flex: 1, gap: 2 },
    storeName: { color: colors.text, fontSize: typography.body.fontSize + 1, fontWeight: '700' },
    storeAddress: { color: colors.textMuted, fontSize: typography.caption.fontSize + 1 },
    storeMeta: { color: colors.accent, fontSize: typography.caption.fontSize, fontWeight: '700' },
    checking: { color: colors.textMuted, fontSize: typography.caption.fontSize, fontWeight: '600' },

    emptyBox: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: spacing.xl,
      gap: spacing.sm,
    },
    emptyTitle: { color: colors.text, fontSize: typography.section.fontSize, fontWeight: '800' },
    emptyBody: {
      color: colors.textMuted,
      fontSize: typography.body.fontSize,
      textAlign: 'center',
      marginBottom: spacing.md,
    },

    reviewBody: { padding: spacing.lg, gap: spacing.md },
    warning: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      backgroundColor: colors.surface,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.danger,
      padding: spacing.md,
    },
    warningText: {
      flex: 1,
      color: colors.danger,
      fontSize: typography.label.fontSize,
      fontWeight: '700',
    },

    issueCard: {
      backgroundColor: colors.surface,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.border,
      padding: spacing.lg,
      gap: spacing.xs,
    },
    issueCardBlocking: { borderColor: colors.danger },
    issueHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
      marginBottom: spacing.xs,
    },
    issueName: {
      flex: 1,
      color: colors.text,
      fontSize: typography.body.fontSize,
      fontWeight: '700',
    },
    issueTag: {
      color: colors.danger,
      fontSize: typography.caption.fontSize,
      fontWeight: '800',
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
    issueTagSoft: { color: colors.accent },
    issueLine: {
      color: colors.textMuted,
      fontSize: typography.caption.fontSize + 1,
      lineHeight: 19,
    },

    totals: {
      backgroundColor: colors.surface,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.border,
      padding: spacing.lg,
      gap: spacing.xs,
      marginTop: spacing.sm,
    },
    totalRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    totalLabel: { color: colors.textMuted, fontSize: typography.body.fontSize },
    totalValue: { color: colors.text, fontSize: typography.body.fontSize, fontWeight: '700' },
    totalValueStrong: {
      color: colors.primary,
      fontSize: typography.section.fontSize,
      fontWeight: '800',
    },
    totalsNote: {
      color: colors.textFaint,
      fontSize: typography.caption.fontSize,
      marginTop: spacing.xs,
    },

    footer: {
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.md,
      borderTopWidth: 1,
      borderTopColor: colors.border,
      backgroundColor: colors.background,
      gap: spacing.sm,
    },
  });
}
