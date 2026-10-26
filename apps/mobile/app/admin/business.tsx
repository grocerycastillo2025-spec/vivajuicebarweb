/**
 * Panel · Negocio: datos de la sucursal, horario y marca.
 *
 * El horario es el que manda en el checkout: la base solo acepta pedidos
 * para horas dentro de el (`app.store_accepts_pickup_at`). Por eso se
 * valida entera la semana antes de guardar.
 */

import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import {
  fetchAdminHours,
  fetchAdminSettings,
  fetchConnectedProviders,
  updatePaymentOptions,
  updateTaxSettings,
  addTeamMember,
  fetchTeam,
  removeTeamMember,
  type MemberRole,
  type TeamMember,
  replaceHours,
  updateSettings,
  updateStore,
  uploadImage,
} from '../../src/api/admin';
import type { AppSettingsRow, StoreHoursRow, StoreRow } from '../../src/api/types';
import { useAdmin } from '../../src/admin/admin-context';
import { canPickImages, pickLogo } from '../../src/admin/pick-image';
import { appInstallUrl, downloadQrPng, printAppPoster, qrDataUrl } from '../../src/admin/qr';
import { MapPicker } from '../../src/admin/MapPicker';
import { GEOCODE_URL, formatLatLng, geocodeQuery, isLatLng, parseGeocode, roundLatLng, type LatLng } from '../../src/domain/geo';
import { storeMapsUrl } from '../../src/domain/maps';
import { adminStrings, adminStrings as t } from '../../src/admin/strings';
import { AdminShell, Card, Field, Notice, Toggle, createAdminStyles } from '../../src/admin/ui';
import { DataState } from '../../src/components/DataState';
import { Button } from '../../src/components/ui';
import {
  clockFromDb,
  normalizeHex,
  parseClockInput,
  validateWeek,
  type DayHours,
} from '../../src/domain/admin';
import type { BrandColors } from '../../src/domain/branding';
import { formatRate, parseRateInput } from '../../src/domain/totals';
import {
  blocksSaving,
  CUSTOMER_METHODS,
  formatZelleRecipient,
  normalizeZelleRecipient,
  ONLINE_PROVIDERS,
  paymentSetupProblems,
  type OnlineProvider,
} from '../../src/domain/payment-options';
import { checkProvider } from '../../src/api/online-payments';
import { useAsync } from '../../src/hooks/use-async';
import { panelAppStrings as strings } from '../../src/admin/language';
import { useBranding, useColors } from '../../src/state/branding-context';
import { useSession } from '../../src/state/session-context';
import { radius, spacing, type as typography } from '../../src/theme';

export default function AdminBusinessScreen(): ReactNode {
  const { store, restaurantId, isOwner } = useAdmin();

  const load = useCallback(async () => {
    const [hours, settings, connected] = await Promise.all([
      fetchAdminHours(store.id),
      fetchAdminSettings(restaurantId),
      fetchConnectedProviders(store.id),
    ]);
    return { hours, settings, connected };
  }, [store.id, restaurantId]);

  const { data, error, loading, reload } = useAsync(load, [store.id]);

  if (!isOwner) {
    return (
      <AdminShell>
        <Notice tone="error" text={t.ownerOnly} />
      </AdminShell>
    );
  }

  if (data === null) {
    return (
      <AdminShell scroll={false}>
        <DataState loading={loading} error={error} empty={false} onRetry={reload} emptyTitle="">
          {null}
        </DataState>
      </AdminShell>
    );
  }

  return (
    <AdminShell>
      <View style={layoutStyles.layout}>
        <View style={layoutStyles.column}>
          <AppQrCard />
          <StoreCard store={store} />
          <HoursCard storeId={store.id} hours={data.hours} />
        </View>
        <View style={layoutStyles.column}>
          <TeamCard />
          <TaxesCard store={store} />
          <PaymentsCard store={store} connected={data.connected} />
          {data.settings !== null ? <BrandCard settings={data.settings} restaurantId={restaurantId} /> : null}
        </View>
      </View>
    </AdminShell>
  );
}

const layoutStyles = StyleSheet.create({
  layout: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.lg, alignItems: 'flex-start' },
  column: { flexGrow: 1, flexBasis: 340, minWidth: 0, gap: spacing.lg },
});

function useSaver(): {
  saving: boolean;
  notice: { tone: 'ok' | 'error'; text: string } | null;
  run: (work: () => Promise<void>) => Promise<void>;
} {
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const run = useCallback(async (work: () => Promise<void>) => {
    setSaving(true);
    setNotice(null);
    try {
      await work();
      setNotice({ tone: 'ok', text: t.saved });
    } catch (cause) {
      setNotice({
        tone: 'error',
        text: `${t.saveFailed}: ${cause instanceof Error ? cause.message : String(cause)}`,
      });
    } finally {
      setSaving(false);
    }
  }, []);
  return { saving, notice, run };
}

function AppQrCard(): ReactNode {
  const { displayName, logoUrl, colors } = useBranding();
  const [copied, setCopied] = useState(false);
  const url = appInstallUrl();
  const logo = typeof logoUrl === 'string' ? logoUrl : null;
  return (
    <Card title={t.business.appQrTitle}>
      <Text style={[qrStyles.hint, { color: colors.textMuted }]}>{t.business.appQrHint}</Text>
      <View style={qrStyles.row}>
        <View style={qrStyles.frame}>
          <Image source={{ uri: qrDataUrl(url, 6) }} style={qrStyles.qr} contentFit="contain" accessibilityLabel={t.business.appQrTitle} />
        </View>
        <View style={qrStyles.actions}>
          <Button
            label={t.business.printPoster}
            onPress={() => printAppPoster({ url, brand: displayName, logoUrl: logo, color: colors.primary })}
            testID="imprimir-cartel"
          />
          <Button label={t.business.downloadQr} variant="outline" onPress={() => downloadQrPng(url, 'qr-app.png')} />
          <Button
            label={copied ? t.business.copied : t.business.copyLink}
            variant="outline"
            onPress={() => {
              void globalThis.navigator?.clipboard?.writeText(url).then(() => setCopied(true)).catch(() => undefined);
            }}
          />
        </View>
      </View>
      <Text style={[qrStyles.url, { color: colors.textFaint }]} selectable>
        {url}
      </Text>
    </Card>
  );
}

const mapStyles = StyleSheet.create({
  title: { fontSize: typography.body.fontSize, fontWeight: '800', marginTop: spacing.sm },
  hint: { fontSize: typography.label.fontSize, lineHeight: 19 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  link: { fontSize: typography.label.fontSize, fontWeight: '700', textDecorationLine: 'underline' },
});

const qrStyles = StyleSheet.create({
  hint: { fontSize: typography.label.fontSize, lineHeight: 19 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.lg, alignItems: 'center' },
  frame: { backgroundColor: '#FFFFFF', padding: spacing.sm, borderRadius: radius.md, borderWidth: 1, borderColor: 'rgba(0,0,0,0.1)' },
  qr: { width: 160, height: 160 },
  actions: { flex: 1, minWidth: 180, gap: spacing.sm },
  url: { fontSize: typography.caption.fontSize },
});

function StoreCard({ store }: { readonly store: StoreRow }): ReactNode {
  const { reloadStore } = useAdmin();
  const [name, setName] = useState(store.name);
  const [phone, setPhone] = useState(store.phone ?? '');
  const [address, setAddress] = useState(store.address_line1 ?? '');
  const [city, setCity] = useState(store.city ?? '');
  const [state, setState] = useState(store.state ?? '');
  const [postal, setPostal] = useState(store.postal_code ?? '');
  const [pickup, setPickup] = useState(store.pickup_enabled);
  const [point, setPoint] = useState<LatLng | null>(
    isLatLng(store.latitude, store.longitude) ? { lat: store.latitude as number, lng: store.longitude as number } : null,
  );
  const [mapNotice, setMapNotice] = useState<string | null>(null);
  const [finding, setFinding] = useState(false);
  const { saving, notice, run } = useSaver();
  const colors = useColors();
  const pointChanged = point !== null && (point.lat !== store.latitude || point.lng !== store.longitude);

  const findAddress = async (): Promise<void> => {
    const q = geocodeQuery({ address, city, state, postal });
    if (q === null) {
      setMapNotice(t.business.mapNotFound);
      return;
    }
    setFinding(true);
    setMapNotice(null);
    try {
      const res = await fetch(`${GEOCODE_URL}${encodeURIComponent(q)}`, { headers: { Accept: 'application/json' } });
      const found = parseGeocode(await res.json());
      if (found === null) setMapNotice(t.business.mapNotFound);
      else setPoint(found);
    } catch {
      setMapNotice(t.business.mapNotFound);
    } finally {
      setFinding(false);
    }
  };

  const useMine = (): void => {
    setMapNotice(null);
    const geo = globalThis.navigator?.geolocation;
    if (geo === undefined) {
      setMapNotice(t.business.mapNoGps);
      return;
    }
    geo.getCurrentPosition(
      (pos) => setPoint(roundLatLng({ lat: pos.coords.latitude, lng: pos.coords.longitude })),
      () => setMapNotice(t.business.mapNoGps),
      { enableHighAccuracy: true, timeout: 15000 },
    );
  };

  const blank = (value: string): string | null => (value.trim() === '' ? null : value.trim());

  return (
    <Card title={t.business.store}>
      <Field label={t.business.name} value={name} onChangeText={setName} />
      <Field label={t.business.phone} value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
      <Field label={t.business.address} value={address} onChangeText={setAddress} />
      <Field label={t.business.city} value={city} onChangeText={setCity} />
      <Field label={t.business.state} value={state} onChangeText={setState} />
      <Field label={t.business.postalCode} value={postal} onChangeText={setPostal} keyboardType="number-pad" />
      <Text style={[mapStyles.title, { color: colors.text }]}>{t.business.mapTitle}</Text>
      <Text style={[mapStyles.hint, { color: colors.textMuted }]}>{t.business.mapHint}</Text>
      <MapPicker
        value={point}
        fallback={point ?? { lat: 40.2601, lng: -74.2738 }}
        onChange={setPoint}
        failedText={t.business.mapFailed}
      />
      <View style={mapStyles.row}>
        <Button label={t.business.mapFind} variant="outline" busy={finding} onPress={() => void findAddress()} testID="buscar-direccion" />
        <Button label={t.business.mapMine} variant="outline" onPress={useMine} />
      </View>
      <Text style={[mapStyles.hint, { color: colors.textMuted }]}>
        {point === null ? t.business.mapUnset : t.business.mapSet(formatLatLng(point))}
        {point !== null && pointChanged ? ` · ${t.business.mapUnsaved}` : ''}
      </Text>
      {point !== null ? (
        <Text
          accessibilityRole="link"
          style={[mapStyles.link, { color: colors.primary }]}
          onPress={() => {
            const url = storeMapsUrl({ name, latitude: point.lat, longitude: point.lng });
            if (url !== null) globalThis.open?.(url, '_blank');
          }}
        >
          {t.business.mapCheck}
        </Text>
      ) : null}
      {mapNotice !== null ? <Notice tone="error" text={mapNotice} /> : null}
      <Toggle label={t.business.pickup} hint={t.business.pickupHint} value={pickup} onValueChange={setPickup} />
      {notice !== null ? <Notice tone={notice.tone} text={notice.text} /> : null}
      <Button
        label={saving ? t.saving : t.save}
        busy={saving}
        disabled={name.trim() === ''}
        onPress={() =>
          void run(async () => {
            await updateStore(store.id, {
              name: name.trim(),
              phone: blank(phone),
              address_line1: blank(address),
              city: blank(city),
              state: blank(state),
              postal_code: blank(postal),
              pickup_enabled: pickup,
              ...(point === null ? {} : { latitude: point.lat, longitude: point.lng }),
            });
            reloadStore();
          })
        }
      />
    </Card>
  );
}

function initialWeek(hours: readonly StoreHoursRow[]): DayHours[] {
  return [0, 1, 2, 3, 4, 5, 6].map((weekday) => {
    const row = hours.find((h) => h.weekday === weekday);
    return row === undefined
      ? { weekday, open: false, opensAt: '08:00', closesAt: '20:00' }
      : { weekday, open: true, opensAt: clockFromDb(row.opens_at), closesAt: clockFromDb(row.closes_at) };
  });
}

function HoursCard({
  storeId,
  hours,
}: {
  readonly storeId: string;
  readonly hours: readonly StoreHoursRow[];
}): ReactNode {
  const colors = useColors();
  const styles = useMemo(() => ({ ...createAdminStyles(colors), ...createStyles(colors) }), [colors]);
  const [week, setWeek] = useState<DayHours[]>(() => initialWeek(hours));
  const { saving, notice, run } = useSaver();
  const problems = validateWeek(week);

  const patch = (weekday: number, change: Partial<DayHours>): void =>
    setWeek((current) => current.map((day) => (day.weekday === weekday ? { ...day, ...change } : day)));

  // Lunes primero, como se lee un horario en Mexico.
  const ordered = [1, 2, 3, 4, 5, 6, 0].map((d) => week.find((day) => day.weekday === d)).filter(
    (day): day is DayHours => day !== undefined,
  );

  return (
    <Card title={t.business.hours}>
      <Text style={styles.hint}>{t.business.hoursHint}</Text>
      {ordered.map((day) => {
        const problem = problems.find((p) => p.weekday === day.weekday);
        return (
          <View key={day.weekday} style={styles.dayRow}>
            <View style={styles.dayHead}>
              <Text style={styles.dayName}>{t.business.weekdays[day.weekday]}</Text>
              <Toggle
                label={day.open ? t.business.open : t.business.closed}
                value={day.open}
                onValueChange={(open) => patch(day.weekday, { open })}
              />
            </View>
            {day.open ? (
              <View style={styles.dayTimes}>
                <View style={styles.timeField}>
                  <Field
                    label={t.business.opens}
                    value={day.opensAt}
                    onChangeText={(opensAt) => patch(day.weekday, { opensAt })}
                  />
                </View>
                <View style={styles.timeField}>
                  <Field
                    label={t.business.closes}
                    value={day.closesAt}
                    onChangeText={(closesAt) => patch(day.weekday, { closesAt })}
                  />
                </View>
              </View>
            ) : null}
            {problem !== undefined ? (
              <Text style={styles.error}>
                {problem.reason === 'bad_time' ? t.business.badTime : t.business.closesBeforeOpens}
              </Text>
            ) : null}
          </View>
        );
      })}
      {notice !== null ? <Notice tone={notice.tone} text={notice.text} /> : null}
      <Button
        label={saving ? t.saving : t.save}
        busy={saving}
        disabled={problems.length > 0}
        onPress={() =>
          void run(() =>
            replaceHours(
              storeId,
              week
                .filter((day) => day.open)
                .map((day) => ({
                  weekday: day.weekday,
                  opens_at: parseClockInput(day.opensAt) ?? day.opensAt,
                  closes_at: parseClockInput(day.closesAt) ?? day.closesAt,
                })),
            ),
          )
        }
      />
    </Card>
  );
}

function BrandCard({
  settings,
  restaurantId,
}: {
  readonly settings: AppSettingsRow;
  readonly restaurantId: string;
}): ReactNode {
  const colors = useColors();
  const styles = useMemo(() => ({ ...createAdminStyles(colors), ...createStyles(colors) }), [colors]);
  const branding = useBranding();
  const [displayName, setDisplayName] = useState(settings.app_display_name);
  const [logoUrl, setLogoUrl] = useState<string | null>(settings.logo_url);
  const [primary, setPrimary] = useState(settings.primary_color);
  const [secondary, setSecondary] = useState(settings.secondary_color);
  const [accent, setAccent] = useState(settings.accent_color);
  const [uploading, setUploading] = useState(false);
  const { saving, notice, run } = useSaver();

  const hex = { primary: normalizeHex(primary), secondary: normalizeHex(secondary), accent: normalizeHex(accent) };
  const valid = hex.primary !== null && hex.secondary !== null && hex.accent !== null && displayName.trim() !== '';

  const chooseLogo = async (): Promise<void> => {
    const picked = await pickLogo();
    if (picked === null) return;
    setUploading(true);
    try {
      setLogoUrl(await uploadImage('branding', restaurantId, picked.blob, picked.extension));
    } finally {
      setUploading(false);
    }
  };

  const swatch = (value: string | null): ReactNode => (
    <View style={[styles.swatch, { backgroundColor: value ?? 'transparent' }]} />
  );

  return (
    <Card title={t.business.brand}>
      <Field label={t.business.displayName} value={displayName} onChangeText={setDisplayName} />

      <View style={styles.field}>
        <Text style={styles.label}>{t.business.logo}</Text>
        <View style={styles.logoRow}>
          <View style={[styles.logoBox, { backgroundColor: hex.primary ?? colors.primary }]}>
            {logoUrl !== null ? (
              <Image source={{ uri: logoUrl }} style={styles.logo} contentFit="contain" />
            ) : null}
          </View>
          {canPickImages ? (
            <Button
              label={t.business.chooseLogo}
              variant="outline"
              busy={uploading}
              onPress={() => void chooseLogo()}
            />
          ) : (
            <Text style={styles.hint}>{t.product.photoNativeOnly}</Text>
          )}
        </View>
      </View>

      <Text style={styles.label}>{t.business.colors}</Text>
      {(
        [
          ['primary', t.business.primary, primary, setPrimary],
          ['secondary', t.business.secondary, secondary, setSecondary],
          ['accent', t.business.accent, accent, setAccent],
        ] as const
      ).map(([key, label, value, set]) => (
        <View key={key} style={styles.colorRow}>
          {swatch(hex[key])}
          <View style={styles.grow}>
            <Field
              label={label}
              value={value}
              onChangeText={set}
              autoCapitalize="characters"
              error={hex[key] === null ? t.business.colorInvalid : null}
            />
          </View>
        </View>
      ))}

      <Text style={styles.hint}>{t.business.brandNote}</Text>
      {notice !== null ? <Notice tone={notice.tone} text={notice.text} /> : null}
      <Button
        label={saving ? t.saving : t.save}
        busy={saving}
        disabled={!valid || uploading}
        onPress={() =>
          void run(async () => {
            if (hex.primary === null || hex.secondary === null || hex.accent === null) return;
            await updateSettings(restaurantId, {
              app_display_name: displayName.trim(),
              logo_url: logoUrl,
              primary_color: hex.primary,
              secondary_color: hex.secondary,
              accent_color: hex.accent,
            });
            branding.reload();
          })
        }
      />
    </Card>
  );
}

function createStyles(colors: BrandColors) {
  return StyleSheet.create({
    dayRow: {
      gap: spacing.sm,
      paddingVertical: spacing.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
    },
    dayHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    dayName: { width: 96, color: colors.text, fontWeight: '800', fontSize: typography.body.fontSize },
    dayTimes: { flexDirection: 'row', gap: spacing.md },
    timeField: { flex: 1, minWidth: 0 },
    logoRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, flexWrap: 'wrap' },
    logoBox: {
      width: 120,
      height: 80,
      borderRadius: radius.md,
      alignItems: 'center',
      justifyContent: 'center',
      overflow: 'hidden',
    },
    logo: { width: 108, height: 68 },
    colorRow: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.md },
    swatch: {
      width: 46,
      height: 46,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.border,
    },
    grow: { flex: 1, minWidth: 0 },
    memberRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.md,
      paddingVertical: spacing.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
    },
    memberAvatar: {
      width: 32,
      height: 32,
      borderRadius: 16,
      backgroundColor: colors.primary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    memberName: { color: colors.text, fontWeight: '700', fontSize: typography.body.fontSize },
    memberActions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, marginTop: 4, alignItems: 'center' },
    linkText: { color: colors.primary, fontWeight: '700', fontSize: typography.label.fontSize },
    dangerText: { color: colors.danger, fontWeight: '700', fontSize: typography.label.fontSize },
    addBox: { gap: spacing.sm, backgroundColor: colors.background, padding: spacing.md, borderRadius: radius.md },
    roleRow: { flexDirection: 'row', gap: spacing.sm },
    roleChip: {
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
    },
    roleChipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
    roleChipText: { color: colors.text, fontWeight: '700', fontSize: typography.label.fontSize },
    roleChipTextOn: { color: colors.onPrimary },
    mpCheck: { alignSelf: 'flex-start', minHeight: 40 },
    paySection: {
      gap: spacing.sm,
      paddingTop: spacing.md,
      borderTopWidth: 1,
      borderTopColor: colors.border,
    },
  });
}

/** 0.03 -> "3"; 0 o nada -> "". */
function rateToInput(value: unknown): string {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? formatRate(n).replace('%', '') : '';
}

function TaxesCard({ store }: { readonly store: StoreRow }): ReactNode {
  const colors = useColors();
  const styles = useMemo(() => ({ ...createAdminStyles(colors), ...createStyles(colors) }), [colors]);
  const { reloadStore } = useAdmin();
  const tx = adminStrings.taxes;
  const [rate, setRate] = useState(rateToInput(store.tax_rate));
  const [surcharges, setSurcharges] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const m of CUSTOMER_METHODS) out[m] = rateToInput(store.payment_surcharges?.[m]);
    return out;
  });
  const [invalid, setInvalid] = useState(false);
  const { saving, notice, run } = useSaver();

  const save = (): void => {
    const taxRate = parseRateInput(rate, 0.249);
    const parsed: Record<string, number> = {};
    let bad = taxRate === null;
    for (const m of CUSTOMER_METHODS) {
      const value = parseRateInput(surcharges[m] ?? '', 0.1);
      if (value === null) bad = true;
      else parsed[m] = value;
    }
    setInvalid(bad);
    if (bad || taxRate === null) return;
    void run(async () => {
      await updateTaxSettings(store.id, { taxRate, surcharges: parsed });
      reloadStore();
    });
  };

  return (
    <Card title={tx.title}>
      <Text style={styles.hint}>{tx.hint}</Text>
      <Field
        label={tx.rate}
        value={rate}
        onChangeText={setRate}
        placeholder={tx.ratePlaceholder}
        keyboardType="decimal-pad"
        hint={tx.rateHint}
      />
      <Text style={styles.label}>{tx.surcharges}</Text>
      <Text style={styles.hint}>{tx.surchargesHint}</Text>
      {CUSTOMER_METHODS.map((m) => (
        <Field
          key={m}
          label={strings.payments.methods[m] ?? m}
          value={surcharges[m] ?? ''}
          onChangeText={(value) => setSurcharges((all) => ({ ...all, [m]: value }))}
          placeholder="0"
          keyboardType="decimal-pad"
        />
      ))}
      {invalid ? <Notice tone="error" text={tx.invalid} /> : null}
      {notice !== null ? <Notice tone={notice.tone} text={notice.text} /> : null}
      <Button
        label={saving ? adminStrings.saving : adminStrings.save}
        busy={saving}
        onPress={save}
        testID="guardar-impuestos"
      />
    </Card>
  );
}

interface ProviderState {
  readonly connected: boolean;
  readonly test?: boolean;
  readonly account?: string | null;
  readonly webhook?: boolean;
  readonly message?: string | null;
}

function PaymentsCard({
  store,
  connected,
}: {
  readonly store: StoreRow;
  readonly connected: ReadonlySet<string>;
}): ReactNode {
  const colors = useColors();
  const styles = useMemo(() => ({ ...createAdminStyles(colors), ...createStyles(colors) }), [colors]);
  const { reloadStore } = useAdmin();
  const p = adminStrings.payments;
  const [options, setOptions] = useState<Record<string, boolean>>(() => ({
    cash: true,
    card_counter: true,
    zelle: false,
    stripe: false,
    paypal: false,
    ...(store.payment_options ?? {}),
  }) as Record<string, boolean>);
  const [zelle, setZelle] = useState(
    store.zelle_recipient === null || store.zelle_recipient === undefined ? '' : formatZelleRecipient(store.zelle_recipient),
  );
  const [zelleName, setZelleName] = useState(store.zelle_name ?? '');
  const { saving, notice, run } = useSaver();
  const [problems, setProblems] = useState<string[]>([]);
  const [providers, setProviders] = useState<Record<OnlineProvider, ProviderState>>(() => ({
    stripe: { connected: connected.has('stripe') },
    paypal: { connected: connected.has('paypal') },
  }));
  const [checking, setChecking] = useState<OnlineProvider | null>(null);

  const probar = async (provider: OnlineProvider): Promise<void> => {
    setChecking(provider);
    try {
      const status = await checkProvider(provider, store.id);
      setProviders((all) => ({
        ...all,
        [provider]: {
          connected: status.connected,
          test: status.test === true,
          account: status.account ?? null,
          webhook: status.webhook,
          message: status.connected ? null : (p.reasons[status.reason ?? ''] ?? p.checkFailed),
        },
      }));
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : '';
      setProviders((all) => ({ ...all, [provider]: { ...all[provider], message: p.reasons[reason] ?? p.checkFailed } }));
    } finally {
      setChecking(null);
    }
  };

  const toggle = (key: string) => (value: boolean): void => setOptions((o) => ({ ...o, [key]: value }));
  const zelleError = zelle.trim() !== '' && normalizeZelleRecipient(zelle) === null ? (p.problems.zelle_invalid ?? null) : null;
  const connectedNow = new Set(ONLINE_PROVIDERS.filter((m) => providers[m].connected));

  const save = (): void => {
    const found = paymentSetupProblems({ options, zelle, connected: connectedNow });
    setProblems(found);
    if (found.some(blocksSaving)) return;
    void run(async () => {
      await updatePaymentOptions(store.id, {
        options,
        zelleRecipient: normalizeZelleRecipient(zelle),
        zelleName,
      });
      reloadStore();
    });
  };

  const providerBlock = (provider: OnlineProvider): ReactNode => {
    const state = providers[provider];
    const off = provider === 'stripe' ? p.stripeOff : p.paypalOff;
    return (
      <View key={provider} style={styles.paySection}>
        <Toggle
          label={provider === 'stripe' ? p.stripeToggle : p.paypalToggle}
          hint={state.connected ? p.connected : p.notConnected}
          value={options[provider] === true}
          onValueChange={toggle(provider)}
        />
        <Notice
          tone={state.connected && state.test !== true ? 'ok' : 'error'}
          text={
            state.connected
              ? state.test === true
                ? p.onlineTest
                : p.onlineOn(state.account ?? '')
              : (state.message ?? off)
          }
        />
        {provider === 'stripe' && state.connected && state.webhook === false ? (
          <Notice tone="error" text={p.stripeNoWebhook} />
        ) : null}
        <Button
          label={checking === provider ? p.checking : p.check}
          variant="outline"
          busy={checking === provider}
          onPress={() => void probar(provider)}
          style={styles.mpCheck}
        />
      </View>
    );
  };

  return (
    <Card title={p.title}>
      <Text style={styles.label}>{p.counter}</Text>
      <Text style={styles.hint}>{p.counterHint}</Text>
      {(['cash', 'card_counter'] as const).map((m) => (
        <Toggle key={m} label={strings.payments.methods[m] ?? m} value={options[m] === true} onValueChange={toggle(m)} />
      ))}

      <View style={styles.paySection}>
        <Toggle label={p.zelleToggle} value={options.zelle === true} onValueChange={toggle('zelle')} />
        <Text style={styles.hint}>{p.zelleHint}</Text>
        {options.zelle === true ? (
          <>
            <Field
              label={p.zelleRecipient}
              value={zelle}
              onChangeText={setZelle}
              placeholder={p.zelleRecipientPlaceholder}
              keyboardType="email-address"
              autoCapitalize="none"
              error={zelleError}
            />
            <Field label={p.zelleName} value={zelleName} onChangeText={setZelleName} placeholder={p.zelleNamePlaceholder} />
          </>
        ) : null}
      </View>

      <Text style={styles.label}>{p.online}</Text>
      <Text style={styles.hint}>{p.onlineHint}</Text>
      {ONLINE_PROVIDERS.map(providerBlock)}

      {problems.map((key) => (
        <Notice key={key} tone="error" text={p.problems[key] ?? key} />
      ))}
      {notice !== null ? <Notice tone={notice.tone} text={notice.text} /> : null}
      <Button
        label={saving ? adminStrings.saving : adminStrings.save}
        busy={saving}
        onPress={save}
        testID="guardar-pagos"
      />
    </Card>
  );
}

function TeamCard(): ReactNode {
  const colors = useColors();
  const styles = useMemo(() => ({ ...createAdminStyles(colors), ...createStyles(colors) }), [colors]);
  const { restaurantId } = useAdmin();
  const { user } = useSession();
  const tm = adminStrings.team;
  const load = useCallback(() => fetchTeam(restaurantId), [restaurantId]);
  const { data, refresh } = useAsync(load, [restaurantId]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<MemberRole>('staff');
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const explain = (cause: unknown): string => {
    const message = cause instanceof Error ? cause.message : String(cause);
    const key = Object.keys(tm.errors).find((k) => message.includes(k));
    return key === undefined ? `${adminStrings.saveFailed}: ${message}` : (tm.errors[key] ?? message);
  };

  const run = async (work: () => Promise<void>, ok: string | null): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      await work();
      if (ok !== null) setNotice({ tone: 'ok', text: ok });
      refresh();
    } catch (cause) {
      setNotice({ tone: 'error', text: explain(cause) });
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  };

  const roleChip = (value: MemberRole, label: string): ReactNode => (
    <Pressable
      key={value}
      accessibilityRole="radio"
      accessibilityState={{ checked: role === value }}
      onPress={() => setRole(value)}
      style={[styles.roleChip, role === value && styles.roleChipOn]}
    >
      <Text style={[styles.roleChipText, role === value && styles.roleChipTextOn]}>{label}</Text>
    </Pressable>
  );

  return (
    <Card title={tm.title}>
      <Text style={styles.hint}>{tm.hint}</Text>
      {(data ?? []).map((member: TeamMember) => {
        const me = member.user_id === user?.id;
        const who = member.name ?? member.email;
        return (
          <View key={member.user_id} style={styles.memberRow}>
            <View style={styles.memberAvatar}>
              <Ionicons name={member.role === 'owner' ? 'key' : 'person'} size={16} color={colors.onPrimary} />
            </View>
            <View style={styles.grow}>
              <Text style={styles.memberName} numberOfLines={1}>
                {who}
                {me ? ` (${tm.you})` : ''}
              </Text>
              <Text style={styles.hint} numberOfLines={1}>
                {member.email} · {member.role === 'owner' ? tm.owner : tm.staff}
              </Text>
              {confirming === member.user_id ? (
                <View style={styles.memberActions}>
                  <Text style={styles.hint}>{tm.removeConfirm(who)}</Text>
                  <Pressable disabled={busy} onPress={() => void run(() => removeTeamMember(restaurantId, member.user_id), null)}>
                    <Text style={styles.dangerText}>{adminStrings.confirmDelete}</Text>
                  </Pressable>
                  <Pressable onPress={() => setConfirming(null)}>
                    <Text style={styles.linkText}>{adminStrings.cancel}</Text>
                  </Pressable>
                </View>
              ) : !me ? (
                <View style={styles.memberActions}>
                  <Pressable
                    disabled={busy}
                    onPress={() =>
                      void run(
                        () => addTeamMember(restaurantId, member.email, member.role === 'owner' ? 'staff' : 'owner'),
                        null,
                      )
                    }
                  >
                    <Text style={styles.linkText}>{member.role === 'owner' ? tm.makeStaff : tm.makeOwner}</Text>
                  </Pressable>
                  <Pressable onPress={() => setConfirming(member.user_id)}>
                    <Text style={styles.dangerText}>{tm.remove}</Text>
                  </Pressable>
                </View>
              ) : null}
            </View>
          </View>
        );
      })}

      <View style={styles.addBox}>
        <Text style={styles.label}>{tm.addTitle}</Text>
        <Text style={styles.hint}>{tm.addHint}</Text>
        <Field label={tm.email} value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" />
        <View style={styles.roleRow}>
          {roleChip('staff', tm.staff)}
          {roleChip('owner', tm.owner)}
        </View>
        <Button
          label={tm.add}
          busy={busy}
          disabled={!email.includes('@')}
          onPress={() =>
            void run(async () => {
              await addTeamMember(restaurantId, email, role);
              setEmail('');
            }, tm.added)
          }
        />
      </View>
      {notice !== null ? <Notice tone={notice.tone} text={notice.text} /> : null}
    </Card>
  );
}
