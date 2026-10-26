import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { authProblem } from '../domain/auth-errors.ts';

describe('Errores de inicio de sesión', () => {
  it('traduce los de Supabase', () => {
    assert.equal(authProblem('Invalid login credentials'), 'bad_credentials');
    assert.equal(authProblem('Email not confirmed'), 'not_confirmed');
    assert.equal(authProblem('User already registered'), 'already_registered');
    assert.equal(authProblem('Password should be at least 6 characters.'), 'weak_password');
    assert.equal(authProblem('Unable to validate email address: invalid format'), 'invalid_email');
    assert.equal(authProblem('email rate limit exceeded'), 'rate_limited');
    assert.equal(authProblem('TypeError: Failed to fetch'), 'offline');
    assert.equal(authProblem('otra cosa'), 'other');
  });
});
