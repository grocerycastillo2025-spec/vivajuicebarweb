/**
 * Checkout: elegir hora de recogida y mandar el pedido.
 *
 * REGLAS QUE SE VEN AQUI
 *  - El pedido nace en `payment_pending` y de aqui se va a la pantalla de
 *    pago. Nada dice "confirmado" hasta que el cobro se registra.
 *  - Solo se ensena SUBTOTAL. Impuestos y total los calcula Clover.
 *  - Hay `idempotency_key` desde ya, aunque el pago sea simulado: es lo
 *    que impide que un reintento cree un segundo pedido (R10).
 *  - La hora es una ESTIMACION. No se promete que estara listo.
 *  - Si la sucursal cobra RECARGO POR TARJETA, aqui se dice cuanto es,
 *    con su cifra. Nueva Jersey (P.L. 2023, c.146) exige el aviso en la
 *    pantalla de checkout y exige que lleve el IMPORTE: decir solo que
 *    existe un recargo es el ejemplo de incumplimiento que da la FAQ de
 *    la NJ Division of Consumer Affairs. Sale dos veces a proposito, y
 *    esta explicado abajo, donde se pinta.
 *
 * La creacion pasa por el RPC `create_pickup_order`, no por un insert: el
 * cliente no tiene permiso de escritura sobre `orders`.
 */

import { Ionicons } from '@expo/vector-icons';
import * as Crypto from 'expo-crypto';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import {
  createPickupOrder,
  fetchSlotOccupancy,
  parseCreateOrderError,
  placeCounterOrder,
} from '../src/api/orders';
import { fetchItemTax, fetchPickupSetup, fetchStore, type ItemTax } from '../src/api/store';
import { AuthForm } from '../src/components/AuthForm';
import { DataState } from '../src/components/DataState';
import { Screen, useScreenInsets } from '../src/components/Screen';
import { SurchargeNotice } from '../src/components/SurchargeNotice';
import { Button } from '../src/components/ui';
import type { BrandColors } from '../src/domain/branding';
import { cartItemCount, cartSubtotalCents, lineTotalCents } from '../src/domain/cart';
import { formatMoney } from '../src/domain/money';
import { makeIdempotencyKey } from '../src/domain/order';
import { connectedProviders } from '../src/api/online-payments';
import type { StoreRow } from '../src/api/types';
import { computeTotals, formatRate, surchargeRateFor } from '../src/domain/totals';
import { customerMethods, isOnlineProvider, type CustomerMethod, type OnlineProvider } from '../src/domain/payment-options';
import {
  buildPickupDays,
  canOrderAsap,
  daysWithSlots,
  firstAvailableSlot,
  validateChosenSlot,
  type PickupConfig,
  type PickupDay,
  type PickupSlot,
} from '../src/domain/pickup';
import { useAsync } from '../src/hooks/use-async';
import { useSurcharge } from '../src/hooks/use-surcharge';
import { useColors } from '../src/state/branding-context';
import { useCart } from '../src/state/cart-context';
import { useSession } from '../src/state/session-context';
import { useStores } from '../src/state/store-context';
import { strings } from '../src/strings';
import { radius, spacing, type as typography } from '../src/theme';

interface Setup {
  readonly days: readonly PickupDay[];
  readonly config: PickupConfig | null;
}

/** Traduce el error del RPC a algo que el cliente entienda. */
function failureMessage(message: string): string {
  const { failure, subject } = parseCreateOrderError(message);
  switch (failure) {
    case 'slot_full':
      return strings.checkout.slotTaken;
    case 'store_closed_at_pickup':
      return strings.checkout.closedBody;
    case 'pickup_too_soon':
    case 'pickup_too_far':
      return strings.checkout.slotTaken;
    case 'item_unavailable':
    case 'modifier_unavailable':
      return subject === null
        ? strings.checkout.cartChanged
        : `${subject}: ${strings.item.unavailableNow}`;
    case 'item_not_found':
    case 'modifier_not_for_item':
      return strings.checkout.cartChanged;
    case 'empty_cart':
      return strings.cart.emptyTitle;
    default:
      return message.includes('payment_method_not_available') ? strings.payments.unavailable : message;
  }
}

/** Íconos de cada forma de pago: un billete, una tarjeta, el teléfono… */
const PAY_ICONS: Record<CustomerMethod, keyof typeof Ionicons.glyphMap> = {
  cash: 'cash-outline',
  card_counter: 'card-outline',
  zelle: 'phone-portrait-outline',
  stripe: 'lock-closed-outline',
  paypal: 'logo-paypal',
};

export default function CheckoutScreen(): ReactNode {
  const router = useRouter();
  const colors = useColors();
  const insets = useScreenInsets();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const { user, loading: sessionLoading } = useSession();
  const { selectedStore, selectedStoreId } = useStores();
  const { cart, isEmpty, clear } = useCart();
  const surcharge = useSurcharge();

  const [selected, setSelected] = useState<PickupSlot | null>(null);
  const [useAsap, setUseAsap] = useState(true);
  const [dayIndex, setDayIndex] = useState(0);
  const [note, setNote] = useState('');
  const [placing, setPlacing] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  /**
   * La clave de idempotencia se genera UNA vez por intento y sobrevive a
   * los reintentos: si el primer envio se pierde por red, el segundo
   * devuelve el mismo pedido en vez de crear otro.
   */
  const idempotencyKey = useRef<string>(
    makeIdempotencyKey(Crypto.randomUUID().replaceAll('-', '')),
  );

  const load = useCallback(async (): Promise<Setup> => {
    if (selectedStoreId === null || selectedStore === null) return { days: [], config: null };

    const setup = await fetchPickupSetup(selectedStoreId);
    if (setup.config === null) return { days: [], config: null };

    const now = new Date();
    const horizon = new Date(now.getTime() + (setup.config.max_days_ahead + 1) * 86400000);
    const occupancy = await fetchSlotOccupancy(selectedStoreId, now, horizon);

    return {
      config: setup.config,
      days: buildPickupDays({
        hours: setup.hours,
        closures: setup.closures,
        config: setup.config,
        timeZone: selectedStore.timezone,
        occupancy,
        now,
      }),
    };
  }, [selectedStore, selectedStoreId]);

  const { data, error, loading, reload } = useAsync(load, [selectedStoreId, user?.id]);

  const openDays = useMemo(() => daysWithSlots(data?.days ?? []), [data]);
  const asapAvailable = useMemo(
    () => (data?.config === null || data === null ? false : canOrderAsap(data.days, data.config)),
    [data],
  );
  const asapSlot = useMemo(() => firstAvailableSlot(data?.days ?? []), [data]);

  // Al llegar las franjas se preselecciona la primera libre.
  useEffect(() => {
    if (selected === null && asapSlot !== null) setSelected(asapSlot);
  }, [asapSlot, selected]);

  const effectiveSlot = useAsap && asapAvailable ? asapSlot : selected;

  // Formas de pago que el dueño tiene prendidas y listas (0024, 0029).
  // Stripe y PayPal solo con la cuenta conectada, que se lee aparte.
  // Se leen al entrar (y no de la sucursal guardada al abrir la app): si el
  // dueño acaba de prender una forma de pago, el cliente la ve ya.
  const [connected, setConnected] = useState<ReadonlySet<OnlineProvider>>(new Set());
  const [freshStore, setFreshStore] = useState<StoreRow | null>(null);
  useEffect(() => {
    if (selectedStoreId === null) return;
    let alive = true;
    void connectedProviders(selectedStoreId).then((value) => alive && setConnected(value));
    void fetchStore(selectedStoreId)
      .then((info) => alive && setFreshStore(info.store))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [selectedStoreId]);
  const paymentStore = freshStore ?? selectedStore;

  // Qué productos del carrito cobran impuesto (0030), para el estimado.
  const cartIds = cart.lines.map((line) => line.cloverItemId).join('|');
  const [itemTax, setItemTax] = useState<ReadonlyMap<string, ItemTax>>(new Map());
  useEffect(() => {
    if (selectedStoreId === null || cartIds === '') return;
    let alive = true;
    void fetchItemTax(selectedStoreId, cartIds.split('|')).then((value) => alive && setItemTax(value));
    return () => {
      alive = false;
    };
  }, [selectedStoreId, cartIds]);
  const methods = useMemo(
    () =>
      customerMethods(
        paymentStore === null
          ? null
          : {
              payment_options: paymentStore.payment_options ?? null,
              zelle_recipient: paymentStore.zelle_recipient ?? null,
              connected,
            },
      ),
    [paymentStore, connected],
  );
  const [payWith, setPayWith] = useState<CustomerMethod | null>(null);
  const chosenPayWith = payWith !== null && methods.includes(payWith) ? payWith : (methods[0] ?? null);

  // Una sola cantidad a pagar: subtotal + impuesto + recargo de la forma de
  // pago elegida. Mismas reglas que la base (domain/totals.ts); lo que se
  // cobra lo calcula la base al crear el pedido.
  const totals = useMemo(
    () =>
      computeTotals({
        lines: cart.lines.map((line) => {
          const tax = itemTax.get(line.cloverItemId);
          return {
            lineTotalCents: lineTotalCents(line),
            taxable: tax?.taxable ?? true,
            taxRateOverride: tax?.taxRateOverride ?? null,
          };
        }),
        storeTaxRate: paymentStore?.tax_rate ?? 0,
        surchargeRate: surchargeRateFor(paymentStore?.payment_surcharges, chosenPayWith),
      }),
    [cart.lines, itemTax, paymentStore, chosenPayWith],
  );
  const surchargeRate = surchargeRateFor(paymentStore?.payment_surcharges, chosenPayWith);

  const place = useCallback(async () => {
    if (effectiveSlot === null || selectedStoreId === null || data?.config === undefined) return;
    if (data?.config === null) return;

    // Ultima comprobacion antes del viaje. El servidor lo valida otra vez.
    const rejection = validateChosenSlot(
      effectiveSlot.startsAt,
      data.days,
      new Date(),
      data.config,
    );
    if (rejection !== null) {
      setFailure(strings.checkout.slotTaken);
      reload();
      return;
    }

    setPlacing(true);
    setFailure(null);

    // Sucursal sin cobro en linea (0020): el pedido se paga en el
    // mostrador y nace confirmado, asi que va directo al seguimiento.
    const payAtCounter = selectedStore?.payments_mode === 'counter';

    try {
      const create = payAtCounter
        ? (input: Parameters<typeof placeCounterOrder>[0]) =>
            placeCounterOrder(input, selectedStore?.payment_options === undefined ? null : chosenPayWith)
        : createPickupOrder;
      const created = await create({
        storeId: selectedStoreId,
        idempotencyKey: idempotencyKey.current,
        pickupAt: effectiveSlot.startsAt,
        isAsap: useAsap && asapAvailable,
        customerNote: note,
        // Solo ids y cantidades: los precios los pone la base.
        items: cart.lines.map((line) => ({
          clover_item_id: line.cloverItemId,
          quantity: line.quantity,
          note: line.note === '' ? null : line.note,
          modifiers: line.modifiers.map((modifier) => modifier.cloverModifierId),
        })),
      });

      clear();
      if (payAtCounter) {
        // Stripe y PayPal: al pedido con `pagar=1`, que abre el pago solo.
        const params: Record<string, string> = { id: created.order_id };
        if (isOnlineProvider(chosenPayWith)) params['pagar'] = '1';
        router.replace({ pathname: '/order/[id]', params });
        return;
      }
      // Al pago, no al seguimiento: el pedido nace en `payment_pending` y
      // hasta que haya cobro no hay nada que seguir.
      router.replace({ pathname: '/pay/[id]', params: { id: created.order_id } });
    } catch (cause) {
      setFailure(failureMessage(cause instanceof Error ? cause.message : String(cause)));
      // Las franjas pueden haber cambiado: se recargan para que la
      // siguiente eleccion parta de datos frescos.
      reload();
    } finally {
      setPlacing(false);
    }
  }, [
    asapAvailable,
    cart.lines,
    clear,
    data,
    effectiveSlot,
    note,
    reload,
    router,
    chosenPayWith,
    selectedStore,
    selectedStoreId,
    useAsap,
  ]);

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
      <Text style={styles.title}>{strings.checkout.title}</Text>
    </View>
  );

  if (isEmpty) {
    return (
      <Screen scroll={false}>
        {header}
        <DataState loading={false} error={null} empty emptyTitle={strings.cart.emptyTitle}>
          {null}
        </DataState>
      </Screen>
    );
  }

  // Puerta de identificacion: el pedido se guarda en la cuenta.
  if (!sessionLoading && user === null) {
    return (
      <Screen scroll={false}>
        {header}
        <ScrollView contentContainerStyle={styles.body}>
          <AuthForm title={strings.auth.signInToOrder} body={strings.auth.signInToOrderBody} />
        </ScrollView>
      </Screen>
    );
  }

  if (sessionLoading || loading || error !== null || openDays.length === 0) {
    return (
      <Screen scroll={false}>
        {header}
        <DataState
          loading={sessionLoading || loading}
          error={error}
          empty={openDays.length === 0}
          onRetry={reload}
          emptyTitle={strings.checkout.noSlotsTitle}
          emptyBody={strings.checkout.noSlotsBody}
        >
          {null}
        </DataState>
      </Screen>
    );
  }

  const activeDay = openDays[Math.min(dayIndex, openDays.length - 1)];
  const subtotal = cartSubtotalCents(cart);

  return (
    <Screen scroll={false}>
      {header}

      <ScrollView contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + 190 }]}>
        {asapAvailable && asapSlot !== null ? (
          <Pressable
            accessibilityRole="radio"
            accessibilityState={{ checked: useAsap }}
            onPress={() => setUseAsap(true)}
            style={({ pressed }) => [
              styles.asap,
              useAsap && styles.asapOn,
              pressed && styles.pressed,
            ]}
          >
            <Ionicons
              name={useAsap ? 'radio-button-on' : 'radio-button-off'}
              size={22}
              color={useAsap ? colors.primary : colors.textFaint}
            />
            <View style={styles.asapBody}>
              <Text style={styles.asapTitle}>{strings.checkout.asap}</Text>
              <Text style={styles.asapHint}>{strings.checkout.asapReady(asapSlot.label)}</Text>
            </View>
          </Pressable>
        ) : null}

        <Pressable
          accessibilityRole="radio"
          accessibilityState={{ checked: !useAsap }}
          onPress={() => setUseAsap(false)}
          style={({ pressed }) => [
            styles.asap,
            !useAsap && styles.asapOn,
            pressed && styles.pressed,
          ]}
        >
          <Ionicons
            name={!useAsap ? 'radio-button-on' : 'radio-button-off'}
            size={22}
            color={!useAsap ? colors.primary : colors.textFaint}
          />
          <View style={styles.asapBody}>
            <Text style={styles.asapTitle}>{strings.checkout.pickTime}</Text>
          </View>
        </Pressable>

        {!useAsap ? (
          <>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.dayTabs}
            >
              {openDays.map((day, index) => {
                const active = index === Math.min(dayIndex, openDays.length - 1);
                const label =
                  day.offsetDays === 0
                    ? strings.checkout.today
                    : day.offsetDays === 1
                      ? strings.checkout.tomorrow
                      : day.day;
                return (
                  <Pressable
                    key={day.day}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: active }}
                    onPress={() => setDayIndex(index)}
                    style={({ pressed }) => [
                      styles.dayTab,
                      active && styles.dayTabOn,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Text style={[styles.dayTabText, active && styles.dayTabTextOn]}>{label}</Text>
                  </Pressable>
                );
              })}
            </ScrollView>

            <View style={styles.slots}>
              {(activeDay?.slots ?? []).map((slot) => {
                const active = selected?.startsAt === slot.startsAt;
                return (
                  <Pressable
                    key={slot.startsAt}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active, disabled: slot.isFull }}
                    disabled={slot.isFull}
                    onPress={() => setSelected(slot)}
                    style={({ pressed }) => [
                      styles.slot,
                      active && styles.slotOn,
                      slot.isFull && styles.slotFull,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Text style={[styles.slotText, active && styles.slotTextOn]}>{slot.label}</Text>
                    {slot.isFull ? (
                      <Text style={styles.slotFullText}>{strings.checkout.full}</Text>
                    ) : null}
                  </Pressable>
                );
              })}
            </View>
          </>
        ) : null}

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{strings.checkout.noteForStore}</Text>
          <TextInput
            value={note}
            onChangeText={setNote}
            placeholder={strings.checkout.noteplaceholder}
            placeholderTextColor={colors.textFaint}
            style={styles.input}
            multiline
            maxLength={240}
          />
        </View>

        <View style={styles.summary}>
          <Text style={styles.sectionTitle}>{strings.checkout.summary}</Text>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>
              {strings.cart.itemCount(cartItemCount(cart))} · {strings.checkout.subtotalLine}
            </Text>
            <Text style={styles.breakdownValue}>{formatMoney(subtotal)}</Text>
          </View>

          {/*
            El aviso del recargo va PEGADO al dinero, antes de la nota de
            impuestos: las dos cosas dicen "esto no es lo que se cobra",
            y separarlas dejaria la de verdad importante suelta al final.

            No se ensena una estimacion en dolares. El recargo se aplica
            sobre el TOTAL, y el total lleva impuestos que esta app no
            calcula a proposito; una estimacion sobre el subtotal saldria
            siempre por debajo de lo cobrado, que es justo el error que la
            ley castiga. El porcentaje ya es divulgacion valida.
          */}
          <SurchargeNotice disclosure={surcharge} />


          {selectedStore?.payments_mode === 'counter' ? (
            <View style={styles.payBlock}>
              <Text style={styles.counterNoteTitle}>{strings.payments.choose}</Text>
              {methods.length === 0 ? (
                <Text style={styles.summaryNote}>{strings.payments.none}</Text>
              ) : null}
              {methods.map((method) => {
                const on = chosenPayWith === method;
                return (
                  <Pressable
                    key={method}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: on }}
                    onPress={() => setPayWith(method)}
                    style={[styles.counterNote, on && styles.payOn]}
                  >
                    <Ionicons
                      name={PAY_ICONS[method]}
                      size={22}
                      color={on ? colors.primary : colors.textMuted}
                    />
                    <View style={styles.counterNoteBody}>
                      <Text style={styles.counterNoteTitle}>
                        {strings.payments.methods[method]}
                        {surchargeRateFor(paymentStore?.payment_surcharges, method) > 0 ? (
                          <Text style={styles.surchargeTag}>
                            {`  ${strings.checkout.surchargeTag(formatRate(surchargeRateFor(paymentStore?.payment_surcharges, method)))}`}
                          </Text>
                        ) : null}
                      </Text>
                      <Text style={styles.summaryNote}>{strings.payments.hints[method]}</Text>
                    </View>
                    <Ionicons
                      name={on ? 'radio-button-on' : 'radio-button-off'}
                      size={22}
                      color={on ? colors.primary : colors.border}
                    />
                  </Pressable>
                );
              })}
            </View>
          ) : null}

          <View style={styles.breakdown} testID="total-a-pagar">
            {totals.taxCents > 0 || totals.surchargeCents > 0 ? (
              <>
                <View style={styles.breakdownRow}>
                  <Text style={styles.breakdownLabel}>{strings.checkout.subtotalLine}</Text>
                  <Text style={styles.breakdownValue}>{formatMoney(totals.subtotalCents)}</Text>
                </View>
                {totals.taxCents > 0 ? (
                  <View style={styles.breakdownRow}>
                    <Text style={styles.breakdownLabel}>{strings.checkout.taxLine}</Text>
                    <Text style={styles.breakdownValue}>{formatMoney(totals.taxCents)}</Text>
                  </View>
                ) : null}
                {totals.surchargeCents > 0 && chosenPayWith !== null ? (
                  <View style={styles.breakdownRow}>
                    <Text style={styles.breakdownLabel}>
                      {strings.checkout.surchargeLine(strings.payments.methods[chosenPayWith] ?? chosenPayWith, formatRate(surchargeRate))}
                    </Text>
                    <Text style={styles.breakdownValue}>{formatMoney(totals.surchargeCents)}</Text>
                  </View>
                ) : null}
              </>
            ) : null}
            <View style={[styles.breakdownRow, styles.totalRow]}>
              <Text style={styles.totalLabel}>{strings.checkout.totalToPay}</Text>
              <Text style={styles.totalValue}>{formatMoney(totals.totalCents)}</Text>
            </View>
            <Text style={styles.summaryNote}>{strings.checkout.taxNote}</Text>
          </View>
        </View>

        {failure !== null ? (
          <View style={styles.failure}>
            <Ionicons name="alert-circle" size={20} color={colors.danger} />
            <Text style={styles.failureText}>{failure}</Text>
          </View>
        ) : null}
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.lg }]}>
        {/*
          Segunda aparicion, y no es un descuido. El boton vive en un pie
          FIJO: se puede pulsar "Place order" sin haber bajado nunca hasta
          el resumen, y entonces el aviso de arriba no se habria visto.
          Un aviso que el cliente puede no llegar a ver no es "claro y
          visible". Aqui va en su forma corta, que tambien lleva la cifra.
        */}
        <SurchargeNotice disclosure={surcharge} variant="line" style={styles.footerNotice} />
        {effectiveSlot !== null ? (
          <Text style={styles.footerSlot}>{strings.order.estimatedFor(effectiveSlot.label)}</Text>
        ) : null}
        <Button
          label={placing ? strings.checkout.placing : strings.checkout.placeOrderTotal(formatMoney(totals.totalCents))}
          onPress={() => void place()}
          busy={placing}
          disabled={effectiveSlot === null}
        />
      </View>
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

    asap: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      backgroundColor: colors.surface,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.border,
      padding: spacing.lg,
    },
    asapOn: { borderColor: colors.primary, borderWidth: 2 },
    asapBody: { flex: 1, gap: 2 },
    asapTitle: { color: colors.text, fontSize: typography.body.fontSize, fontWeight: '700' },
    asapHint: { color: colors.textMuted, fontSize: typography.caption.fontSize },

    dayTabs: { gap: spacing.sm, paddingVertical: spacing.xs },
    dayTab: {
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
    },
    dayTabOn: { backgroundColor: colors.primary, borderColor: colors.primary },
    dayTabText: { color: colors.textMuted, fontSize: typography.label.fontSize, fontWeight: '600' },
    dayTabTextOn: { color: colors.onPrimary },

    slots: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    slot: {
      minWidth: 92,
      alignItems: 'center',
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.md,
    },
    slotOn: { backgroundColor: colors.primary, borderColor: colors.primary },
    slotFull: { opacity: 0.4 },
    slotText: { color: colors.text, fontSize: typography.label.fontSize, fontWeight: '600' },
    slotTextOn: { color: colors.onPrimary },
    slotFullText: { color: colors.danger, fontSize: 10, fontWeight: '700', marginTop: 2 },

    section: { gap: spacing.sm, marginTop: spacing.sm },
    sectionTitle: { color: colors.text, fontSize: typography.section.fontSize, fontWeight: '700' },
    input: {
      backgroundColor: colors.surface,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      padding: spacing.md,
      minHeight: 64,
      color: colors.text,
      fontSize: typography.body.fontSize,
      textAlignVertical: 'top',
    },

    summary: {
      backgroundColor: colors.surface,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.border,
      padding: spacing.lg,
      gap: spacing.sm,
      marginTop: spacing.sm,
    },
    summaryRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    breakdown: { gap: spacing.xs, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.md },
    breakdownRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md },
    breakdownLabel: { flex: 1, color: colors.textMuted, fontSize: typography.label.fontSize },
    breakdownValue: { color: colors.text, fontSize: typography.label.fontSize, fontWeight: '700' },
    totalRow: { marginTop: spacing.xs },
    totalLabel: { color: colors.text, fontSize: typography.body.fontSize, fontWeight: '800' },
    totalValue: { color: colors.text, fontSize: typography.title.fontSize, fontWeight: '800' },
    surchargeTag: { color: colors.textMuted, fontSize: typography.caption.fontSize, fontWeight: '700' },
    summaryLabel: { color: colors.textMuted, fontSize: typography.body.fontSize },
    summaryValue: { color: colors.text, fontSize: typography.title.fontSize, fontWeight: '800' },
    summaryNote: { color: colors.textFaint, fontSize: typography.caption.fontSize, lineHeight: 18 },
    counterNote: {
      flexDirection: 'row',
      gap: spacing.sm,
      alignItems: 'center',
      padding: spacing.md,
      borderRadius: radius.md,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
    },
    counterNoteBody: { flex: 1, minWidth: 0, gap: 2 },
    payBlock: { gap: spacing.sm, marginTop: spacing.sm },
    payOn: { borderColor: colors.primary, borderWidth: 2 },
    counterNoteTitle: { color: colors.text, fontSize: typography.body.fontSize, fontWeight: '800' },

    failure: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.danger,
      backgroundColor: colors.surface,
      padding: spacing.md,
    },
    failureText: { flex: 1, color: colors.danger, fontSize: typography.label.fontSize },

    footer: {
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.md,
      borderTopWidth: 1,
      borderTopColor: colors.border,
      backgroundColor: colors.background,
      gap: spacing.sm,
    },
    footerNotice: { justifyContent: 'center' },
    footerSlot: {
      color: colors.textMuted,
      fontSize: typography.label.fontSize,
      textAlign: 'center',
    },
  });
}
