/**
 * Historias ya bajadas, compartidas entre Inicio y el visor: al tocar una
 * el visor abre al instante con la lista que ya está en memoria, sin
 * volver a pedirla, y las fotos ya vienen precargadas.
 */

import { fetchStories, type StoryRow } from '../api/stories';
import { autoOpenStart } from '../domain/stories';
import { loadSeenStories } from './seen-stories';
import { preloadImages } from './preload';

let cached: StoryRow[] | null = null;

export function cachedStories(): StoryRow[] | null {
  return cached;
}

/** Cuántas fotos se precargan al abrir la app (las primeras de la fila). */
const PRELOAD_FIRST = 4;

export async function loadStories(restaurantId: string): Promise<StoryRow[]> {
  const list = await fetchStories(restaurantId);
  cached = list;
  preloadImages(list.filter((s) => s.media_type === 'image').slice(0, PRELOAD_FIRST).map((s) => s.media_url));
  return list;
}

export function preloadStory(story: StoryRow | undefined): void {
  if (story?.media_type === 'image') preloadImages([story.media_url]);
}

// ---------------------------------------------------------------------
// Abrir solas al cargar la app
// ---------------------------------------------------------------------

let autoOpenedThisSession = false;

/** Ya se decidió en esta visita si las historias salen solas. */
export function autoOpenDecided(): boolean {
  return autoOpenedThisSession;
}

/** Id de la historia con la que abrir el visor solo, o null. Una vez por visita. */
export async function takeAutoOpen(stories: readonly StoryRow[]): Promise<string | null> {
  if (autoOpenedThisSession) return null;
  autoOpenedThisSession = true;
  return autoOpenStart(stories, await loadSeenStories());
}
