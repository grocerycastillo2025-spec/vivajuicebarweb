/** Historias (migracion 0022). */

import { dataError } from '../domain/errors';
import type { StoryDuration } from '../domain/stories';
import { expiresFor } from '../domain/stories';
import { localizedOptional } from '../i18n';
import { getSupabase } from '../supabase';

export interface StoryRow {
  readonly id: string;
  readonly media_url: string;
  readonly media_type: 'image' | 'video';
  readonly caption: string | null;
  readonly item_id: string | null;
  readonly starts_at: string;
  readonly expires_at: string | null;
  readonly sort_order: number;
  readonly created_at: string;
  /** Traducciones (0029): {"es": {"caption": "..."}}. */
  readonly i18n?: unknown;
}

const COLUMNS = 'id, media_url, media_type, caption, item_id, starts_at, expires_at, sort_order, created_at';

function fail(error: { message: string; code?: string } | null): void {
  if (error) throw dataError(error.message, error.code);
}

/**
 * Vigentes, para el cliente. La RLS ya filtra las caducadas y las
 * programadas; aqui solo se ordena.
 */
export async function fetchStories(restaurantId: string): Promise<StoryRow[]> {
  const query = (columns: string) =>
    getSupabase()
      .from('stories')
      .select(columns)
      .eq('restaurant_id', restaurantId)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: false })
      .returns<StoryRow[]>();
  let { data, error } = await query(COLUMNS + ', i18n');
  // Base sin la 0029: sin traducciones, pero con historias.
  if (error?.code === '42703') ({ data, error } = await query(COLUMNS));
  // Una base sin la 0022 no tiene historias: la fila no se pinta.
  if (error?.code === '42P01' || error?.code === 'PGRST205') return [];
  fail(error);
  return (data ?? []).map((story) => ({ ...story, caption: localizedOptional(story.caption, story.i18n, 'caption') }));
}

/** Todas, para el panel (el dueño tambien ve las caducadas). */
export async function fetchAdminStories(restaurantId: string): Promise<StoryRow[]> {
  const { data, error } = await getSupabase()
    .from('stories')
    .select(COLUMNS)
    .eq('restaurant_id', restaurantId)
    .order('created_at', { ascending: false })
    .limit(60)
    .returns<StoryRow[]>();
  fail(error);
  return data ?? [];
}

export async function createStory(
  restaurantId: string,
  input: {
    media_url: string;
    media_type: 'image' | 'video';
    caption: string;
    caption_es?: string;
    item_id: string | null;
    duration: StoryDuration;
  },
): Promise<void> {
  const row: Record<string, unknown> = {
    restaurant_id: restaurantId,
    media_url: input.media_url,
    media_type: input.media_type,
    caption: input.caption.trim() === '' ? null : input.caption.trim(),
    item_id: input.item_id,
    expires_at: expiresFor(input.duration),
    // Lo nuevo va delante de las destacadas.
    sort_order: -Math.floor(Date.now() / 1000),
  };
  const es = input.caption_es?.trim() ?? '';
  if (es !== '') row['i18n'] = { es: { caption: es } };
  let { error } = await getSupabase().from('stories').insert(row);
  // Base sin la 0029: se guarda sin la traducción.
  if ((error?.code === '42703' || error?.code === 'PGRST204') && 'i18n' in row) {
    const { i18n: _sinTraduccion, ...sinI18n } = row;
    ({ error } = await getSupabase().from('stories').insert(sinI18n));
  }
  fail(error);
}

export async function setStoryDuration(storyId: string, duration: StoryDuration): Promise<void> {
  const { error } = await getSupabase()
    .from('stories')
    .update({ expires_at: expiresFor(duration), starts_at: new Date().toISOString() })
    .eq('id', storyId);
  fail(error);
}

export async function deleteStory(storyId: string): Promise<void> {
  const { error } = await getSupabase().from('stories').delete().eq('id', storyId);
  fail(error);
}
