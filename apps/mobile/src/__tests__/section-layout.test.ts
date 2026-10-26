import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { sectionListLayout, type SectionSizes } from '../domain/section-layout.ts';

const SIZES: SectionSizes = { header: 40, row: 100, footer: 0 };

describe('posiciones de una lista por secciones', () => {
  // Dos secciones de 2 y 3 filas. La lista plana es:
  //   0 cab.A  1 fila  2 fila  3 pie.A
  //   4 cab.B  5 fila  6 fila  7 fila  8 pie.B
  const counts = [2, 3];

  it('el encabezado de la primera seccion esta arriba del todo', () => {
    assert.deepEqual(sectionListLayout(counts, SIZES, 0), {
      length: 40,
      offset: 0,
      index: 0,
    });
  });

  it('las filas van despues de su encabezado', () => {
    assert.equal(sectionListLayout(counts, SIZES, 1).offset, 40);
    assert.equal(sectionListLayout(counts, SIZES, 2).offset, 140);
    assert.equal(sectionListLayout(counts, SIZES, 1).length, 100);
  });

  it('el pie ocupa un indice aunque mida cero', () => {
    const foot = sectionListLayout(counts, SIZES, 3);
    assert.equal(foot.length, 0);
    assert.equal(foot.offset, 240);
  });

  it('la segunda seccion empieza despues de todo lo anterior', () => {
    // 40 de cabecera + 200 de dos filas + 0 de pie.
    assert.deepEqual(sectionListLayout(counts, SIZES, 4), {
      length: 40,
      offset: 240,
      index: 4,
    });
    assert.equal(sectionListLayout(counts, SIZES, 5).offset, 280);
    assert.equal(sectionListLayout(counts, SIZES, 7).offset, 480);
  });

  it('un pie con alto real desplaza la seccion siguiente', () => {
    const withFooter: SectionSizes = { header: 40, row: 100, footer: 16 };
    assert.equal(sectionListLayout(counts, withFooter, 4).offset, 256);
  });

  it('una seccion vacia solo ocupa encabezado y pie', () => {
    assert.equal(sectionListLayout([0, 1], SIZES, 0).offset, 0);
    assert.equal(sectionListLayout([0, 1], SIZES, 2).offset, 40);
  });

  it('un indice fuera de rango no rompe: devuelve alto cero al final', () => {
    const past = sectionListLayout(counts, SIZES, 99);
    assert.equal(past.length, 0);
    // El alto total: 40 + 2x100 + 40 + 3x100.
    assert.equal(past.offset, 580);
  });
});
