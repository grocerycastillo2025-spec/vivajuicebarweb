import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { teamErrorCode, tempPassword } from '../domain/team.ts';

describe('Equipo', () => {
  it('contraseña temporal legible y de al menos 8', () => {
    const p = tempPassword(() => 0);
    assert.equal(p, 'Viva-AAAA-2222');
    assert.match(tempPassword(), /^Viva-[A-HJ-NP-Z]{4}-[2-9]{4}$/);
    assert.ok(tempPassword().length >= 8);
  });
  it('lee el motivo del error', () => {
    assert.equal(teamErrorCode('solo_dueno'), 'solo_dueno');
    assert.equal(teamErrorCode('algo raro'), null);
  });
});
