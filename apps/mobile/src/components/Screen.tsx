/**
 * Contenedor base de TODAS las pantallas.
 *
 * Regla 2 de docs/ANDROID-COMPATIBILIDAD.md: nada de padding fijo para la
 * barra de estado. Android 16 dibuja siempre edge-to-edge y no deja
 * desactivarlo, asi que el margen seguro sale de `useSafeAreaInsets()`.
 * Tambien se aplican los insets laterales, que es lo que hace falta en
 * horizontal con notch — y la orientacion no se bloquea (regla 1).
 */

import { useMemo, type ReactNode } from 'react';
import {
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useColors } from '../state/branding-context';
import { spacing } from '../theme';

interface ScreenProps {
  readonly children: ReactNode;
  /** `false` cuando la pantalla trae su propia lista con scroll. */
  readonly scroll?: boolean;
  /** La barra de pestanas ya reserva su propio hueco inferior. */
  readonly withTabBar?: boolean;
  readonly refreshing?: boolean;
  readonly onRefresh?: () => void;
  readonly contentStyle?: StyleProp<ViewStyle>;
  readonly background?: string;
}

export function Screen({
  children,
  scroll = true,
  withTabBar = false,
  refreshing,
  onRefresh,
  contentStyle,
  background,
}: ScreenProps): ReactNode {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => createStyles(), []);

  const frame: StyleProp<ViewStyle> = {
    flex: 1,
    backgroundColor: background ?? colors.background,
    paddingTop: insets.top,
    paddingLeft: insets.left,
    paddingRight: insets.right,
  };

  // Con barra de pestanas, el inset inferior lo pone react-navigation.
  const bottomPadding = (withTabBar ? 0 : insets.bottom) + spacing.xl;

  if (!scroll) {
    return <View style={frame}>{children}</View>;
  }

  return (
    <View style={frame}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[{ paddingBottom: bottomPadding }, contentStyle]}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          onRefresh === undefined ? undefined : (
            <RefreshControl
              refreshing={refreshing ?? false}
              onRefresh={onRefresh}
              tintColor={colors.primary}
              colors={[colors.primary]}
            />
          )
        }
      >
        {children}
      </ScrollView>
    </View>
  );
}

/** Igual que `Screen` pero devolviendo los insets, para listas propias. */
export function useScreenInsets(): {
  top: number;
  bottom: number;
  left: number;
  right: number;
} {
  const insets = useSafeAreaInsets();
  return insets;
}

function createStyles() {
  return StyleSheet.create({
    scroll: { flex: 1 },
  });
}
