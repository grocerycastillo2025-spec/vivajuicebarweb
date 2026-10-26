/**
 * "Instala la app" en la versión web. Ver src/domain/install.ts: ningún
 * navegador instala solo; esto deja la instalación a uno o dos toques.
 *
 * - Chrome/Edge/Samsung: el botón abre la ventana "Instalar" del navegador.
 * - iPhone: botón "Cómo instalarla" con los pasos de Safari.
 * - WhatsApp/Instagram/Facebook: pide abrir la liga en Safari o Chrome.
 *
 * "Ahora no" lo esconde unos días (en este navegador). La liga del QR
 * trae ?instalar=1 y lo vuelve a mostrar, abierto.
 */

import { Ionicons } from '@expo/vector-icons';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { BrandColors } from '../domain/branding';
import { dismissedRecently, installMode, platformOf, wantsInstall, type InstallMode } from '../domain/install';
import { useColors } from '../state/branding-context';
import { strings } from '../strings';
import { radius, spacing, type as typography } from '../theme';
import { Button } from './ui';

const KEY = 'viva.install.dismissedAt';
type IconName = keyof typeof Ionicons.glyphMap;

interface DeferredPrompt {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}
type InstallWindow = Window & { __vivaInstallPrompt?: DeferredPrompt | null; __vivaInstalled?: boolean };

function readDismissed(): number | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw === null ? null : Number(raw);
  } catch {
    return null;
  }
}
function writeDismissed(at: number): void {
  try {
    window.localStorage.setItem(KEY, String(at));
  } catch {
    // Sin almacenamiento (modo privado): solo se esconde por esta vez.
  }
}

function currentMode(): InstallMode {
  const w = window as InstallWindow;
  const standalone =
    w.__vivaInstalled === true ||
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return installMode({
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints,
    standalone,
    hasPrompt: w.__vivaInstallPrompt != null,
  });
}

export function InstallBanner(): ReactNode {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const fromQr = useMemo(() => wantsInstall(window.location.search), []);
  const [mode, setMode] = useState<InstallMode>(() => currentMode());
  const [hidden, setHidden] = useState(() => !fromQr && dismissedRecently(readDismissed(), Date.now()));
  const [open, setOpen] = useState(fromQr);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const update = (): void => setMode(currentMode());
    window.addEventListener('viva-install-ready', update);
    return () => window.removeEventListener('viva-install-ready', update);
  }, []);

  if (hidden || mode === 'installed' || mode === 'none') return null;

  const dismiss = (): void => {
    writeDismissed(Date.now());
    setHidden(true);
  };

  const install = async (): Promise<void> => {
    const w = window as InstallWindow;
    const deferred = w.__vivaInstallPrompt;
    if (deferred == null) {
      setOpen(true);
      return;
    }
    await deferred.prompt();
    const choice = await deferred.userChoice;
    // El aviso del navegador se usa una sola vez.
    w.__vivaInstallPrompt = null;
    if (choice.outcome === 'accepted') setHidden(true);
    setMode(currentMode());
  };

  const copyLink = async (): Promise<void> => {
    const url = window.location.origin + window.location.pathname;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const ios = platformOf(navigator.userAgent, navigator.maxTouchPoints) === 'ios';
  const steps = ios ? strings.install.iosSteps : strings.install.androidSteps;

  return (
    <View style={styles.card} accessibilityRole="summary">
      <View style={styles.head}>
        <View style={styles.badge}>
          <Ionicons name="phone-portrait-outline" size={22} color={colors.onPrimary} />
        </View>
        <View style={styles.headText}>
          <Text style={styles.title}>{mode === 'in_app' ? strings.install.inAppTitle : strings.install.title}</Text>
          <Text style={styles.body}>
            {mode === 'in_app'
              ? ios
                ? strings.install.inAppIos
                : strings.install.inAppAndroid
              : strings.install.body}
          </Text>
        </View>
        <Pressable
          onPress={dismiss}
          accessibilityRole="button"
          accessibilityLabel={strings.install.close}
          hitSlop={12}
        >
          <Ionicons name="close" size={20} color={colors.textMuted} />
        </Pressable>
      </View>

      {mode === 'in_app' ? (
        <View style={styles.actions}>
          <Button label={strings.install.copy} variant="outline" onPress={() => void copyLink()} />
          {copied ? <Text style={styles.note}>{strings.install.copied}</Text> : null}
        </View>
      ) : open && mode !== 'prompt' ? (
        <View style={styles.steps}>
          {steps.map((step, index) => (
            <View key={step.text} style={styles.step}>
              <View style={styles.stepNumber}>
                <Text style={styles.stepNumberText}>{index + 1}</Text>
              </View>
              <Ionicons name={step.icon as IconName} size={22} color={colors.primary} />
              <Text style={styles.stepText}>{step.text}</Text>
            </View>
          ))}
        </View>
      ) : (
        <View style={styles.actions}>
          <Button
            label={mode === 'prompt' ? strings.install.install : strings.install.howTo}
            onPress={() => (mode === 'prompt' ? void install() : setOpen(true))}
          />
          <Pressable onPress={dismiss} accessibilityRole="button" hitSlop={8}>
            <Text style={styles.later}>{strings.install.later}</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

function createStyles(colors: BrandColors) {
  return StyleSheet.create({
    card: {
      backgroundColor: colors.surface,
      borderRadius: radius.lg,
      borderWidth: 2,
      borderColor: colors.primary,
      padding: spacing.lg,
      gap: spacing.md,
    },
    head: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
    badge: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: colors.primary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    headText: { flex: 1, minWidth: 0, gap: 2 },
    title: { color: colors.text, fontSize: typography.body.fontSize + 2, fontWeight: '800' },
    body: { color: colors.textMuted, fontSize: typography.label.fontSize, lineHeight: 19 },
    actions: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg, flexWrap: 'wrap' },
    later: { color: colors.textMuted, fontSize: typography.label.fontSize, fontWeight: '700' },
    note: { color: colors.textMuted, fontSize: typography.caption.fontSize, flexBasis: '100%' },
    steps: { gap: spacing.sm },
    step: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    stepNumber: {
      width: 24,
      height: 24,
      borderRadius: 12,
      backgroundColor: colors.primary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    stepNumberText: { color: colors.onPrimary, fontSize: 13, fontWeight: '800' },
    stepText: { flex: 1, color: colors.text, fontSize: typography.label.fontSize, lineHeight: 19 },
  });
}
