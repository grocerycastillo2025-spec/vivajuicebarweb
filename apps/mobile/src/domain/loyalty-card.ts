/**
 * Tarjeta de lealtad del cliente (0032): lo que se razona sin red.
 *
 * El QR del cliente es un enlace al panel: `<app>/admin/cliente?c=<tarjeta>`.
 * Así la tienda lo puede leer con el escáner del panel o con la cámara del
 * teléfono (abre el panel en esa pantalla; si no hay sesión de tienda, pide
 * entrar). El código no es el id ni el correo del cliente: es al azar.
 *
 * Módulo puro, sin imports en tiempo de ejecución.
 */

const CARD = /^[A-HJ-NP-Z2-9]{10}$/;

/** Mayúsculas, sin espacios ni guiones. `null` si no parece una tarjeta. */
export function normalizeCard(text: string): string | null {
  const clean = text.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return CARD.test(clean) ? clean : null;
}

/** "ABCDE-FGHJK": más fácil de dictar o teclear si la cámara falla. */
export function formatCard(code: string): string {
  return code.length === 10 ? `${code.slice(0, 5)}-${code.slice(5)}` : code;
}

export function buildCardUrl(appUrl: string, code: string): string {
  return `${appUrl.replace(/\/+$/, '')}/admin/cliente?c=${encodeURIComponent(code)}`;
}

/**
 * Lee lo que devolvió el escáner del panel: el enlace de la tarjeta o el
 * código solo (con o sin guion). Un QR de otra cosa devuelve `null`.
 */
export function parseCardPayload(text: string): string | null {
  const raw = text.trim();
  if (raw === '') return null;
  const at = raw.indexOf('/admin/cliente?');
  if (at !== -1) {
    const query = raw.slice(at + '/admin/cliente?'.length).split('#')[0] ?? '';
    for (const pair of query.split('&')) {
      const [key, value] = pair.split('=');
      if (key === 'c' && value !== undefined) {
        try {
          return normalizeCard(decodeURIComponent(value));
        } catch {
          return null;
        }
      }
    }
    return null;
  }
  if (raw.includes('/') || raw.includes('?')) return null;
  return normalizeCard(raw);
}

export interface CardReward {
  readonly id: string;
  readonly name: string;
  readonly i18n?: unknown;
  readonly cost: number;
  readonly eligible: boolean;
  readonly missing: number;
}

export interface CardState {
  readonly card: string;
  readonly customer: string;
  readonly balance: number;
  readonly lifetime: number;
  readonly visits: number;
  readonly last_visit_at: string | null;
  readonly next_visit_at: string | null;
  readonly can_visit: boolean;
  readonly points_per_visit: number;
  readonly rewards_given: number;
  readonly rewards: readonly CardReward[];
  /** Solo al sumar visita: las recompensas que alcanzó con ella. */
  readonly added?: number;
  readonly newly_eligible?: readonly string[];
  /** Solo al entregar. */
  readonly given?: string;
}

export type CardFailure =
  | { readonly kind: 'not_found' }
  | { readonly kind: 'too_soon'; readonly nextAt: Date | null }
  | { readonly kind: 'not_enough' }
  | { readonly kind: 'reward_gone' }
  | { readonly kind: 'disabled' }
  | { readonly kind: 'staff_only' }
  | { readonly kind: 'missing_sql' }
  | { readonly kind: 'other'; readonly detail: string };

export function parseCardError(message: string): CardFailure {
  if (message.includes('card_not_found')) return { kind: 'not_found' };
  const soon = /too_soon:(\S+)/.exec(message);
  if (soon !== null) {
    const at = new Date(soon[1] ?? '');
    return { kind: 'too_soon', nextAt: Number.isNaN(at.getTime()) ? null : at };
  }
  if (message.includes('too_soon')) return { kind: 'too_soon', nextAt: null };
  if (message.includes('not_enough_points')) return { kind: 'not_enough' };
  if (message.includes('reward_not_available')) return { kind: 'reward_gone' };
  if (message.includes('loyalty_disabled')) return { kind: 'disabled' };
  if (message.includes('staff_only')) return { kind: 'staff_only' };
  if (/Could not find the function|PGRST202|does not exist/.test(message)) return { kind: 'missing_sql' };
  return { kind: 'other', detail: message };
}

/** Nombre de la recompensa en el idioma pedido (i18n {"es": {"name"}}). */
export function rewardLabel(reward: Pick<CardReward, 'name' | 'i18n'>, lang: string): string {
  const entry = (reward.i18n as Record<string, { name?: unknown } | undefined> | null | undefined)?.[lang];
  return typeof entry?.name === 'string' && entry.name.trim() !== '' ? entry.name : reward.name;
}

/** 0..1 hacia una recompensa, para la barra de progreso. */
export function progressTo(balance: number, cost: number): number {
  if (cost <= 0) return 1;
  return Math.max(0, Math.min(1, balance / cost));
}

/** Visitas que faltan (redondeando hacia arriba). */
export function visitsMissing(balance: number, cost: number, perVisit: number): number {
  if (perVisit <= 0) return 0;
  return Math.max(0, Math.ceil((cost - balance) / perVisit));
}
