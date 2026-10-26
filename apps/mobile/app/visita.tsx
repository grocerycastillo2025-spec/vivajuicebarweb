/**
 * /visita?s=<sucursal>&c=<codigo> — a donde lleva el QR del local.
 *
 * Llega de dos maneras: desde el escaner de la app o abriendo el enlace
 * con la camara del telefono. En las dos, si no hay sesion se pide entrar
 * y despues se suma la visita sin volver a escanear.
 *
 * La visita se reclama UNA vez por montaje: un re-render no debe volver a
 * llamar a la base (que de todos modos respondera "ya registraste").
 */

import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { claimVisit, type VisitResult } from '../src/api/loyalty';
import { AuthForm } from '../src/components/AuthForm';
import { Screen } from '../src/components/Screen';
import { Button } from '../src/components/ui';
import type { BrandColors } from '../src/domain/branding';
import { moneyDefaults } from '../src/domain/money';
import { parseVisitError, toPayload, type VisitFailure } from '../src/domain/visit';
import { useColors } from '../src/state/branding-context';
import { useSession } from '../src/state/session-context';
import { strings } from '../src/strings';
import { radius, spacing, type as typography } from '../src/theme';

type State =
  | { readonly kind: 'idle' }
  | { readonly kind: 'claiming' }
  | { readonly kind: 'done'; readonly result: VisitResult }
  | { readonly kind: 'failed'; readonly failure: VisitFailure };

function formatWhen(date: Date): string {
  const { locale } = moneyDefaults();
  return date.toLocaleString(locale, { weekday: 'long', hour: 'numeric', minute: '2-digit' });
}

export default function VisitScreen(): ReactNode {
  const params = useLocalSearchParams<{ s?: string; c?: string }>();
  const payload = useMemo(() => toPayload(params.s, params.c), [params.s, params.c]);
  const { user, loading: sessionLoading } = useSession();
  const router = useRouter();
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [state, setState] = useState<State>({ kind: 'idle' });
  const claimedFor = useRef<string | null>(null);

  useEffect(() => {
    if (payload === null || user === null) return;
    const key = `${user.id}:${payload.storeId}:${payload.code}`;
    if (claimedFor.current === key) return;
    claimedFor.current = key;

    setState({ kind: 'claiming' });
    claimVisit(payload)
      .then((result) => setState({ kind: 'done', result }))
      .catch((cause: unknown) =>
        setState({
          kind: 'failed',
          failure: parseVisitError(cause instanceof Error ? cause.message : String(cause)),
        }),
      );
  }, [payload, user]);

  const goRewards = (): void => router.replace('/rewards');

  let body: ReactNode;
  if (payload === null) {
    body = <Result icon="alert-circle" tone="danger" title={strings.visit.badLinkTitle} styles={styles} colors={colors} />;
  } else if (sessionLoading) {
    body = <ActivityIndicator color={colors.primary} />;
  } else if (user === null) {
    body = <AuthForm title={strings.visit.signInTitle} body={strings.visit.signInBody} />;
  } else if (state.kind === 'done') {
    body = (
      <Result
        icon="sparkles"
        tone="ok"
        title={strings.visit.successTitle(state.result.points)}
        body={`${strings.visit.successBody(state.result.balance)}\n${strings.visit.nextVisit(formatWhen(new Date(state.result.next_at)))}`}
        styles={styles}
        colors={colors}
      />
    );
  } else if (state.kind === 'failed') {
    const f = state.failure;
    body =
      f.kind === 'too_soon' ? (
        <Result
          icon="time-outline"
          tone="muted"
          title={strings.visit.tooSoonTitle}
          body={f.nextAt === null ? strings.visit.tooSoonNoDate : strings.visit.tooSoonBody(formatWhen(f.nextAt))}
          styles={styles}
          colors={colors}
        />
      ) : f.kind === 'invalid_code' ? (
        <Result icon="qr-code-outline" tone="danger" title={strings.visit.invalidTitle} body={strings.visit.invalidBody} styles={styles} colors={colors} />
      ) : f.kind === 'staff_scans' ? (
        <Result icon="qr-code-outline" tone="muted" title={strings.visit.staffScansTitle} body={strings.visit.staffScansBody} styles={styles} colors={colors} />
      ) : f.kind === 'loyalty_disabled' ? (
        <Result icon="pause-circle-outline" tone="muted" title={strings.visit.disabledTitle} body={strings.visit.disabledBody} styles={styles} colors={colors} />
      ) : (
        <Result
          icon="alert-circle"
          tone="danger"
          title={strings.visit.failed}
          body={f.kind === 'unknown' ? f.detail : undefined}
          styles={styles}
          colors={colors}
        />
      );
  } else {
    body = (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} />
        <Text style={styles.body}>{strings.visit.claiming}</Text>
      </View>
    );
  }

  const finished = state.kind === 'done' || state.kind === 'failed' || payload === null;

  return (
    <Screen contentStyle={styles.content}>
      <Text style={styles.heading}>{strings.visit.title}</Text>
      {body}
      {finished ? <Button label={strings.visit.seeRewards} onPress={goRewards} /> : null}
    </Screen>
  );
}

function Result({
  icon,
  tone,
  title,
  body,
  styles,
  colors,
}: {
  readonly icon: keyof typeof Ionicons.glyphMap;
  readonly tone: 'ok' | 'muted' | 'danger';
  readonly title: string;
  readonly body?: string | undefined;
  readonly styles: ReturnType<typeof createStyles>;
  readonly colors: BrandColors;
}): ReactNode {
  const color = tone === 'ok' ? colors.primary : tone === 'danger' ? colors.danger : colors.textMuted;
  return (
    <View style={[styles.card, tone === 'ok' && styles.cardOk]}>
      <Ionicons name={icon} size={48} color={tone === 'ok' ? colors.onPrimary : color} />
      <Text style={[styles.title, tone === 'ok' && styles.onPrimary]}>{title}</Text>
      {body !== undefined ? <Text style={[styles.body, tone === 'ok' && styles.onPrimary]}>{body}</Text> : null}
    </View>
  );
}

function createStyles(colors: BrandColors) {
  return StyleSheet.create({
    content: { padding: spacing.lg, gap: spacing.lg },
    heading: { color: colors.text, fontSize: typography.title.fontSize, fontWeight: '800' },
    center: { alignItems: 'center', gap: spacing.md, paddingVertical: spacing.xl },
    card: {
      alignItems: 'center',
      gap: spacing.sm,
      padding: spacing.xl,
      borderRadius: radius.lg,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
    },
    cardOk: { backgroundColor: colors.primary, borderColor: colors.primary },
    title: { color: colors.text, fontSize: typography.display.fontSize, fontWeight: '800', textAlign: 'center' },
    body: { color: colors.textMuted, fontSize: typography.body.fontSize, textAlign: 'center', lineHeight: 22 },
    onPrimary: { color: colors.onPrimary },
  });
}
