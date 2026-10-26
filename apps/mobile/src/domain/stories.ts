/**
 * Historias (migracion 0022): decisiones sin red.
 *
 * Modulo puro, sin imports en tiempo de ejecucion.
 */

export interface StoryTiming {
  readonly starts_at: string;
  readonly expires_at: string | null;
}

export type StoryStatus = 'scheduled' | 'active' | 'featured' | 'expired';

/** En que estado esta una historia ahora. `featured` = activa y sin caducidad. */
export function storyStatus(story: StoryTiming, now: Date = new Date()): StoryStatus {
  const t = now.getTime();
  if (Date.parse(story.starts_at) > t) return 'scheduled';
  if (story.expires_at === null) return 'featured';
  return Date.parse(story.expires_at) > t ? 'active' : 'expired';
}

export type StoryDuration = '24h' | '3d' | '7d' | 'featured';

const HOURS: Record<Exclude<StoryDuration, 'featured'>, number> = { '24h': 24, '3d': 72, '7d': 168 };

/** Caducidad para una duracion elegida en el panel. `null` = destacada. */
export function expiresFor(duration: StoryDuration, from: Date = new Date()): string | null {
  if (duration === 'featured') return null;
  return new Date(from.getTime() + HOURS[duration] * 3_600_000).toISOString();
}

/** Horas que le quedan (redondeando hacia arriba), o null si no caduca. */
export function hoursLeft(story: StoryTiming, now: Date = new Date()): number | null {
  if (story.expires_at === null) return null;
  return Math.max(0, Math.ceil((Date.parse(story.expires_at) - now.getTime()) / 3_600_000));
}

/**
 * Orden en la fila de inicio: primero las que el cliente no ha visto,
 * y dentro de cada grupo el orden que decidio el negocio. Asi lo nuevo
 * siempre queda a la vista, como en Instagram.
 */
export function orderForViewer<T extends { readonly id: string; readonly sort_order: number }>(
  stories: readonly T[],
  seen: ReadonlySet<string>,
): T[] {
  return stories
    .map((story, index) => ({ story, index }))
    .sort((a, b) => {
      const sa = seen.has(a.story.id) ? 1 : 0;
      const sb = seen.has(b.story.id) ? 1 : 0;
      if (sa !== sb) return sa - sb;
      if (a.story.sort_order !== b.story.sort_order) return a.story.sort_order - b.story.sort_order;
      return a.index - b.index;
    })
    .map((entry) => entry.story);
}

/** Cuanto dura en pantalla una imagen. Los videos duran lo que dura el video. */
export const IMAGE_STORY_MS = 5_000;

/** Tipo de medio segun el MIME del archivo elegido. */
export function mediaTypeOf(mime: string): 'image' | 'video' | null {
  if (/^image\/(jpeg|png|webp)$/.test(mime)) return 'image';
  if (/^video\/(mp4|webm|quicktime)$/.test(mime)) return 'video';
  return null;
}

/** El bucket admite 50 MB por archivo. */
export const MAX_STORY_BYTES = 50 * 1024 * 1024;

/** Limita la lista de ids vistos guardada en el telefono. */
export function trimSeen(ids: readonly string[], max = 200): string[] {
  return ids.length <= max ? [...ids] : ids.slice(ids.length - max);
}


/**
 * Con qué historia abrir el visor solo al cargar la app, o null.
 *
 * Cada vez que se abre la app (una vez por visita): si hay historias que
 * este teléfono no ha visto, empieza por la primera nueva; si ya vio
 * todas, empieza desde el principio. Así el dueño siempre tiene ese
 * espacio para sus promos.
 */
export function autoOpenStart(
  stories: readonly { readonly id: string }[],
  seen: ReadonlySet<string>,
): string | null {
  if (stories.length === 0) return null;
  const firstNew = stories.find((s) => !seen.has(s.id));
  return firstNew?.id ?? stories[0]?.id ?? null;
}
