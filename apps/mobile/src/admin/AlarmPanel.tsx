/**
 * Panel → Pedidos → "Alertas": cómo avisa ESTE dispositivo cuando entra
 * un pedido (sonido, volumen, repetir, vibrar, avisos, pantalla encendida).
 */

import { Ionicons } from '@expo/vector-icons';
import { useMemo, useState, type ReactNode } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Button } from '../components/ui';
import type { BrandColors } from '../domain/branding';
import type { AlarmSettings, AlarmSound, AlarmVolume } from '../domain/alerts';
import {
  askNotificationPermission,
  canVibrate,
  loadCustomSound,
  notificationPermission,
  pickSoundFile,
  saveCustomSound,
  unlockSound,
  wakeLockSupported,
} from '../lib/alerts';
import { useColors } from '../state/branding-context';
import { radius, spacing, type as typography } from '../theme';
import { ringOnce } from './order-alarm';
import { adminStrings } from './strings';
import { Toggle } from './ui';

const t = adminStrings.alarm;

export function AlarmPanel({
  visible,
  settings,
  onChange,
  onClose,
}: {
  readonly visible: boolean;
  readonly settings: AlarmSettings;
  readonly onChange: (next: AlarmSettings) => void;
  readonly onClose: () => void;
}): ReactNode {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [hasCustom, setHasCustom] = useState(() => loadCustomSound() !== null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [permission, setPermission] = useState(() => notificationPermission());

  const set = (patch: Partial<AlarmSettings>): void => onChange({ ...settings, ...patch });

  const chip = <V extends string | number>(value: V, current: V, label: string, onPress: () => void): ReactNode => (
    <Pressable
      key={String(value)}
      accessibilityRole="radio"
      accessibilityState={{ checked: value === current }}
      onPress={onPress}
      style={[styles.chip, value === current && styles.chipOn]}
    >
      <Text style={[styles.chipText, value === current && styles.chipTextOn]}>{label}</Text>
    </Pressable>
  );

  const upload = async (): Promise<void> => {
    setMessage(null);
    const picked = await pickSoundFile();
    if (picked === null) return;
    if ('error' in picked) {
      setMessage({ ok: false, text: picked.error === 'too_big' ? t.tooBig : t.notAudio });
      return;
    }
    if (!saveCustomSound(picked.dataUrl)) {
      setMessage({ ok: false, text: t.saveFailed });
      return;
    }
    setHasCustom(true);
    const next = { ...settings, sound: 'propio' as AlarmSound };
    onChange(next);
    setMessage({ ok: true, text: t.uploaded });
    void unlockSound().then(() => ringOnce(next));
  };

  const toggleNotify = async (on: boolean): Promise<void> => {
    if (!on) return set({ notify: false });
    const result = await askNotificationPermission();
    setPermission(result);
    set({ notify: result === 'granted' });
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet} testID="alertas">
          <View style={styles.head}>
            <Text style={styles.title}>{t.title}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel={t.close} onPress={onClose} hitSlop={12} style={styles.x}>
              <Ionicons name="close" size={26} color={colors.textMuted} />
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.body}>
            <Text style={styles.label}>{t.sound}</Text>
            <View style={styles.chips}>
              {(['alarma', 'timbre', 'campana'] as const).map((s) => chip(s, settings.sound, t.sounds[s] ?? s, () => set({ sound: s })))}
              {hasCustom ? chip('propio' as AlarmSound, settings.sound, t.sounds['propio'] ?? '', () => set({ sound: 'propio' })) : null}
            </View>
            <View style={styles.row}>
              <Button
                label={t.test}
                variant="outline"
                onPress={() => void unlockSound().then(() => ringOnce(settings))}
                testID="probar-sonido"
              />
              <Button label={t.upload} variant="outline" onPress={() => void upload()} />
              {hasCustom ? (
                <Pressable
                  onPress={() => {
                    saveCustomSound(null);
                    setHasCustom(false);
                    if (settings.sound === 'propio') set({ sound: 'alarma' });
                  }}
                  style={styles.link}
                >
                  <Text style={styles.linkText}>{t.removeCustom}</Text>
                </Pressable>
              ) : null}
            </View>
            <Text style={styles.hint}>{t.uploadHint}</Text>
            {message !== null ? (
              <Text style={[styles.hint, { color: message.ok ? colors.success : colors.danger }]}>{message.text}</Text>
            ) : null}

            <Text style={styles.label}>{t.volume}</Text>
            <View style={styles.chips}>
              {(['medio', 'alto', 'maximo'] as const).map((v) =>
                chip(v, settings.volume, t.volumes[v] ?? v, () => set({ volume: v as AlarmVolume })),
              )}
            </View>
            <Text style={styles.hint}>{t.volumeHint}</Text>

            <Text style={styles.label}>{t.repeat}</Text>
            <View style={styles.chips}>
              {([15, 30, 60, 0] as const).map((r) =>
                chip(r, settings.repeatSeconds, t.repeats[String(r)] ?? String(r), () => set({ repeatSeconds: r })),
              )}
            </View>

            <Toggle
              label={t.vibrate}
              hint={canVibrate() ? t.vibrateHint : t.vibrateUnsupported}
              value={settings.vibrate && canVibrate()}
              onValueChange={(v) => set({ vibrate: v })}
              disabled={!canVibrate()}
            />
            <Toggle
              label={t.notify}
              hint={
                permission === 'unsupported'
                  ? t.notifyUnsupported
                  : permission === 'denied'
                    ? t.notifyDenied
                    : t.notifyHint
              }
              value={settings.notify && permission === 'granted'}
              onValueChange={(v) => void toggleNotify(v)}
              disabled={permission === 'unsupported' || permission === 'denied'}
            />
            {wakeLockSupported() ? (
              <Toggle
                label={t.keepAwake}
                hint={t.keepAwakeHint}
                value={settings.keepAwake}
                onValueChange={(v) => set({ keepAwake: v })}
              />
            ) : null}
          </ScrollView>
          <Button label={t.close} onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}

function createStyles(colors: BrandColors) {
  return StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center', padding: spacing.lg },
    sheet: {
      width: '100%',
      maxWidth: 560,
      maxHeight: '92%',
      backgroundColor: colors.surface,
      borderRadius: radius.lg,
      padding: spacing.lg,
      gap: spacing.md,
    },
    head: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
    title: { flex: 1, color: colors.text, fontSize: typography.section.fontSize, fontWeight: '800' },
    x: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', marginTop: -6, marginRight: -8 },
    body: { gap: spacing.sm, paddingBottom: spacing.sm },
    label: { color: colors.text, fontSize: typography.body.fontSize, fontWeight: '800', marginTop: spacing.sm },
    hint: { color: colors.textMuted, fontSize: typography.label.fontSize, lineHeight: 19 },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    chip: {
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.background,
      minHeight: 40,
      justifyContent: 'center',
    },
    chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
    chipText: { color: colors.text, fontWeight: '700', fontSize: typography.label.fontSize },
    chipTextOn: { color: colors.onPrimary },
    row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, alignItems: 'center' },
    link: { paddingVertical: spacing.sm },
    linkText: { color: colors.danger, fontWeight: '700', fontSize: typography.label.fontSize },
  });
}
