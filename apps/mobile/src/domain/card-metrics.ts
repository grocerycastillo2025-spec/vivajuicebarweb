/**
 * Las medidas de la lista del menu, en un modulo sin React.
 *
 * POR QUE AQUI Y NO EN EL COMPONENTE
 * La lista calcula la posicion de cada categoria a partir de estos numeros
 * para poder saltar a ella de un tiron, y para saber cuanta cola hay que
 * dejar debajo de la ultima (`section-layout.ts`). Si viven dentro del
 * componente, esa aritmetica solo se puede comprobar copiandolos a mano en
 * el test — y una copia que se queda vieja es justo como vuelve un fallo
 * de posiciones.
 *
 * Todas son enteras a proposito: un `hairlineWidth` de 0,5 se redondea
 * distinto en cada densidad de pantalla y el error se acumula fila a fila.
 *
 * Sin imports a proposito: esto lo lee tambien un test que corre en Node
 * pelado, donde `../theme` no resuelve.
 */

export const CARD = {
  /** Lado de la foto en la fila. */
  thumb: 96,
  padV: 14,
  separator: 1,
  /** Diametro del boton "+" y cuanto se mete dentro de la foto. */
  plus: 34,
  plusInset: 6,
  /** Mosaico: alto de la foto y del texto de debajo. */
  tileImage: 150,
  tileBody: 70,
  tileGap: 18,
} as const;

/** Alto TOTAL de una fila, separador incluido: lo que pide getItemLayout. */
export const ROW_HEIGHT = CARD.thumb + CARD.padV * 2 + CARD.separator;
export const TILE_HEIGHT = CARD.tileImage + CARD.tileBody + CARD.tileGap;

/** Alto fijo del encabezado de categoria. */
export const HEADER_HEIGHT = 52;
