import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { communityProblem, contactInfo, photoUrl, starBars, timeAgo } from '../domain/community.ts';

describe('Comunidad', () => {
  it('bloquea teléfonos, correos y tarjetas (igual que la base)', () => {
    assert.equal(contactInfo('llámame al (732) 555-0142'), 'number');
    assert.equal(contactInfo('ana@gmail.com'), 'email');
    assert.equal(contactInfo('4242 4242 4242 4242'), 'number');
    assert.equal(contactInfo('El Viva Berry de 16 oz por $8.50, 10/10'), null);
  });
  it('tiempo relativo', () => {
    const now = new Date('2026-10-27T12:00:00Z');
    assert.equal(timeAgo('2026-10-27T11:58:00Z', now, 'es', 'es-US'), 'hace 2 min');
    assert.equal(timeAgo('2026-10-27T09:00:00Z', now, 'en', 'en-US'), '3 h ago');
    assert.equal(timeAgo('2026-10-27T11:59:59Z', now, 'es', 'es-US'), 'ahora');
  });
  it('liga pública de la foto', () => {
    assert.equal(photoUrl('https://x.supabase.co/', 'u1/foto 1.jpg'), 'https://x.supabase.co/storage/v1/object/public/community/u1/foto%201.jpg');
    assert.equal(photoUrl('https://x', null), null);
  });
  it('errores de la base', () => {
    assert.equal(communityProblem('contact_info_blocked:email'), 'contact_email');
    assert.equal(communityProblem('contact_info_blocked:number'), 'contact_number');
    assert.equal(communityProblem('community_disabled'), 'disabled');
  });
  it('barras de estrellas', () => {
    const bars = starBars({ reviews: 4, stars: { '5': 3, '4': 1, '3': 0, '2': 0, '1': 0 } });
    assert.deepEqual(bars[0], { star: 5, count: 3, pct: 75 });
    assert.equal(bars.length, 5);
  });
});
