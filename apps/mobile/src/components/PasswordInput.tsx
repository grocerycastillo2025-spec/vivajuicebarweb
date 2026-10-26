/**
 * Campo de contraseña con el ojito para verla mientras se escribe.
 */

import { Ionicons } from '@expo/vector-icons';
import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, TextInput, View, type StyleProp, type TextStyle } from 'react-native';

import { useColors } from '../state/branding-context';
import { strings } from '../strings';
import { spacing } from '../theme';

export function PasswordInput({
  value,
  onChangeText,
  placeholder,
  accessibilityLabel,
  autoComplete,
  style,
  onSubmitEditing,
  testID,
}: {
  readonly value: string;
  readonly onChangeText: (text: string) => void;
  readonly placeholder?: string;
  readonly accessibilityLabel?: string;
  readonly autoComplete: 'current-password' | 'new-password';
  readonly style: StyleProp<TextStyle>;
  readonly onSubmitEditing?: () => void;
  readonly testID?: string;
}): ReactNode {
  const colors = useColors();
  const [visible, setVisible] = useState(false);
  return (
    <View style={styles.wrap}>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textFaint}
        secureTextEntry={!visible}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete={autoComplete}
        accessibilityLabel={accessibilityLabel ?? placeholder}
        onSubmitEditing={onSubmitEditing}
        style={[style, styles.input]}
        testID={testID}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={visible ? strings.auth.hidePassword : strings.auth.showPassword}
        onPress={() => setVisible((v) => !v)}
        hitSlop={8}
        style={styles.eye}
        testID={testID === undefined ? undefined : `${testID}-ver`}
      >
        <Ionicons name={visible ? 'eye-off-outline' : 'eye-outline'} size={22} color={colors.textMuted} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'relative', justifyContent: 'center' },
  input: { paddingRight: 52 },
  eye: { position: 'absolute', right: spacing.sm, height: 44, width: 40, alignItems: 'center', justifyContent: 'center' },
});
