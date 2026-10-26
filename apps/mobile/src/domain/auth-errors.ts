/**
 * Mensajes de Supabase Auth → qué le decimos a la persona. Módulo puro.
 */
export type AuthProblem =
  | 'bad_credentials'
  | 'not_confirmed'
  | 'already_registered'
  | 'weak_password'
  | 'invalid_email'
  | 'rate_limited'
  | 'offline'
  | 'other';

export function authProblem(message: string): AuthProblem {
  const m = message.toLowerCase();
  if (m.includes('invalid login credentials') || m.includes('invalid_grant')) return 'bad_credentials';
  if (m.includes('email not confirmed')) return 'not_confirmed';
  if (m.includes('already registered') || m.includes('already been registered') || m.includes('user_already_exists')) {
    return 'already_registered';
  }
  if (m.includes('password should be') || m.includes('weak password') || m.includes('weak_password')) return 'weak_password';
  if (m.includes('invalid email') || m.includes('unable to validate email') || m.includes('email_address_invalid')) {
    return 'invalid_email';
  }
  if (m.includes('rate limit') || m.includes('too many') || m.includes('over_email_send_rate_limit')) return 'rate_limited';
  if (m.includes('failed to fetch') || m.includes('network')) return 'offline';
  return 'other';
}
