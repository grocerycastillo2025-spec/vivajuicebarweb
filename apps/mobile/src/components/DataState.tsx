/**
 * Estados de una consulta a datos: cargando, error o vacio.
 *
 * Existe porque una pantalla en blanco no distingue "no hay productos" de
 * "no hay conexion" de "faltan permisos", y las tres se arreglan de forma
 * distinta. `classifyError` decide cual es; esto lo pinta.
 */

import { Ionicons } from '@expo/vector-icons';
import { useMemo, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { BrandColors } from '../domain/branding';
import { classifyError, type DataErrorKind } from '../domain/errors';
import { useColors } from '../state/branding-context';
import { strings } from '../strings';
import { radius, spacing, type as typography } from '../theme';
import { Button, Loading } from './ui';

type IconName = keyof typeof Ionicons.glyphMap;

/** La copia vive en strings; el dominio solo clasifica. Se lee al pintar (idioma). */
function copyFor(kind: DataErrorKind): { title: string; message: string; hint: string } {
  const t = strings.dataError;
  switch (kind) {
    case 'config':
      return t.config;
    case 'auth':
      return t.auth;
    case 'permission':
      return t.permission;
    case 'offline':
      return t.offline;
    case 'not-found':
      return t.notFound;
    case 'server':
      return t.server;
    default:
      return t.unknown;
  }
}

const ICONS: Record<DataErrorKind, IconName> = {
  config: 'construct-outline',
  auth: 'key-outline',
  permission: 'lock-closed-outline',
  offline: 'cloud-offline-outline',
  'not-found': 'file-tray-outline',
  server: 'server-outline',
  unknown: 'alert-circle-outline',
};

export function ErrorState({
  error,
  onRetry,
}: {
  readonly error: unknown;
  readonly onRetry?: () => void;
}): ReactNode {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [showDetail, setShowDetail] = useState(false);

  const classified = classifyError(error);
  const copy = copyFor(classified.kind);

  // Cuando el mensaje original ya explica el problema en terminos utiles
  // (la clave secreta, por ejemplo) se ensena tal cual.
  const message = classified.useDetailAsMessage ? classified.detail : copy.message;

  return (
    <View style={styles.center}>
      <View style={styles.iconCircle}>
        <Ionicons name={ICONS[classified.kind]} size={30} color={colors.primary} />
      </View>

      <Text style={styles.title}>{copy.title}</Text>
      <Text style={styles.message}>{message}</Text>
      <Text style={styles.hint}>{copy.hint}</Text>

      {classified.retryable && onRetry !== undefined ? (
        <Button
          label={strings.common.retry}
          onPress={onRetry}
          variant="outline"
          style={styles.action}
        />
      ) : null}

      {/* El detalle tecnico existe pero no grita: sirve para el reporte. */}
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: showDetail }}
        onPress={() => setShowDetail((current) => !current)}
        hitSlop={8}
        style={styles.detailToggle}
      >
        <Text style={styles.detailToggleText}>
          {showDetail ? strings.common.hideTechnicalDetail : strings.common.technicalDetail}
        </Text>
      </Pressable>

      {showDetail ? (
        <View style={styles.detailBox}>
          <Text selectable style={styles.detailText}>
            {classified.code === null
              ? classified.detail
              : `[${classified.code}] ${classified.detail}`}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

interface DataStateProps {
  readonly loading: boolean;
  readonly error: unknown;
  /** `true` cuando la consulta fue bien pero no devolvio nada. */
  readonly empty: boolean;
  readonly onRetry?: () => void;
  readonly loadingLabel?: string;
  readonly emptyTitle: string;
  readonly emptyBody?: string;
  readonly emptyAction?: ReactNode;
  readonly children: ReactNode;
}

/**
 * Decide que ensenar. El orden importa: primero se resuelve el error,
 * porque un fallo que devuelve una lista vacia NO es "no hay productos".
 */
export function DataState({
  loading,
  error,
  empty,
  onRetry,
  loadingLabel,
  emptyTitle,
  emptyBody,
  emptyAction,
  children,
}: DataStateProps): ReactNode {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);

  if (error !== null && error !== undefined) {
    return <ErrorState error={error} {...(onRetry === undefined ? {} : { onRetry })} />;
  }

  if (loading) {
    return <Loading {...(loadingLabel === undefined ? {} : { label: loadingLabel })} />;
  }

  if (empty) {
    return (
      <View style={styles.center}>
        <View style={styles.iconCircle}>
          <Ionicons name="basket-outline" size={30} color={colors.primary} />
        </View>
        <Text style={styles.title}>{emptyTitle}</Text>
        {emptyBody !== undefined ? <Text style={styles.message}>{emptyBody}</Text> : null}
        {emptyAction}
        {onRetry !== undefined ? (
          <Button
            label={strings.common.refresh}
            onPress={onRetry}
            variant="outline"
            style={styles.action}
          />
        ) : null}
      </View>
    );
  }

  return children;
}

function createStyles(colors: BrandColors) {
  return StyleSheet.create({
    center: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: spacing.xl,
      gap: spacing.sm,
    },
    iconCircle: {
      width: 64,
      height: 64,
      borderRadius: radius.pill,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      marginBottom: spacing.sm,
    },
    title: {
      color: colors.text,
      fontSize: typography.section.fontSize,
      fontWeight: '800',
      textAlign: 'center',
    },
    message: {
      color: colors.textMuted,
      fontSize: typography.body.fontSize,
      textAlign: 'center',
      lineHeight: 21,
    },
    hint: {
      color: colors.textFaint,
      fontSize: typography.caption.fontSize,
      textAlign: 'center',
      lineHeight: 18,
      maxWidth: 340,
    },
    action: { marginTop: spacing.md, alignSelf: 'center' },
    detailToggle: { marginTop: spacing.lg, padding: spacing.sm },
    detailToggleText: {
      color: colors.textFaint,
      fontSize: typography.caption.fontSize,
      textDecorationLine: 'underline',
    },
    detailBox: {
      backgroundColor: colors.surface,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      padding: spacing.md,
      maxWidth: 420,
    },
    detailText: {
      color: colors.textMuted,
      fontSize: typography.caption.fontSize,
      fontFamily: 'monospace',
    },
  });
}
