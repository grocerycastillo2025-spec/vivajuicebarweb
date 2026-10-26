/**
 * Panel · Lealtad.
 *
 * Para el mostrador (dueño y empleados): validar el codigo de un canje y
 * ver los ultimos. Para el dueño, ademas: configurar el programa, el QR
 * del local (fijo o en pantalla) y las recompensas.
 */

import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import {
  fetchAdminRewards,
  fetchOwnerProgram,
  fetchRewardsGiven,
  fetchVisitQr,
  rewardSpanish,
  regenerateVisitCode,
  saveProgram,
  saveReward,
  setVisitQrMode,
  validateRedemptionCode as validateRedemption,
  type AdminReward,
  type VisitQr,
} from '../../src/api/loyalty';
import { useAdmin } from '../../src/admin/admin-context';
import { CardCodeInput } from '../../src/admin/CardCodeInput';
import { appPublicUrl, printVisitQr, qrDataUrl } from '../../src/admin/qr';
import { adminStrings } from '../../src/admin/strings';
import { AdminShell, Card, Field, Notice, Toggle, createAdminStyles } from '../../src/admin/ui';
import { DataState } from '../../src/components/DataState';
import { Button } from '../../src/components/ui';
import type { BrandColors } from '../../src/domain/branding';
import { moneyDefaults } from '../../src/domain/money';
import { rewardLabel } from '../../src/domain/loyalty-card';
import { buildVisitUrl, normalizeRedemptionCode, parseUseRedemptionError } from '../../src/domain/visit';
import { useAsync } from '../../src/hooks/use-async';
import { useBranding, useColors } from '../../src/state/branding-context';
import { radius, spacing, type as typography } from '../../src/theme';

const t = adminStrings.loyalty;

function when(iso: string): string {
  return new Date(iso).toLocaleString(moneyDefaults().locale, {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function errorText(cause: unknown): string {
  return `${adminStrings.saveFailed}: ${cause instanceof Error ? cause.message : String(cause)}`;
}

export default function AdminLoyaltyScreen(): ReactNode {
  const { restaurantId, store, isOwner } = useAdmin();
  const router = useRouter();
  const colors = useColors();
  const styles = useMemo(() => ({ ...createAdminStyles(colors), ...createStyles(colors) }), [colors]);

  const load = useCallback(async () => {
    const [redemptions, program, rewards, qr] = await Promise.all([
      fetchRewardsGiven(restaurantId),
      isOwner ? fetchOwnerProgram(restaurantId) : Promise.resolve(null),
      isOwner ? fetchAdminRewards(restaurantId) : Promise.resolve([]),
      isOwner ? fetchVisitQr(store.id) : Promise.resolve(null),
    ]);
    return { redemptions, program, rewards, qr };
  }, [isOwner, restaurantId, store.id]);

  const { data, error, loading, refresh, reload } = useAsync(load, [restaurantId, store.id]);

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
      <View style={styles.layout}>
        <View style={styles.column}>
          <Card title={t.cardTitle}>
            <Text style={styles.hint}>{t.cardHint}</Text>
            <Button label={t.scanCard} onPress={() => router.push('/admin/escanear')} testID="escanear-tarjeta" />
            <CardCodeInput />
          </Card>
          <Card title={t.history}>
            {data.redemptions.length === 0 ? <Text style={styles.hint}>{t.historyEmpty}</Text> : null}
            {data.redemptions.map((r) => (
              <View key={r.id} style={styles.row}>
                <View style={styles.rowBody}>
                  <Text style={styles.rowTitle}>
                    {rewardLabel({ name: r.reward_name ?? '', i18n: r.reward_i18n }, 'es')}
                    {r.customer !== null ? ` → ${r.customer}` : ''}
                  </Text>
                  <Text style={styles.hint}>
                    {when(r.given_at)}
                    {r.given_by !== null ? ` · ${t.givenBy(r.given_by)}` : ''}
                    {r.code !== null ? ` · ${r.code}` : ''}
                  </Text>
                </View>
                <Text style={[styles.status, r.status === 'issued' && styles.statusOpen]}>
                  {t.statusLabel[r.status]}
                </Text>
              </View>
            ))}
          </Card>
          <ValidateCard onDone={refresh} />
        </View>

        {isOwner ? (
          <View style={styles.column}>
            {data.program !== null ? <ProgramCard initial={data.program} onSaved={refresh} /> : null}
            {data.qr !== null && data.program?.self_checkin === true ? <QrCard initial={data.qr} /> : null}
            <RewardsCard rewards={data.rewards} onSaved={refresh} />
          </View>
        ) : null}
      </View>
    </AdminShell>
  );
}

// ---------------------------------------------------------------------
// VALIDAR CANJE
// ---------------------------------------------------------------------

function ValidateCard({ onDone }: { readonly onDone: () => void }): ReactNode {
  const colors = useColors();
  const styles = useMemo(() => ({ ...createAdminStyles(colors), ...createStyles(colors) }), [colors]);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const submit = async (): Promise<void> => {
    const clean = normalizeRedemptionCode(code);
    if (clean === '') return;
    setBusy(true);
    setNotice(null);
    try {
      const used = await validateRedemption(clean);
      setNotice({ tone: 'ok', text: t.deliver(used.reward ?? '', used.customer) });
      setCode('');
      onDone();
    } catch (cause) {
      const f = parseUseRedemptionError(cause instanceof Error ? cause.message : String(cause));
      setNotice({
        tone: 'error',
        text:
          f.kind === 'not_found'
            ? t.notFound
            : f.kind === 'already_used'
              ? t.alreadyUsed(f.usedAt === null ? '' : when(f.usedAt.toISOString()))
              : f.kind === 'canceled'
                ? t.canceled
                : errorText(f.detail),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={t.validateTitle}>
      <Text style={styles.hint}>{t.legacyHint} {t.validateHint}</Text>
      <View style={styles.inline}>
        <TextInput
          value={code}
          onChangeText={(text) => setCode(text.toUpperCase())}
          placeholder={t.codePlaceholder}
          placeholderTextColor={colors.textFaint}
          autoCapitalize="characters"
          autoCorrect={false}
          onSubmitEditing={() => void submit()}
          accessibilityLabel={t.validateTitle}
          style={[styles.input, styles.codeInput]}
        />
        <Button label={t.validate} busy={busy} onPress={() => void submit()} />
      </View>
      {notice !== null ? <Notice tone={notice.tone} text={notice.text} /> : null}
    </Card>
  );
}

// ---------------------------------------------------------------------
// PROGRAMA
// ---------------------------------------------------------------------

function ProgramCard({
  initial,
  onSaved,
}: {
  readonly initial: { enabled: boolean; points_per_visit?: number; visit_cooldown_hours?: number; self_checkin?: boolean };
  readonly onSaved: () => void;
}): ReactNode {
  const { restaurantId } = useAdmin();
  const branding = useBranding();
  const [enabled, setEnabled] = useState(initial.enabled);
  const [perVisit, setPerVisit] = useState(String(initial.points_per_visit ?? 10));
  const [cooldown, setCooldown] = useState(String(initial.visit_cooldown_hours ?? 20));
  const [selfCheckin, setSelfCheckin] = useState(initial.self_checkin === true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const points = Number.parseInt(perVisit, 10);
  const hours = Number.parseInt(cooldown, 10);
  const pointsOk = /^\d+$/.test(perVisit.trim()) && points >= 1 && points <= 10000;
  const hoursOk = /^\d+$/.test(cooldown.trim()) && hours >= 0 && hours <= 168;

  const save = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      await saveProgram(restaurantId, {
        enabled,
        points_per_visit: points,
        visit_cooldown_hours: hours,
        ...(initial.self_checkin === undefined ? {} : { self_checkin: selfCheckin }),
      });
      setNotice({ tone: 'ok', text: adminStrings.saved });
      branding.reload();
      onSaved();
    } catch (cause) {
      setNotice({ tone: 'error', text: errorText(cause) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={t.programTitle}>
      <Toggle label={t.enabled} hint={t.enabledHint} value={enabled} onValueChange={setEnabled} />
      <Field
        label={t.perVisit}
        value={perVisit}
        onChangeText={setPerVisit}
        keyboardType="number-pad"
        error={pointsOk ? null : t.invalidNumber}
      />
      <Field
        label={t.cooldown}
        value={cooldown}
        onChangeText={setCooldown}
        keyboardType="number-pad"
        hint={t.cooldownHint}
        error={hoursOk ? null : t.invalidNumber}
      />
      {initial.self_checkin !== undefined ? (
        <Toggle label={t.selfCheckin} hint={selfCheckin ? t.selfCheckinHint : t.qrOffHint} value={selfCheckin} onValueChange={setSelfCheckin} />
      ) : null}
      {notice !== null ? <Notice tone={notice.tone} text={notice.text} /> : null}
      <Button label={busy ? adminStrings.saving : adminStrings.save} busy={busy} disabled={!pointsOk || !hoursOk} onPress={() => void save()} />
    </Card>
  );
}

// ---------------------------------------------------------------------
// QR
// ---------------------------------------------------------------------

function QrCard({ initial }: { readonly initial: VisitQr }): ReactNode {
  const colors = useColors();
  const styles = useMemo(() => ({ ...createAdminStyles(colors), ...createStyles(colors) }), [colors]);
  const router = useRouter();
  const { store } = useAdmin();
  const { displayName } = useBranding();
  const [qr, setQr] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const url = buildVisitUrl(appPublicUrl(), { storeId: store.id, code: qr.code });

  const run = async (work: () => Promise<VisitQr>): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      setQr(await work());
    } catch (cause) {
      setFailure(errorText(cause));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  const option = (mode: VisitQr['mode'], label: string, hint: string): ReactNode => (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: qr.mode === mode }}
      onPress={() => qr.mode !== mode && void run(() => setVisitQrMode(store.id, mode))}
      disabled={busy}
      style={[styles.option, qr.mode === mode && styles.optionOn]}
    >
      <View style={[styles.radio, qr.mode === mode && styles.radioOn]} />
      <View style={styles.rowBody}>
        <Text style={styles.rowTitle}>{label}</Text>
        <Text style={styles.hint}>{hint}</Text>
      </View>
    </Pressable>
  );

  return (
    <Card title={t.qrTitle}>
      {option('static', t.modeStatic, t.modeStaticHint)}
      {option('rotating', t.modeRotating, t.modeRotatingHint)}

      {qr.mode === 'static' ? (
        <View style={styles.qrBlock}>
          <Image source={{ uri: qrDataUrl(url, 6) }} style={styles.qrImage} contentFit="contain" />
          <Text style={styles.hint}>{t.previewNote}</Text>
          {qr.rotated_at !== undefined ? <Text style={styles.hint}>{t.rotatedAt(when(qr.rotated_at))}</Text> : null}
          <View style={styles.inline}>
            <Button label={t.print} onPress={() => printVisitQr(url, displayName)} />
            {!confirming ? (
              <Button label={t.regenerate} variant="outline" onPress={() => setConfirming(true)} />
            ) : null}
          </View>
          {confirming ? (
            <View style={styles.confirm}>
              <Text style={styles.rowTitle}>{t.regenerateConfirm}</Text>
              <View style={styles.inline}>
                <Button
                  label={t.regenerate}
                  busy={busy}
                  onPress={() => void run(() => regenerateVisitCode(store.id))}
                  style={{ backgroundColor: colors.danger }}
                />
                <Button label={adminStrings.cancel} variant="outline" onPress={() => setConfirming(false)} />
              </View>
            </View>
          ) : null}
        </View>
      ) : (
        <Button label={t.openScreen} onPress={() => router.push('/admin/qr-pantalla')} />
      )}

      {failure !== null ? <Notice tone="error" text={failure} /> : null}
    </Card>
  );
}

// ---------------------------------------------------------------------
// RECOMPENSAS
// ---------------------------------------------------------------------

function RewardsCard({
  rewards,
  onSaved,
}: {
  readonly rewards: readonly AdminReward[];
  readonly onSaved: () => void;
}): ReactNode {
  const colors = useColors();
  const styles = useMemo(() => ({ ...createAdminStyles(colors), ...createStyles(colors) }), [colors]);

  return (
    <Card title={t.rewardsTitle}>
      <Text style={styles.hint}>{t.rewardsHint}</Text>
      {rewards.length === 0 ? <Text style={styles.hint}>{t.noRewards}</Text> : null}
      {rewards.map((reward) => (
        <RewardEditor key={reward.id} reward={reward} onSaved={onSaved} />
      ))}
      <RewardEditor reward={null} onSaved={onSaved} />
    </Card>
  );
}

function RewardEditor({
  reward,
  onSaved,
}: {
  readonly reward: AdminReward | null;
  readonly onSaved: () => void;
}): ReactNode {
  const colors = useColors();
  const styles = useMemo(() => ({ ...createAdminStyles(colors), ...createStyles(colors) }), [colors]);
  const { restaurantId } = useAdmin();
  const [name, setName] = useState(reward?.name ?? '');
  const [description, setDescription] = useState(reward?.description ?? '');
  const [nameEs, setNameEs] = useState(rewardSpanish(reward, 'name'));
  const [descriptionEs, setDescriptionEs] = useState(rewardSpanish(reward, 'description'));
  const [cost, setCost] = useState(reward === null ? '' : String(reward.cost_points));
  const [active, setActive] = useState(reward?.active ?? true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const costValue = Number.parseInt(cost, 10);
  const valid = (name.trim() !== '' || nameEs.trim() !== '') && /^\d+$/.test(cost.trim()) && costValue > 0;

  const save = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      await saveReward(restaurantId, {
        ...(reward !== null ? { id: reward.id } : {}),
        name,
        description,
        nameEs,
        descriptionEs,
        cost_points: costValue,
        active,
      });
      if (reward === null) {
        setName('');
        setDescription('');
        setNameEs('');
        setDescriptionEs('');
        setCost('');
      }
      setNotice({ tone: 'ok', text: adminStrings.saved });
      onSaved();
    } catch (cause) {
      setNotice({ tone: 'error', text: errorText(cause) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={[styles.rewardBox, reward === null && styles.rewardNew]}>
      {reward === null ? <Text style={styles.rowTitle}>{t.addReward}</Text> : null}
      <Field label={t.rewardNameEs} value={nameEs} onChangeText={setNameEs} placeholder={t.rewardNameEsPlaceholder} />
      <Field label={t.rewardName} value={name} onChangeText={setName} placeholder={t.rewardNamePlaceholder} />
      <Field label={t.rewardDescriptionEs} value={descriptionEs} onChangeText={setDescriptionEs} />
      <Field label={t.rewardDescription} value={description} onChangeText={setDescription} />
      <Field label={t.rewardCost} value={cost} onChangeText={setCost} keyboardType="number-pad" />
      {reward !== null ? <Toggle label={t.rewardActive} value={active} onValueChange={setActive} /> : null}
      {notice !== null ? <Notice tone={notice.tone} text={notice.text} /> : null}
      <Button
        label={reward === null ? t.addReward : adminStrings.save}
        variant={reward === null ? 'primary' : 'outline'}
        busy={busy}
        disabled={!valid}
        onPress={() => void save()}
        style={styles.alignStart}
      />
    </View>
  );
}

function createStyles(colors: BrandColors) {
  return StyleSheet.create({
    layout: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.lg, alignItems: 'flex-start' },
    column: { flexGrow: 1, flexBasis: 340, minWidth: 0, gap: spacing.lg },
    inline: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, alignItems: 'center' },
    codeInput: {
      flex: 1,
      minWidth: 160,
      fontSize: 22,
      fontWeight: '800',
      letterSpacing: 4,
      textAlign: 'center',
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
    },
    rowBody: { flex: 1, minWidth: 0, gap: 2 },
    rowTitle: { color: colors.text, fontSize: typography.body.fontSize, fontWeight: '700' },
    status: { color: colors.textMuted, fontSize: typography.label.fontSize, fontWeight: '700' },
    statusOpen: { color: colors.accent },
    option: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      padding: spacing.md,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.border,
    },
    optionOn: { borderColor: colors.primary, borderWidth: 2 },
    radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: colors.border },
    radioOn: { borderColor: colors.primary, backgroundColor: colors.primary },
    qrBlock: { alignItems: 'center', gap: spacing.sm },
    qrImage: { width: 220, height: 220 },
    confirm: { gap: spacing.sm, alignItems: 'center' },
    rewardBox: {
      gap: spacing.sm,
      paddingTop: spacing.md,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
    },
    rewardNew: { backgroundColor: colors.background, padding: spacing.md, borderRadius: radius.md, borderTopWidth: 0 },
    alignStart: { alignSelf: 'flex-start' },
  });
}
