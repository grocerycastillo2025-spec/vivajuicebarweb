/**
 * Ancho util para maquetar.
 *
 * En el telefono es el de la ventana. En la app web, en una pantalla
 * ancha, la app se pinta dentro de una columna centrada de
 * `WEB_MAX_WIDTH` (la define `public/index.html`), asi que medir la
 * ventana daria un mosaico de seis columnas dentro de una columna de
 * telefono. Aqui se recorta al ancho de esa columna.
 */

import { Platform, useWindowDimensions } from 'react-native';

/** Debe coincidir con el `max-width` de `#root` en public/index.html. */
export const WEB_MAX_WIDTH = 520;

export function useContentWidth(): number {
  const { width } = useWindowDimensions();
  return Platform.OS === 'web' ? Math.min(width, WEB_MAX_WIDTH) : width;
}
