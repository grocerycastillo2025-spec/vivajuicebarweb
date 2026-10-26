/** Perfil, lealtad y recompensas del usuario que ha iniciado sesion. */

import { dataError } from '../domain/errors';
import { localized, localizedOptional } from '../i18n';
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
    .select('*')
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
  const query = (withI18n: boolean) =>
    getSupabase()
      .from('rewards')
      .select(withI18n ? 'id, name, description, image_url, cost_points, i18n' : 'id, name, description, image_url, cost_points')
      .eq('tenant_id', restaurantId)
      .eq('active', true)
      .order('cost_points', { ascending: true })
      .returns<RewardRow[]>();
  let { data, error } = await query(true);
  // Base sin la 0032: sin traducciones.
  if (error?.code === '42703') ({ data, error } = await query(false));

  if (error) throw dataError(error.message, error.code);
  return (data ?? []).map((r) => ({
    ...r,
    name: localized(r.name, r.i18n, 'name'),
    description: localizedOptional(r.description, r.i18n, 'description'),
  }));
}
