/**
 * Panel · Ficha del cliente al escanear su tarjeta (0032).
 *
 * Nombre, puntos y recompensas. "Sumar visita" y, cuando ya le alcanza,
 * "Entregar": la base descuenta los puntos (el conteo vuelve a empezar) y
 * deja registrado qué recibió, cuándo y quién se lo dio.
 *
 * Se llega desde el escáner del panel o con la cámara del teléfono
 * (el QR es un enlace a esta pantalla).
 */

import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { addVisit, giveReward, lookupCard } from '../../src/api/loyalty';
import { MISSING_SQL_FILE } from '../../src/api/new-columns';
import { useAdmin } from '../../src/admin/admin-context';
import { adminStrings } from '../../src/admin/strings';
import { AdminShell, Card, Notice, createAdminStyles } from '../../src/admin/ui';
import { DataState } from '../../src/components/DataState';
import { Button } from '../../src/components/ui';
import type { BrandColors } from '../../src/domain/branding';
import { formatCard, parseCardError, parseCardPayload, progressTo, rewardLabel, type CardState } from '../../src/domain/loyalty-card';
import { moneyDefaults } from '../../src/domain/money';
import { useColors } from '../../src/state/branding-context';
import { radius, spacing, type as typography } from '../../src/theme';

const t = adminStrings.loyalty;
const ADMIN_LANG = 'es';

function when(iso: string | Date): string {
  return new Date(iso).toLocaleString(moneyDefaults().locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function failureText(cause: unknown): string {
  const f = parseCardError(cause instanceof Error ? cause.message : String(cause));
  switch (f.kind) {
    case 'not_found':
      return t.cardNotFound;
    case 'too_soon':
      return t.alreadyToday(f.nextAt === null ? '' : when(f.nextAt));
    case 'not_enough':
      return t.notEnough;
    case 'reward_gone':
      return t.rewardGone;
    case 'disabled':
      return t.disabledProgram;
    case 'missing_sql':
      return `Falta correr ${MISSING_SQL_FILE} en Supabase (SQL Editor → Run).`;
    case 'staff_only':
      return adminStrings.notMemberTitle;
    default:
      return `${adminStrings.saveFailed}: ${f.detail}`;
  }
}

export default function AdminCustomerCardScreen(): ReactNode {
  const params = useLocalSearchParams<{ c?: string }>();
  const card = typeof params.c === 'string' ? parseCardPayload(params.c) : null;
  const { store } = useAdmin();
  const router = useRouter();
  const colors = useColors();
  const styles = useMemo(() => ({ ...createAdminStyles(colors), ...createStyles(colors) }), [colors]);

  const [state, setState] = useState<CardState | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (card === null) {
      setLoading(false);
      setLoadError(t.invalidCard);
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      setState(await lookupCard(store.id, card));
    } catch (cause) {
      setLoadError(failureText(cause));
    } finally {
      setLoading(false);
    }
  }, [card, store.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (key: string, work: () => Promise<CardState>, ok: (s: CardState) => string): Promise<void> => {
    setBusy(key);
    setNotice(null);
    try {
      const next = await work();
      setState(next);
      setConfirming(null);
      setNotice({ tone: 'ok', text: ok(next) });
    } catch (cause) {
      setNotice({ tone: 'error', text: failureText(cause) });
      // Por si cambió algo (otra tienda sumó, se desactivó la recompensa).
      if (card !== null) void lookupCard(store.id, card).then(setState).catch(() => undefined);
    } finally {
      setBusy(null);
    }
  };

  if (state === null) {
    return (
      <AdminShell scroll={false}>
        {loading ? (
          <DataState loading error={null} empty={false} emptyTitle="">
            {null}
          </DataState>
        ) : (
          <View style={styles.missing}>
            <Notice tone="error" text={loadError ?? t.cardNotFound} />
            <Button label={t.scanAnother} onPress={() => router.replace('/admin/escanear')} />
          </View>
        )}
      </AdminShell>
    );
  }

  const ready = state.rewards.filter((r) => r.eligible);
  const nextVisit = state.next_visit_at === null ? null : new Date(state.next_visit_at);

  return (
    <AdminShell>
      <View style={styles.layout}>
        <View style={styles.column}>
          <View style={styles.hero} testID="ficha-cliente">
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{state.customer.slice(0, 1).toUpperCase()}</Text>
            </View>
            <View style={styles.heroText}>
              <Text style={styles.name}>{state.customer}</Text>
              <Text style={styles.heroHint}>
                {formatCard(state.card)} · {t.visitsCount(state.visits)} · {t.givenCount(state.rewards_given)}
              </Text>
              <Text style={styles.heroHint}>
                {state.last_visit_at === null ? t.neverVisited : t.lastVisit(when(state.last_visit_at))}
              </Text>
            </View>
            <View style={styles.pointsBox}>
              <Text style={styles.pointsValue}>{state.balance}</Text>
              <Text style={styles.pointsLabel}>{t.points}</Text>
            </View>
          </View>

          {notice !== null ? <Notice tone={notice.tone} text={notice.text} /> : null}

          {ready.length > 0 ? (
            <View style={styles.ready} accessibilityRole="alert" testID="ya-tiene-recompensa">
              <Ionicons name="gift" size={32} color={colors.onPrimary} />
              <View style={styles.heroText}>
                <Text style={styles.readyTitle}>{t.readyTitle(state.customer)}</Text>
                <Text style={styles.readyBody}>{t.readyBody}</Text>
              </View>
            </View>
          ) : null}

          <Card title={t.cardTitle}>
            {state.can_visit ? (
              <Button
                label={t.addVisit(state.points_per_visit)}
                busy={busy === 'visit'}
                onPress={() =>
                  void run('visit', () => addVisit(store.id, state.card), (s) => t.visitAdded(s.added ?? 0, s.balance))
                }
                testID="sumar-visita"
              />
            ) : (
              <View style={styles.done}>
                <Ionicons name="checkmark-circle" size={24} color={colors.primary} />
                <Text style={styles.doneText}>{t.alreadyToday(nextVisit === null ? '' : when(nextVisit))}</Text>
              </View>
            )}
            <Button label={t.scanAnother} variant="outline" onPress={() => router.replace('/admin/escanear')} />
          </Card>
        </View>

        <View style={styles.column}>
          <Card title={t.rewardsTitle}>
            {state.rewards.length === 0 ? <Text style={styles.hint}>{t.noRewards}</Text> : null}
            {state.rewards.map((r) => ({ ...r, name: rewardLabel(r, ADMIN_LANG) })).map((reward) => (
              <View key={reward.id} style={[styles.reward, reward.eligible && styles.rewardReady]}>
                <View style={styles.rewardRow}>
                  <Ionicons
                    name={reward.eligible ? 'gift' : 'gift-outline'}
                    size={24}
                    color={reward.eligible ? colors.accent : colors.textMuted}
                  />
                  <View style={styles.heroText}>
                    <Text style={styles.rewardName}>{reward.name}</Text>
                    <Text style={styles.hint}>
                      {reward.cost} pts{reward.eligible ? '' : ` · ${t.missingPts(reward.missing)}`}
                    </Text>
                  </View>
                  {reward.eligible && confirming !== reward.id ? (
                    <Button label={t.give} variant="accent" onPress={() => setConfirming(reward.id)} testID="entregar" />
                  ) : null}
                </View>
                <View style={styles.bar}>
                  <View
                    style={[
                      styles.barFill,
                      { width: `${Math.round(progressTo(state.balance, reward.cost) * 100)}%` },
                      reward.eligible && styles.barReady,
                    ]}
                  />
                </View>
                {confirming === reward.id ? (
                  <View style={styles.confirm}>
                    <Text style={styles.rewardName}>{t.giveConfirm(reward.name, reward.cost)}</Text>
                    <View style={styles.inline}>
                      <Button
                        label={t.giveYes}
                        busy={busy === reward.id}
                        onPress={() =>
                          void run(
                            reward.id,
                            () => giveReward(store.id, state.card, reward.id),
                            (s) => t.given(reward.name, s.customer),
                          )
                        }
                        testID="confirmar-entrega"
                      />
                      <Button label={adminStrings.cancel} variant="outline" onPress={() => setConfirming(null)} />
                    </View>
                  </View>
                ) : null}
              </View>
            ))}
          </Card>
        </View>
      </View>
    </AdminShell>
  );
}

function createStyles(colors: BrandColors) {
  return StyleSheet.create({
    layout: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.lg, alignItems: 'flex-start' },
    column: { flexGrow: 1, flexBasis: 340, minWidth: 0, gap: spacing.lg },
    missing: { padding: spacing.lg, gap: spacing.md, maxWidth: 520, width: '100%', alignSelf: 'center' },
    hero: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      padding: spacing.lg,
      borderRadius: radius.lg,
      backgroundColor: colors.primary,
    },
    avatar: {
      width: 56,
      height: 56,
      borderRadius: 28,
      backgroundColor: colors.onPrimary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    avatarText: { color: colors.primary, fontSize: 26, fontWeight: '800' },
    heroText: { flex: 1, minWidth: 0, gap: 2 },
    name: { color: colors.onPrimary, fontSize: typography.title.fontSize, fontWeight: '800' },
    heroHint: { color: colors.onPrimary, opacity: 0.9, fontSize: typography.label.fontSize },
    pointsBox: { alignItems: 'center' },
    pointsValue: { color: colors.onPrimary, fontSize: 40, fontWeight: '800' },
    pointsLabel: { color: colors.onPrimary, fontSize: typography.caption.fontSize, fontWeight: '800', textTransform: 'uppercase' },
    ready: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      padding: spacing.lg,
      borderRadius: radius.lg,
      backgroundColor: colors.accent,
    },
    readyTitle: { color: colors.onPrimary, fontSize: typography.section.fontSize, fontWeight: '800' },
    readyBody: { color: colors.onPrimary, fontSize: typography.label.fontSize, lineHeight: 19 },
    reward: {
      gap: spacing.sm,
      paddingVertical: spacing.md,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
    },
    rewardReady: {},
    rewardRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    rewardName: { color: colors.text, fontSize: typography.body.fontSize, fontWeight: '700' },
    bar: { height: 8, borderRadius: 4, backgroundColor: colors.border, overflow: 'hidden' },
    barFill: { height: 8, borderRadius: 4, backgroundColor: colors.primary },
    barReady: { backgroundColor: colors.accent },
    confirm: { gap: spacing.sm },
    done: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      padding: spacing.md,
      borderRadius: radius.md,
      backgroundColor: colors.background,
    },
    doneText: { flex: 1, color: colors.text, fontSize: typography.body.fontSize, fontWeight: '600' },
    inline: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  });
}
