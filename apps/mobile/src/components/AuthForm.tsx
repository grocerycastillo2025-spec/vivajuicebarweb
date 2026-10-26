/**
 * Alta y entrada por correo, y Google si esta configurado.
 *
 * Vive en un componente porque se usa en dos sitios: la pestana Profile y
 * la puerta del checkout, donde hay que identificarse antes de pedir.
 */

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Alert, StyleSheet, Text, TextInput, View } from 'react-native';

import type { BrandColors } from '../domain/branding';
import { useColors } from '../state/branding-context';
import { useSession } from '../state/session-context';
import { strings } from '../strings';
import { radius, spacing, type as typography } from '../theme';
import { Button } from './ui';

export function AuthForm({
  title,
  body,
  onSignedIn,
}: {
  readonly title?: string;
  readonly body?: string;
  readonly onSignedIn?: () => void;
}): ReactNode {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { signIn, signUp, signInWithGoogle, googleEnabled } = useSession();

  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [firstName, setFirstName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);

  const submit = useCallback(async () => {
    setBusy(true);
    try {
      if (mode === 'signin') {
        await signIn(email, password);
        onSignedIn?.();
      } else {
        const needsConfirmation = await signUp(email, password, firstName);
        setPassword('');
        if (needsConfirmation) {
          Alert.alert(strings.auth.checkYourEmail, strings.auth.checkYourEmailBody);
        } else {
          onSignedIn?.();
        }
      }
    } catch (cause) {
      Alert.alert(
        mode === 'signin' ? strings.auth.signInFailed : strings.auth.signUpFailed,
        cause instanceof Error ? cause.message : String(cause),
      );
    } finally {
      setBusy(false);
    }
  }, [email, firstName, mode, onSignedIn, password, signIn, signUp]);

  const google = useCallback(async () => {
    setGoogleBusy(true);
    try {
      await signInWithGoogle();
      onSignedIn?.();
    } catch (cause) {
      Alert.alert(
        strings.auth.signInFailed,
        cause instanceof Error ? cause.message : String(cause),
      );
    } finally {
      setGoogleBusy(false);
    }
  }, [onSignedIn, signInWithGoogle]);

  return (
    <View style={styles.card}>
      <Text style={styles.title}>
        {title ?? (mode === 'signin' ? strings.auth.signInTitle : strings.auth.signUpTitle)}
      </Text>
      <Text style={styles.body}>{body ?? strings.auth.body}</Text>

      {googleEnabled ? (
        <>
          <Button
            label={strings.auth.google}
            variant="outline"
            onPress={() => void google()}
            busy={googleBusy}
          />
          <Text style={styles.divider}>{strings.auth.orEmail}</Text>
        </>
      ) : null}

      {mode === 'signup' ? (
        <TextInput
          value={firstName}
          onChangeText={setFirstName}
          placeholder={strings.auth.firstName}
          placeholderTextColor={colors.textFaint}
          autoCapitalize="words"
          autoComplete="given-name"
          style={styles.input}
        />
      ) : null}

      <TextInput
        value={email}
        onChangeText={setEmail}
        placeholder={strings.auth.email}
        placeholderTextColor={colors.textFaint}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        autoComplete="email"
        style={styles.input}
      />

      <TextInput
        value={password}
        onChangeText={setPassword}
        placeholder={strings.auth.password}
        placeholderTextColor={colors.textFaint}
        secureTextEntry
        autoCapitalize="none"
        autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
        style={styles.input}
      />

      <Button
        label={mode === 'signin' ? strings.auth.signIn : strings.auth.signUp}
        onPress={() => void submit()}
        busy={busy}
        disabled={email.trim() === '' || password === ''}
      />

      <Button
        label={mode === 'signin' ? strings.auth.noAccount : strings.auth.haveAccount}
        variant="outline"
        onPress={() => setMode(mode === 'signin' ? 'signup' : 'signin')}
      />
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
    title: { color: colors.text, fontSize: typography.section.fontSize, fontWeight: '800' },
    body: { color: colors.textMuted, fontSize: typography.body.fontSize, lineHeight: 21 },
    divider: {
      color: colors.textFaint,
      fontSize: typography.caption.fontSize,
      textAlign: 'center',
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
  });
}
