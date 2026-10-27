/**
 * Piezas del Panel del negocio: el marco con pestañas, tarjetas y campos
 * de formulario. Mismos colores de marca que la app del cliente.
 */

import { Ionicons } from '@expo/vector-icons';
import { usePathname, useRouter } from 'expo-router';
import { useMemo, useState, type ReactNode } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  useWindowDimensions,
  type KeyboardTypeOptions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { BrandColors } from '../domain/branding';
import { useBranding, useColors } from '../state/branding-context';
import { useSession } from '../state/session-context';
import { radius, spacing, type as typography } from '../theme';
import { useAdmin } from './admin-context';
import { setAdminLanguage, useAdminLanguage } from './language';
import { adminStrings as t } from './strings';

type Tab = { readonly href: '/admin' | '/admin/tienda' | '/admin/menu' | '/admin/historias' | '/admin/estadisticas' | '/admin/lealtad' | '/admin/business' | '/admin/comunidad'; readonly label: keyof typeof t.tabs; readonly icon: keyof typeof Ionicons.glyphMap; readonly ownerOnly: boolean };

const TABS: readonly Tab[] = [
  { href: '/admin', label: 'orders', icon: 'receipt-outline', ownerOnly: false },
  { href: '/admin/tienda', label: 'store', icon: 'toggle-outline', ownerOnly: false },
  { href: '/admin/menu', label: 'menu', icon: 'restaurant-outline', ownerOnly: true },
  { href: '/admin/historias', label: 'stories', icon: 'images-outline', ownerOnly: true },
  { href: '/admin/estadisticas', label: 'stats', icon: 'stats-chart-outline', ownerOnly: true },
  { href: '/admin/lealtad', label: 'loyalty', icon: 'gift-outline', ownerOnly: false },
  { href: '/admin/comunidad', label: 'community', icon: 'chatbubbles-outline', ownerOnly: true },
  { href: '/admin/business', label: 'business', icon: 'storefront-outline', ownerOnly: true },
];

export function AdminShell({
  children,
  scroll = true,
  actions,
}: {
  readonly children: ReactNode;
  readonly scroll?: boolean;
  readonly actions?: ReactNode;
}): ReactNode {
  const colors = useColors();
  const styles = useMemo(() => createAdminStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const pathname = usePathname();
  const { displayName } = useBranding();
  const { isOwner, store } = useAdmin();
  const lang = useAdminLanguage();
  const { user, signOut } = useSession();
  const { width } = useWindowDimensions();
  // En teléfono los botones del encabezado quedan solo con su ícono.
  const compact = width < 640;
  const [leaving, setLeaving] = useState(false);

  // La sesión es la misma en la app y en el panel: salir aquí sale de las dos.
  const leave = async (): Promise<void> => {
    setLeaving(true);
    try {
      await signOut();
    } finally {
      setLeaving(false);
      router.replace('/profile');
    }
  };

  const active = (href: string): boolean =>
    href === '/admin'
      ? pathname === '/admin' || pathname === '/admin/'
      : pathname.startsWith(href) ||
        (href === '/admin/lealtad' && (pathname.startsWith('/admin/cliente') || pathname.startsWith('/admin/escanear')));

  const body = <View style={styles.body}>{children}</View>;

  return (
    <View style={[styles.frame, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <View style={styles.headerText}>
            <Text style={styles.kicker}>{t.title}</Text>
            <Text style={styles.brand} numberOfLines={1}>
              {store.name === displayName ? displayName : `${displayName} · ${store.name}`}
            </Text>
            {user?.email ? (
              <Text style={styles.who} numberOfLines={1} testID="panel-quien">
                {user.email} · {isOwner ? t.team.owner : t.team.staff}
              </Text>
            ) : null}
          </View>
          <View style={styles.langSwitch} accessibilityRole="radiogroup" accessibilityLabel={t.language}>
            {(['es', 'en'] as const).map((code) => (
              <Pressable
                key={code}
                accessibilityRole="radio"
                accessibilityState={{ checked: lang === code }}
                accessibilityLabel={code === 'es' ? 'Español' : 'English'}
                onPress={() => setAdminLanguage(code)}
                testID={`panel-idioma-${code}`}
                style={[styles.langOption, lang === code && styles.langOptionOn]}
              >
                <Text style={[styles.langText, lang === code && styles.langTextOn]}>{code.toUpperCase()}</Text>
              </Pressable>
            ))}
          </View>
          <Pressable
            accessibilityRole="link"
            accessibilityLabel={t.backToApp}
            onPress={() => router.replace('/')}
            style={({ pressed }) => [styles.backLink, pressed && styles.pressed]}
          >
            <Ionicons name="phone-portrait-outline" size={16} color={colors.onPrimary} />
            {compact ? null : <Text style={styles.backLinkText}>{t.backToApp}</Text>}
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t.signOut}
            disabled={leaving}
            onPress={() => void leave()}
            testID="panel-salir"
            style={({ pressed }) => [styles.backLink, pressed && styles.pressed]}
          >
            <Ionicons name="log-out-outline" size={16} color={colors.onPrimary} />
            {compact ? null : <Text style={styles.backLinkText}>{t.signOut}</Text>}
          </Pressable>
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabs}>
          {TABS.filter((tab) => isOwner || !tab.ownerOnly).map((tab) => {
            const on = active(tab.href);
            return (
              <Pressable
                key={tab.href}
                accessibilityRole="tab"
                accessibilityState={{ selected: on }}
                onPress={() => router.replace(tab.href)}
                style={({ pressed }) => [styles.tab, on && styles.tabOn, pressed && styles.pressed]}
              >
                <Ionicons name={tab.icon} size={18} color={on ? colors.primary : colors.onPrimary} />
                <Text style={[styles.tabText, on && styles.tabTextOn]}>{t.tabs[tab.label]}</Text>
              </Pressable>
            );
          })}
          {actions}
        </ScrollView>
      </View>
      {scroll ? (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={[styles.scrollContent, { paddingBottom: insets.bottom + spacing.xxl }]}
          keyboardShouldPersistTaps="handled"
        >
          {body}
        </ScrollView>
      ) : (
        body
      )}
    </View>
  );
}

export function Card({
  title,
  children,
  right,
}: {
  readonly title?: string;
  readonly children: ReactNode;
  readonly right?: ReactNode;
}): ReactNode {
  const colors = useColors();
  const styles = useMemo(() => createAdminStyles(colors), [colors]);
  return (
    <View style={styles.card}>
      {title !== undefined ? (
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle}>{title}</Text>
          {right}
        </View>
      ) : null}
      {children}
    </View>
  );
}

export function Field({
  label,
  value,
  onChangeText,
  placeholder,
  error,
  hint,
  multiline = false,
  keyboardType,
  autoCapitalize,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChangeText: (text: string) => void;
  readonly placeholder?: string;
  readonly error?: string | null;
  readonly hint?: string;
  readonly multiline?: boolean;
  readonly keyboardType?: KeyboardTypeOptions;
  readonly autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
}): ReactNode {
  const colors = useColors();
  const styles = useMemo(() => createAdminStyles(colors), [colors]);
  const hasError = error !== undefined && error !== null && error !== '';
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textFaint}
        multiline={multiline}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        accessibilityLabel={label}
        style={[styles.input, multiline && styles.inputMultiline, hasError && styles.inputError]}
      />
      {hasError ? <Text style={styles.error}>{error}</Text> : null}
      {!hasError && hint !== undefined ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

export function Toggle({
  label,
  hint,
  value,
  onValueChange,
  disabled = false,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly value: boolean;
  readonly onValueChange: (value: boolean) => void;
  readonly disabled?: boolean;
}): ReactNode {
  const colors = useColors();
  const styles = useMemo(() => createAdminStyles(colors), [colors]);
  return (
    <View style={styles.toggleRow}>
      <View style={styles.toggleText}>
        <Text style={styles.toggleLabel}>{label}</Text>
        {hint !== undefined ? <Text style={styles.hint}>{hint}</Text> : null}
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        accessibilityLabel={label}
        trackColor={{ false: colors.border, true: colors.primary }}
        thumbColor="#FFFFFF"
        {...({ activeThumbColor: '#FFFFFF' } as object)}
      />
    </View>
  );
}

/** Aviso de exito o de error, pegado al boton que lo provoco. */
export function Notice({
  tone,
  text,
}: {
  readonly tone: 'ok' | 'error' | 'info';
  readonly text: string;
}): ReactNode {
  const colors = useColors();
  const styles = useMemo(() => createAdminStyles(colors), [colors]);
  return (
    <View
      style={[
        styles.notice,
        tone === 'error' ? styles.noticeError : tone === 'info' ? { borderColor: colors.border } : styles.noticeOk,
      ]}
    >
      <Ionicons
        name={tone === 'error' ? 'alert-circle' : tone === 'info' ? 'information-circle' : 'checkmark-circle'}
        size={18}
        color={tone === 'error' ? colors.danger : tone === 'info' ? colors.textMuted : colors.success}
      />
      <Text style={styles.noticeText}>{text}</Text>
    </View>
  );
}

/** Boton pequeño con icono, para acciones dentro de una fila. */
export function IconButton({
  icon,
  label,
  onPress,
  tone = 'default',
  disabled = false,
}: {
  readonly icon: keyof typeof Ionicons.glyphMap;
  readonly label: string;
  readonly onPress: () => void;
  readonly tone?: 'default' | 'danger';
  readonly disabled?: boolean;
}): ReactNode {
  const colors = useColors();
  const styles = useMemo(() => createAdminStyles(colors), [colors]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      disabled={disabled}
      hitSlop={8}
      style={({ pressed }) => [styles.iconButton, pressed && styles.pressed, disabled && styles.disabled]}
    >
      <Ionicons name={icon} size={18} color={tone === 'danger' ? colors.danger : colors.text} />
    </Pressable>
  );
}

export function createAdminStyles(colors: BrandColors) {
  return StyleSheet.create({
    frame: { flex: 1, backgroundColor: colors.background },
    header: {
      backgroundColor: colors.primary,
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.md,
      gap: spacing.md,
    },
    headerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    headerText: { flex: 1, minWidth: 0 },
    kicker: {
      color: colors.onPrimary,
      opacity: 0.8,
      fontSize: typography.caption.fontSize,
      fontWeight: '700',
      textTransform: 'uppercase',
      letterSpacing: 0.8,
    },
    brand: { color: colors.onPrimary, fontSize: typography.section.fontSize, fontWeight: '800' },
    who: { color: colors.onPrimary, opacity: 0.8, fontSize: typography.caption.fontSize + 1 },
    backLink: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: spacing.md,
      paddingVertical: 6,
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.4)',
      flexShrink: 0,
    },
    backLinkText: { color: colors.onPrimary, fontSize: typography.label.fontSize, fontWeight: '700' },
    langSwitch: {
      flexDirection: 'row',
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.4)',
      overflow: 'hidden',
      flexShrink: 0,
    },
    langOption: { paddingHorizontal: spacing.md, paddingVertical: 6, minWidth: 44, alignItems: 'center' },
    langOptionOn: { backgroundColor: colors.onPrimary },
    langText: { color: colors.onPrimary, fontSize: typography.label.fontSize, fontWeight: '800' },
    langTextOn: { color: colors.primary },
    tabs: { flexDirection: 'row', gap: spacing.xs, alignItems: 'flex-end' },
    tab: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm + 2,
      borderTopLeftRadius: radius.md,
      borderTopRightRadius: radius.md,
      flexShrink: 0,
    },
    tabOn: { backgroundColor: colors.background },
    tabText: { color: colors.onPrimary, fontSize: typography.label.fontSize + 1, fontWeight: '700' },
    tabTextOn: { color: colors.primary },
    pressed: { opacity: 0.7 },
    disabled: { opacity: 0.4 },

    scroll: { flex: 1 },
    scrollContent: { padding: spacing.lg },
    body: { flex: 1, gap: spacing.lg },

    card: {
      backgroundColor: colors.surface,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.border,
      padding: spacing.lg,
      gap: spacing.md,
    },
    cardHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    cardTitle: {
      flex: 1,
      minWidth: 0,
      color: colors.text,
      fontSize: typography.section.fontSize,
      fontWeight: '800',
    },

    field: { gap: 6 },
    label: { color: colors.text, fontSize: typography.label.fontSize, fontWeight: '700' },
    input: {
      minHeight: 46,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.background,
      color: colors.text,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      fontSize: typography.body.fontSize,
    },
    inputMultiline: { minHeight: 84, textAlignVertical: 'top' },
    inputError: { borderColor: colors.danger },
    error: { color: colors.danger, fontSize: typography.caption.fontSize, fontWeight: '600' },
    hint: { color: colors.textMuted, fontSize: typography.caption.fontSize, lineHeight: 17 },

    toggleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    toggleText: { flex: 1, minWidth: 0, gap: 2 },
    toggleLabel: { color: colors.text, fontSize: typography.body.fontSize, fontWeight: '600' },

    notice: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      padding: spacing.md,
      borderRadius: radius.md,
      borderWidth: 1,
    },
    noticeOk: { borderColor: colors.success, backgroundColor: colors.surface },
    noticeError: { borderColor: colors.danger, backgroundColor: colors.surface },
    noticeText: { flex: 1, minWidth: 0, color: colors.text, fontSize: typography.label.fontSize },

    iconButton: {
      width: 34,
      height: 34,
      borderRadius: radius.pill,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.background,
      flexShrink: 0,
    },
  });
}
