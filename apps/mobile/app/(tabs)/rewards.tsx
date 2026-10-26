/**
 * Puntos. Saldo, como ganar (escaneando el QR del local), recompensas y
 * los canjes vigentes con su codigo para el mostrador.
 *
 * Todo lo que mueve puntos es una funcion de la base (0021); esta
 * pantalla solo pide y ensena.
 */

import { useRouter } from 'expo-router';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { fetchLoyaltyAccount, fetchLoyaltyProgram, fetchRewards } from '../../src/api/account';
import {
  cancelRedemption,
  fetchMyRedemptions,
  redeemReward,
  type RedemptionRow,
} from '../../src/api/loyalty';
import type { LoyaltyAccountRow, LoyaltyProgramRow, RewardRow } from '../../src/api/types';
import { DataState } from '../../src/components/DataState';
import { Screen } from '../../src/components/Screen';
import { Button, SectionTitle } from '../../src/components/ui';
import type { BrandColors } from '../../src/domain/branding';
import { parseRedeemError, pointsMissing } from '../../src/domain/visit';
import { useAsync } from '../../src/hooks/use-async';
import { useBranding, useColors } from '../../src/state/branding-context';
import { useSession } from '../../src/state/session-context';
import { useStores } from '../../src/state/store-context';
import { radius, spacing, type as typography } from '../../src/theme';
import { strings } from '../../src/strings';

interface RewardsData {
  readonly program: LoyaltyProgramRow | null;
  readonly account: LoyaltyAccountRow | null;
  readonly rewards: readonly RewardRow[];
  readonly redemptions: readonly RedemptionRow[];
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
    if (restaurantId === null) return { program: null, account: null, rewards: [], redemptions: [] };
    const [program, rewards, account, redemptions] = await Promise.all([
      fetchLoyaltyProgram(restaurantId),
      fetchRewards(restaurantId),
      user === null ? Promise.resolve(null) : fetchLoyaltyAccount(),
      user === null ? Promise.resolve([]) : fetchMyRedemptions(user.id),
    ]);
    return { program, account, rewards, redemptions };
  }, [restaurantId, user]);

  const { data, error, loading, refreshing, refresh, reload } = useAsync(load, [restaurantId, user?.id]);

  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const redeem = async (reward: RewardRow): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      await redeemReward(reward.id);
      setConfirming(null);
      refresh();
    } catch (cause) {
      const kind = parseRedeemError(cause instanceof Error ? cause.message : String(cause));
      setFailure(
        kind === 'not_enough_points'
          ? strings.rewards.notEnough
          : kind === 'reward_not_available'
            ? strings.rewards.notAvailable
            : strings.rewards.redeemFailed,
      );
    } finally {
      setBusy(false);
    }
  };

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
  const points = data?.account?.points_balance ?? 0;
  const active = (data?.redemptions ?? []).filter((r) => r.status === 'issued');

  return (
    <Screen withTabBar refreshing={refreshing} onRefresh={refresh} contentStyle={styles.content}>
      <Text style={styles.title}>{strings.rewards.title}</Text>

      <View style={styles.pointsCard}>
        <Text style={styles.pointsLabel}>{strings.rewards.yourPoints}</Text>
        <Text style={styles.pointsValue}>{user === null ? '—' : points}</Text>
        <Text style={styles.pointsHelp}>
          {user === null
            ? strings.rewards.signInPrompt
            : !enabled
              ? strings.rewards.inactive(displayName)
              : strings.rewards.perVisit(program.points_per_visit ?? 0)}
        </Text>
        {enabled ? (
          <Button
            label={strings.rewards.scan}
            variant="accent"
            onPress={() => router.push('/escanear')}
            style={styles.scanButton}
          />
        ) : null}
      </View>

      {active.length > 0 ? (
        <View style={styles.section}>
          <SectionTitle>{strings.rewards.activeTitle}</SectionTitle>
          {active.map((redemption) => (
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
        <SectionTitle>{strings.rewards.catalog}</SectionTitle>
        {(data?.rewards ?? []).length === 0 ? (
          <Text style={styles.empty}>{strings.rewards.empty}</Text>
        ) : (
          (data?.rewards ?? []).map((reward) => {
            const missing = pointsMissing(points, reward.cost_points);
            const canRedeem = user !== null && enabled && missing === 0;
            return (
              <View key={reward.id} style={styles.reward}>
                <View style={styles.rewardRow}>
                  <View style={styles.rewardBody}>
                    <Text style={styles.rewardName}>{reward.name}</Text>
                    {reward.description !== null ? (
                      <Text style={styles.rewardDescription}>{reward.description}</Text>
                    ) : null}
                  </View>
                  <Text style={styles.rewardCost}>{strings.rewards.points(reward.cost_points)}</Text>
                </View>

                {confirming === reward.id ? (
                  <View style={styles.confirm}>
                    <Text style={styles.rewardDescription}>
                      {strings.rewards.confirmRedeem(reward.name, reward.cost_points)}
                    </Text>
                    <View style={styles.confirmRow}>
                      <Button label={strings.rewards.confirm} busy={busy} onPress={() => void redeem(reward)} />
                      <Button label={strings.common.cancel} variant="outline" onPress={() => setConfirming(null)} />
                    </View>
                  </View>
                ) : user !== null && enabled ? (
                  canRedeem ? (
                    <Button
                      label={strings.rewards.redeem}
                      variant="outline"
                      onPress={() => setConfirming(reward.id)}
                      style={styles.redeemButton}
                    />
                  ) : (
                    <Text style={styles.missing}>{strings.rewards.missing(missing)}</Text>
                  )
                ) : null}
              </View>
            );
          })
        )}
      </View>

      <Text style={styles.footnote}>{strings.rewards.footnote}</Text>
    </Screen>
  );
}

function createStyles(colors: BrandColors) {
  return StyleSheet.create({
    content: { padding: spacing.lg, gap: spacing.xl },
    title: { color: colors.text, fontSize: typography.display.fontSize, fontWeight: '800' },
    pointsCard: {
      backgroundColor: colors.primary,
      borderRadius: radius.lg,
      padding: spacing.xl,
      gap: spacing.xs,
    },
    pointsLabel: {
      // Sobre el color principal: tinta legible, no el acento (que puede
      // no contrastar, p. ej. verde sobre naranja).
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
      gap: spacing.md,
      backgroundColor: colors.surface,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.border,
      padding: spacing.lg,
      marginBottom: spacing.sm,
    },
    rewardRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    rewardBody: { flex: 1, minWidth: 0, gap: 2 },
    rewardName: { color: colors.text, fontSize: typography.body.fontSize + 1, fontWeight: '700' },
    rewardDescription: { color: colors.textMuted, fontSize: typography.caption.fontSize + 1 },
    rewardCost: { color: colors.accent, fontSize: typography.body.fontSize, fontWeight: '800', flexShrink: 0 },
    redeemButton: { alignSelf: 'flex-start', minHeight: 40 },
    missing: { color: colors.textFaint, fontSize: typography.label.fontSize, fontWeight: '600' },
    confirm: { gap: spacing.sm },
    confirmRow: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },

    footnote: { color: colors.textFaint, fontSize: typography.caption.fontSize, lineHeight: 18 },
  });
}
