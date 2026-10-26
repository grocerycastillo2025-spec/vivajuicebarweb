/**
 * Puerta del Panel del negocio (/admin).
 *
 * Tres casos antes de ensenar nada:
 *   1. sin sesion           -> formulario de entrada
 *   2. sesion de cliente    -> "esta cuenta no administra el negocio"
 *   3. dueño o empleado     -> el panel, con la sucursal resuelta
 *
 * Esto NO es la seguridad: la RLS de la 0020 es la que impide que un
 * cliente lea pedidos ajenos o cambie un precio. Aqui solo se evita
 * ensenarle pantallas que la base le va a negar.
 */

import { Stack } from 'expo-router';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';

import { fetchAdminStores, fetchMembership } from '../../src/api/admin';
import { AdminProvider, type AdminContextValue } from '../../src/admin/admin-context';
import { adminStrings as t } from '../../src/admin/strings';
import { AuthForm } from '../../src/components/AuthForm';
import { DataState } from '../../src/components/DataState';
import { Screen } from '../../src/components/Screen';
import { Button } from '../../src/components/ui';
import { readEnv } from '../../src/env';
import { es as strings } from '../../src/strings';
import { useAsync } from '../../src/hooks/use-async';
import { useColors } from '../../src/state/branding-context';
import { useSession } from '../../src/state/session-context';
import { spacing, type as typography } from '../../src/theme';

/** En web el panel usa mas ancho que la columna de telefono del cliente. */
function useWideLayout(): void {
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return undefined;
    document.body.classList.add('admin-wide');
    const previousTitle = document.title;
    document.title = t.title;
    return () => {
      document.body.classList.remove('admin-wide');
      document.title = previousTitle;
    };
  }, []);
}

export default function AdminLayout(): ReactNode {
  useWideLayout();
  const colors = useColors();
  const { user, loading: sessionLoading, signOut } = useSession();
  const [attempt, setAttempt] = useState(0);

  const load = useCallback(async () => {
    if (user === null) return null;
    const restaurantId = readEnv().restaurantId;
    const membership = await fetchMembership(user.id, restaurantId);
    if (membership === null) return { membership: null, stores: [] };
    const stores = await fetchAdminStores(restaurantId);
    return { membership, stores };
  }, [user]);

  const { data, error, loading, reload } = useAsync(load, [user?.id, attempt]);

  const reloadStore = useCallback(() => setAttempt((n) => n + 1), []);

  const value = useMemo<AdminContextValue | null>(() => {
    const membership = data?.membership;
    const store = data?.stores[0];
    if (membership === null || membership === undefined || store === undefined) return null;
    return {
      restaurantId: membership.restaurantId,
      role: membership.role,
      isOwner: membership.role === 'owner',
      store,
      reloadStore,
    };
  }, [data, reloadStore]);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        gate: { padding: spacing.lg, gap: spacing.lg, maxWidth: 480, width: '100%', alignSelf: 'center' },
        title: { color: colors.text, fontSize: typography.title.fontSize, fontWeight: '800' },
        body: { color: colors.textMuted, fontSize: typography.body.fontSize, lineHeight: 22 },
      }),
    [colors],
  );

  if (sessionLoading || (user !== null && loading && data === null)) {
    return (
      <Screen scroll={false}>
        <DataState loading error={null} empty={false} emptyTitle="">
          {null}
        </DataState>
      </Screen>
    );
  }

  if (user === null) {
    return (
      <Screen scroll={false}>
        <ScrollView contentContainerStyle={styles.gate}>
          <Text style={styles.title}>{t.title}</Text>
          <AuthForm title={t.signInTitle} body={t.signInBody} />
        </ScrollView>
      </Screen>
    );
  }

  if (error !== null) {
    return (
      <Screen scroll={false}>
        <DataState loading={false} error={error} empty={false} onRetry={reload} emptyTitle="">
          {null}
        </DataState>
      </Screen>
    );
  }

  if (data?.membership === null || data?.membership === undefined) {
    return (
      <Screen scroll={false}>
        <View style={styles.gate}>
          <Text style={styles.title}>{t.notMemberTitle}</Text>
          <Text style={styles.body}>{t.notMemberBody(user.email ?? '')}</Text>
          <Button label={strings.auth.signOut} variant="outline" onPress={() => void signOut()} />
        </View>
      </Screen>
    );
  }

  if (value === null) {
    return (
      <Screen scroll={false}>
        <View style={styles.gate}>
          <Text style={styles.title}>{t.noStoreTitle}</Text>
          <Text style={styles.body}>{t.noStoreBody}</Text>
        </View>
      </Screen>
    );
  }

  return (
    <AdminProvider value={value}>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }} />
    </AdminProvider>
  );
}
