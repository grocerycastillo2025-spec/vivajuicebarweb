/**
 * "Paga tu pedido" para lo que no se cobra en el mostrador (0029):
 *
 *  - Zelle: correo o teléfono, nombre, monto y nota "Pedido #N", cada uno
 *    con su botón Copiar. Queda "Pago por confirmar" hasta que el cajero
 *    toca "Pago recibido".
 *  - Stripe / PayPal: botón que abre la página del proveedor con el total
 *    exacto (lo calcula la Edge Function con la base). Al volver
 *    (`?pago=ok`), se le pide a la función que confirme con el proveedor y
 *    la tarjeta cambia sola a "Pago recibido".
 *
 * Con `?pagar=1` (recién hecho el pedido) el pago se abre solo.
 */

import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { confirmOnlinePayment, startOnlinePayment } from '../api/online-payments';
import type { OrderRow } from '../api/orders';
import type { StoreRow } from '../api/types';
import type { BrandColors } from '../domain/branding';
import { formatMoney } from '../domain/money';
import { formatZelleRecipient, isOnlineProvider, needsPaymentConfirmation } from '../domain/payment-options';
import { useColors } from '../state/branding-context';
import { strings } from '../strings';
import { radius, spacing, type as typography } from '../theme';
import { Button } from './ui';

export function PayInstructions({
  order,
  store,
  amountCents,
  onChanged,
}: {
  readonly order: OrderRow;
  readonly store: StoreRow | null;
  readonly amountCents: number;
  /** Para que la pantalla vuelva a leer el pedido (ya pagado). */
  readonly onChanged?: () => void;
}): ReactNode {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const params = useLocalSearchParams<{ pagar?: string; pago?: string }>();
  const [copied, setCopied] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const t = strings.payments;

  const payWith = order.pay_with;
  const provider = isOnlineProvider(payWith) ? payWith : null;
  const paid = order.paid_confirmed_at !== null && order.paid_confirmed_at !== undefined;
  const open = order.status !== 'canceled' && order.status !== 'completed';
  const methodName = payWith === null ? '' : (t.methods[payWith] ?? payWith);

  const pay = useCallback(async (): Promise<void> => {
    if (provider === null) return;
    setOpening(true);
    setProblem(null);
    try {
      const url = await startOnlinePayment(provider, order.id);
      // En la web se va en la misma pestaña: el proveedor regresa solo a
      // esta pantalla con ?pago=ok o ?pago=cancelado.
      if (Platform.OS === 'web') window.location.assign(url);
      else await Linking.openURL(url);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : '';
      setProblem(t.onlineErrors[reason] ?? t.onlineFailed(methodName));
      setOpening(false);
    }
  }, [methodName, order.id, provider, t]);

  // Recién hecho el pedido: el pago se abre solo, una vez.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (params.pagar !== '1' || autoStarted.current || provider === null || paid || !open) return;
    autoStarted.current = true;
    void pay();
  }, [open, paid, params.pagar, pay, provider]);

  // De regreso del proveedor: confirmar con él, y si aún no, reintentar
  // unas veces (el aviso del webhook puede tardar unos segundos).
  const returnHandled = useRef(false);
  useEffect(() => {
    if (params.pago !== 'ok' || returnHandled.current || provider === null || paid) return;
    returnHandled.current = true;
    let alive = true;
    let tries = 0;
    setConfirming(true);
    const attempt = async (): Promise<void> => {
      tries += 1;
      try {
        const result = await confirmOnlinePayment(provider, order.id);
        if (!alive) return;
        if (result.paid) {
          setConfirming(false);
          onChanged?.();
          return;
        }
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : '';
        if (reason === 'pago_no_aprobado' || reason === 'ya_pagado') {
          if (!alive) return;
          setConfirming(false);
          if (reason === 'ya_pagado') onChanged?.();
          else setProblem(t.onlineErrors[reason] ?? null);
          return;
        }
      }
      if (alive && tries < 8) setTimeout(() => void attempt(), 3000);
      else if (alive) {
        setConfirming(false);
        onChanged?.();
      }
    };
    void attempt();
    return () => {
      alive = false;
    };
  }, [onChanged, order.id, paid, params.pago, provider, t]);

  if (!needsPaymentConfirmation(payWith) || order.status === 'canceled') return null;

  if (paid) {
    return (
      <View style={[styles.card, styles.cardPaid]} testID="pago-recibido">
        <Ionicons name="checkmark-circle" size={26} color={colors.success} />
        <Text style={styles.title}>{t.confirmed}</Text>
      </View>
    );
  }
  if (!open) return null;

  const amount = formatMoney(amountCents);
  const orderNumber = `#${order.order_number}`;

  const copy = (key: string, value: string): void => {
    void Clipboard.setStringAsync(value)
      .then(() => setCopied(key))
      .catch(() => setCopied(null));
  };

  const row = (key: string, label: string, value: string, copyValue?: string): ReactNode => (
    <View key={key} style={styles.row}>
      <View style={styles.rowBody}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={styles.rowValue} selectable>
          {value}
        </Text>
      </View>
      {copyValue !== undefined ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${t.copy} ${label}`}
          onPress={() => copy(key, copyValue)}
          style={styles.copy}
          hitSlop={8}
        >
          <Ionicons name={copied === key ? 'checkmark' : 'copy-outline'} size={16} color={colors.primary} />
          <Text style={styles.copyText}>{copied === key ? t.copied : t.copy}</Text>
        </Pressable>
      ) : null}
    </View>
  );

  const zelle = store?.zelle_recipient ?? null;

  return (
    <View style={styles.card} testID="pagar-pedido">
      <View style={styles.head}>
        <Ionicons
          name={provider === 'paypal' ? 'logo-paypal' : provider === 'stripe' ? 'card-outline' : 'phone-portrait-outline'}
          size={22}
          color={colors.primary}
        />
        <Text style={styles.title}>{t.payTitle}</Text>
      </View>

      {provider !== null ? (
        <>
          {row('amount', t.amount, amount)}
          {confirming ? (
            <View style={styles.pending}>
              <Ionicons name="sync-outline" size={16} color={colors.primary} />
              <Text style={styles.confirming}>{t.confirming}</Text>
            </View>
          ) : (
            <Button
              label={opening ? t.opening(methodName) : t.onlineButton(methodName, amount)}
              busy={opening}
              onPress={() => void pay()}
            />
          )}
          {params.pago === 'cancelado' && problem === null ? <Text style={styles.hint}>{t.canceledReturn}</Text> : null}
          {problem !== null ? <Text style={styles.error}>{problem}</Text> : null}
          <Text style={styles.hint}>{t.onlineSteps(methodName)}</Text>
        </>
      ) : payWith === 'zelle' ? (
        <>
          {zelle !== null ? row('zelle', t.zelleTo, formatZelleRecipient(zelle), zelle.replace(/^\+1/, '')) : null}
          {store?.zelle_name ? row('name', t.zelleName, store.zelle_name) : null}
          {row('amount', t.amount, amount, (amountCents / 100).toFixed(2))}
          {row('memo', t.memo, t.memoValue(orderNumber), t.memoValue(orderNumber))}
          <Text style={styles.hint}>{t.zelleSteps}</Text>
        </>
      ) : (
        <>
          {row('amount', t.amount, amount, (amountCents / 100).toFixed(2))}
          {row('concept', t.concept, t.conceptValue(orderNumber), t.conceptValue(orderNumber))}
        </>
      )}

      <View style={styles.pending}>
        <Ionicons name="time-outline" size={16} color={colors.textMuted} />
        <Text style={styles.pendingText}>
          {provider !== null ? `${t.payNowPending}. ${t.onlinePending}` : `${t.pending}. ${t.pendingHint}`}
        </Text>
      </View>
    </View>
  );
}

function createStyles(colors: BrandColors) {
  return StyleSheet.create({
    card: {
      backgroundColor: colors.surface,
      borderRadius: radius.lg,
      borderWidth: 2,
      borderColor: colors.primary,
      padding: spacing.lg,
      gap: spacing.md,
    },
    cardPaid: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, borderColor: colors.border },
    head: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    title: { color: colors.text, fontSize: typography.section.fontSize, fontWeight: '800' },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingBottom: spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    rowBody: { flex: 1, minWidth: 0, gap: 2 },
    rowLabel: { color: colors.textMuted, fontSize: typography.caption.fontSize, fontWeight: '700' },
    rowValue: { color: colors.text, fontSize: typography.body.fontSize + 1, fontWeight: '700' },
    copy: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: spacing.sm,
      paddingVertical: 6,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: colors.primary,
    },
    copyText: { color: colors.primary, fontSize: typography.caption.fontSize, fontWeight: '800' },
    error: { color: colors.danger, fontSize: typography.label.fontSize, fontWeight: '600' },
    hint: { color: colors.textMuted, fontSize: typography.label.fontSize, lineHeight: 19 },
    confirming: { color: colors.primary, fontSize: typography.label.fontSize, fontWeight: '700' },
    pending: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    pendingText: { flex: 1, color: colors.textMuted, fontSize: typography.caption.fontSize, fontWeight: '600' },
  });
}
