/**
 * Lealtad por visitas (migracion 0021).
 *
 * Todo lo que mueve puntos es una funcion de la base (`claim_visit`,
 * `redeem_reward`, `use_redemption`...): el cliente no tiene permiso para
 * escribir puntos, y el panel tampoco los toca a mano.
 */

import { dataError } from '../domain/errors';
import type { CardState } from '../domain/loyalty-card';
import type { VisitPayload } from '../domain/visit';
import { getSupabase } from '../supabase';
import type { LoyaltyProgramRow, RewardRow } from './types';

function fail(error: { message: string; code?: string } | null): void {
  if (error) throw dataError(error.message, error.code);
}

async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await getSupabase().rpc(name, args);
  fail(error);
  if (data === null || data === undefined) throw dataError(`${name} no devolvio nada`);
  return data as T;
}

// ---------------------------------------------------------------------
// CLIENTE
// ---------------------------------------------------------------------

export interface VisitResult {
  readonly points: number;
  readonly balance: number;
  readonly next_at: string;
}

export function claimVisit(payload: VisitPayload): Promise<VisitResult> {
  return rpc('claim_visit', { p_store_id: payload.storeId, p_code: payload.code });
}

export interface RedeemResult {
  readonly redemption_id: string;
  readonly code: string;
  readonly reward: string;
  readonly balance: number;
}

export function redeemReward(rewardId: string): Promise<RedeemResult> {
  return rpc('redeem_reward', { p_reward_id: rewardId });
}

export function cancelRedemption(redemptionId: string): Promise<{ balance: number }> {
  return rpc('cancel_redemption', { p_redemption_id: redemptionId });
}

export interface RedemptionRow {
  readonly id: string;
  readonly code: string | null;
  readonly status: 'issued' | 'used' | 'canceled';
  readonly reward_name: string | null;
  readonly points_cost: number;
  readonly redeemed_at: string;
  readonly used_at: string | null;
}

/** Canjes del cliente: los vigentes primero, luego los ultimos usados. */
export async function fetchMyRedemptions(userId: string): Promise<RedemptionRow[]> {
  const { data, error } = await getSupabase()
    .from('reward_redemptions')
    .select('id, code, status, reward_name, points_cost, redeemed_at, used_at')
    .eq('user_id', userId)
    .neq('status', 'canceled')
    .order('redeemed_at', { ascending: false })
    .limit(10)
    .returns<RedemptionRow[]>();
  fail(error);
  return data ?? [];
}

export interface MyCard {
  readonly code: string;
  readonly balance: number;
  readonly lifetime: number;
}

/** Tarjeta del cliente (0032). `null` si la base todavía no la tiene. */
export async function fetchMyCard(restaurantId: string): Promise<MyCard | null> {
  const { data, error } = await getSupabase().rpc('my_loyalty_card', { p_restaurant_id: restaurantId });
  if (error?.code === 'PGRST202' || error?.code === '42883') return null;
  fail(error);
  return (data as MyCard | null) ?? null;
}

// ---------------------------------------------------------------------
// PANEL
// ---------------------------------------------------------------------

// Tarjeta del cliente: la tienda la escanea (0032). Los errores llegan con
// el código de la base (`card_not_found`, `too_soon:...`) y la pantalla los
// traduce con `parseCardError`.
export function lookupCard(storeId: string, card: string): Promise<CardState> {
  return rpc('loyalty_lookup', { p_store_id: storeId, p_card: card });
}

export function addVisit(storeId: string, card: string): Promise<CardState> {
  return rpc('staff_add_visit', { p_store_id: storeId, p_card: card });
}

export function giveReward(storeId: string, card: string, rewardId: string): Promise<CardState> {
  return rpc('staff_give_reward', { p_store_id: storeId, p_card: card, p_reward_id: rewardId });
}

export interface GivenReward {
  readonly id: string;
  readonly given_at: string;
  readonly reward_name: string | null;
  readonly customer: string | null;
  readonly given_by: string | null;
  readonly status: 'issued' | 'used' | 'canceled';
  readonly code: string | null;
  readonly reward_i18n?: unknown;
}

/** A quién se le dio qué y quién lo entregó. Sin la 0032, los canjes de antes. */
export async function fetchRewardsGiven(restaurantId: string): Promise<GivenReward[]> {
  const { data, error } = await getSupabase().rpc('rewards_given', { p_restaurant_id: restaurantId, p_limit: 30 });
  if (error?.code === 'PGRST202' || error?.code === '42883') {
    const old = await fetchRecentRedemptions(restaurantId);
    return old.map((r) => ({
      id: r.id,
      given_at: r.used_at ?? r.redeemed_at,
      reward_name: r.reward_name,
      customer: null,
      given_by: null,
      status: r.status,
      code: r.code,
    }));
  }
  fail(error);
  return Array.isArray(data) ? (data as GivenReward[]) : [];
}

export interface VisitQr {
  readonly mode: 'static' | 'rotating';
  readonly code: string;
  readonly expires_at?: string;
  readonly rotated_at?: string;
}

export function fetchVisitQr(storeId: string): Promise<VisitQr> {
  return rpc('visit_qr', { p_store_id: storeId });
}

export function setVisitQrMode(storeId: string, mode: VisitQr['mode']): Promise<VisitQr> {
  return rpc('set_visit_qr_mode', { p_store_id: storeId, p_mode: mode });
}

export function regenerateVisitCode(storeId: string): Promise<VisitQr> {
  return rpc('regenerate_visit_code', { p_store_id: storeId });
}

export interface UsedRedemption {
  readonly reward: string | null;
  readonly customer: string | null;
  readonly points: number;
}

export function validateRedemptionCode(code: string): Promise<UsedRedemption> {
  return rpc('use_redemption', { p_code: code });
}

export async function fetchOwnerProgram(restaurantId: string): Promise<LoyaltyProgramRow | null> {
  const { data, error } = await getSupabase()
    .from('loyalty_programs')
    .select('*')
    .eq('restaurant_id', restaurantId)
    .maybeSingle<LoyaltyProgramRow>();
  fail(error);
  return data;
}

/**
 * Guarda el programa y enciende o apaga la pestaña "Puntos" de la app
 * (`app_settings.features.loyalty`), para que las dos cosas no queden
 * desalineadas: un programa activo sin pestaña no lo encuentra nadie.
 */
export async function saveProgram(
  restaurantId: string,
  input: { enabled: boolean; points_per_visit: number; visit_cooldown_hours: number; self_checkin?: boolean },
): Promise<void> {
  const supabase = getSupabase();
  let saved = await supabase
    .from('loyalty_programs')
    .upsert({ restaurant_id: restaurantId, ...input }, { onConflict: 'restaurant_id' });
  if (saved.error?.code === 'PGRST204' || saved.error?.code === '42703') {
    // Base sin la 0032: se guarda lo demás.
    const { self_checkin: _ignored, ...rest } = input;
    saved = await supabase.from('loyalty_programs').upsert({ restaurant_id: restaurantId, ...rest }, { onConflict: 'restaurant_id' });
  }
  fail(saved.error);

  const current = await supabase
    .from('app_settings')
    .select('features')
    .eq('restaurant_id', restaurantId)
    .maybeSingle<{ features: Record<string, boolean> }>();
  fail(current.error);
  const features = { ...(current.data?.features ?? {}), loyalty: input.enabled };
  const { error } = await supabase.from('app_settings').update({ features }).eq('restaurant_id', restaurantId);
  fail(error);
}

export interface AdminReward extends RewardRow {
  readonly active: boolean;
}

export async function fetchAdminRewards(restaurantId: string): Promise<AdminReward[]> {
  const { data, error } = await getSupabase()
    .from('rewards')
    .select('*')
    .eq('tenant_id', restaurantId)
    .order('cost_points')
    .returns<AdminReward[]>();
  fail(error);
  return data ?? [];
}

/** Texto en español guardado en `i18n.es`. */
export function rewardSpanish(reward: AdminReward | null, field: 'name' | 'description'): string {
  const es = (reward?.i18n as { es?: Record<string, unknown> } | undefined)?.es;
  const value = es?.[field];
  return typeof value === 'string' ? value : '';
}

export async function saveReward(
  restaurantId: string,
  reward: {
    id?: string;
    name: string;
    description: string;
    nameEs?: string;
    descriptionEs?: string;
    cost_points: number;
    active: boolean;
  },
): Promise<void> {
  const es: Record<string, string> = {};
  if ((reward.nameEs ?? '').trim() !== '') es['name'] = (reward.nameEs ?? '').trim();
  if ((reward.descriptionEs ?? '').trim() !== '') es['description'] = (reward.descriptionEs ?? '').trim();
  const base = {
    tenant_id: restaurantId,
    // Sin inglés, el español queda de texto base.
    name: reward.name.trim() !== '' ? reward.name.trim() : (reward.nameEs ?? '').trim(),
    description: reward.description.trim() === '' ? null : reward.description.trim(),
    cost_points: reward.cost_points,
    active: reward.active,
  };
  const supabase = getSupabase();
  const write = (row: Record<string, unknown>) =>
    reward.id === undefined
      ? supabase.from('rewards').insert(row)
      : supabase.from('rewards').update(row).eq('id', reward.id);
  let { error } = await write({ ...base, i18n: Object.keys(es).length === 0 ? {} : { es } });
  // Base sin la 0032: sin traducción.
  if (error?.code === 'PGRST204' || error?.code === '42703') ({ error } = await write(base));
  fail(error);
}

export interface AdminRedemption extends RedemptionRow {
  readonly user_id: string;
}

/** Ultimos canjes del negocio, para que el mostrador vea que se entrego. */
export async function fetchRecentRedemptions(restaurantId: string): Promise<AdminRedemption[]> {
  const { data, error } = await getSupabase()
    .from('reward_redemptions')
    .select('id, code, status, reward_name, points_cost, redeemed_at, used_at, user_id')
    .eq('tenant_id', restaurantId)
    .order('redeemed_at', { ascending: false })
    .limit(20)
    .returns<AdminRedemption[]>();
  fail(error);
  return data ?? [];
}
