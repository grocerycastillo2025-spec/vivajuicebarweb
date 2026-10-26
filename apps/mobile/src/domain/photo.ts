/**
 * Cuando se ensena la foto de un producto.
 *
 * Parece trivial y no lo es: hay tres estados que van a convivir durante
 * semanas —sin url, url que carga, url rota— y el diseno tiene que
 * aguantar los tres sin cambiar de alto ni dejar un hueco. Esta es la
 * regla, aparte del componente, para poder comprobarla.
 *
 * Una cadena vacia cuenta como "sin foto": el SQL que conecta las
 * imagenes puede dejarla asi, y `'' !== null` habria pasado el filtro
 * ingenuo y pedido una url vacia.
 */
export function shouldShowPhoto(url: string | null | undefined, broken: boolean): boolean {
  if (broken) return false;
  return typeof url === 'string' && url.trim() !== '';
}
