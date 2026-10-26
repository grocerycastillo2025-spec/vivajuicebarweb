/**
 * Escaner de QR en el telefono (build nativo).
 *
 * Todavia no hay camara en el APK: hacerlo exige `expo-camera`, una
 * dependencia nativa, y por tanto un build nuevo y subir el
 * `runtimeVersion`. Mientras tanto, la camara del telefono abre el enlace
 * del QR y la app llega a la misma pantalla de visita. La version web
 * (`QrScanner.web.tsx`) si escanea dentro de la app.
 */

import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { strings } from '../strings';

export interface QrScannerProps {
  readonly onResult: (text: string) => boolean;
}

export function QrScanner(_props: QrScannerProps): ReactNode {
  return (
    <View style={styles.message}>
      <Text style={styles.text}>{strings.scanner.nativeOnly}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  message: { padding: 16, borderRadius: 12, backgroundColor: 'rgba(0,0,0,0.05)' },
  text: { fontSize: 15, lineHeight: 22, color: '#333' },
});
