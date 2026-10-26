/** Perfil, lealtad y recompensas del usuario que ha iniciado sesion. */

import { dataError } from '../domain/errors';
import { localized, localizedOptional } from '../i18n';
import { getSupabase } from '../supabase';
import type { LoyaltyAccountRow, LoyaltyProgramRow, ProfileRow, RewardRow } from './types';

export async function fetchProfile(userId: string): Promise<ProfileRow | null> {
  const query = (withAvatar: boolean) =>
    getSupabase()
      .from('profiles')
      .select(`id, first_name, last_name, phone, marketing_opt_in, default_store_id${withAvatar ? ', avatar_path' : ''}`)
      .eq('id', userId)
      .maybeSingle<ProfileRow>();
  let { data, error } = await query(true);
  // Base sin la 0034: sin foto.
  if (error?.code === '42703') ({ data, error } = await query(false));

  if (error) throw dataError(error.message, error.code);
  return data;
}

export interface ProfileInput {
  readonly first_name: string | null;
  readonly last_name: string | null;
  readonly phone: string | null;
  readonly avatar_path?: string | null;
}

export async function updateProfile(userId: string, input: ProfileInput): Promise<void> {
  const supabase = getSupabase();
  let { error } = await supabase.from('profiles').update(input).eq('id', userId);
  if (error?.code === 'PGRST204' || error?.code === '42703') {
    const { avatar_path: _ignored, ...rest } = input;
    ({ error } = await supabase.from('profiles').update(rest).eq('id', userId));
  }
  if (error) throw dataError(error.message, error.code);
}

/** Sube la foto a avatars/<usuario>/… y devuelve la ruta para el perfil. */
export async function uploadAvatar(userId: string, blob: Blob): Promise<string> {
  const path = `${userId}/avatar-${Date.now()}.jpg`;
  const { error } = await getSupabase().storage.from('avatars').upload(path, blob, {
    contentType: 'image/jpeg',
    upsert: false,
  });
  if (error) throw dataError(error.message);
  return path;
}

export async function changePassword(password: string): Promise<void> {
  const { error } = await getSupabase().auth.updateUser({ password });
  if (error) throw dataError(error.message);
}

/** El bucket es privado: se pide una liga firmada que dura una hora. */
export async function avatarUrl(path: string | null | undefined): Promise<string | null> {
  if (path === null || path === undefined || path === '') return null;
  const { data, error } = await getSupabase().storage.from('avatars').createSignedUrl(path, 3600);
  if (error) return null;
  return data.signedUrl;
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
