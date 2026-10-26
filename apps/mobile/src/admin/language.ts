/**
 * Idioma del Panel: español o inglés, aparte del idioma de la app del
 * cliente (el dueño puede querer el panel en un idioma y su teléfono en
 * otro). Se recuerda en el navegador; por defecto, español.
 */

import { useEffect, useState } from 'react';

import { en } from '../strings.en';
import { es, type Strings } from '../strings';
import { adminEn } from './strings.en';
import { adminEs, fillAdminStrings } from './strings';

export type AdminLang = 'es' | 'en';

const KEY = 'juicebar.admin.lang.v1';
let current: AdminLang = 'es';
const listeners = new Set<(lang: AdminLang) => void>();

function copySections<T extends object>(source: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    out[key] = value !== null && typeof value === 'object' && !Array.isArray(value) ? { ...value } : value;
  }
  return out as T;
}

/**
 * Textos de la app del cliente que también salen en el panel (Salir,
 * estados de pedido…), en el idioma del panel.
 */
export const panelAppStrings: Strings = copySections(es);

function apply(lang: AdminLang): void {
  current = lang;
  fillAdminStrings(lang === 'en' ? adminEn : adminEs);
  const source = (lang === 'en' ? en : es) as unknown as Record<string, unknown>;
  const target = panelAppStrings as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(source)) {
    const now = target[key];
    if (now !== null && typeof now === 'object' && !Array.isArray(now) && typeof value === 'object') {
      Object.assign(now, value);
    } else {
      target[key] = value;
    }
  }
}

function stored(): AdminLang | null {
  try {
    const value = globalThis.localStorage?.getItem(KEY);
    return value === 'en' || value === 'es' ? value : null;
  } catch {
    return null;
  }
}

// Se aplica al cargar el módulo, antes de pintar el panel: sin parpadeo.
apply(stored() ?? 'es');

export function getAdminLanguage(): AdminLang {
  return current;
}

/** Para fechas y horas del panel. */
export function adminLocale(): string {
  return current === 'en' ? 'en-US' : 'es-US';
}

export function setAdminLanguage(lang: AdminLang): void {
  if (lang === current) return;
  apply(lang);
  try {
    globalThis.localStorage?.setItem(KEY, lang);
  } catch {
    // Navegador privado: se queda solo esta visita.
  }
  for (const listener of listeners) listener(lang);
}

export function useAdminLanguage(): AdminLang {
  const [lang, setLang] = useState(current);
  useEffect(() => {
    listeners.add(setLang);
    setLang(current);
    return () => {
      listeners.delete(setLang);
    };
  }, []);
  return lang;
}
