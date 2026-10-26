/**
 * Seguimiento del pedido.
 *
 * LO QUE NO SE PROMETE (Variable 1 del addendum)
 * Clover no modela el fin de la preparacion y no hay webhook "order
 * ready". Hasta que entre el APK companion (fase 9), lo unico honesto es
 * una HORA ESTIMADA. Por eso el texto grande dice "estimado para las
 * 4:30" y nunca "tu pedido esta listo".
 *
 * El codigo de recogida solo aparece cuando el pedido esta confirmado: si
 * se ensenara con el pago pendiente, invitaria a ir al mostrador por algo
 * que la cocina todavia no tiene.
 */

import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useMemo, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { fetchOrder, type OrderWithItems } from '../../src/api/orders';
import { fetchOrderPayments, type PaymentRow } from '../../src/api/payments';
import { DataState } from '../../src/components/DataState';
import { PayInstructions } from '../../src/components/PayInstructions';
import { Screen } from '../../src/components/Screen';
import { Button } from '../../src/components/ui';
import type { BrandColors } from '../../src/domain/branding';
import { formatMoney, moneyDefaults } from '../../src/domain/money';
import {
  displayAmountCents,
  hasAuthoritativeTotal,
  isPayable,
  ORDER_PROGRESS_STEPS,
  progressStep,
  showsPickupCode,
} from '../../src/domain/order';
import { formatSlotLabel, partsInZone } from '../../src/domain/pickup';
import { useAsync } from '../../src/hooks/use-async';
import { useInterval } from '../../src/hooks/use-interval';
import { useColors } from '../../src/state/branding-context';
import { useStores } from '../../src/state/store-context';
import { strings } from '../../src/strings';
import { radius, spacing, type as typography } from '../../src/theme';

interface Loaded {
  readonly order: OrderWithItems | null;
  readonly payments: readonly PaymentRow[];
}

export default function OrderScreen(): ReactNode {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { selectedStore } = useStores();

  const load = useCallback(async (): Promise<Loaded> => {
    const order = await fetchOrder(id);
    if (order === null) return { order: null, payments: [] };
    return { order, payments: await fetchOrderPayments(order.id) };
  }, [id]);

  const { data, error, loading, refreshing, refresh, reload } = useAsync(load, [id]);

  // Mientras el pedido siga en curso, se revisa solo cada 20 s: el
  // negocio lo mueve desde su panel y el cliente tiene que verlo.
  const status = data?.order?.status;
  useInterval(
    refresh,
    20_000,
    status === 'confirmed' || status === 'preparing' || status === 'ready',
  );

  if (loading || error !== null || data === null || data.order === null) {
    return (
      <Screen scroll={false}>
        <DataState
          loading={loading}
          error={error}
          empty={!loading && error === null}
          onRetry={reload}
          emptyTitle={strings.order.notFound}
        >
          {null}
        </DataState>
      </Screen>
    );
  }

  const order = data.order;
  const timeZone = selectedStore?.timezone ?? 'America/New_York';
  const step = progressStep(order.status);

  // El aviso sale de los pagos guardados, no de una constante: cuando
  // entre Clover, un pedido pagado de verdad deja de mostrarlo solo.
  const paidWithMock = data.payments.some(
    (payment) => payment.provider === 'mock' && payment.status === 'succeeded',
  );

  const pickupLabel =
    order.pickup_at === null
      ? strings.order.asapEstimate
      : (() => {
          const parts = partsInZone(new Date(order.pickup_at), timeZone);
          return formatSlotLabel(parts.hour * 60 + parts.minute);
        })();

  const totals = {
    subtotalCents: order.subtotal_cents,
    discountCents: order.discount_cents,
    taxCents: order.tax_cents,
    tipCents: order.tip_cents,
    totalCents: order.total_cents,
  };

  return (
    <Screen refreshing={refreshing} onRefresh={refresh} contentStyle={styles.content}>
      <View style={styles.headerRow}>
        <Text style={styles.number}>{strings.order.number(order.order_number)}</Text>
        <Text style={styles.placed}>
          {strings.order.placedAt(new Date(order.created_at).toLocaleDateString(moneyDefaults().locale))}
        </Text>
      </View>

      <PayInstructions
        order={order}
        store={selectedStore ?? null}
        amountCents={displayAmountCents(totals)}
        onChanged={refresh}
      />

      <View style={styles.statusCard}>
        <Text style={styles.statusTitle}>{strings.order.status[order.status]}</Text>
        <Text style={styles.statusHint}>{strings.order.statusHint[order.status]}</Text>

        {step >= 0 ? (
          <View style={styles.progress}>
            {Array.from({ length: ORDER_PROGRESS_STEPS }, (_, index) => (
              <View
                key={index}
                style={[styles.progressBar, index <= step && styles.progressBarOn]}
              />
            ))}
          </View>
        ) : null}

        {/* Hora ESTIMADA, nunca una promesa de que ya esta. */}
        <Text style={styles.estimate}>
          {order.is_asap && order.pickup_at === null
            ? strings.order.asapEstimate
            : strings.order.estimatedFor(pickupLabel)}
        </Text>
      </View>

      {isPayable(order.status) ? (
        <View style={styles.payCard}>
          <Text style={styles.payTitle}>{strings.order.payPending}</Text>
          <Button
            label={
              order.status === 'payment_failed'
                ? strings.payment.retry
                : strings.payment.payNow
            }
            onPress={() => router.push({ pathname: '/pay/[id]', params: { id } })}
          />
        </View>
      ) : null}

      {/* Un pago simulado no manda ningun ticket a ninguna cocina, y la
          pantalla no puede dejar que parezca que si. */}
      {paidWithMock ? (
        <View style={styles.simulated}>
          <Text style={styles.simulatedTitle}>{strings.payment.simulatedTitle}</Text>
          <Text style={styles.simulatedText}>{strings.order.simulatedConfirmed}</Text>
        </View>
      ) : null}

      {showsPickupCode(order.status) ? (
        <View style={styles.codeCard}>
          <Text style={styles.codeLabel}>{strings.order.pickupCode}</Text>
          <Text style={styles.code}>{order.pickup_code}</Text>
          <Text style={styles.codeHint}>{strings.order.pickupCodeHint}</Text>
        </View>
      ) : null}

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{strings.order.itemsTitle}</Text>
        {order.order_items
          .slice()
          .sort((a, b) => a.sort_order - b.sort_order)
          .map((item) => (
            <View key={item.id} style={styles.line}>
              <Text style={styles.lineQty}>{item.quantity}×</Text>
              <View style={styles.lineBody}>
                <Text style={styles.lineName}>{item.name_snapshot}</Text>
                {item.order_item_modifiers.map((modifier) => (
                  <Text key={modifier.clover_modifier_id} style={styles.lineModifier}>
                    {modifier.name_snapshot}
                    {modifier.price_snapshot_cents === 0
                      ? ''
                      : ` (${formatMoney(modifier.price_snapshot_cents)})`}
                  </Text>
                ))}
                {item.note !== null && item.note !== '' ? (
                  <Text style={styles.lineNote}>“{item.note}”</Text>
                ) : null}
              </View>
              <Text style={styles.lineTotal}>{formatMoney(item.line_total_cents)}</Text>
            </View>
          ))}
      </View>

      <View style={styles.totals}>
        {order.tax_cents > 0 || (order.surcharge_cents ?? 0) > 0 ? (
          <>
            <View style={styles.breakdownRow}>
              <Text style={styles.breakdownLabel}>{strings.order.subtotalLine}</Text>
              <Text style={styles.breakdownValue}>{formatMoney(order.subtotal_cents)}</Text>
            </View>
            {order.tax_cents > 0 ? (
              <View style={styles.breakdownRow}>
                <Text style={styles.breakdownLabel}>{strings.order.taxLine}</Text>
                <Text style={styles.breakdownValue}>{formatMoney(order.tax_cents)}</Text>
              </View>
            ) : null}
            {(order.surcharge_cents ?? 0) > 0 ? (
              <View style={styles.breakdownRow}>
                <Text style={styles.breakdownLabel}>{strings.order.surchargeLine}</Text>
                <Text style={styles.breakdownValue}>{formatMoney(order.surcharge_cents ?? 0)}</Text>
              </View>
            ) : null}
          </>
        ) : null}
        <View style={styles.totalRow}>
          <Text style={styles.totalLabel}>{strings.order.subtotal}</Text>
          <Text style={styles.totalValue}>{formatMoney(displayAmountCents(totals))}</Text>
        </View>
        {/* Mientras Clover no devuelva el total, no se inventa uno. */}
        {!hasAuthoritativeTotal(totals) || order.payment_method === 'counter' ? (
          <Text style={styles.totalNote}>{strings.order.taxNote}</Text>
        ) : null}
        {order.payment_method === 'counter' &&
        order.status !== 'completed' &&
        order.status !== 'canceled' ? (
          <Text style={styles.totalNote}>
            {order.pay_with !== null && strings.payments.methods[order.pay_with] !== undefined
              ? strings.payments.payWith(strings.payments.methods[order.pay_with] ?? '')
              : strings.order.payAtCounter}
          </Text>
        ) : null}
      </View>

      {order.customer_note !== null && order.customer_note !== '' ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{strings.checkout.noteForStore}</Text>
          <Text style={styles.lineNote}>“{order.customer_note}”</Text>
        </View>
      ) : null}

      <Text style={styles.footnote}>{strings.order.trackingNote}</Text>

      <Button
        label={strings.common.done}
        variant="outline"
        onPress={() => router.replace('/orders')}
      />
    </Screen>
  );
}

function createStyles(colors: BrandColors) {
  return StyleSheet.create({
    content: { padding: spacing.lg, gap: spacing.lg },
    headerRow: {
      flexDirection: 'row',
      alignItems: 'baseline',
      justifyContent: 'space-between',
      gap: spacing.sm,
    },
    number: { color: colors.text, fontSize: typography.display.fontSize, fontWeight: '800' },
    placed: { color: colors.textFaint, fontSize: typography.caption.fontSize },

    payCard: {
      backgroundColor: colors.surface,
      borderRadius: radius.lg,
      borderWidth: 2,
      borderColor: colors.accent,
      padding: spacing.lg,
      gap: spacing.md,
    },
    payTitle: { color: colors.text, fontSize: typography.body.fontSize, fontWeight: '700' },

    simulated: {
      backgroundColor: colors.surface,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.accent,
      padding: spacing.lg,
      gap: 4,
    },
    simulatedTitle: { color: colors.text, fontSize: typography.body.fontSize, fontWeight: '800' },
    simulatedText: {
      color: colors.textMuted,
      fontSize: typography.caption.fontSize,
      lineHeight: 18,
    },

    statusCard: {
      backgroundColor: colors.primary,
      borderRadius: radius.lg,
      padding: spacing.xl,
      gap: spacing.sm,
    },
    statusTitle: {
      color: colors.onPrimary,
      fontSize: typography.title.fontSize,
      fontWeight: '800',
    },
    statusHint: {
      color: colors.onPrimary,
      opacity: 0.85,
      fontSize: typography.body.fontSize,
      lineHeight: 21,
    },
    progress: { flexDirection: 'row', gap: spacing.xs, marginTop: spacing.sm },
    progressBar: {
      flex: 1,
      height: 4,
      borderRadius: 2,
      backgroundColor: colors.onPrimary,
      opacity: 0.25,
    },
    progressBarOn: { opacity: 1, backgroundColor: colors.accent },
    estimate: {
      color: colors.onPrimary,
      fontSize: typography.section.fontSize,
      fontWeight: '700',
      marginTop: spacing.sm,
    },

    codeCard: {
      backgroundColor: colors.surface,
      borderRadius: radius.lg,
      borderWidth: 2,
      borderColor: colors.accent,
      padding: spacing.xl,
      alignItems: 'center',
      gap: spacing.xs,
    },
    codeLabel: {
      color: colors.textFaint,
      fontSize: typography.caption.fontSize,
      fontWeight: '800',
      letterSpacing: 1,
      textTransform: 'uppercase',
    },
    code: { color: colors.primary, fontSize: 44, fontWeight: '800', letterSpacing: 6 },
    codeHint: { color: colors.textMuted, fontSize: typography.caption.fontSize },

    section: { gap: spacing.sm },
    sectionTitle: { color: colors.text, fontSize: typography.section.fontSize, fontWeight: '700' },
    line: {
      flexDirection: 'row',
      gap: spacing.md,
      backgroundColor: colors.surface,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      padding: spacing.md,
    },
    lineQty: { color: colors.primary, fontSize: typography.body.fontSize, fontWeight: '800' },
    lineBody: { flex: 1, gap: 2 },
    lineName: { color: colors.text, fontSize: typography.body.fontSize, fontWeight: '600' },
    lineModifier: { color: colors.textMuted, fontSize: typography.caption.fontSize },
    lineNote: { color: colors.accent, fontSize: typography.caption.fontSize, fontStyle: 'italic' },
    lineTotal: { color: colors.text, fontSize: typography.body.fontSize, fontWeight: '700' },

    totals: {
      backgroundColor: colors.surface,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.border,
      padding: spacing.lg,
      gap: spacing.xs,
    },
    breakdownRow: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md },
    breakdownLabel: { flex: 1, color: colors.textMuted, fontSize: typography.label.fontSize },
    breakdownValue: { color: colors.text, fontSize: typography.label.fontSize, fontWeight: '700' },
    totalRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    totalLabel: { color: colors.textMuted, fontSize: typography.body.fontSize },
    totalValue: { color: colors.text, fontSize: typography.title.fontSize, fontWeight: '800' },
    totalNote: { color: colors.textFaint, fontSize: typography.caption.fontSize },

    footnote: { color: colors.textFaint, fontSize: typography.caption.fontSize, lineHeight: 18 },
  });
}
