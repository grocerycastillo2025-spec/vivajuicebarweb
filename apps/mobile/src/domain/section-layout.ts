/**
 * Medidas de una lista por secciones.
 *
 * `SectionList` sabe saltar a una seccion, pero sin `getItemLayout` tiene
 * que ir midiendo mientras baja: el salto a una categoria lejana se queda
 * corto, corrige, y se ve un tiron. Con las filas de alto fijo se puede
 * calcular la posicion exacta, y el salto es instantaneo.
 *
 * EL INDICE NO ES EL QUE PARECE
 * `getItemLayout` recibe el indice de la lista PLANA que arma
 * `VirtualizedList` por dentro, y ahi cada seccion ocupa
 * `1 + n + 1` posiciones: encabezado, sus filas, y un pie que existe
 * aunque no se pinte nada. Confundir ese indice con el de la fila es el
 * error clasico, y se nota en que los saltos caen desplazados una
 * cabecera.
 *
 * Modulo puro, sin React.
 */

export interface SectionSizes {
  readonly header: number;
  readonly row: number;
  readonly footer: number;
}

export interface Span {
  readonly length: number;
  readonly offset: number;
  readonly index: number;
}

/**
 * Recorre la lista plana acumulando altos. Devuelve el alto y la posicion
 * de cada indice.
 *
 * `counts` son las filas de cada seccion, en orden.
 */
export function sectionListLayout(
  counts: readonly number[],
  sizes: SectionSizes,
  index: number,
): Span {
  let offset = 0;
  let cursor = 0;

  for (const count of counts) {
    // Encabezado
    if (cursor === index) return { length: sizes.header, offset, index };
    cursor += 1;
    offset += sizes.header;

    // Filas
    if (index < cursor + count) {
      const within = index - cursor;
      return { length: sizes.row, offset: offset + within * sizes.row, index };
    }
    cursor += count;
    offset += count * sizes.row;

    // Pie: ocupa un hueco aunque mida cero.
    if (cursor === index) return { length: sizes.footer, offset, index };
    cursor += 1;
    offset += sizes.footer;
  }

  // Fuera de rango: se responde algo coherente en vez de romper el scroll.
  return { length: 0, offset, index };
}

export function makeSectionLayout(counts: readonly number[], sizes: SectionSizes) {
  return (_data: unknown, index: number): Span => sectionListLayout(counts, sizes, index);
}

/**
 * Indice PLANO de la cabecera de una seccion.
 *
 * Espejo exacto de `VirtualizedSectionList.scrollToLocation`, que hace:
 *
 *     let index = itemIndex;
 *     for (let i = 0; i < sectionIndex; i++)
 *       index += getItemCount(sections[i].data) + 2;
 *
 * El `+ 2` es la cabecera y el pie de cada seccion. Se replica aqui para
 * poder comprobar el salto sin un telefono delante.
 */
export function sectionFlatIndex(counts: readonly number[], sectionIndex: number): number {
  let index = 0;
  for (let i = 0; i < sectionIndex && i < counts.length; i++) index += (counts[i] ?? 0) + 2;
  return index;
}

/**
 * El camino de vuelta: de indice plano a numero de seccion.
 *
 * Hace falta porque `onScrollToIndexFailed` informa del indice PLANO que
 * no pudo alcanzar, y `scrollToLocation` pide un indice de SECCION. Pasar
 * uno donde va el otro manda la lista a una categoria cualquiera.
 */
export function sectionOfFlatIndex(counts: readonly number[], flatIndex: number): number {
  if (flatIndex <= 0) return 0;
  let cursor = 0;
  for (let section = 0; section < counts.length; section++) {
    cursor += (counts[section] ?? 0) + 2;
    if (flatIndex < cursor) return section;
  }
  return Math.max(0, counts.length - 1);
}

/**
 * Relleno inferior que necesita la lista para que la ULTIMA categoria
 * pueda ponerse arriba del todo.
 *
 * ESTO ES EL FALLO DE "UN PASO ATRASADO"
 * Saltar a una categoria es desplazar la lista hasta que su cabecera
 * quede arriba. Para eso tiene que haber una ventana entera de contenido
 * POR DEBAJO de esa cabecera. La ultima categoria no la tiene: con 2
 * productos mide 300 px y la ventana son ~700. El sistema recorta el
 * desplazamiento al maximo posible y la lista se queda 400 px corta, es
 * decir, ensenando el final de la categoria ANTERIOR — mientras el chip,
 * que se marco al tocarlo, dice la elegida. El menu iba un paso atrasado.
 *
 * No es un fallo de calculo: `sectionListLayout` da la posicion correcta y
 * el salto la pide bien. Es que ahi abajo no hay sitio. La solucion es
 * darselo.
 *
 * `base` es el hueco de siempre (barra de pestanas, area segura, carrito).
 */
export function tailPadding(
  counts: readonly number[],
  sizes: SectionSizes,
  viewportHeight: number,
  base: number,
): number {
  if (counts.length === 0 || viewportHeight <= 0) return base;
  const last = counts[counts.length - 1] ?? 0;
  const lastSectionHeight = sizes.header + last * sizes.row + sizes.footer;
  return base + Math.max(0, viewportHeight - lastSectionHeight);
}
