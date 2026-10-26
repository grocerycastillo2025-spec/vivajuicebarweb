import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { shortAddress, storeMapsUrl } from '../domain/maps.ts';

// La sucursal del seed.
const FREEHOLD = {
  name: 'Freehold',
  latitude: 40.2595,
  longitude: -74.2743,
  addressLine1: '31 South St',
  city: 'Freehold',
  state: 'NJ',
  postalCode: '07728',
};

describe('abrir la sucursal en Google Maps', () => {
  it('con coordenadas, va al punto exacto', () => {
    assert.equal(
      storeMapsUrl(FREEHOLD),
      'https://www.google.com/maps/search/?api=1&query=40.2595%2C-74.2743',
    );
  });

  it('sin coordenadas, busca el local por nombre y direccion', () => {
    assert.equal(
      storeMapsUrl({ ...FREEHOLD, latitude: null, longitude: null }),
      'https://www.google.com/maps/search/?api=1&query=' +
        encodeURIComponent('Freehold, 31 South St, Freehold, NJ, 07728'),
    );
  });

  it('una coordenada sola no sirve: se cae a la direccion', () => {
    const url = storeMapsUrl({ ...FREEHOLD, longitude: null });
    assert.ok(url !== null && url.includes(encodeURIComponent('31 South St')));
  });

  it('coordenadas imposibles se descartan en vez de llevar al oceano', () => {
    // Un 200 en la longitud es un dato mal cargado, no un sitio.
    const url = storeMapsUrl({ ...FREEHOLD, longitude: 200 });
    assert.ok(url !== null && url.includes(encodeURIComponent('31 South St')));

    assert.ok(storeMapsUrl({ ...FREEHOLD, latitude: Number.NaN })?.includes('South'));
  });

  it('sin coordenadas y sin direccion no hay enlace', () => {
    assert.equal(
      storeMapsUrl({
        name: 'Sin datos',
        latitude: null,
        longitude: null,
        addressLine1: null,
        city: null,
        state: null,
        postalCode: null,
      }),
      null,
    );
  });

  it('los espacios y las comas van escapados', () => {
    const url = storeMapsUrl({ name: 'A & B', latitude: null, longitude: null, city: 'New York' });
    assert.ok(url !== null);
    assert.ok(!url.includes(' '));
    assert.ok(url.includes('%20') || url.includes('%26'));
  });

  it('la direccion corta es calle y ciudad, sin estado ni codigo postal', () => {
    assert.equal(shortAddress(FREEHOLD), '31 South St, Freehold');
    assert.equal(shortAddress({ ...FREEHOLD, addressLine1: null }), 'Freehold');
    assert.equal(shortAddress({ name: 'x' }), '');
  });

  it('los campos en blanco no dejan comas sueltas', () => {
    assert.equal(shortAddress({ ...FREEHOLD, city: '   ' }), '31 South St');
  });
});
