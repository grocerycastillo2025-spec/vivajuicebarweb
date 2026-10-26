/**
 * QR de visita (migracion 0021): lo que se puede razonar sin red.
 *
 * El QR del local es un enlace a la app: `<app>/visita?s=<sucursal>&c=<codigo>`.
 * Asi sirve de las dos maneras: escaneado desde la app (se lee el enlace
 * y se navega dentro) o con la camara del telefono (abre la app web en
 * esa pantalla).
 *
 * Modulo puro, sin imports en tiempo de ejecucion.
 */

export interface VisitPayload {
  readonly storeId: string;
  readonly code: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[0-9a-z]{6,32}$/i;

/** Enlace que va dentro del QR. `appUrl` es la raiz publica de la app. */
export function buildVisitUrl(appUrl: string, payload: VisitPayload): string {
  const base = appUrl.replace(/\/+$/, '');
  const query = `s=${encodeURIComponent(payload.storeId)}&c=${encodeURIComponent(payload.code)}`;
  return `${base}/visita?${query}`;
}

/**
 * Lee lo que devolvio el escaner. Acepta el enlace completo, solo la ruta
 * o la consulta. Cualquier otra cosa (un QR de otro negocio, de un menu,
 * de wifi) devuelve `null`: no se navega a enlaces ajenos.
 */
export function parseVisitPayload(text: string): VisitPayload | null {
  const raw = text.trim();
  if (raw === '') return null;

  const at = raw.indexOf('/visita?');
  const query = at !== -1 ? raw.slice(at + '/visita?'.length) : raw.startsWith('?') ? raw.slice(1) : null;
  if (query === null) return null;

  const params = new Map<string, string>();
  for (const pair of query.split('#')[0]?.split('&') ?? []) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    try {
      params.set(pair.slice(0, eq), decodeURIComponent(pair.slice(eq + 1)));
    } catch {
      return null;
    }
  }

  return toPayload(params.get('s'), params.get('c'));
}

/** Valida los parametros de la ruta /visita. */
export function toPayload(storeId: unknown, code: unknown): VisitPayload | null {
  if (typeof storeId !== 'string' || typeof code !== 'string') return null;
  if (!UUID.test(storeId) || !CODE.test(code)) return null;
  return { storeId, code };
}

// ---------------------------------------------------------------------
// ERRORES DE LA BASE -> que decirle al cliente
// ---------------------------------------------------------------------

export type VisitFailure =
  | { readonly kind: 'too_soon'; readonly nextAt: Date | null }
  | { readonly kind: 'invalid_code' }
  | { readonly kind: 'loyalty_disabled' }
  | { readonly kind: 'auth_required' }
  | { readonly kind: 'unknown'; readonly detail: string };

export function parseVisitError(message: string): VisitFailure {
  const soon = /too_soon:(\S+)/.exec(message);
  if (soon !== null) {
    const when = new Date(soon[1] ?? '');
    return { kind: 'too_soon', nextAt: Number.isFinite(when.getTime()) ? when : null };
  }
  if (message.includes('too_soon')) return { kind: 'too_soon', nextAt: null };
  if (message.includes('invalid_code')) return { kind: 'invalid_code' };
  if (message.includes('loyalty_disabled')) return { kind: 'loyalty_disabled' };
  if (message.includes('auth_required')) return { kind: 'auth_required' };
  return { kind: 'unknown', detail: message };
}

export type RedeemFailure = 'not_enough_points' | 'reward_not_available' | 'loyalty_disabled' | 'unknown';

export function parseRedeemError(message: string): RedeemFailure {
  for (const code of ['not_enough_points', 'reward_not_available', 'loyalty_disabled'] as const) {
    if (message.includes(code)) return code;
  }
  return 'unknown';
}

export type UseRedemptionFailure =
  | { readonly kind: 'not_found' }
  | { readonly kind: 'already_used'; readonly usedAt: Date | null }
  | { readonly kind: 'canceled' }
  | { readonly kind: 'unknown'; readonly detail: string };

export function parseUseRedemptionError(message: string): UseRedemptionFailure {
  const used = /redemption_already_used:(\S+)/.exec(message);
  if (used !== null) {
    const when = new Date(used[1] ?? '');
    return { kind: 'already_used', usedAt: Number.isFinite(when.getTime()) ? when : null };
  }
  if (message.includes('redemption_not_found')) return { kind: 'not_found' };
  if (message.includes('redemption_canceled')) return { kind: 'canceled' };
  return { kind: 'unknown', detail: message };
}

/** Normaliza lo que teclea el cajero: "abc 234" -> "ABC234". */
export function normalizeRedemptionCode(raw: string): string {
  return raw.replace(/[^0-9a-z]/gi, '').toUpperCase();
}

/** Cuantos puntos faltan para una recompensa (0 si ya alcanza). */
export function pointsMissing(balance: number, cost: number): number {
  return Math.max(0, Math.trunc(cost) - Math.trunc(balance));
}
