/**
 * "Si apago Naranja, ¿qué más se afecta?" — Panel → Tienda.
 *
 * No hay una lista formal de ingredientes por producto: se buscan los
 * nombres de la opción (en inglés y en español) en el nombre y la
 * descripción de cada producto ("Naranja, zanahoria y betabel"). Es una
 * SUGERENCIA: el panel muestra la lista marcada y la persona decide.
 *
 * Módulo puro.
 */

export function plainText(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Palabra completa, aceptando plural simple: "fresa" encuentra "fresas". */
export function mentions(text: string, term: string): boolean {
  const t = plainText(term);
  if (t.length < 3) return false;
  const re = new RegExp(`(^|[^a-z0-9])${escapeRegex(t)}(s|es)?([^a-z0-9]|$)`);
  return re.test(plainText(text));
}

export interface SearchableItem {
  readonly id: string;
  /** Nombre y descripción en todos los idiomas. */
  readonly texts: readonly string[];
}

export interface SearchableOption {
  readonly id: string;
  /** Nombre en todos los idiomas ("Orange", "Naranja"). */
  readonly names: readonly string[];
}

/** Productos que mencionan la opción. */
export function itemsUsing(option: SearchableOption, items: readonly SearchableItem[]): string[] {
  const terms = [...new Set(option.names.map(plainText).filter((n) => n.length >= 3))];
  return items.filter((item) => item.texts.some((text) => terms.some((term) => mentions(text, term)))).map((i) => i.id);
}

/** La misma opción en otros grupos ("Fresa" en frutas del licuado y del bowl). */
export function sameOptionElsewhere(option: SearchableOption, options: readonly SearchableOption[]): string[] {
  const mine = new Set(option.names.map(plainText).filter((n) => n !== ''));
  return options
    .filter((o) => o.id !== option.id && o.names.some((n) => mine.has(plainText(n))))
    .map((o) => o.id);
}
