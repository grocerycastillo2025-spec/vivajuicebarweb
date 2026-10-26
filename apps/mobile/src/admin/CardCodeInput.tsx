/**
 * Teclear el código de la tarjeta del cliente (si la cámara no ayuda) y
 * abrir su ficha en /admin/cliente.
 */

import { useRouter } from 'expo-router';
import { useMemo, useState, type ReactNode } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { Button } from '../components/ui';
import { parseCardPayload } from '../domain/loyalty-card';
import { useColors } from '../state/branding-context';
import { spacing } from '../theme';
import { adminStrings } from './strings';
import { createAdminStyles } from './ui';

const t = adminStrings.loyalty;

export function CardCodeInput(): ReactNode {
  const router = useRouter();
  const colors = useColors();
  const styles = useMemo(() => createAdminStyles(colors), [colors]);
  const [code, setCode] = useState('');
  const [invalid, setInvalid] = useState(false);

  const open = (): void => {
    const card = parseCardPayload(code);
    if (card === null) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    router.push({ pathname: '/admin/cliente', params: { c: card } });
  };

  return (
    <View style={local.box}>
      <Text style={styles.hint}>{t.typeCard}</Text>
      <View style={local.row}>
        <TextInput
          value={code}
          onChangeText={(text) => setCode(text.toUpperCase())}
          placeholder={t.cardPlaceholder}
          placeholderTextColor={colors.textFaint}
          autoCapitalize="characters"
          autoCorrect={false}
          onSubmitEditing={open}
          accessibilityLabel={t.typeCard}
          style={[styles.input, local.input]}
        />
        <Button label={t.open} variant="outline" onPress={open} testID="abrir-tarjeta" />
      </View>
      {invalid ? <Text style={[styles.hint, { color: colors.danger }]}>{t.invalidCard}</Text> : null}
    </View>
  );
}

const local = StyleSheet.create({
  box: { gap: spacing.xs },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, alignItems: 'center' },
  input: { flex: 1, minWidth: 180, fontSize: 18, fontWeight: '700', letterSpacing: 2 },
});
