/**
 * Puntos. Saldo, "Mi tarjeta" (el QR que escanea la tienda, 0032), el
 * avance hacia cada recompensa y lo que ya recibió.
 *
 * Todo lo que mueve puntos es una función de la base; esta pantalla solo
 * pide y enseña. Si el dueño prendió el QR del local (self_checkin), queda
 * también el botón para escanearlo.
 */

import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { appPublicUrl, qrDataUrl } from '../../src/admin/qr';
import { fetchLoyaltyAccount, fetchLoyaltyProgram, fetchRewards } from '../../src/api/account';
import { cancelRedemption, fetchMyCard, fetchMyRedemptions, type MyCard, type RedemptionRow } from '../../src/api/loyalty';
import type { LoyaltyAccountRow, LoyaltyProgramRow, RewardRow } from '../../src/api/types';
import { DataState } from '../../src/components/DataState';
import { Screen } from '../../src/components/Screen';
import { Button, SectionTitle } from '../../src/components/ui';
import type { BrandColors } from '../../src/domain/branding';
import { buildCardUrl, formatCard, progressTo, visitsMissing } from '../../src/domain/loyalty-card';
import { moneyDefaults } from '../../src/domain/money';
import { pointsMissing } from '../../src/domain/visit';
import { useAsync } from '../../src/hooks/use-async';
import { useBranding, useColors } from '../../src/state/branding-context';
import { useSession } from '../../src/state/session-context';
import { useStores } from '../../src/state/store-context';
import { radius, spacing, type as typography } from '../../src/theme';
import { strings } from '../../src/strings';

interface RewardsData {
  readonly program: LoyaltyProgramRow | null;
  readonly account: LoyaltyAccountRow | null;
  readonly card: MyCard | null;
  readonly rewards: readonly RewardRow[];
  readonly redemptions: readonly RedemptionRow[];
}

function when(iso: string): string {
  return new Date(iso).toLocaleDateString(moneyDefaults().locale, { day: 'numeric', month: 'short' });
}

export default function RewardsScreen(): ReactNode {
  const { user } = useSession();
  const router = useRouter();
  const colors = useColors();
  const { displayName } = useBranding();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { selectedStore } = useStores();

  const restaurantId = selectedStore?.restaurant_id ?? null;

  const load = useCallback(async (): Promise<RewardsData> => {
    if (restaurantId === null) return { program: null, account: null, card: null, rewards: [], redemptions: [] };
    const [program, rewards, account, redemptions] = await Promise.all([
      fetchLoyaltyProgram(restaurantId),
      fetchRewards(restaurantId),
      user === null ? Promise.resolve(null) : fetchLoyaltyAccount(),
      user === null ? Promise.resolve([]) : fetchMyRedemptions(user.id),
    ]);
    const card = user !== null && program?.enabled === true ? await fetchMyCard(restaurantId) : null;
    return { program, account, card, rewards, redemptions };
  }, [restaurantId, user]);

  const { data, error, loading, refreshing, refresh, reload } = useAsync(load, [restaurantId, user?.id]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const undo = async (redemption: RedemptionRow): Promise<void> => {
    setBusy(true);
    try {
      await cancelRedemption(redemption.id);
      refresh();
    } catch (cause) {
      setFailure(`${strings.rewards.redeemFailed}: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setBusy(false);
    }
  };

  if (loading || error !== null) {
    return (
      <Screen withTabBar scroll={false}>
        <DataState loading={loading} error={error} empty={false} onRetry={reload} emptyTitle="">
          {null}
        </DataState>
      </Screen>
    );
  }

  const program = data?.program ?? null;
  const enabled = program !== null && program.enabled;
  const card = data?.card ?? null;
  const points = card?.balance ?? data?.account?.points_balance ?? 0;
  const perVisit = program?.points_per_visit ?? 0;
  const rewards = data?.rewards ?? [];
  const ready = user !== null && enabled ? rewards.filter((r) => points >= r.cost_points) : [];
  const issued = (data?.redemptions ?? []).filter((r) => r.status === 'issued');
  const received = (data?.redemptions ?? []).filter((r) => r.status === 'used');

  return (
    <Screen withTabBar refreshing={refreshing} onRefresh={refresh} contentStyle={styles.content}>
      <Text style={styles.title}>{strings.rewards.title}</Text>

      {ready.length > 0 ? (
        <View style={styles.readyBanner} accessibilityRole="alert" testID="recompensa-lista">
          <Ionicons name="gift" size={28} color={colors.onPrimary} />
          <View style={styles.readyText}>
            <Text style={styles.readyTitle}>{strings.rewards.readyBanner(ready[ready.length - 1]?.name ?? '')}</Text>
            <Text style={styles.readyBody}>{strings.rewards.ready}</Text>
          </View>
        </View>
      ) : null}

      <View style={styles.pointsCard}>
        <Text style={styles.pointsLabel}>{strings.rewards.yourPoints}</Text>
        <Text style={styles.pointsValue}>{user === null ? '—' : points}</Text>
        <Text style={styles.pointsHelp}>
          {user === null
            ? strings.rewards.signInPrompt
            : !enabled
              ? strings.rewards.inactive(displayName)
              : card !== null
                ? strings.rewards.perVisitCard(perVisit)
                : strings.rewards.perVisit(perVisit)}
        </Text>
        {user === null ? (
          <Button label={strings.auth.signIn} variant="accent" onPress={() => router.push('/profile')} style={styles.scanButton} />
        ) : null}
      </View>

      {card !== null ? (
        <View style={styles.cardBox} testID="mi-tarjeta">
          <Text style={styles.cardTitle}>{strings.rewards.cardTitle}</Text>
          <View style={styles.qrFrame}>
            <Image
              source={{ uri: qrDataUrl(buildCardUrl(appPublicUrl(), card.code), 7) }}
              style={styles.qr}
              contentFit="contain"
              accessibilityLabel={`${strings.rewards.cardTitle} ${formatCard(card.code)}`}
            />
          </View>
          <Text style={styles.cardCode} selectable>
            {formatCard(card.code)}
          </Text>
          <Text style={styles.cardHint}>{strings.rewards.cardHint}</Text>
        </View>
      ) : null}

      {enabled && user !== null && (card === null || program.self_checkin === true) ? (
        <Button label={strings.rewards.scan} variant="outline" onPress={() => router.push('/escanear')} />
      ) : null}

      {issued.length > 0 ? (
        <View style={styles.section}>
          <SectionTitle>{strings.rewards.activeTitle}</SectionTitle>
          {issued.map((redemption) => (
            <View key={redemption.id} style={styles.codeCard}>
              <Text style={styles.codeReward}>{redemption.reward_name}</Text>
              <Text style={styles.code}>{redemption.code}</Text>
              <Text style={styles.codeHint}>{strings.rewards.showCode}</Text>
              <Pressable onPress={() => void undo(redemption)} disabled={busy}>
                <Text style={styles.cancel}>{strings.rewards.cancelRedemption}</Text>
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}

      {failure !== null ? <Text style={styles.failure}>{failure}</Text> : null}

      <View style={styles.section}>
        <SectionTitle>{strings.rewards.progressTitle}</SectionTitle>
        {rewards.length === 0 ? (
          <Text style={styles.empty}>{strings.rewards.empty}</Text>
        ) : (
          rewards.map((reward) => {
            const missing = pointsMissing(points, reward.cost_points);
            const done = user !== null && missing === 0;
            const visits = visitsMissing(points, reward.cost_points, perVisit);
            return (
              <View key={reward.id} style={[styles.reward, done && styles.rewardDone]}>
                <View style={styles.rewardRow}>
                  <Ionicons
                    name={done ? 'gift' : 'gift-outline'}
                    size={26}
                    color={done ? colors.accent : colors.textMuted}
                  />
                  <View style={styles.rewardBody}>
                    <Text style={styles.rewardName}>{reward.name}</Text>
                    {reward.description !== null ? (
                      <Text style={styles.rewardDescription}>{reward.description}</Text>
                    ) : null}
                  </View>
                  <Text style={styles.rewardCost}>{strings.rewards.points(reward.cost_points)}</Text>
                </View>
                {user !== null && enabled ? (
                  <>
                    <View style={styles.bar} accessibilityRole="progressbar"
                      accessibilityValue={{ min: 0, max: reward.cost_points, now: Math.min(points, reward.cost_points) }}>
                      <View style={[styles.barFill, { width: `${Math.round(progressTo(points, reward.cost_points) * 100)}%` }, done && styles.barDone]} />
                    </View>
                    <Text style={[styles.missing, done && styles.missingDone]}>
                      {done
                        ? strings.rewards.ready
                        : perVisit > 0
                          ? `${strings.rewards.missing(missing)} · ${strings.rewards.visitsLeft(visits)}`
                          : strings.rewards.missing(missing)}
                    </Text>
                  </>
                ) : null}
              </View>
            );
          })
        )}
      </View>

      {received.length > 0 ? (
        <View style={styles.section}>
          <SectionTitle>{strings.rewards.received}</SectionTitle>
          {received.map((r) => (
            <View key={r.id} style={styles.receivedRow}>
              <Ionicons name="checkmark-circle" size={20} color={colors.primary} />
              <Text style={styles.receivedText}>
                {strings.rewards.receivedOn(r.reward_name ?? '', when(r.used_at ?? r.redeemed_at))}
              </Text>
            </View>
          ))}
        </View>
      ) : null}

      <Text style={styles.footnote}>{strings.rewards.footnote}</Text>
    </Screen>
  );
}

function createStyles(colors: BrandColors) {
  return StyleSheet.create({
    content: { padding: spacing.lg, gap: spacing.xl },
    title: { color: colors.text, fontSize: typography.display.fontSize, fontWeight: '800' },

    readyBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      backgroundColor: colors.accent,
      borderRadius: radius.lg,
      padding: spacing.lg,
    },
    readyText: { flex: 1, gap: 2 },
    readyTitle: { color: colors.onPrimary, fontSize: typography.section.fontSize, fontWeight: '800' },
    readyBody: { color: colors.onPrimary, fontSize: typography.label.fontSize, lineHeight: 19 },

    pointsCard: {
      backgroundColor: colors.primary,
      borderRadius: radius.lg,
      padding: spacing.xl,
      gap: spacing.xs,
    },
    pointsLabel: {
      color: colors.onPrimary,
      opacity: 0.85,
      fontSize: typography.caption.fontSize,
      fontWeight: '800',
      letterSpacing: 1,
      textTransform: 'uppercase',
    },
    pointsValue: { color: colors.onPrimary, fontSize: 44, fontWeight: '800' },
    pointsHelp: { color: colors.onPrimary, opacity: 0.85, fontSize: typography.body.fontSize, lineHeight: 21 },
    scanButton: { marginTop: spacing.md, alignSelf: 'flex-start' },

    cardBox: {
      alignItems: 'center',
      gap: spacing.sm,
      padding: spacing.lg,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
    },
    cardTitle: { color: colors.text, fontSize: typography.section.fontSize, fontWeight: '800' },
    // Fondo blanco siempre: un QR sobre color se lee peor.
    qrFrame: { backgroundColor: '#FFFFFF', padding: spacing.sm, borderRadius: radius.md },
    qr: { width: 220, height: 220 },
    cardCode: { color: colors.text, fontSize: 22, fontWeight: '800', letterSpacing: 3 },
    cardHint: { color: colors.textMuted, fontSize: typography.label.fontSize, textAlign: 'center' },

    section: { gap: spacing.sm },
    empty: { color: colors.textMuted, fontSize: typography.body.fontSize },

    codeCard: {
      alignItems: 'center',
      gap: spacing.xs,
      padding: spacing.lg,
      borderRadius: radius.lg,
      borderWidth: 2,
      borderColor: colors.accent,
      backgroundColor: colors.surface,
    },
    codeReward: { color: colors.text, fontSize: typography.section.fontSize, fontWeight: '800' },
    code: { color: colors.primary, fontSize: 40, fontWeight: '800', letterSpacing: 6 },
    codeHint: { color: colors.textMuted, fontSize: typography.label.fontSize, textAlign: 'center' },
    cancel: { color: colors.danger, fontSize: typography.label.fontSize, fontWeight: '700', marginTop: spacing.xs },
    failure: { color: colors.danger, fontSize: typography.label.fontSize, fontWeight: '600' },

    reward: {
      gap: spacing.sm,
      backgroundColor: colors.surface,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.border,
      padding: spacing.lg,
      marginBottom: spacing.sm,
    },
    rewardDone: { borderColor: colors.accent, borderWidth: 2 },
    rewardRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    rewardBody: { flex: 1, minWidth: 0, gap: 2 },
    rewardName: { color: colors.text, fontSize: typography.body.fontSize + 1, fontWeight: '700' },
    rewardDescription: { color: colors.textMuted, fontSize: typography.caption.fontSize + 1 },
    rewardCost: { color: colors.accent, fontSize: typography.body.fontSize, fontWeight: '800', flexShrink: 0 },
    bar: { height: 10, borderRadius: 5, backgroundColor: colors.border, overflow: 'hidden' },
    barFill: { height: 10, borderRadius: 5, backgroundColor: colors.primary },
    barDone: { backgroundColor: colors.accent },
    missing: { color: colors.textMuted, fontSize: typography.label.fontSize, fontWeight: '600' },
    missingDone: { color: colors.text, fontWeight: '800' },

    receivedRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    receivedText: { color: colors.text, fontSize: typography.body.fontSize },

    footnote: { color: colors.textFaint, fontSize: typography.caption.fontSize, lineHeight: 18 },
  });
}
