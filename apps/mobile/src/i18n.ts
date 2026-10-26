/**
 * Idioma de la app del cliente: español o inglés, a elección de quien la
 * usa. La primera vez se toma el idioma del teléfono; después, lo que la
 * persona eligió (se guarda en el dispositivo).
 *
 * Cambiar de idioma cambia tres cosas:
 *  - los textos (`strings`, ver strings.ts),
 *  - el formato de precios y fechas (es-US / en-US, siempre en dólares),
 *  - el texto del menú que viene de la base (`localized`).
 *
 * El Panel del negocio sigue en español.
 */

import { detectLanguage, localizedText, type Lang } from './domain/language';
import { configureMoney, moneyDefaults } from './domain/money';
import { es, replaceStrings } from './strings';
import { en } from './strings.en';

export type { Lang };
export { detectLanguage };
export const LANGS: readonly Lang[] = ['en', 'es'];

const STORAGE_KEY = 'viva.lang';

let current: Lang = 'en';
const listeners = new Set<(lang: Lang) => void>();

export function getLanguage(): Lang {
  return current;
}

/** Formato de dinero y fechas para cada idioma (siempre dólares en EE. UU.). */
export function localeFor(lang: Lang): string {
  return lang === 'es' ? 'es-US' : 'en-US';
}

/** Aplica el idioma: textos y formato de dinero. No guarda nada. */
export function applyLanguage(lang: Lang): void {
  current = lang;
  replaceStrings(lang === 'es' ? es : en);
  configureMoney(moneyDefaults().currency, localeFor(lang));
  if (typeof document !== 'undefined') document.documentElement.lang = lang;
}

/** Cambia el idioma, lo recuerda en el dispositivo y avisa a la app. */
export function setLanguage(lang: Lang): void {
  if (lang === current) return;
  applyLanguage(lang);
  saveLanguage(lang);
  for (const listener of listeners) listener(lang);
}

export function onLanguageChange(listener: (lang: Lang) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Arranque: en la web se lee de forma síncrona (localStorage y el idioma
 * del navegador), así la primera pantalla ya sale en su idioma, sin parpadeo.
 */
export function initLanguage(): Lang {
  let saved: string | null = null;
  const system: string[] = [];
  try {
    if (typeof localStorage !== 'undefined') saved = localStorage.getItem(STORAGE_KEY);
  } catch {
    saved = null;
  }
  // `?lang=es` en la liga fuerza el idioma (útil para el póster en español).
  try {
    if (typeof window !== 'undefined' && typeof window.location?.search === 'string') {
      const forced = new URLSearchParams(window.location.search).get('lang');
      if (forced === 'es' || forced === 'en') saved = forced;
    }
  } catch {
    // sin URL (nativo)
  }
  if (typeof navigator !== 'undefined') {
    if (Array.isArray(navigator.languages)) system.push(...navigator.languages);
    if (typeof navigator.language === 'string') system.push(navigator.language);
  }
  if (system.length === 0) {
    try {
      system.push(Intl.DateTimeFormat().resolvedOptions().locale);
    } catch {
      // sin Intl: inglés
    }
  }
  const lang = detectLanguage(saved, system);
  applyLanguage(lang);
  return lang;
}

function saveLanguage(lang: Lang): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // modo privado o almacenamiento bloqueado: solo dura esta visita
  }
}

/**
 * Texto del menú en el idioma actual. La base guarda el texto en inglés y
 * las traducciones en `i18n` ({"es": {"name": "..."}}). Sin traducción, se
 * muestra el texto base.
 */
export function localized(base: string, i18n: unknown, field: string, lang: Lang = current): string {
  return localizedText(base, i18n, field, lang);
}

/** Igual que `localized`, para textos que pueden faltar (descripción, pie de historia). */
export function localizedOptional(base: string | null, i18n: unknown, field: string, lang: Lang = current): string | null {
  const value = localizedText(base ?? '', i18n, field, lang);
  return value === '' ? null : value;
}
