/**
 * Historial de pedidos, con "volver a pedir".
 *
 * Volver a pedir NO copia el carrito tal cual: un pedido de hace un mes
 * puede traer precios viejos o productos que ya no estan. Se reconstruye
 * el carrito y se pasa por `revalidateCart` contra el catalogo de hoy,
 * exactamente la misma ruta que el cambio de sucursal. Si algo cambio, el
 * cliente lo ve antes de pagar en vez de encontrarselo en la caja.
 */

import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { fetchCatalogSnapshot } from '../../src/api/menu';
import { fetchMyOrders, type OrderWithItems } from '../../src/api/orders';
import { AuthForm } from '../../src/components/AuthForm';
import { DataState } from '../../src/components/DataState';
import { Screen } from '../../src/components/Screen';
import { Button, SectionTitle } from '../../src/components/ui';
import type { BrandColors } from '../../src/domain/branding';
import { pastOrderToCart, revalidateCart } from '../../src/domain/cart';
import { formatMoney, moneyDefaults } from '../../src/domain/money';
import { displayAmountCents, isActiveOrder } from '../../src/domain/order';
import { useAsync } from '../../src/hooks/use-async';
import { useColors } from '../../src/state/branding-context';
import { useCart } from '../../src/state/cart-context';
import { useSession } from '../../src/state/session-context';
import { useStores } from '../../src/state/store-context';
import { strings } from '../../src/strings';
import { radius, spacing, type as typography } from '../../src/theme';

export default function OrdersScreen(): ReactNode {
  const router = useRouter();
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { user, loading: sessionLoading } = useSession();
  const { selectedStoreId } = useStores();
  const { replaceCart } = useCart();
  const [reordering, setReordering] = useState<string | null>(null);

  const load = useCallback(
    async (): Promise<OrderWithItems[]> => (user === null ? [] : fetchMyOrders()),
    [user],
  );
  const { data, error, loading, refreshing, refresh, reload } = useAsync(load, [user?.id]);

  const reorder = useCallback(
    async (order: OrderWithItems) => {
      if (selectedStoreId === null) return;
      setReordering(order.id);

      try {
        const rebuilt = pastOrderToCart(selectedStoreId, order.order_items);
        const cloverItemIds = [...new Set(rebuilt.lines.map((line) => line.cloverItemId))];
        const cloverModifierIds = [
          ...new Set(rebuilt.lines.flatMap((l) => l.modifiers.map((m) => m.cloverModifierId))),
        ];

        // Misma revalidacion que al cambiar de sucursal: precios de hoy.
        const snapshot = await fetchCatalogSnapshot(
          selectedStoreId,
          cloverItemIds,
          cloverModifierIds,
        );
        const result = revalidateCart(rebuilt, snapshot);

        if (result.cart.lines.length === 0) {
          Alert.alert(strings.orders.title, strings.storePicker.notOnMenu);
          return;
        }

        replaceCart(result.cart);

        if (result.needsReview) {
          // Lo que cambio se dice, no se cuela.
          const changed = result.issues
            .map((issue) =>
              issue.blocking
                ? `${issue.itemName}: ${strings.storePicker.willBeRemoved}`
                : `${issue.itemName}: ${formatMoney(issue.beforeCents ?? 0)} → ${formatMoney(issue.afterCents ?? 0)}`,
            )
            .join('\n');
          Alert.alert(strings.storePicker.reviewTitle, changed);
        } else {
          Alert.alert(strings.order.reorder, strings.order.reorderAdded);
        }

        router.push('/cart');
      } catch (cause) {
        Alert.alert(strings.orders.title, cause instanceof Error ? cause.message : String(cause));
      } finally {
        setReordering(null);
      }
    },
    [replaceCart, router, selectedStoreId],
  );

  if (!sessionLoading && user === null) {
    return (
      <Screen withTabBar contentStyle={styles.content}>
        <Text style={styles.title}>{strings.orders.title}</Text>
        <AuthForm title={strings.orders.signInTitle} body={strings.orders.signInBody} />
      </Screen>
    );
  }

  const orders = data ?? [];
  const active = orders.filter((order) => isActiveOrder(order.status));
  const past = orders.filter((order) => !isActiveOrder(order.status));

  if (sessionLoading || loading || error !== null || orders.length === 0) {
    return (
      <Screen withTabBar scroll={false}>
        <View style={styles.header}>
          <Text style={styles.title}>{strings.orders.title}</Text>
        </View>
        <DataState
          loading={sessionLoading || loading}
          error={error}
          empty={orders.length === 0}
          onRetry={reload}
          emptyTitle={strings.orders.emptyTitle}
          emptyBody={strings.orders.emptyBody}
        >
          {null}
        </DataState>
      </Screen>
    );
  }

  const card = (order: OrderWithItems): ReactNode => {
    const totals = {
      subtotalCents: order.subtotal_cents,
      discountCents: order.discount_cents,
      taxCents: order.tax_cents,
      tipCents: order.tip_cents,
      totalCents: order.total_cents,
    };
    const units = order.order_items.reduce((sum, item) => sum + item.quantity, 0);

    return (
      <View key={order.id} style={styles.card}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={strings.order.number(order.order_number)}
          onPress={() => router.push({ pathname: '/order/[id]', params: { id: order.id } })}
          style={({ pressed }) => [styles.cardTop, pressed && styles.pressed]}
        >
          <View style={styles.cardBody}>
            <Text style={styles.cardNumber}>{strings.order.number(order.order_number)}</Text>
            <Text style={styles.cardStatus}>{strings.order.status[order.status]}</Text>
            <Text style={styles.cardMeta}>
              {strings.orders.itemsCount(units)} · {new Date(order.created_at).toLocaleDateString(moneyDefaults().locale)}
            </Text>
          </View>
          <View style={styles.cardSide}>
            <Text style={styles.cardAmount}>{formatMoney(displayAmountCents(totals))}</Text>
            <Ionicons name="chevron-forward" size={20} color={colors.textFaint} />
          </View>
        </Pressable>

        <Button
          label={strings.order.reorder}
          variant="outline"
          onPress={() => void reorder(order)}
          busy={reordering === order.id}
          disabled={reordering !== null && reordering !== order.id}
        />
      </View>
    );
  };

  return (
    <Screen withTabBar refreshing={refreshing} onRefresh={refresh} contentStyle={styles.content}>
      <Text style={styles.title}>{strings.orders.title}</Text>

      {active.length > 0 ? (
        <View style={styles.section}>
          <SectionTitle>{strings.orders.active}</SectionTitle>
          {active.map(card)}
        </View>
      ) : null}

      {past.length > 0 ? (
        <View style={styles.section}>
          <SectionTitle>{strings.orders.past}</SectionTitle>
          {past.map(card)}
        </View>
      ) : null}
    </Screen>
  );
}

function createStyles(colors: BrandColors) {
  return StyleSheet.create({
    content: { padding: spacing.lg, gap: spacing.lg },
    header: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
    title: { color: colors.text, fontSize: typography.display.fontSize, fontWeight: '800' },
    section: { gap: spacing.sm },

    card: {
      backgroundColor: colors.surface,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.border,
      padding: spacing.lg,
      gap: spacing.md,
      marginBottom: spacing.md,
    },
    cardTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    pressed: { opacity: 0.7 },
    cardBody: { flex: 1, gap: 2 },
    cardNumber: { color: colors.text, fontSize: typography.body.fontSize + 1, fontWeight: '800' },
    cardStatus: { color: colors.primary, fontSize: typography.label.fontSize, fontWeight: '700' },
    cardMeta: { color: colors.textMuted, fontSize: typography.caption.fontSize },
    cardSide: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
    cardAmount: { color: colors.text, fontSize: typography.body.fontSize, fontWeight: '800' },
  });
}
