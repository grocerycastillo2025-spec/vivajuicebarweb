import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  autoOpenStart,
  expiresFor,
  hoursLeft,
  mediaTypeOf,
  orderForViewer,
  storyStatus,
  trimSeen,
} from '../domain/stories.ts';

const NOW = new Date('2026-10-25T18:00:00Z');

describe('historias', () => {
  it('estado segun las fechas', () => {
    assert.equal(storyStatus({ starts_at: '2026-10-25T10:00:00Z', expires_at: null }, NOW), 'featured');
    assert.equal(
      storyStatus({ starts_at: '2026-10-25T10:00:00Z', expires_at: '2026-10-26T10:00:00Z' }, NOW),
      'active',
    );
    assert.equal(
      storyStatus({ starts_at: '2026-10-24T10:00:00Z', expires_at: '2026-10-25T10:00:00Z' }, NOW),
      'expired',
    );
    assert.equal(storyStatus({ starts_at: '2026-10-26T10:00:00Z', expires_at: null }, NOW), 'scheduled');
  });

  it('duraciones', () => {
    assert.equal(expiresFor('24h', NOW), '2026-10-26T18:00:00.000Z');
    assert.equal(expiresFor('7d', NOW), '2026-11-01T18:00:00.000Z');
    assert.equal(expiresFor('featured', NOW), null);
    assert.equal(hoursLeft({ starts_at: '', expires_at: '2026-10-25T20:30:00Z' }, NOW), 3);
    assert.equal(hoursLeft({ starts_at: '', expires_at: null }, NOW), null);
  });

  it('lo no visto va primero, respetando el orden del negocio', () => {
    const list = [
      { id: 'a', sort_order: 10 },
      { id: 'b', sort_order: 20 },
      { id: 'c', sort_order: 30 },
    ];
    assert.deepEqual(
      orderForViewer(list, new Set(['a'])).map((s) => s.id),
      ['b', 'c', 'a'],
    );
    assert.deepEqual(
      orderForViewer(list, new Set()).map((s) => s.id),
      ['a', 'b', 'c'],
    );
  });

  it('tipos de archivo', () => {
    assert.equal(mediaTypeOf('image/jpeg'), 'image');
    assert.equal(mediaTypeOf('video/mp4'), 'video');
    assert.equal(mediaTypeOf('video/quicktime'), 'video');
    assert.equal(mediaTypeOf('image/gif'), null);
    assert.equal(mediaTypeOf('application/pdf'), null);
  });

  it('recorta la lista de vistos', () => {
    assert.deepEqual(trimSeen(['1', '2', '3'], 2), ['2', '3']);
  });
});

describe('historias al abrir la app', () => {
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  it('empieza por la primera nueva', () => {
    assert.equal(autoOpenStart(list, new Set(['a'])), 'b');
    assert.equal(autoOpenStart(list, new Set()), 'a');
  });
  it('si ya vio todas, igual abre desde el principio', () => {
    assert.equal(autoOpenStart(list, new Set(['a', 'b', 'c'])), 'a');
  });
  it('sin historias no abre', () => {
    assert.equal(autoOpenStart([], new Set()), null);
  });
});
