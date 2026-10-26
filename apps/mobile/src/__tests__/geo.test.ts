import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatLatLng, geocodeQuery, isLatLng, parseGeocode, roundLatLng } from '../domain/geo.ts';

describe('Punto en el mapa', () => {
  it('valida coordenadas', () => {
    assert.equal(isLatLng(40.2601, -74.2738), true);
    assert.equal(isLatLng(0, 0), false);
    assert.equal(isLatLng(91, 0), false);
    assert.equal(isLatLng(null, 1), false);
  });

  it('redondea a 6 decimales', () => {
    assert.deepEqual(roundLatLng({ lat: 40.26012345678, lng: -74.27381234 }), { lat: 40.260123, lng: -74.273812 });
    assert.equal(formatLatLng({ lat: 40.26, lng: -74.27 }), '40.260000, -74.270000');
  });

  it('arma la búsqueda de la dirección', () => {
    assert.equal(
      geocodeQuery({ address: '31 South St', city: 'Freehold', state: 'NJ', postal: '07728' }),
      '31 South St, Freehold, NJ, 07728, USA',
    );
    assert.equal(geocodeQuery({ address: ' ', city: '', state: 'NJ', postal: '' }), null);
  });

  it('lee la respuesta del buscador', () => {
    assert.deepEqual(parseGeocode([{ lat: '40.2601', lon: '-74.2738' }]), { lat: 40.2601, lng: -74.2738 });
    assert.equal(parseGeocode([]), null);
    assert.equal(parseGeocode({ error: 'x' }), null);
  });
});
