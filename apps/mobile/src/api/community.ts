/**
 * Comunidad VIVA (0035). Todo por funciones de la base: la app no lee ni
 * escribe las tablas directo.
 */

import { dataError } from '../domain/errors';
import type { CommunityPost, CommunityReply, CommunitySummary, PostKind } from '../domain/community';
import { getSupabase } from '../supabase';

function fail(error: { message: string; code?: string } | null): void {
  if (error) throw dataError(error.message, error.code);
}

async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await getSupabase().rpc(name, args);
  fail(error);
  return data as T;
}

const missing = (error: { code?: string } | null): boolean => error?.code === 'PGRST202' || error?.code === '42883';

/** `null` si la base todavía no tiene la comunidad (falta correr el SQL). */
export async function fetchCommunitySummary(restaurantId: string): Promise<CommunitySummary | null> {
  const { data, error } = await getSupabase().rpc('community_summary', { p_restaurant_id: restaurantId });
  if (missing(error)) return null;
  fail(error);
  return data as CommunitySummary;
}

export async function fetchFeed(
  restaurantId: string,
  opts: { kind?: PostKind | null; before?: string | null; limit?: number } = {},
): Promise<CommunityPost[]> {
  const { data, error } = await getSupabase().rpc('community_feed', {
    p_restaurant_id: restaurantId,
    p_kind: opts.kind ?? null,
    p_before: opts.before ?? null,
    p_limit: opts.limit ?? 20,
  });
  if (missing(error)) return [];
  fail(error);
  return Array.isArray(data) ? (data as CommunityPost[]) : [];
}

export function fetchThread(postId: string): Promise<{ post: CommunityPost | null; replies: CommunityReply[] }> {
  return rpc('community_thread', { p_post_id: postId });
}

export function createPost(
  restaurantId: string,
  input: { kind: Exclude<PostKind, 'announcement'>; body: string; rating?: number | null; photoPath?: string | null },
): Promise<{ id: string; status: string; points: number }> {
  return rpc('community_post', {
    p_restaurant_id: restaurantId,
    p_kind: input.kind,
    p_body: input.body,
    p_rating: input.kind === 'review' ? (input.rating ?? null) : null,
    p_photo_path: input.photoPath ?? null,
  });
}

export function replyTo(postId: string, body: string): Promise<{ id: string }> {
  return rpc('community_reply', { p_post_id: postId, p_body: body });
}

export function setHelpful(postId: string, on: boolean): Promise<{ helpful_count: number }> {
  return rpc('community_helpful', { p_post_id: postId, p_on: on });
}

export function report(type: 'post' | 'reply', id: string, reason: string): Promise<{ reports: number }> {
  return rpc('community_report', { p_type: type, p_id: id, p_reason: reason });
}

export interface CommunityNotice {
  readonly id: string;
  readonly kind: 'store_reply' | 'reply' | 'helpful' | 'approved' | 'hidden' | 'points';
  readonly post_id: string | null;
  readonly actor_name: string | null;
  readonly points: number | null;
  readonly created_at: string;
  readonly read: boolean;
}

export async function fetchMyNotices(restaurantId: string, markRead = false): Promise<CommunityNotice[]> {
  const { data, error } = await getSupabase().rpc('community_my_notifications', {
    p_restaurant_id: restaurantId,
    p_mark_read: markRead,
  });
  if (missing(error)) return [];
  fail(error);
  return Array.isArray(data) ? (data as CommunityNotice[]) : [];
}

/** Sube la foto a community/<usuario>/… (bucket público) y devuelve la ruta. */
export async function uploadCommunityPhoto(userId: string, blob: Blob): Promise<string> {
  const path = `${userId}/${Date.now()}.jpg`;
  const { error } = await getSupabase().storage.from('community').upload(path, blob, {
    contentType: 'image/jpeg',
    upsert: false,
  });
  if (error) throw dataError(error.message);
  return path;
}

// ---------------------------------------------------------------------
// PANEL (solo dueño)
// ---------------------------------------------------------------------
export interface AdminCommunityPost extends Omit<CommunityPost, 'mine' | 'helped' | 'store_replied'> {
  readonly author_email: string | null;
  readonly report_count: number;
  readonly report_reasons: readonly string[];
  readonly replies: readonly CommunityReply[];
}

export type AdminFilter = 'review' | 'published' | 'hidden' | 'suggestion' | 'announcement';

export async function fetchAdminCommunity(restaurantId: string, filter: AdminFilter): Promise<AdminCommunityPost[]> {
  const data = await rpc<unknown>('community_admin_list', { p_restaurant_id: restaurantId, p_filter: filter });
  return Array.isArray(data) ? (data as AdminCommunityPost[]) : [];
}

export function moderate(
  type: 'post' | 'reply',
  id: string,
  action: 'publish' | 'hide',
  reason: string | null = null,
): Promise<{ status: string }> {
  return rpc('community_moderate', { p_type: type, p_id: id, p_action: action, p_reason: reason });
}

export function storePost(
  restaurantId: string,
  input: { body: string; photoPath?: string | null; eventDate?: string | null; pinned?: boolean },
): Promise<{ id: string }> {
  return rpc('community_store_post', {
    p_restaurant_id: restaurantId,
    p_body: input.body,
    p_photo_path: input.photoPath ?? null,
    p_event_date: input.eventDate ?? null,
    p_pinned: input.pinned ?? false,
  });
}

export function deleteAnnouncement(postId: string): Promise<void> {
  return rpc('community_delete_announcement', { p_post_id: postId });
}

export interface CommunitySettings {
  readonly enabled: boolean;
  readonly auto_min_stars: number;
  readonly review_points: number;
  readonly pending: number;
}

export function fetchCommunitySettings(restaurantId: string): Promise<CommunitySettings> {
  return rpc('community_get_settings', { p_restaurant_id: restaurantId });
}

export function saveCommunitySettings(
  restaurantId: string,
  input: { enabled: boolean; autoMinStars: number; reviewPoints: number },
): Promise<CommunitySettings> {
  return rpc('community_save_settings', {
    p_restaurant_id: restaurantId,
    p_enabled: input.enabled,
    p_auto_min_stars: input.autoMinStars,
    p_review_points: input.reviewPoints,
  });
}

export interface AuditRow {
  readonly created_at: string;
  readonly who: string | null;
  readonly action: string;
  readonly target_type: string;
  readonly reason: string | null;
  readonly excerpt: string | null;
}

export async function fetchCommunityAudit(restaurantId: string): Promise<AuditRow[]> {
  const data = await rpc<unknown>('community_audit_list', { p_restaurant_id: restaurantId });
  return Array.isArray(data) ? (data as AuditRow[]) : [];
}
