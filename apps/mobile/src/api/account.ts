/** Perfil, lealtad y recompensas del usuario que ha iniciado sesion. */

import { dataError } from '../domain/errors';
import { getSupabase } from '../supabase';
import type { LoyaltyAccountRow, LoyaltyProgramRow, ProfileRow, RewardRow } from './types';

export async function fetchProfile(userId: string): Promise<ProfileRow | null> {
  const { data, error } = await getSupabase()
    .from('profiles')
    .select('id, first_name, last_name, phone, marketing_opt_in, default_store_id')
    .eq('id', userId)
    .maybeSingle<ProfileRow>();

  if (error) throw dataError(error.message, error.code);
  return data;
}

export async function fetchLoyaltyProgram(restaurantId: string): Promise<LoyaltyProgramRow | null> {
  const { data, error } = await getSupabase()
    .from('loyalty_programs')
    .select(
      'restaurant_id, enabled, points_per_dollar, min_points_to_redeem, points_per_visit, visit_cooldown_hours',
    )
    .eq('restaurant_id', restaurantId)
    .maybeSingle<LoyaltyProgramRow>();

  if (error) throw dataError(error.message, error.code);
  return data;
}

/** `null` cuando no hay sesion o el usuario aun no tiene cuenta de puntos. */
export async function fetchLoyaltyAccount(): Promise<LoyaltyAccountRow | null> {
  const { data, error } = await getSupabase()
    .from('loyalty_accounts')
    .select('points_balance, lifetime_points, tier')
    .maybeSingle<LoyaltyAccountRow>();

  if (error) throw dataError(error.message, error.code);
  return data;
}

export async function fetchRewards(restaurantId: string): Promise<RewardRow[]> {
  const { data, error } = await getSupabase()
    .from('rewards')
    .select('id, name, description, image_url, cost_points')
    .eq('tenant_id', restaurantId)
    .eq('active', true)
    .order('cost_points', { ascending: true })
    .returns<RewardRow[]>();

  if (error) throw dataError(error.message, error.code);
  return data ?? [];
}
