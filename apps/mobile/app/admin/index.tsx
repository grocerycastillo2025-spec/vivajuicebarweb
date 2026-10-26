/**
 * Panel · Pedidos.
 *
 * La pantalla que el mostrador deja abierta todo el turno. Tres columnas
 * (Nuevos, En preparación, Listos) y debajo los cerrados de hoy. Se
 * actualiza sola cada 15 s y suena cuando entra un pedido nuevo.
 *
 * Cada boton llama a `set_order_status`, que valida la transicion en la
 * base: si dos personas tocan el mismo pedido a la vez, gana la primera y
 * la segunda ve el estado real en la siguiente carga.
 */

import { Ionicons } from '@expo/vector-icons';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';

import { fetchStoreOrders, setOrderPaid, setOrderStatus } from '../../src/api/admin';
import type { OrderWithItems } from '../../src/api/orders';
import { useAdmin } from '../../src/admin/admin-context';
import { adminStrings as t } from '../../src/admin/strings';
import { AlarmPanel } from '../../src/admin/AlarmPanel';
import { useAlarmSettings, useOrderAlarm } from '../../src/admin/order-alarm';
import { AdminShell, Notice, createAdminStyles } from '../../src/admin/ui';
import { DataState } from '../../src/components/DataState';
import { Button } from '../../src/components/ui';
import {
  canCancel,
  orderActions,
  orderColumn,
  type OrderColumn,
} from '../../src/domain/admin';
import type { BrandColors } from '../../src/domain/branding';
import { formatMoney } from '../../src/domain/money';
import { isOnlineProvider, needsPaymentConfirmation } from '../../src/domain/payment-options';
import type { OrderStatus } from '../../src/domain/order';
import { dayKey, formatSlotLabel, partsInZone } from '../../src/domain/pickup';
import { useAsync } from '../../src/hooks/use-async';
import { useInterval } from '../../src/hooks/use-interval';
import { useColors } from '../../src/state/branding-context';
import { panelAppStrings as strings } from '../../src/admin/language';
import { radius, spacing, type as typography } from '../../src/theme';

const LIVE_COLUMNS: readonly OrderColumn[] = ['new', 'preparing', 'ready'];

export default function AdminOrdersScreen(): ReactNode {
  const colors = useColors();
  const admin = useAdminStyles(colors);
  const { store } = useAdmin();
  const { width } = useWindowDimensions();
  const sideBySide = width >= 900;

  const [failure, setFailure] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [settings, setSettings] = useAlarmSettings();
  const [alarmOpen, setAlarmOpen] = useState(false);

  const load = useCallback(async () => {
    const orders = await fetchStoreOrders(store.id, dayKey(new Date(), store.timezone));
    setUpdatedAt(new Date());
    return orders;
  }, [store.id, store.timezone]);

  const { data, error, loading, refresh, reload } = useAsync(load, [store.id]);
  // Cada 10 s, también con la pantalla en otra pestaña (el navegador lo
  // espacia más en segundo plano, pero sigue llegando).
  useInterval(refresh, 10_000, true, true);
  const alarm = useOrderAlarm(data, settings);

  const move = useCallback(
    async (order: OrderWithItems, to: OrderStatus, reason: string | null = null) => {
      setFailure(null);
      try {
        await setOrderStatus(order.id, to, reason);
        refresh();
      } catch (cause) {
        setFailure(`${t.orders.failed}: ${cause instanceof Error ? cause.message : String(cause)}`);
        refresh();
      }
    },
    [refresh],
  );

  const markPaid = useCallback(
    async (order: OrderWithItems, paid: boolean) => {
      setFailure(null);
      try {
        await setOrderPaid(order.id, paid);
      } catch (cause) {
        setFailure(`${t.orders.failed}: ${cause instanceof Error ? cause.message : String(cause)}`);
      } finally {
        refresh();
      }
    },
    [refresh],
  );

  const grouped = useMemo(() => {
    const groups: Record<OrderColumn, OrderWithItems[]> = {
      new: [],
      preparing: [],
      ready: [],
      done: [],
    };
    for (const order of data ?? []) groups[orderColumn(order.status)].push(order);
    return groups;
  }, [data]);

  if (data === null) {
    return (
      <AdminShell scroll={false}>
        <DataState loading={loading} error={error} empty={false} onRetry={reload} emptyTitle="">
          {null}
        </DataState>
      </AdminShell>
    );
  }

  const liveCount = grouped.new.length + grouped.preparing.length + grouped.ready.length;
  const clock =
    updatedAt === null ? '' : formatSlotLabel(updatedAt.getHours() * 60 + updatedAt.getMinutes());

  return (
    <AdminShell>
      {alarm.locked ? (
        <Pressable accessibilityRole="button" onPress={alarm.unlock} style={admin.unlock} testID="activar-sonido">
          <Ionicons name="volume-high" size={28} color={colors.onPrimary} />
          <View style={admin.grow}>
            <Text style={admin.unlockTitle}>{t.alarm.tapToEnable}</Text>
            <Text style={admin.unlockHint}>{t.alarm.tapToEnableHint}</Text>
          </View>
        </Pressable>
      ) : null}
      {alarm.waiting > 0 ? (
        <View style={admin.alarmBanner} accessibilityRole="alert" testID="pedidos-esperando">
          <Ionicons name="notifications" size={28} color="#FFFFFF" />
          <View style={admin.grow}>
            <Text style={admin.alarmTitle}>{t.alarm.waiting(alarm.waiting)}</Text>
            <Text style={admin.alarmHint}>
              {alarm.snoozedUntil !== null && alarm.snoozedUntil > Date.now()
                ? t.alarm.snoozed(formatSlotLabel(new Date(alarm.snoozedUntil).getHours() * 60 + new Date(alarm.snoozedUntil).getMinutes()))
                : settings.repeatSeconds > 0
                  ? t.alarm.repeatsEvery(settings.repeatSeconds)
                  : t.alarm.noRepeat}
            </Text>
          </View>
          {alarm.snoozedUntil !== null && alarm.snoozedUntil > Date.now() ? (
            <Pressable accessibilityRole="button" onPress={() => alarm.snooze(0)} style={admin.snooze}>
              <Text style={admin.snoozeText}>{t.alarm.unsnooze}</Text>
            </Pressable>
          ) : (
            <Pressable accessibilityRole="button" onPress={() => alarm.snooze(2)} style={admin.snooze} testID="silenciar">
              <Ionicons name="volume-mute" size={18} color="#FFFFFF" />
              <Text style={admin.snoozeText}>{t.alarm.snooze}</Text>
            </Pressable>
          )}
        </View>
      ) : null}
      {failure !== null ? <Notice tone="error" text={failure} /> : null}

      <View style={admin.toolbar}>
        <Pressable accessibilityRole="button" onPress={() => setAlarmOpen(true)} style={admin.alertsButton} testID="abrir-alertas">
          <Ionicons name="notifications-outline" size={18} color={colors.primary} />
          <Text style={admin.alertsButtonText}>{t.alarm.button}</Text>
        </Pressable>
        <Text style={admin.updated}>{t.orders.lastUpdate(clock)}</Text>
        <Pressable accessibilityRole="button" onPress={refresh} style={admin.refresh} hitSlop={8}>
          <Ionicons name="refresh" size={18} color={colors.primary} />
        </Pressable>
      </View>

      {liveCount === 0 ? (
        <View style={admin.empty}>
          <Ionicons name="cafe-outline" size={40} color={colors.textFaint} />
          <Text style={admin.emptyTitle}>{t.orders.emptyTitle}</Text>
          <Text style={admin.emptyBody}>{t.orders.emptyBody}</Text>
        </View>
      ) : (
        <View style={[admin.columns, sideBySide && admin.columnsRow]}>
          {LIVE_COLUMNS.map((column) => (
            <View key={column} style={[admin.column, sideBySide && admin.columnFlex]}>
              <Text style={admin.columnTitle}>
                {t.orders.columns[column]} · {grouped[column].length}
              </Text>
              {grouped[column].map((order) => (
                <OrderCard
                  key={order.id}
                  order={order}
                  timeZone={store.timezone}
                  onMove={move}
                  onPaid={markPaid}
                />
              ))}
            </View>
          ))}
        </View>
      )}

      {grouped.done.length > 0 ? (
        <View style={admin.column}>
          <Text style={admin.columnTitle}>
            {t.orders.columns.done} · {grouped.done.length}
          </Text>
          {grouped.done.map((order) => (
            <OrderCard
              key={order.id}
              order={order}
              timeZone={store.timezone}
              onMove={move}
              onPaid={markPaid}
              compact
            />
          ))}
        </View>
      ) : null}
      <AlarmPanel visible={alarmOpen} settings={settings} onChange={setSettings} onClose={() => setAlarmOpen(false)} />
    </AdminShell>
  );
}

function OrderCard({
  order,
  timeZone,
  onMove,
  onPaid,
  compact = false,
}: {
  readonly order: OrderWithItems;
  readonly timeZone: string;
  readonly onMove: (
    order: OrderWithItems,
    to: OrderStatus,
    reason?: string | null,
  ) => Promise<void>;
  readonly onPaid: (order: OrderWithItems, paid: boolean) => Promise<void>;
  readonly compact?: boolean;
}): ReactNode {
  const colors = useColors();
  const styles = useAdminStyles(colors);
  const [busy, setBusy] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [reason, setReason] = useState('');

  const time =
    order.pickup_at === null
      ? t.orders.asap
      : (() => {
          const p = partsInZone(new Date(order.pickup_at), timeZone);
          return formatSlotLabel(p.hour * 60 + p.minute);
        })();

  const run = async (to: OrderStatus, why: string | null = null): Promise<void> => {
    setBusy(true);
    try {
      await onMove(order, to, why);
    } finally {
      setBusy(false);
      setCanceling(false);
    }
  };

  const paid = order.paid_confirmed_at !== null && order.paid_confirmed_at !== undefined;
  const togglePaid = async (value: boolean): Promise<void> => {
    setBusy(true);
    try {
      await onPaid(order, value);
    } finally {
      setBusy(false);
    }
  };

  const items = order.order_items.slice().sort((a, b) => a.sort_order - b.sort_order);

  return (
    <View style={[styles.orderCard, order.status === 'confirmed' && styles.orderCardNew]}>
      <View style={styles.orderHead}>
        <Text style={styles.orderNumber}>{t.orders.number(order.order_number)}</Text>
        <View style={styles.statusPill}>
          <Text style={styles.statusPillText}>{t.orders.statusLabel[order.status]}</Text>
        </View>
        <Text style={styles.orderTime}>
          {order.is_asap ? t.orders.asap : t.orders.pickupAt(time)}
        </Text>
      </View>

      <Text style={styles.orderMeta}>
        {order.customer_name ?? t.orders.customer} · {t.orders.code(order.pickup_code)}
      </Text>

      {!compact
        ? items.map((item) => (
            <View key={item.id} style={styles.line}>
              <Text style={styles.lineQty}>{item.quantity}×</Text>
              <View style={styles.lineBody}>
                <Text style={styles.lineName}>{item.name_snapshot}</Text>
                {item.order_item_modifiers.map((m) => (
                  <Text key={m.clover_modifier_id} style={styles.lineMod}>
                    + {m.name_snapshot}
                  </Text>
                ))}
                {item.note !== null && item.note !== '' ? (
                  <Text style={styles.lineNote}>“{item.note}”</Text>
                ) : null}
              </View>
            </View>
          ))
        : null}

      {!compact && order.customer_note !== null && order.customer_note !== '' ? (
        <View style={styles.noteBox}>
          <Text style={styles.noteLabel}>{t.orders.note}</Text>
          <Text style={styles.noteText}>{order.customer_note}</Text>
        </View>
      ) : null}

      {order.status === 'canceled' && order.cancel_reason !== null ? (
        <Text style={styles.lineNote}>{order.cancel_reason}</Text>
      ) : null}

      {!compact && (order.tax_cents > 0 || (order.surcharge_cents ?? 0) > 0) ? (
        <Text style={styles.lineNote}>
          {t.orders.breakdown(
            formatMoney(order.subtotal_cents, order.currency),
            formatMoney(order.tax_cents, order.currency),
            formatMoney(order.surcharge_cents ?? 0, order.currency),
          )}
        </Text>
      ) : null}

      <View style={styles.orderFoot}>
        <Text style={styles.orderTotal}>
          {t.orders.total}{' '}
          {formatMoney(
            order.total_cents > 0 ? order.total_cents : order.subtotal_cents,
            order.currency,
          )}
        </Text>
        {order.payment_method === 'counter' && !compact ? (
          <Text style={styles.payTag}>
            {order.pay_with !== null && strings.payments.methods[order.pay_with] !== undefined
              ? strings.payments.methods[order.pay_with]
              : t.orders.payAtCounter}
          </Text>
        ) : null}
        {needsPaymentConfirmation(order.pay_with) && order.status !== 'canceled' ? (
          <Text style={[styles.payTag, paid ? styles.paidTag : styles.unpaidTag]}>
            {paid ? `✓ ${t.payments.paid}` : isOnlineProvider(order.pay_with) ? t.payments.unpaidOnline : t.payments.unpaid}
          </Text>
        ) : null}
      </View>

      {!compact && needsPaymentConfirmation(order.pay_with) && order.status !== 'canceled' ? (
        paid ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => void togglePaid(false)}
            disabled={busy}
            style={styles.cancelLink}
          >
            <Text style={styles.cancelLinkText}>{t.payments.unmarkPaid}</Text>
          </Pressable>
        ) : (
          <Button
            label={t.payments.markPaid}
            variant="outline"
            busy={busy}
            onPress={() => void togglePaid(true)}
            style={styles.paidButton}
          />
        )
      ) : null}

      {!compact && !canceling ? (
        <View style={styles.actions}>
          {orderActions(order.status).map((action) => (
            <Button
              key={action.to}
              label={t.orders.action[action.to as 'preparing' | 'ready' | 'completed']}
              variant={action.kind === 'primary' ? 'primary' : 'outline'}
              busy={busy && action.kind === 'primary'}
              disabled={busy}
              onPress={() => void run(action.to)}
              style={styles.actionButton}
            />
          ))}
          {canCancel(order.status) ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => setCanceling(true)}
              disabled={busy}
              style={styles.cancelLink}
            >
              <Text style={styles.cancelLinkText}>{t.orders.cancel}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {canceling ? (
        <View style={styles.cancelBox}>
          <TextInput
            value={reason}
            onChangeText={setReason}
            placeholder={t.orders.cancelReason}
            placeholderTextColor={colors.textFaint}
            style={styles.cancelInput}
            accessibilityLabel={t.orders.cancelReason}
          />
          <View style={styles.actions}>
            <Button
              label={t.orders.cancelConfirm}
              busy={busy}
              onPress={() => void run('canceled', reason)}
              style={[styles.actionButton, { backgroundColor: colors.danger }]}
            />
            <Button
              label={t.orders.keep}
              variant="outline"
              disabled={busy}
              onPress={() => setCanceling(false)}
              style={styles.actionButton}
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}

function useAdminStyles(colors: BrandColors) {
  return useMemo(() => ({ ...createAdminStyles(colors), ...createStyles(colors) }), [colors]);
}

function createStyles(colors: BrandColors) {
  return StyleSheet.create({
    grow: { flex: 1, minWidth: 0 },
    unlock: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      backgroundColor: colors.primary,
      padding: spacing.lg,
      borderRadius: radius.lg,
    },
    unlockTitle: { color: colors.onPrimary, fontWeight: '800', fontSize: typography.section.fontSize },
    unlockHint: { color: colors.onPrimary, opacity: 0.9, fontSize: typography.label.fontSize },
    alarmBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      flexWrap: 'wrap',
      gap: spacing.md,
      backgroundColor: colors.danger,
      padding: spacing.lg,
      borderRadius: radius.lg,
    },
    alarmTitle: { color: '#FFFFFF', fontWeight: '800', fontSize: typography.section.fontSize },
    alarmHint: { color: '#FFFFFF', opacity: 0.92, fontSize: typography.label.fontSize },
    snooze: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.7)',
      borderRadius: radius.pill,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
    },
    snoozeText: { color: '#FFFFFF', fontWeight: '800', fontSize: typography.label.fontSize },
    alertsButton: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      marginRight: 'auto',
      borderWidth: 1,
      borderColor: colors.primary,
      borderRadius: radius.pill,
      paddingHorizontal: spacing.md,
      paddingVertical: 6,
    },
    alertsButtonText: { color: colors.primary, fontWeight: '800', fontSize: typography.label.fontSize },
    toolbar: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'flex-end',
      gap: spacing.sm,
    },
    updated: { color: colors.textFaint, fontSize: typography.caption.fontSize },
    refresh: {
      width: 34,
      height: 34,
      borderRadius: radius.pill,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: colors.border,
    },
    empty: { alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.xxl },
    emptyTitle: { color: colors.text, fontSize: typography.section.fontSize, fontWeight: '800' },
    emptyBody: {
      color: colors.textMuted,
      fontSize: typography.body.fontSize,
      textAlign: 'center',
      maxWidth: 360,
    },

    columns: { gap: spacing.lg },
    columnsRow: { flexDirection: 'row', alignItems: 'flex-start' },
    column: { gap: spacing.md },
    columnFlex: { flex: 1, minWidth: 0 },
    columnTitle: {
      color: colors.textMuted,
      fontSize: typography.label.fontSize,
      fontWeight: '800',
      textTransform: 'uppercase',
      letterSpacing: 0.6,
    },

    orderCard: {
      backgroundColor: colors.surface,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.border,
      padding: spacing.md,
      gap: spacing.sm,
    },
    orderCardNew: { borderColor: colors.accent, borderWidth: 2 },
    orderHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
    orderNumber: { color: colors.text, fontSize: typography.title.fontSize, fontWeight: '800' },
    statusPill: {
      backgroundColor: colors.background,
      borderRadius: radius.pill,
      paddingHorizontal: spacing.sm,
      paddingVertical: 2,
      borderWidth: 1,
      borderColor: colors.border,
    },
    statusPillText: {
      color: colors.textMuted,
      fontSize: typography.caption.fontSize,
      fontWeight: '700',
    },
    orderTime: {
      marginLeft: 'auto',
      color: colors.primary,
      fontSize: typography.body.fontSize,
      fontWeight: '800',
    },
    orderMeta: { color: colors.textMuted, fontSize: typography.label.fontSize },
    line: { flexDirection: 'row', gap: spacing.sm },
    lineQty: {
      color: colors.text,
      fontWeight: '800',
      fontSize: typography.body.fontSize,
      minWidth: 26,
    },
    lineBody: { flex: 1, minWidth: 0, gap: 2 },
    lineName: { color: colors.text, fontWeight: '700', fontSize: typography.body.fontSize },
    lineMod: { color: colors.textMuted, fontSize: typography.label.fontSize },
    lineNote: { color: colors.accent, fontSize: typography.label.fontSize, fontStyle: 'italic' },
    noteBox: {
      backgroundColor: colors.background,
      borderRadius: radius.sm,
      padding: spacing.sm,
      gap: 2,
    },
    noteLabel: {
      color: colors.textFaint,
      fontSize: typography.caption.fontSize,
      fontWeight: '700',
    },
    noteText: { color: colors.text, fontSize: typography.label.fontSize },
    orderFoot: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
    orderTotal: { color: colors.text, fontWeight: '800', fontSize: typography.body.fontSize },
    paidButton: { alignSelf: 'flex-start', minHeight: 40 },
    paidTag: { color: colors.success, borderColor: colors.success },
    unpaidTag: { color: colors.danger, borderColor: colors.danger },
    payTag: {
      color: colors.primary,
      fontSize: typography.caption.fontSize,
      fontWeight: '700',
      borderWidth: 1,
      borderColor: colors.primary,
      borderRadius: radius.pill,
      paddingHorizontal: spacing.sm,
      paddingVertical: 1,
    },
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, alignItems: 'center' },
    actionButton: { minHeight: 42, paddingHorizontal: spacing.lg },
    cancelLink: { paddingVertical: spacing.sm, paddingHorizontal: spacing.xs },
    cancelLinkText: {
      color: colors.danger,
      fontWeight: '700',
      fontSize: typography.label.fontSize,
    },
    cancelBox: { gap: spacing.sm },
    cancelInput: {
      minHeight: 42,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: spacing.md,
      color: colors.text,
      backgroundColor: colors.background,
    },
  });
}
