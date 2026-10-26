/**
 * Pago del pedido (fase 6).
 *
 * EL COBRO ES SIMULADO Y LA PANTALLA LO DICE
 * `MockPaymentService` corre en el telefono: no hay dinero, no hay
 * tarjeta y la tienda no recibe el ticket. Mientras sea asi, el aviso
 * esta arriba y no se puede quitar. Sale del proveedor, no de una
 * constante: cuando entre Clover desaparece solo.
 *
 * LO QUE YA ESTA MONTADO PARA LA FASE 7
 *  - la eleccion de tarjeta usa TOKENS de prueba, como un sandbox de
 *    verdad; con Clover cambia de donde sale el token, no la pantalla
 *  - si la sesion trae `url`, ahi ira el iframe alojado en un WebView:
 *    el PAN y el CVV no pasan nunca por este codigo
 *  - un cobro que no se pudo guardar NO se reintenta cobrando, se cierra
 *    preguntando al proveedor (`getPayment`)
 *
 * EL RECARGO POR TARJETA SALE AQUI TAMBIEN
 * Y no por repetir el de checkout: esta es la pantalla donde se elige la
 * tarjeta y se pulsa "pagar", el ultimo momento en que el cliente puede
 * echarse atras. Se lee del pedido (`order.store_id`), no de la sucursal
 * elegida, que puede haber cambiado desde que se creo el pedido: anunciar
 * el porcentaje de otra sucursal seria peor que no anunciar ninguno.
 */

import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { fetchOrder } from '../../src/api/orders';
import {
  fetchOrderPayments,
  parseRecordPaymentError,
  supabasePaymentRecorder,
  type PaymentRow,
} from '../../src/api/payments';
import { DataState } from '../../src/components/DataState';
import { Screen, useScreenInsets } from '../../src/components/Screen';
import { SurchargeNotice } from '../../src/components/SurchargeNotice';
import { Button } from '../../src/components/ui';
import type { BrandColors } from '../../src/domain/branding';
import { formatMoney, moneyDefaults } from '../../src/domain/money';
import { isPayable } from '../../src/domain/order';
import {
  resumeUnrecordedAttempt,
  runPaymentAttempt,
  type PaymentOutcome,
} from '../../src/payments/checkout-flow';
import { TEST_TOKENS } from '../../src/payments/payment-service';
import { getPaymentService, isSimulatedPayments } from '../../src/payments/provider';
import { useAsync } from '../../src/hooks/use-async';
import { useSurcharge } from '../../src/hooks/use-surcharge';
import { useColors } from '../../src/state/branding-context';
import { strings } from '../../src/strings';
import { radius, spacing, type as typography } from '../../src/theme';
import type { OrderWithItems } from '../../src/api/orders';

interface Loaded {
  readonly order: OrderWithItems | null;
  readonly payments: readonly PaymentRow[];
}

interface Pending {
  readonly attemptKey: string;
  readonly providerPaymentId: string;
}

interface Orphaned {
  readonly code: string;
  readonly providerPaymentId: string;
}

const CARDS = [
  { token: TEST_TOKENS.approve, label: strings.payment.approve, icon: 'card-outline' },
  { token: TEST_TOKENS.declineCard, label: strings.payment.declineCard, icon: 'close-circle-outline' },
  { token: TEST_TOKENS.declineFunds, label: strings.payment.declineFunds, icon: 'alert-circle-outline' },
] as const;

/** El codigo del RPC se convierte en algo que el cliente entienda. */
function recorderMessage(message: string): string {
  switch (parseRecordPaymentError(message)) {
    case 'simulated_payments_disabled':
      return strings.payment.disabledBody;
    case 'amount_mismatch':
      return strings.payment.amountMismatch;
    case 'order_not_payable':
      return strings.payment.orderNotPayable;
    case 'idempotency_key_conflict':
      return strings.payment.conflict;
    default:
      return message;
  }
}

function declineMessage(code: string): string {
  const known = strings.payment.declined as Record<string, string | undefined>;
  return known[code] ?? strings.payment.declined.declined;
}

export default function PayScreen(): ReactNode {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const colors = useColors();
  const insets = useScreenInsets();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const service = getPaymentService();
  const simulated = isSimulatedPayments(service);

  const [token, setToken] = useState<string>(TEST_TOKENS.approve);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [declined, setDeclined] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [orphaned, setOrphaned] = useState<Orphaned | null>(null);

  const load = useCallback(async (): Promise<Loaded> => {
    const order = await fetchOrder(id);
    if (order === null) return { order: null, payments: [] };
    return { order, payments: await fetchOrderPayments(order.id) };
  }, [id]);

  const { data, error, loading, reload } = useAsync(load, [id]);

  // La sucursal DEL PEDIDO, no la elegida ahora mismo. Hasta que el
  // pedido llega esto no divulga nada, y tampoco hay nada pintado: la
  // pantalla esta en `DataState`.
  const surcharge = useSurcharge(data?.order?.store_id);

  const finish = useCallback(
    (outcome: PaymentOutcome) => {
      switch (outcome.kind) {
        case 'paid':
          setPending(null);
          router.replace({ pathname: '/order/[id]', params: { id } });
          return;
        case 'declined':
          setPending(null);
          setDeclined(outcome.failureCode);
          // Los intentos se cuentan con los pagos ya guardados, asi que
          // el siguiente usa una clave nueva sin llevar cuenta aqui.
          reload();
          return;
        case 'unrecorded':
          // El dinero se movio y no lo pudimos escribir. Ni se reintenta
          // el cobro ni se deja pasar: se cierra preguntando.
          setPending({
            attemptKey: outcome.attemptKey,
            providerPaymentId: outcome.providerPaymentId,
          });
          return;
        case 'orphaned':
          // Se cobro y la base lo rechaza por regla. Reintentar daria la
          // misma respuesta siempre, asi que aqui no hay boton.
          setPending(null);
          setOrphaned({ code: outcome.code, providerPaymentId: outcome.providerPaymentId });
          reload();
          return;
      }
    },
    [id, reload, router],
  );

  const pay = useCallback(async () => {
    if (data?.order === null || data?.order === undefined) return;
    setBusy(true);
    setFailure(null);
    setDeclined(null);
    setOrphaned(null);

    try {
      finish(
        await runPaymentAttempt(
          { payments: service, recorder: supabasePaymentRecorder },
          {
            orderId: data.order.id,
            storeId: data.order.store_id,
            // Sin clave de pedido no hay forma de derivar la del intento:
            // se para antes que arriesgar un cobro sin idempotencia.
            orderKey: data.order.idempotency_key ?? '',
            attempt: data.payments.length + 1,
            amountCents: data.order.subtotal_cents,
            currency: data.order.currency,
            sourceToken: token,
          },
        ),
      );
    } catch (cause) {
      setFailure(recorderMessage(cause instanceof Error ? cause.message : String(cause)));
    } finally {
      setBusy(false);
    }
  }, [data, finish, service, token]);

  const resume = useCallback(async () => {
    if (pending === null || data?.order === null || data?.order === undefined) return;
    setBusy(true);
    setFailure(null);

    try {
      finish(
        await resumeUnrecordedAttempt(
          { payments: service, recorder: supabasePaymentRecorder },
          { orderId: data.order.id, ...pending },
        ),
      );
    } catch (cause) {
      setFailure(recorderMessage(cause instanceof Error ? cause.message : String(cause)));
    } finally {
      setBusy(false);
    }
  }, [data, finish, pending, service]);

  const header = (
    <View style={styles.header}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={strings.common.back}
        onPress={() => router.back()}
        hitSlop={12}
        style={({ pressed }) => [styles.close, pressed && styles.pressed]}
      >
        <Ionicons name="arrow-back" size={22} color={colors.text} />
      </Pressable>
      <Text style={styles.title}>{strings.payment.title}</Text>
    </View>
  );

  if (loading || error !== null || data?.order === null || data === null) {
    return (
      <Screen scroll={false}>
        {header}
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

  // Un pedido ya pagado (o cancelado) no vuelve a pasar por aqui.
  if (!isPayable(order.status)) {
    return (
      <Screen scroll={false}>
        {header}
        <View style={styles.body}>
          <Text style={styles.notice}>{strings.payment.orderNotPayable}</Text>
          <Button
            label={strings.order.title}
            onPress={() => router.replace({ pathname: '/order/[id]', params: { id } })}
          />
        </View>
      </Screen>
    );
  }

  return (
    <Screen scroll={false}>
      {header}

      <ScrollView contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + 170 }]}>
        {simulated ? (
          <View style={styles.simulated}>
            <Ionicons name="flask-outline" size={20} color={colors.accent} />
            <View style={styles.simulatedBody}>
              <Text style={styles.simulatedTitle}>{strings.payment.simulatedTitle}</Text>
              <Text style={styles.simulatedText}>{strings.payment.simulatedBody}</Text>
            </View>
          </View>
        ) : null}

        <View style={styles.amountCard}>
          <Text style={styles.amountLabel}>{strings.payment.amountDue}</Text>
          <Text style={styles.amount}>{formatMoney(order.subtotal_cents)}</Text>
          {/* Subtotal, no total: el total lo calcula la caja. */}
          <Text style={styles.amountNote}>{strings.payment.subtotalNote}</Text>
        </View>

        {/*
          Justo debajo del importe y ENCIMA de la eleccion de tarjeta: el
          recargo depende de con que se pague, asi que decirlo despues de
          haber elegido llegaria tarde.
        */}
        <SurchargeNotice disclosure={surcharge} />

        {orphaned !== null ? (
          <View style={styles.orphaned}>
            <Text style={styles.orphanedTitle}>{strings.payment.orphanedTitle}</Text>
            <Text style={styles.unrecordedText}>{strings.payment.orphanedBody}</Text>
            <Text style={styles.attempt}>
              {strings.payment.orphanedRef(orphaned.providerPaymentId)}
            </Text>
            <Button
              label={strings.order.title}
              variant="outline"
              onPress={() => router.replace({ pathname: '/order/[id]', params: { id } })}
            />
          </View>
        ) : pending !== null ? (
          <View style={styles.unrecorded}>
            <Text style={styles.unrecordedTitle}>{strings.payment.unrecordedTitle}</Text>
            <Text style={styles.unrecordedText}>{strings.payment.unrecordedBody}</Text>
            <Button
              label={busy ? strings.payment.saving : strings.payment.finishSaving}
              onPress={() => void resume()}
              busy={busy}
            />
          </View>
        ) : (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>{strings.payment.method}</Text>
            <Text style={styles.sectionHint}>{strings.payment.methodNote}</Text>

            {CARDS.map((card) => {
              const active = card.token === token;
              return (
                <Pressable
                  key={card.token}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: active }}
                  onPress={() => setToken(card.token)}
                  style={({ pressed }) => [
                    styles.card,
                    active && styles.cardOn,
                    pressed && styles.pressed,
                  ]}
                >
                  <Ionicons
                    name={active ? 'radio-button-on' : 'radio-button-off'}
                    size={22}
                    color={active ? colors.primary : colors.textFaint}
                  />
                  <Ionicons name={card.icon} size={20} color={colors.textMuted} />
                  <Text style={styles.cardLabel}>{card.label}</Text>
                </Pressable>
              );
            })}
          </View>
        )}

        {declined !== null ? (
          <View style={styles.failure}>
            <Ionicons name="close-circle" size={20} color={colors.danger} />
            <View style={styles.failureBody}>
              <Text style={styles.failureTitle}>{strings.payment.declinedTitle}</Text>
              <Text style={styles.failureText}>{declineMessage(declined)}</Text>
            </View>
          </View>
        ) : null}

        {failure !== null ? (
          <View style={styles.failure}>
            <Ionicons name="alert-circle" size={20} color={colors.danger} />
            <View style={styles.failureBody}>
              <Text style={styles.failureTitle}>{strings.payment.failed}</Text>
              <Text style={styles.failureText}>{failure}</Text>
            </View>
          </View>
        ) : null}

        {data.payments.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>{strings.payment.history}</Text>
            {data.payments.map((payment) => (
              <Text key={payment.id} style={styles.attempt}>
                {strings.payment.attempt(
                  strings.payment.statusLabel[payment.status],
                  formatMoney(payment.amount_cents),
                  new Date(payment.created_at).toLocaleTimeString(moneyDefaults().locale),
                )}
              </Text>
            ))}
          </View>
        ) : null}
      </ScrollView>

      {pending === null && orphaned === null ? (
        <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.lg }]}>
          <Button
            label={
              busy
                ? strings.payment.paying
                : declined === null
                  ? strings.payment.pay(formatMoney(order.subtotal_cents))
                  : strings.payment.retry
            }
            onPress={() => void pay()}
            busy={busy}
          />
          <Button
            label={strings.payment.payLater}
            variant="outline"
            onPress={() => router.replace({ pathname: '/order/[id]', params: { id } })}
          />
        </View>
      ) : null}
    </Screen>
  );
}

function createStyles(colors: BrandColors) {
  return StyleSheet.create({
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
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

    body: { padding: spacing.lg, gap: spacing.md },
    notice: { color: colors.textMuted, fontSize: typography.body.fontSize },

    simulated: {
      flexDirection: 'row',
      gap: spacing.md,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.accent,
      backgroundColor: colors.surface,
      padding: spacing.lg,
    },
    simulatedBody: { flex: 1, gap: 4 },
    simulatedTitle: { color: colors.text, fontSize: typography.body.fontSize, fontWeight: '800' },
    simulatedText: {
      color: colors.textMuted,
      fontSize: typography.caption.fontSize,
      lineHeight: 18,
    },

    amountCard: {
      backgroundColor: colors.surface,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.border,
      padding: spacing.lg,
      gap: spacing.xs,
    },
    amountLabel: { color: colors.textMuted, fontSize: typography.label.fontSize },
    amount: { color: colors.text, fontSize: typography.display.fontSize, fontWeight: '800' },
    amountNote: { color: colors.textFaint, fontSize: typography.caption.fontSize, lineHeight: 18 },

    section: { gap: spacing.sm, marginTop: spacing.sm },
    sectionTitle: { color: colors.text, fontSize: typography.section.fontSize, fontWeight: '700' },
    sectionHint: { color: colors.textMuted, fontSize: typography.caption.fontSize },

    card: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      backgroundColor: colors.surface,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.border,
      padding: spacing.lg,
    },
    cardOn: { borderColor: colors.primary, borderWidth: 2 },
    cardLabel: { flex: 1, color: colors.text, fontSize: typography.body.fontSize },

    unrecorded: {
      gap: spacing.sm,
      borderRadius: radius.lg,
      borderWidth: 2,
      borderColor: colors.accent,
      backgroundColor: colors.surface,
      padding: spacing.lg,
    },
    unrecordedTitle: { color: colors.text, fontSize: typography.body.fontSize, fontWeight: '800' },
    orphaned: {
      gap: spacing.sm,
      borderRadius: radius.lg,
      borderWidth: 2,
      borderColor: colors.danger,
      backgroundColor: colors.surface,
      padding: spacing.lg,
    },
    orphanedTitle: { color: colors.danger, fontSize: typography.body.fontSize, fontWeight: '800' },
    unrecordedText: {
      color: colors.textMuted,
      fontSize: typography.caption.fontSize,
      lineHeight: 18,
    },

    failure: {
      flexDirection: 'row',
      gap: spacing.sm,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.danger,
      backgroundColor: colors.surface,
      padding: spacing.md,
    },
    failureBody: { flex: 1, gap: 2 },
    failureTitle: { color: colors.danger, fontSize: typography.label.fontSize, fontWeight: '700' },
    failureText: { color: colors.textMuted, fontSize: typography.caption.fontSize, lineHeight: 18 },

    attempt: { color: colors.textMuted, fontSize: typography.caption.fontSize },

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
