/**
 * Comunidad VIVA (0035): lo que se razona sin red. Módulo puro.
 */

export type PostKind = 'review' | 'question' | 'suggestion' | 'announcement';
export type PostStatus = 'published' | 'pending' | 'reported' | 'hidden';

export interface CommunityPost {
  readonly id: string;
  readonly kind: PostKind;
  readonly rating: number | null;
  readonly body: string;
  readonly photo_path: string | null;
  readonly author_name: string;
  readonly author_role: 'customer' | 'store';
  readonly verified: boolean;
  readonly status: PostStatus;
  readonly hidden_reason: string | null;
  readonly event_date: string | null;
  readonly pinned: boolean;
  readonly helpful_count: number;
  readonly reply_count: number;
  readonly created_at: string;
  readonly mine: boolean;
  readonly helped: boolean;
  readonly store_replied: boolean;
}

export interface CommunityReply {
  readonly id: string;
  readonly body: string;
  readonly author_name: string;
  readonly author_role: 'customer' | 'store';
  readonly verified?: boolean;
  readonly created_at: string;
  readonly mine?: boolean;
  readonly status: 'published' | 'reported' | 'hidden';
  readonly report_count?: number;
}

export interface CommunitySummary {
  readonly enabled: boolean;
  readonly reviews: number;
  readonly average: number | null;
  readonly stars: Readonly<Record<'1' | '2' | '3' | '4' | '5', number>>;
}

/**
 * Mismo filtro que la base (app.community_blocked): correos y 10+ dígitos
 * seguidos (teléfono, tarjeta, cuenta). Aquí solo para avisar antes de
 * enviar; la base es la que manda.
 */
export function contactInfo(text: string): 'email' | 'number' | null {
  if (/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(text)) return 'email';
  for (const m of text.matchAll(/[+(]?[0-9][0-9 ().-]{6,}[0-9]/g)) {
    if (m[0].replace(/[^0-9]/g, '').length >= 10) return 'number';
  }
  return null;
}

/** "hace 5 min", "hace 3 h", "hace 2 d" o la fecha. */
export function timeAgo(iso: string, now: Date, lang: 'es' | 'en', locale: string): string {
  const diff = Math.max(0, now.getTime() - new Date(iso).getTime()) / 1000;
  const es = lang === 'es';
  if (diff < 60) return es ? 'ahora' : 'now';
  if (diff < 3600) return es ? `hace ${Math.floor(diff / 60)} min` : `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return es ? `hace ${Math.floor(diff / 3600)} h` : `${Math.floor(diff / 3600)} h ago`;
  if (diff < 7 * 86400) return es ? `hace ${Math.floor(diff / 86400)} d` : `${Math.floor(diff / 86400)} d ago`;
  return new Date(iso).toLocaleDateString(locale, { day: 'numeric', month: 'short' });
}

export function photoUrl(supabaseUrl: string, path: string | null): string | null {
  if (path === null || path === '') return null;
  return `${supabaseUrl.replace(/\/+$/, '')}/storage/v1/object/public/community/${path
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;
}

export type CommunityProblem =
  | 'contact_email'
  | 'contact_number'
  | 'rating_required'
  | 'too_many'
  | 'disabled'
  | 'auth'
  | 'not_found'
  | 'own'
  | 'missing_sql'
  | 'other';

export function communityProblem(message: string): CommunityProblem {
  if (message.includes('contact_info_blocked:email')) return 'contact_email';
  if (message.includes('contact_info_blocked')) return 'contact_number';
  if (message.includes('rating_required')) return 'rating_required';
  if (message.includes('too_many_posts')) return 'too_many';
  if (message.includes('community_disabled')) return 'disabled';
  if (message.includes('auth_required')) return 'auth';
  if (message.includes('post_not_found')) return 'not_found';
  if (message.includes('own_content')) return 'own';
  if (/Could not find the function|PGRST202|does not exist/.test(message)) return 'missing_sql';
  return 'other';
}

/** Barras de 1 a 5 estrellas en porcentaje (0–100). */
export function starBars(summary: Pick<CommunitySummary, 'stars' | 'reviews'>): { star: number; pct: number; count: number }[] {
  return [5, 4, 3, 2, 1].map((star) => {
    const count = summary.stars[String(star) as '1'] ?? 0;
    return { star, count, pct: summary.reviews === 0 ? 0 : Math.round((count / summary.reviews) * 100) };
  });
}
