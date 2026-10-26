/**
 * Foto de producto, con su bloque de marca debajo.
 *
 * Una sola pieza para los tres casos, porque los tres van a convivir: hoy
 * `image_url` viene vacio, manana estara lleno, y por el camino habra
 * urls que apunten a un archivo que aun no se subio. El bloque de marca
 * esta SIEMPRE; la foto se pinta encima cuando carga, y si falla se
 * retira. Nunca queda un hueco gris ni cambia el alto.
 *
 * Las fotos llegan por base de datos, asi que anadirlas no exige
 * recompilar nada: en cuanto `app_item_overrides.image_url` tiene valor,
 * la siguiente carga del menu ya las trae.
 */

import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useMemo, useState, type ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import type { BrandColors } from '../domain/branding';
import { shouldShowPhoto } from '../domain/photo';
import { useColors } from '../state/branding-context';
import { radius } from '../theme';

interface ItemPhotoProps {
  readonly url: string | null;
  /** Para no ensenar un instante la foto del producto anterior al reciclar. */
  readonly recyclingKey: string;
  readonly glyphSize?: number;
  readonly style?: StyleProp<ViewStyle>;
  readonly rounded?: boolean;
}

export function ItemPhoto({
  url,
  recyclingKey,
  glyphSize = 28,
  style,
  rounded = true,
}: ItemPhotoProps): ReactNode {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [broken, setBroken] = useState(false);

  const show = shouldShowPhoto(url, broken);

  return (
    <View style={[styles.block, rounded && styles.rounded, style]}>
      <Ionicons name="leaf" size={glyphSize} color={colors.primary} />
      {show ? (
        <Image
          source={url}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          transition={180}
          recyclingKey={recyclingKey}
          cachePolicy="memory-disk"
          onError={() => setBroken(true)}
          accessibilityIgnoresInvertColors
        />
      ) : null}
    </View>
  );
}

function createStyles(colors: BrandColors) {
  return StyleSheet.create({
    block: {
      // NO puede ser `colors.background`: es el color de la pantalla, asi
      // que el bloque quedaba invisible sobre ella y solo se veia la hoja
      // suelta, como un icono perdido en mitad de la fila. Con `surface` y
      // un borde fino se lee como un hueco de foto a proposito, sobre
      // cualquier fondo de marca.
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      alignItems: 'center',
      justifyContent: 'center',
      overflow: 'hidden',
    },
    rounded: { borderRadius: radius.md },
  });
}
