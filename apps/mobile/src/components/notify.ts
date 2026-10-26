/**
 * Aviso simple que también se ve en web (`Alert.alert` de React Native no
 * muestra nada en el navegador).
 */
import { Alert, Platform } from 'react-native';

export function notify(title: string, message: string): void {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    window.alert(`${title}\n\n${message}`);
    return;
  }
  Alert.alert(title, message);
}
