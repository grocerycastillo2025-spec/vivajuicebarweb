/**
 * Tarjeta del perfil del cliente: foto, nombre, correo y teléfono, con
 * "Editar perfil". La foto y el teléfono sirven para que la tienda lo
 * reconozca al escanear su tarjeta de puntos (0034).
 */

import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { canPickImages, pickAvatar, type PickedImage } from '../admin/pick-image';
import { avatarUrl, changePassword, updateProfile, uploadAvatar } from '../api/account';
import type { ProfileRow } from '../api/types';
import type { BrandColors } from '../domain/branding';
import { useColors } from '../state/branding-context';
import { strings } from '../strings';
import { radius, spacing, type as typography } from '../theme';
import { PasswordInput } from './PasswordInput';
import { Button } from './ui';

export function ProfileEditor({
  userId,
  email,
  profile,
  onSaved,
  onSignOut,
}: {
  readonly userId: string;
  readonly email: string | undefined;
  readonly profile: ProfileRow | null;
  readonly onSaved: () => void;
  readonly onSignOut: () => void;
}): ReactNode {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [editing, setEditing] = useState(false);
  const [changingPw, setChangingPw] = useState(false);
  const [pw1, setPw1] = useState('');
  const [pw2, setPw2] = useState('');
  const [first, setFirst] = useState(profile?.first_name ?? '');
  const [last, setLast] = useState(profile?.last_name ?? '');
  const [phone, setPhone] = useState(profile?.phone ?? '');
  const [photo, setPhoto] = useState<PickedImage | null>(null);
  const [currentUrl, setCurrentUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void avatarUrl(profile?.avatar_path).then((url) => {
      if (!cancelled) setCurrentUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [profile?.avatar_path]);

  const name = [profile?.first_name, profile?.last_name].filter(Boolean).join(' ').trim();
  const shownUrl = photo?.previewUrl ?? currentUrl;
  const blank = (v: string): string | null => (v.trim() === '' ? null : v.trim());

  const choose = async (): Promise<void> => {
    try {
      const picked = await pickAvatar();
      if (picked !== null) setPhoto(picked);
    } catch (cause) {
      setNotice({ ok: false, text: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  const save = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      const path = photo === null ? undefined : await uploadAvatar(userId, photo.blob);
      await updateProfile(userId, {
        first_name: blank(first),
        last_name: blank(last),
        phone: blank(phone)?.slice(0, 30) ?? null,
        ...(path === undefined ? {} : { avatar_path: path }),
      });
      setNotice({ ok: true, text: strings.profile.saved });
      setEditing(false);
      setPhoto(null);
      onSaved();
    } catch (cause) {
      setNotice({ ok: false, text: `${strings.profile.saveFailed}: ${cause instanceof Error ? cause.message : String(cause)}` });
    } finally {
      setBusy(false);
    }
  };

  const savePassword = async (): Promise<void> => {
    if (pw1.length < 8) return setNotice({ ok: false, text: strings.profile.passwordShort });
    if (pw1 !== pw2) return setNotice({ ok: false, text: strings.profile.passwordMismatch });
    setBusy(true);
    setNotice(null);
    try {
      await changePassword(pw1);
      setNotice({ ok: true, text: strings.profile.passwordChanged });
      setChangingPw(false);
      setPw1('');
      setPw2('');
    } catch (cause) {
      setNotice({ ok: false, text: `${strings.profile.saveFailed}: ${cause instanceof Error ? cause.message : String(cause)}` });
    } finally {
      setBusy(false);
    }
  };

  const avatar = (
    <View style={styles.avatar}>
      {shownUrl !== null ? (
        <Image source={{ uri: shownUrl }} style={styles.avatarImg} contentFit="cover" accessibilityLabel={strings.profile.photo} />
      ) : (
        <Ionicons name="person" size={34} color={colors.textMuted} />
      )}
    </View>
  );

  return (
    <View style={styles.card}>
      <View style={styles.head}>
        {avatar}
        <View style={styles.headText}>
          <Text style={styles.name}>{name !== '' ? name : (email ?? strings.profile.customer)}</Text>
          <Text style={styles.body}>{email}</Text>
          {profile?.phone != null ? <Text style={styles.body}>{profile.phone}</Text> : null}
        </View>
      </View>

      {editing ? (
        <View style={styles.form}>
          <Text style={styles.label}>{strings.profile.photo}</Text>
          <Text style={styles.hint}>{strings.profile.photoHint}</Text>
          {canPickImages ? (
            <Button
              label={shownUrl === null ? strings.profile.choosePhoto : strings.profile.changePhoto}
              variant="outline"
              onPress={() => void choose()}
              testID="elegir-foto-perfil"
            />
          ) : (
            <Text style={styles.hint}>{strings.profile.photoWebOnly}</Text>
          )}
          <Text style={styles.label}>{strings.profile.firstName}</Text>
          <TextInput value={first} onChangeText={setFirst} style={styles.input} accessibilityLabel={strings.profile.firstName}
            autoComplete="given-name" />
          <Text style={styles.label}>{strings.profile.lastName}</Text>
          <TextInput value={last} onChangeText={setLast} style={styles.input} accessibilityLabel={strings.profile.lastName}
            autoComplete="family-name" />
          <Text style={styles.label}>{strings.profile.phone}</Text>
          <TextInput value={phone} onChangeText={setPhone} style={styles.input} accessibilityLabel={strings.profile.phone}
            keyboardType="phone-pad" autoComplete="tel" placeholder="(732) 555-0123" placeholderTextColor={colors.textFaint} />
          <Text style={styles.hint}>{strings.profile.phoneHint}</Text>
          <View style={styles.row}>
            <Button label={strings.profile.save} busy={busy} onPress={() => void save()} testID="guardar-perfil" />
            <Button label={strings.profile.cancel} variant="outline" onPress={() => { setEditing(false); setPhoto(null); }} />
          </View>
        </View>
      ) : (
        <Button label={strings.profile.edit} variant="outline" onPress={() => setEditing(true)} testID="editar-perfil" />
      )}
      {changingPw ? (
        <View style={styles.form}>
          <Text style={styles.label}>{strings.profile.newPassword}</Text>
          <PasswordInput value={pw1} onChangeText={setPw1} style={styles.input}
            accessibilityLabel={strings.profile.newPassword} autoComplete="new-password" />
          <Text style={styles.label}>{strings.profile.repeatPassword}</Text>
          <PasswordInput value={pw2} onChangeText={setPw2} style={styles.input}
            accessibilityLabel={strings.profile.repeatPassword} autoComplete="new-password" />
          <Text style={styles.hint}>{strings.profile.passwordShort}</Text>
          <View style={styles.row}>
            <Button label={strings.profile.save} busy={busy} onPress={() => void savePassword()} testID="guardar-contrasena" />
            <Button label={strings.profile.cancel} variant="outline" onPress={() => setChangingPw(false)} />
          </View>
        </View>
      ) : !editing ? (
        <Button label={strings.profile.changePassword} variant="outline" onPress={() => setChangingPw(true)} testID="cambiar-contrasena" />
      ) : null}
      {notice !== null ? (
        <Text style={[styles.hint, { color: notice.ok ? colors.success : colors.danger }]}>{notice.text}</Text>
      ) : null}
      <Button label={strings.auth.signOut} variant="outline" onPress={onSignOut} />
    </View>
  );
}

function createStyles(colors: BrandColors) {
  return StyleSheet.create({
    card: {
      backgroundColor: colors.surface,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.border,
      padding: spacing.lg,
      gap: spacing.md,
    },
    head: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    avatar: {
      width: 72,
      height: 72,
      borderRadius: 36,
      backgroundColor: colors.background,
      alignItems: 'center',
      justifyContent: 'center',
      overflow: 'hidden',
    },
    avatarImg: { width: 72, height: 72 },
    headText: { flex: 1, minWidth: 0, gap: 2 },
    name: { color: colors.text, fontSize: typography.section.fontSize, fontWeight: '800' },
    body: { color: colors.textMuted, fontSize: typography.body.fontSize },
    form: { gap: spacing.sm },
    label: { color: colors.text, fontSize: typography.label.fontSize, fontWeight: '700', marginTop: spacing.xs },
    hint: { color: colors.textMuted, fontSize: typography.caption.fontSize + 1, lineHeight: 18 },
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
    row: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
  });
}
