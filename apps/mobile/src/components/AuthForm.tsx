/**
 * Alta y entrada por correo, y Google si esta configurado.
 *
 * Vive en un componente porque se usa en dos sitios: la pestana Profile y
 * la puerta del checkout, donde hay que identificarse antes de pedir.
 */

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { authProblem } from '../domain/auth-errors';

import type { BrandColors } from '../domain/branding';
import { useColors } from '../state/branding-context';
import { useSession } from '../state/session-context';
import { strings } from '../strings';
import { radius, spacing, type as typography } from '../theme';
import { PasswordInput } from './PasswordInput';
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
  // En web `Alert.alert` no muestra nada: los avisos van dentro del formulario.
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const submit = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    try {
      if (mode === 'signin') {
        await signIn(email, password);
        onSignedIn?.();
      } else {
        if (password.length < 8) {
          setNotice({ ok: false, text: strings.auth.problems['weak_password'] ?? '' });
          return;
        }
        const needsConfirmation = await signUp(email, password, firstName);
        setPassword('');
        if (needsConfirmation) {
          setNotice({ ok: true, text: strings.auth.confirmSent(email.trim()) });
          setMode('signin');
        } else {
          onSignedIn?.();
        }
      }
    } catch (cause) {
      const problem = authProblem(cause instanceof Error ? cause.message : String(cause));
      setNotice({ ok: false, text: strings.auth.problems[problem] ?? String(cause) });
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
      const problem = authProblem(cause instanceof Error ? cause.message : String(cause));
      setNotice({ ok: false, text: strings.auth.problems[problem] ?? String(cause) });
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
        // Al crear cuenta no se ofrecen correos guardados (el de otra cuenta
        // tapaba el campo de contraseña); al entrar, sí.
        autoComplete={mode === 'signin' ? 'email' : 'off'}
        importantForAutofill={mode === 'signin' ? 'auto' : 'no'}
        style={styles.input}
      />

      <PasswordInput
        value={password}
        onChangeText={setPassword}
        placeholder={strings.auth.password}
        autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
        onSubmitEditing={() => void submit()}
        style={styles.input}
      />

      {notice !== null ? (
        <Text
          accessibilityRole="alert"
          style={[styles.notice, { color: notice.ok ? colors.success : colors.danger }]}
          testID="aviso-cuenta"
        >
          {notice.text}
        </Text>
      ) : null}

      <Button
        label={mode === 'signin' ? strings.auth.signIn : strings.auth.signUp}
        onPress={() => void submit()}
        busy={busy}
        disabled={email.trim() === '' || password === ''}
      />

      <Button
        label={mode === 'signin' ? strings.auth.noAccount : strings.auth.haveAccount}
        variant="outline"
        onPress={() => {
          setMode(mode === 'signin' ? 'signup' : 'signin');
          setNotice(null);
        }}
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
    notice: { fontSize: typography.label.fontSize, fontWeight: '700', lineHeight: 20 },
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
