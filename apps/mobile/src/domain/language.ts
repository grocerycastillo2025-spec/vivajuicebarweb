/**
 * Idioma: lo que no depende de React ni del dispositivo. Módulo puro, corre
 * bajo `node --test`.
 */

export type Lang = 'es' | 'en';

/** Lo que eligió la persona, o el idioma del teléfono; si no, inglés. */
export function detectLanguage(saved: string | null, systemLanguages: readonly string[]): Lang {
  if (saved === 'es' || saved === 'en') return saved;
  for (const tag of systemLanguages) {
    const base = tag.toLowerCase().slice(0, 2);
    if (base === 'es') return 'es';
    if (base === 'en') return 'en';
  }
  return 'en';
}

/**
 * Texto de la base en un idioma. El texto base es el inglés; las
 * traducciones viven en `i18n` ({"es": {"name": "..."}}). Sin traducción
 * (o vacía), se queda el texto base.
 */
export function localizedText(base: string, i18n: unknown, field: string, lang: Lang): string {
  if (lang === 'en' || i18n === null || typeof i18n !== 'object') return base;
  const entry = (i18n as Record<string, unknown>)[lang];
  if (entry === null || typeof entry !== 'object') return base;
  const value = (entry as Record<string, unknown>)[field];
  return typeof value === 'string' && value.trim() !== '' ? value : base;
}
