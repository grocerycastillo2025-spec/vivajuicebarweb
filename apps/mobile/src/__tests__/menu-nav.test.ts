/**
 * El fallo de "el menu va un paso atrasado", reproducido.
 *
 * Sintoma: se toca el chip de una categoria y la pantalla ensena los
 * productos de la ANTERIOR.
 *
 * Estos tests reproducen las dos mitades del fallo sin telefono:
 *   1. la geometrica, que es la causa: la ultima categoria no cabe arriba
 *   2. la de estado: los avisos del camino pisan el chip elegido
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { HEADER_HEIGHT, ROW_HEIGHT } from '../domain/card-metrics.ts';
import { menuNav, initialNavState, type NavState } from '../domain/menu-nav.ts';
import {
  sectionFlatIndex,
  sectionListLayout,
  sectionOfFlatIndex,
  tailPadding,
  type SectionSizes,
} from '../domain/section-layout.ts';

// Las 13 categorias del seed de Viva, con sus productos, en el orden de
// `catalog_categories.sort_order`. Ice Cream, la ultima, tiene 2.
const SEED = [6, 3, 3, 1, 3, 4, 5, 8, 3, 2, 2, 8, 2];
const NAMES = [
  'Juices',
  'Smoothies',
  'Virgin Drinks',
  'Fruit Water',
  'Viva Boost Shots',
  'Bowls',
  'Iced Coffee',
  'Hot Coffee',
  'Viva Bites',
  'Crepes & Waffles',
  'Fresh Fruit Cup',
  'Treats',
  'Ice Cream',
];
// Las medidas de verdad de la tarjeta, no una copia: si alguien cambia el
// alto de una fila, este test sigue midiendo lo que se ve en el telefono.
const SIZES: SectionSizes = { header: HEADER_HEIGHT, row: ROW_HEIGHT, footer: 0 };

// Alto util de la lista en un telefono normal, descontando cabecera de
// pantalla y barra de pestanas.
const VIEWPORT = 700;
/** Lo que reservaba la pantalla antes: area segura + hueco del carrito. */
const BASE = 120;

const contentHeight = (pad: number): number =>
  SEED.reduce((total, n) => total + SIZES.header + n * SIZES.row, 0) + pad;

/** Donde acaba la lista de verdad: el sistema recorta al maximo posible. */
function landsOn(section: number, pad: number): number {
  const wanted = sectionListLayout(SEED, SIZES, sectionFlatIndex(SEED, section)).offset;
  const maxScroll = Math.max(0, contentHeight(pad) - VIEWPORT);
  const real = Math.min(wanted, maxScroll);

  let top = 0;
  for (let s = 0; s < SEED.length; s++) {
    const offset = sectionListLayout(SEED, SIZES, sectionFlatIndex(SEED, s)).offset;
    if (offset <= real + 1) top = s;
  }
  return top;
}

describe('el indice plano de una seccion', () => {
  // Espejo de VirtualizedSectionList: cada seccion ocupa 1 + n + 1.
  it('cuenta la cabecera y el pie de cada seccion anterior', () => {
    assert.equal(sectionFlatIndex([2, 3], 0), 0);
    assert.equal(sectionFlatIndex([2, 3], 1), 4);
    assert.equal(sectionFlatIndex([2, 3], 2), 9);
  });

  it('la cabecera de cada categoria cae donde dice el calculo de posiciones', () => {
    // Las dos piezas tienen que estar de acuerdo, o el salto queda
    // desplazado justo una cabecera.
    let offset = 0;
    SEED.forEach((n, section) => {
      const flat = sectionFlatIndex(SEED, section);
      assert.equal(sectionListLayout(SEED, SIZES, flat).offset, offset, NAMES[section]);
      assert.equal(sectionListLayout(SEED, SIZES, flat).length, SIZES.header);
      offset += SIZES.header + n * SIZES.row;
    });
  });

  it('vuelve del indice plano al numero de seccion', () => {
    // `onScrollToIndexFailed` informa del indice PLANO y `scrollToLocation`
    // pide el de SECCION: sin esta vuelta, uno se pasa por el otro.
    SEED.forEach((_, section) => {
      assert.equal(sectionOfFlatIndex(SEED, sectionFlatIndex(SEED, section)), section);
    });
    assert.equal(sectionOfFlatIndex(SEED, 0), 0);
    assert.equal(sectionOfFlatIndex(SEED, -5), 0);
    assert.equal(sectionOfFlatIndex(SEED, 99999), SEED.length - 1);
  });
});

describe('tocar un chip lleva a SU categoria, no a la anterior', () => {
  it('REPRODUCE EL FALLO: con el relleno de antes, Ice Cream se queda en Treats', () => {
    assert.equal(NAMES[landsOn(12, BASE)], 'Treats');
  });

  it('con el relleno calculado, todas las categorias llegan arriba', () => {
    const pad = tailPadding(SEED, SIZES, VIEWPORT, BASE);
    SEED.forEach((_, section) => {
      assert.equal(NAMES[landsOn(section, pad)], NAMES[section]);
    });
  });

  it('el relleno es exactamente lo que le falta a la ultima categoria', () => {
    // Ice Cream son 2 productos: una cabecera y dos filas.
    const iceCream = HEADER_HEIGHT + 2 * ROW_HEIGHT;
    assert.equal(tailPadding(SEED, SIZES, VIEWPORT, BASE), BASE + VIEWPORT - iceCream);
  });

  it('una ultima categoria que ya llena la pantalla no necesita nada extra', () => {
    const largo = [3, 20];
    assert.equal(tailPadding(largo, SIZES, VIEWPORT, BASE), BASE);
  });

  it('sin haber medido la lista todavia, no se inventa relleno', () => {
    assert.equal(tailPadding(SEED, SIZES, 0, BASE), BASE);
    assert.equal(tailPadding([], SIZES, VIEWPORT, BASE), BASE);
  });
});

// ---------------------------------------------------------------------
// La otra mitad: el chip marcado
// ---------------------------------------------------------------------

/**
 * La regla ANTERIOR, para que se vea que estos tests muerden.
 *
 * Era una guardia booleana que se levantaba con un CRONOMETRO de 600 ms.
 * No escuchaba el final del scroll: el unico modo de bajar la guardia era
 * que se cumpliera el plazo, llegara o no la lista a su destino.
 */
type Paso =
  | { readonly t: 'tap'; readonly id: string }
  | { readonly t: 'scrolled'; readonly id: string }
  /** Se cumplen los 600 ms. Solo existe en la regla vieja. */
  | { readonly t: 'timer' }
  /** El scroll se para de verdad. La regla vieja no se enteraba. */
  | { readonly t: 'settled' };

function reglaVieja(state: NavState, paso: Paso): NavState {
  if (paso.t === 'tap') return { activeId: paso.id, pendingId: paso.id };
  if (paso.t === 'timer') return { ...state, pendingId: null };
  if (paso.t === 'scrolled') {
    if (state.pendingId !== null) return state;
    return { activeId: paso.id, pendingId: null };
  }
  return state;
}

function reglaNueva(state: NavState, paso: Paso): NavState {
  switch (paso.t) {
    case 'tap':
      return menuNav(state, { type: 'tap', id: paso.id });
    case 'scrolled':
      return menuNav(state, { type: 'scrolled', topId: paso.id });
    case 'settled':
      return menuNav(state, { type: 'settled' });
    case 'timer':
      // La regla nueva no tiene cronometro: no hay nada que hacer.
      return state;
  }
}

const run = (rule: (s: NavState, p: Paso) => NavState, pasos: readonly Paso[]): NavState =>
  pasos.reduce(rule, initialNavState);

/** Por que categorias pasa el chip a lo largo de un viaje. */
function recorrido(rule: (s: NavState, p: Paso) => NavState, pasos: readonly Paso[]): string[] {
  const visto: string[] = [];
  let state = initialNavState;
  for (const paso of pasos) {
    state = rule(state, paso);
    if (state.activeId !== null && state.activeId !== visto[visto.length - 1]) {
      visto.push(state.activeId);
    }
  }
  return visto;
}

describe('el chip marcado', () => {
  it('marca la primera categoria al cargar, y no vuelve a ella al recargar', () => {
    let state = menuNav(initialNavState, { type: 'load', firstId: 'juices' });
    assert.equal(state.activeId, 'juices');

    state = menuNav(state, { type: 'scrolled', topId: 'bowls' });
    state = menuNav(state, { type: 'load', firstId: 'juices' });
    assert.equal(state.activeId, 'bowls');
  });

  it('el chip se marca en cuanto se toca, sin esperar al scroll', () => {
    assert.equal(menuNav(initialNavState, { type: 'tap', id: 'treats' }).activeId, 'treats');
  });

  // Un salto de Juices a Treats atraviesa diez categorias, y cada una avisa
  // de que esta a la vista por el camino. Ninguna de esas es la elegida.
  const viajeLargo: readonly Paso[] = [
    { t: 'tap', id: 'Treats' },
    ...NAMES.slice(1, 11).map((id) => ({ t: 'scrolled' as const, id })),
    { t: 'scrolled', id: 'Treats' },
    { t: 'settled' },
  ];

  it('REPRODUCE EL FALLO: la regla vieja ensena por el camino categorias que nadie eligio', () => {
    // El cronometro se cumple a los 600 ms; un salto de 6000 px dura mas.
    // A partir de ahi, cada categoria que la lista atraviesa se marca.
    const conCronometro: readonly Paso[] = [
      ...viajeLargo.slice(0, 3),
      { t: 'timer' },
      ...viajeLargo.slice(3),
    ];

    assert.deepEqual(recorrido(reglaVieja, conCronometro), [
      'Treats',
      'Fruit Water',
      'Viva Boost Shots',
      'Bowls',
      'Iced Coffee',
      'Hot Coffee',
      'Viva Bites',
      'Crepes & Waffles',
      'Fresh Fruit Cup',
      'Treats',
    ]);

    // La regla nueva marca la elegida y no la suelta.
    assert.deepEqual(recorrido(reglaNueva, conCronometro), ['Treats']);
  });

  it('el viaje acaba en la categoria elegida con las dos reglas', () => {
    assert.equal(run(reglaVieja, viajeLargo).activeId, 'Treats');
    assert.equal(run(reglaNueva, viajeLargo).activeId, 'Treats');
  });

  it('REPRODUCE EL FALLO: dos chips seguidos y el cronometro del primero abre la puerta', () => {
    // El codigo anterior no cancelaba el temporizador al tocar otro chip.
    const dosToques: readonly Paso[] = [
      { t: 'tap', id: 'Bowls' },
      { t: 'scrolled', id: 'Smoothies' },
      { t: 'tap', id: 'Treats' },
      { t: 'timer' }, // el del PRIMER toque, aun pendiente
      { t: 'scrolled', id: 'Viva Bites' },
      { t: 'scrolled', id: 'Treats' },
      { t: 'settled' },
    ];

    // A mitad del segundo viaje el chip ya ensena una categoria anterior a
    // la elegida.
    assert.equal(run(reglaVieja, dosToques.slice(0, 5)).activeId, 'Viva Bites');
    assert.equal(run(reglaNueva, dosToques.slice(0, 5)).activeId, 'Treats');
    assert.deepEqual(recorrido(reglaNueva, dosToques), ['Bowls', 'Treats']);
  });

  it('llegar a la categoria pedida levanta la guardia', () => {
    let state = menuNav(initialNavState, { type: 'tap', id: 'bowls' });
    state = menuNav(state, { type: 'scrolled', topId: 'bowls' });
    assert.equal(state.pendingId, null);

    // A partir de ahi vuelve a mandar el dedo.
    state = menuNav(state, { type: 'scrolled', topId: 'iced' });
    assert.equal(state.activeId, 'iced');
  });

  it('pararse levanta la guardia aunque no se haya llegado', () => {
    // Si no, un salto que se queda corto dejaria el chip clavado para
    // siempre y el scroll del dedo no lo movería nunca mas.
    let state = menuNav(initialNavState, { type: 'tap', id: 'ice-cream' });
    state = menuNav(state, { type: 'settled' });
    assert.equal(state.pendingId, null);
    assert.equal(state.activeId, 'ice-cream');

    state = menuNav(state, { type: 'scrolled', topId: 'treats' });
    assert.equal(state.activeId, 'treats');
  });

  it('si el cliente toca la lista, su dedo gana al salto en vuelo', () => {
    let state = menuNav(initialNavState, { type: 'tap', id: 'ice-cream' });
    state = menuNav(state, { type: 'touched' });
    assert.equal(state.pendingId, null);
    // Tocar no cambia el chip: lo cambia lo que se vea despues.
    assert.equal(state.activeId, 'ice-cream');

    state = menuNav(state, { type: 'scrolled', topId: 'treats' });
    assert.equal(state.activeId, 'treats');
  });

  it('un aviso sin categoria arriba no borra el chip', () => {
    const state = menuNav({ activeId: 'bowls', pendingId: null }, { type: 'scrolled', topId: null });
    assert.equal(state.activeId, 'bowls');
  });

  it('el scroll normal marca la categoria que se esta mirando', () => {
    const state = run(reglaNueva, [
      { t: 'scrolled', id: 'smoothies' },
      { t: 'scrolled', id: 'bowls' },
      { t: 'settled' },
    ]);
    assert.equal(state.activeId, 'bowls');
  });
});
