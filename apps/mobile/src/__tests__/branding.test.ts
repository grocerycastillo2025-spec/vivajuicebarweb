import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildColors,
  contrastRatio,
  defaultBranding,
  isHexColor,
  normalizeBranding,
  readableOn,
} from '../domain/branding.ts';

describe('isHexColor', () => {
  it('acepta solo #RRGGBB', () => {
    assert.equal(isHexColor('#0E4A2B'), true);
    assert.equal(isHexColor('#0e4a2b'), true);
    assert.equal(isHexColor('0E4A2B'), false);
    assert.equal(isHexColor('#0E4'), false);
    assert.equal(isHexColor('verde'), false);
    assert.equal(isHexColor(null), false);
  });
});

describe('contrastRatio', () => {
  it('blanco sobre negro es 21:1', () => {
    assert.equal(Math.round(contrastRatio('#FFFFFF', '#000000')), 21);
  });

  it('un color consigo mismo es 1:1', () => {
    assert.equal(Math.round(contrastRatio('#0E4A2B', '#0E4A2B')), 1);
  });
});

describe('readableOn', () => {
  it('mantiene el crema sobre el verde de Viva: se lee de sobra', () => {
    assert.equal(readableOn('#0E4A2B', '#F5F0E6'), '#F5F0E6');
    assert.ok(contrastRatio('#0E4A2B', '#F5F0E6') >= 4.5);
  });

  it('descarta el color de marca si no llega a AA', () => {
    // Amarillo palido sobre crema es ilegible: se cae a texto oscuro.
    const result = readableOn('#FFF6C0', '#F5F0E6');
    assert.notEqual(result, '#F5F0E6');
    assert.ok(contrastRatio('#FFF6C0', result) >= 4.5);
  });

  it('sin color preferido elige el que mas contraste da', () => {
    assert.equal(readableOn('#000000'), '#FFFFFF');
    assert.equal(readableOn('#FFFFFF'), '#1A1A18');
  });
});

describe('buildColors', () => {
  it('mapea primario, secundario y acento de la marca', () => {
    const colors = buildColors('#0E4A2B', '#F5F0E6', '#E87722');
    assert.equal(colors.primary, '#0E4A2B');
    assert.equal(colors.background, '#F5F0E6');
    assert.equal(colors.accent, '#E87722');
  });

  it('un color invalido en la base no rompe la app', () => {
    // Cae a los colores de VIVA Juice and Coffee (verde, crema, naranja).
    const colors = buildColors('azulito', null, undefined);
    assert.equal(colors.primary, '#0E4A2B');
    assert.equal(colors.background, '#F5F0E6');
    assert.equal(colors.accent, '#E87722');
  });

  it('el texto sobre primario y sobre acento siempre cumple AA', () => {
    // #7A7A7A es el caso duro: solo el negro puro llega a 4.5 sobre el.
    for (const primary of ['#0E4A2B', '#C9480F', '#FFF6C0', '#000000', '#FFFFFF', '#7A7A7A']) {
      const colors = buildColors(primary, '#F5F0E6', '#E87722');
      assert.ok(
        contrastRatio(colors.primary, colors.onPrimary) >= 4.5,
        `contraste insuficiente sobre ${primary}`,
      );
      assert.ok(contrastRatio(colors.accent, colors.onAccent) >= 4.5);
    }
  });
});

describe('normalizeBranding', () => {
  it('sin fila devuelve el branding por defecto', () => {
    assert.deepEqual(normalizeBranding(null), defaultBranding);
    assert.deepEqual(normalizeBranding(undefined), defaultBranding);
  });

  it('lee el nombre, el logo y los colores del seed', () => {
    const branding = normalizeBranding({
      app_display_name: 'Viva Juice and Coffee',
      logo_url: 'https://cdn.example/logo.png',
      primary_color: '#0E4A2B',
      secondary_color: '#F5F0E6',
      accent_color: '#E87722',
      features: { loyalty: true, promotions: true, tips: true, favorites: true, scheduling: true },
    });

    assert.equal(branding.displayName, 'Viva Juice and Coffee');
    assert.equal(branding.logoUrl, 'https://cdn.example/logo.png');
    assert.equal(branding.colors.primary, '#0E4A2B');
    assert.equal(branding.features.loyalty, true);
  });

  it('un nombre vacio no deja la cabecera en blanco', () => {
    assert.equal(
      normalizeBranding({ app_display_name: '   ' }).displayName,
      defaultBranding.displayName,
    );
  });

  it('un logo vacio es null, no cadena vacia', () => {
    assert.equal(normalizeBranding({ logo_url: '' }).logoUrl, null);
    assert.equal(normalizeBranding({ logo_url: '  ' }).logoUrl, null);
  });

  describe('features', () => {
    it('solo un false explicito apaga una feature', () => {
      const branding = normalizeBranding({ features: { loyalty: false } });
      assert.equal(branding.features.loyalty, false);
      // Las que no vienen siguen encendidas: un jsonb incompleto no puede
      // esconder media app.
      assert.equal(branding.features.promotions, true);
    });

    it('un features corrupto no apaga nada', () => {
      for (const features of [null, 'si', 42, []]) {
        assert.deepEqual(normalizeBranding({ features }).features, defaultBranding.features);
      }
    });

    it('un valor que no es booleano se ignora', () => {
      assert.equal(normalizeBranding({ features: { loyalty: 'no' } }).features.loyalty, true);
    });
  });
});

describe('normalizeBranding · ida y vuelta por JSON', () => {
  // El branding se cachea en el telefono como la fila cruda, no como la
  // paleta ya calculada: asi un cambio en `buildColors` se aplica al
  // arrancar en vez de quedar congelado en la cache. Este test protege
  // esa propiedad.
  it('la fila cruda sobrevive a JSON y produce el mismo branding', () => {
    const row = {
      app_display_name: 'Viva Juice and Coffee',
      logo_url: 'https://cdn.example/logo.png',
      primary_color: '#0E4A2B',
      secondary_color: '#F5F0E6',
      accent_color: '#E87722',
      features: { loyalty: false, tips: true },
    };

    const direct = normalizeBranding(row);
    const cached = normalizeBranding(JSON.parse(JSON.stringify(row)));

    assert.deepEqual(cached, direct);
    assert.equal(cached.features.loyalty, false);
  });

  it('una cache con basura no puede romper el arranque', () => {
    for (const value of [{}, { primary_color: 42 }, { features: 'si' }]) {
      const branding = normalizeBranding(value as never);
      assert.ok(branding.colors.primary.startsWith('#'));
      assert.ok(branding.displayName.length > 0);
    }
  });
});
