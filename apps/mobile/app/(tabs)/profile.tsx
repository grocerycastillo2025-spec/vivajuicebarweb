/**
 * Profile basico: sesion con correo y contrasena (paso 3.5 de
 * docs/PUESTA-EN-MARCHA.md), datos del perfil y sucursal activa.
 *
 * `profiles` se crea sola con el trigger `app.handle_new_user` y RLS solo
 * deja ver la fila propia.
 */

import { useCallback, useMemo, type ReactNode } from 'react';
import { useRouter } from 'expo-router';
import { Alert, StyleSheet, Text, View } from 'react-native';

import { fetchProfile } from '../../src/api/account';
import { fetchMembership, type Membership } from '../../src/api/admin';
import { formatAddress } from '../../src/api/store';
import type { ProfileRow } from '../../src/api/types';
import { AuthForm } from '../../src/components/AuthForm';
import { DataState } from '../../src/components/DataState';
import { LanguageToggle } from '../../src/components/LanguageToggle';
import { Screen } from '../../src/components/Screen';
import { Button } from '../../src/components/ui';
import { PushCard } from '../../src/components/PushCard';
import { ProfileEditor } from '../../src/components/ProfileEditor';
import type { BrandColors } from '../../src/domain/branding';
import { readEnv } from '../../src/env';
import { useAsync } from '../../src/hooks/use-async';
import { useBranding, useColors } from '../../src/state/branding-context';
import { useCart } from '../../src/state/cart-context';
import { usePush } from '../../src/state/push-context';
import { useSession } from '../../src/state/session-context';
import { useStores } from '../../src/state/store-context';
import { radius, spacing, type as typography } from '../../src/theme';
import { strings } from '../../src/strings';

export default function ProfileScreen(): ReactNode {
  const { user, loading: sessionLoading, signOut } = useSession();
  const { itemCount } = useCart();
  const push = usePush();
  const router = useRouter();

  const colors = useColors();
  const { displayName } = useBranding();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { selectedStore, hasChoice } = useStores();

  const load = useCallback(async (): Promise<{
    profile: ProfileRow | null;
    membership: Membership | null;
  }> => {
    if (user === null) return { profile: null, membership: null };
    const [profile, membership] = await Promise.all([
      fetchProfile(user.id),
      // Si falla (base sin la 0020), el perfil se ve igual, sin el panel.
      fetchMembership(user.id, readEnv().restaurantId).catch(() => null),
    ]);
    return { profile, membership };
  }, [user]);

  const { data, error, loading, refreshing, refresh, reload } = useAsync(load, [user?.id]);

  const onSignOut = useCallback(() => {
    void signOut().catch((cause: unknown) => {
      Alert.alert('Error', cause instanceof Error ? cause.message : String(cause));
    });
  }, [signOut]);

  if (sessionLoading || loading || error !== null) {
    return (
      <Screen withTabBar scroll={false}>
        <DataState
          loading={sessionLoading || loading}
          error={error}
          empty={false}
          onRetry={reload}
          emptyTitle=""
        >
          {null}
        </DataState>
      </Screen>
    );
  }

  return (
    <Screen withTabBar refreshing={refreshing} onRefresh={refresh} contentStyle={styles.content}>
      <Text style={styles.title}>{strings.profile.title}</Text>

      <View style={styles.card}>
        <Text style={styles.cardLabel}>{strings.language.title}</Text>
        <LanguageToggle variant="row" />
      </View>

      {user === null ? (
        <AuthForm />
      ) : (
        <ProfileEditor
          key={`${data?.profile?.first_name ?? ''}|${data?.profile?.phone ?? ''}|${data?.profile?.avatar_path ?? ''}`}
          userId={user.id}
          email={user.email}
          profile={data?.profile ?? null}
          onSaved={refresh}
          onSignOut={onSignOut}
        />
      )}

      {data?.membership != null ? (
        <View style={styles.card}>
          <Text style={styles.cardLabel}>{strings.profile.adminTitle}</Text>
          <Text style={styles.cardBody}>{strings.profile.adminBody}</Text>
          <Button label={strings.profile.adminOpen} onPress={() => router.push('/admin')} />
        </View>
      ) : null}

      {selectedStore !== null ? (
        <View style={styles.card}>
          <Text style={styles.cardLabel}>{strings.profile.location}</Text>
          <Text style={styles.cardTitle}>{selectedStore.name}</Text>
          <Text style={styles.cardBody}>{formatAddress(selectedStore)}</Text>
          <Text style={styles.cardBody}>{strings.profile.timezone(selectedStore.timezone)}</Text>
          {hasChoice ? (
            <Button
              label={strings.profile.changeStore}
              variant="outline"
              onPress={() => router.push('/store-picker')}
            />
          ) : null}
        </View>
      ) : null}

      <PushCard state={push.state} onEnable={push.enable} signedIn={user !== null} />

      <View style={styles.card}>
        <Text style={styles.cardLabel}>{strings.profile.cart}</Text>
        <Text style={styles.cardBody}>
          {itemCount === 0 ? strings.profile.cartEmpty : strings.profile.cartCount(itemCount)}
        </Text>
      </View>

      <Text style={styles.footnote}>
        {displayName} · {readEnv().appEnv}
        {'\n'}
        {strings.profile.footnote}
      </Text>
    </Screen>
  );
}

function createStyles(colors: BrandColors) {
  return StyleSheet.create({
    content: { padding: spacing.lg, gap: spacing.lg },
    title: {
      color: colors.text,
      fontSize: typography.display.fontSize,
      fontWeight: '800',
    },
    card: {
      backgroundColor: colors.surface,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.border,
      padding: spacing.lg,
      gap: spacing.md,
    },
    cardLabel: {
      color: colors.textFaint,
      fontSize: typography.caption.fontSize,
      fontWeight: '800',
      letterSpacing: 0.8,
      textTransform: 'uppercase',
    },
    cardTitle: {
      color: colors.text,
      fontSize: typography.section.fontSize,
      fontWeight: '800',
    },
    cardBody: {
      color: colors.textMuted,
      fontSize: typography.body.fontSize,
      lineHeight: 21,
    },
    input: {
      backgroundColor: colors.background,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: spacing.lg,
      minHeight: 48,
      color: colors.text,
      fontSize: typography.body.fontSize,
    },
    footnote: {
      color: colors.textFaint,
      fontSize: typography.caption.fontSize,
      lineHeight: 18,
    },
  });
}
