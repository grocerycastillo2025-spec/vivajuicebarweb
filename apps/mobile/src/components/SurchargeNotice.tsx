/**
 * El aviso del recargo por tarjeta de credito.
 *
 * POR QUE ES UN COMPONENTE Y NO UN PARRAFO EN CADA PANTALLA
 * Porque tiene que salir en CUATRO sitios y decir lo mismo en los cuatro.
 * Nueva Jersey (P.L. 2023, c.146) exige un aviso electronico claro y
 * visible en la pantalla de checkout, y ademas —por ser Viva un
 * restaurante— el importe en la CARTA, incluidas las cartas en linea o
 * por QR, que es literalmente la pestana de menu de esta app. Cuatro
 * copias sueltas se desincronizan; esta no puede.
 *
 * LO QUE ESTE COMPONENTE NO PUEDE HACER
 * Pintarse sin cifra. No recibe un booleano "hay recargo": recibe la
 * divulgacion de `domain/surcharge.ts`, y si esa no trae `percentLabel`
 * devuelve `null`. El cartel sin importe es el ejemplo de incumplimiento
 * que da la FAQ de la NJ Division of Consumer Affairs, asi que la unica
 * forma de que aparezca es teniendo el numero.
 *
 * DOS FORMAS, UNA SOLA FUENTE
 *   `card`  bloque con titulo e icono. Donde se decide pagar: checkout y
 *           pago. Es el aviso "claro y visible" de la ley.
 *   `line`  una linea. Donde solo se estan mirando precios: carta y
 *           carrito. Cumple lo del menu sin comerse la pantalla.
 *
 * Ninguna de las dos usa `textFaint`: un aviso obligatorio no puede ser
 * el texto mas apagado de la pantalla. La `card` va bordeada en el color
 * de acento, no en `danger`: no es un error, es el precio.
 */

import { Ionicons } from '@expo/vector-icons';
import { useMemo, type ReactNode } from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import type { BrandColors } from '../domain/branding';
import type { SurchargeDisclosure } from '../domain/surcharge';
import { useColors } from '../state/branding-context';
import { strings } from '../strings';
import { radius, spacing, type as typography } from '../theme';

interface SurchargeNoticeProps {
  readonly disclosure: SurchargeDisclosure;
  readonly variant?: 'card' | 'line';
  /**
   * Texto de la variante `line`. En la carta se dice que los precios de
   * al lado NO lo llevan dentro; en el carrito, que la tarjeta lo suma.
   */
  readonly tone?: 'payment' | 'menu';
  readonly style?: StyleProp<ViewStyle>;
}

export function SurchargeNotice({
  disclosure,
  variant = 'card',
  tone = 'payment',
  style,
}: SurchargeNoticeProps): ReactNode {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);

  // La unica puerta. `disclose` ya garantiza que hay cifra; se comprueba
  // tambien `percentLabel` para que el tipo lo sepa y para que nadie
  // pueda saltarse la garantia construyendo el objeto a mano.
  const percent = disclosure.percentLabel;
  if (!disclosure.disclose || percent === null) return null;

  // El lector de pantalla lee el aviso entero de una vez: partido en
  // titulo y cuerpo se oye como dos frases sueltas.
  const label = strings.surcharge.a11y(percent);

  if (variant === 'line') {
    return (
      <View
        accessible
        accessibilityRole="text"
        accessibilityLabel={label}
        style={[styles.line, style]}
      >
        <Ionicons name="card-outline" size={14} color={colors.accent} />
        <Text style={styles.lineText}>
          {tone === 'menu' ? strings.surcharge.menuNote(percent) : strings.surcharge.short(percent)}
        </Text>
      </View>
    );
  }

  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={label}
      style={[styles.card, style]}
    >
      <Ionicons name="card-outline" size={20} color={colors.accent} />
      <View style={styles.cardBody}>
        <Text style={styles.cardTitle}>{strings.surcharge.title(percent)}</Text>
        <Text style={styles.cardText}>{strings.surcharge.body(percent)}</Text>
      </View>
    </View>
  );
}

function createStyles(colors: BrandColors) {
  return StyleSheet.create({
    card: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.md,
      backgroundColor: colors.surface,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.accent,
      padding: spacing.md,
    },
    cardBody: { flex: 1, gap: 2 },
    cardTitle: {
      color: colors.text,
      fontSize: typography.label.fontSize,
      fontWeight: '700',
    },
    cardText: {
      color: colors.textMuted,
      fontSize: typography.caption.fontSize,
      lineHeight: 17,
    },

    line: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
    },
    lineText: {
      // `flexShrink` y no `flex: 1`: asi el texto ocupa lo que mide y el
      // par icono+texto se puede centrar desde fuera (el pie fijo del
      // checkout lo hace), pero sigue partiendo en dos lineas si no cabe.
      flexShrink: 1,
      color: colors.textMuted,
      fontSize: typography.caption.fontSize,
      fontWeight: '600',
    },
  });
}
