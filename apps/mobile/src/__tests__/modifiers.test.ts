import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  availableModifiers,
  canSelectMore,
  canToggleModifier,
  optionState,
  defaultSelection,
  selectionSurchargeCents,
  selectionToModifiers,
  toggleModifier,
  validateSelection,
  type ModifierGroup,
} from '../domain/modifiers.ts';
import { breadGroup, flavorGroup, milkGroup } from './fixtures.ts';

describe('availableModifiers', () => {
  it('esconde lo no disponible y respeta el orden del catalogo', () => {
    const names = availableModifiers(flavorGroup).map((modifier) => modifier.name);
    assert.deepEqual(names, ['Vanilla', 'Lavender']);
  });
});

describe('defaultSelection', () => {
  it('preselecciona la primera opcion de los grupos obligatorios', () => {
    const selection = defaultSelection([milkGroup, flavorGroup]);
    assert.deepEqual(selection[milkGroup.id], ['m-reg']);
  });

  it('no toca los grupos opcionales', () => {
    const selection = defaultSelection([milkGroup, flavorGroup]);
    assert.equal(selection[flavorGroup.id], undefined);
  });

  it('deja el pedido por defecto sin recargo', () => {
    const selection = defaultSelection([milkGroup, flavorGroup]);
    assert.equal(selectionSurchargeCents([milkGroup, flavorGroup], selection), 0);
  });
});

describe('toggleModifier', () => {
  it('en un grupo de eleccion unica sustituye', () => {
    let selection = defaultSelection([milkGroup]);
    selection = toggleModifier(milkGroup, selection, 'm-oat');
    assert.deepEqual(selection[milkGroup.id], ['m-oat']);
  });

  it('no deja desmarcar por debajo del minimo obligatorio', () => {
    const selection = defaultSelection([milkGroup]);
    const after = toggleModifier(milkGroup, selection, 'm-reg');
    assert.deepEqual(after[milkGroup.id], ['m-reg']);
  });

  it('en un grupo opcional se puede marcar y desmarcar', () => {
    let selection = toggleModifier(flavorGroup, {}, 'f-van');
    assert.deepEqual(selection[flavorGroup.id], ['f-van']);
    selection = toggleModifier(flavorGroup, selection, 'f-van');
    assert.deepEqual(selection[flavorGroup.id], []);
  });
});

describe('canSelectMore', () => {
  it('se apaga cuando el grupo esta lleno', () => {
    const selection = defaultSelection([milkGroup]);
    assert.equal(canSelectMore(milkGroup, selection), false);
    assert.equal(canSelectMore(flavorGroup, {}), true);
  });
});

describe('selectionSurchargeCents', () => {
  // La regla del negocio: avena y coco cuestan $1.00 mas. El numero sale
  // de catalog_modifiers.price_cents, no de una constante en la app.
  it('cobra $1.00 por leche de avena', () => {
    const selection = toggleModifier(milkGroup, defaultSelection([milkGroup]), 'm-oat');
    assert.equal(selectionSurchargeCents([milkGroup], selection), 100);
  });

  it('cobra $1.00 por leche de coco', () => {
    const selection = toggleModifier(milkGroup, defaultSelection([milkGroup]), 'm-coc');
    assert.equal(selectionSurchargeCents([milkGroup], selection), 100);
  });

  it('no cobra por almendra ni por soya', () => {
    for (const id of ['m-alm', 'm-soy']) {
      const selection = toggleModifier(milkGroup, defaultSelection([milkGroup]), id);
      assert.equal(selectionSurchargeCents([milkGroup], selection), 0);
    }
  });
});

describe('validateSelection', () => {
  it('acepta la seleccion por defecto', () => {
    const groups = [milkGroup, flavorGroup];
    assert.deepEqual(validateSelection(groups, defaultSelection(groups)), []);
  });

  it('exige elegir en los grupos obligatorios', () => {
    const issues = validateSelection([milkGroup], {});
    assert.equal(issues.length, 1);
    assert.equal(issues[0]?.kind, 'too-few');
  });

  it('rechaza pasarse del tope', () => {
    const issues = validateSelection([flavorGroup], { [flavorGroup.id]: ['f-van', 'f-lav'] });
    assert.equal(issues[0]?.kind, 'too-many');
  });

  it('rechaza un modificador que dejo de estar disponible', () => {
    const issues = validateSelection([flavorGroup], { [flavorGroup.id]: ['f-car'] });
    assert.equal(issues[0]?.kind, 'unavailable');
  });
});

describe('selectionToModifiers', () => {
  it('aplana con el precio que dice el catalogo', () => {
    const groups = [milkGroup, flavorGroup];
    let selection = toggleModifier(milkGroup, defaultSelection(groups), 'm-coc');
    selection = toggleModifier(flavorGroup, selection, 'f-van');

    const flat = selectionToModifiers(groups, selection);
    assert.deepEqual(
      flat.map((modifier) => [modifier.name, modifier.priceCents]),
      [
        ['Coconut Milk', 100],
        ['Vanilla', 0],
      ],
    );
  });
});

// ---------------------------------------------------------------------
// REGRESION: la seleccion de modificadores se quedaba muerta
//
// Con "Regular Milk" preseleccionada, el grupo (min 1, max 1) esta lleno.
// La pantalla apagaba toda opcion no marcada de un grupo lleno, asi que
// avena, soja y coco salian visibles y no se podian tocar: no habia forma
// de pedir un latte con avena, que es donde vive el recargo de $1.00.
//
// El fallo no era de la leche sino de TODO grupo con max 1. En Bread se
// veia igual; en Flavor (min 0) la primera eleccion funcionaba y cambiar
// de idea despues, no.
// ---------------------------------------------------------------------

describe('canToggleModifier: los tres grupos del seed', () => {
  it('Milk (min 1, max 1): se puede cambiar a cualquier leche', () => {
    const selection = defaultSelection([milkGroup]);
    assert.deepEqual(selection[milkGroup.id], ['m-reg']);

    for (const id of ['m-alm', 'm-soy', 'm-oat', 'm-coc']) {
      assert.equal(canToggleModifier(milkGroup, selection, id), true, id);
    }
  });

  it('Milk: elegir avena sustituye y suma el recargo de la base', () => {
    const before = defaultSelection([milkGroup]);
    const after = toggleModifier(milkGroup, before, 'm-oat');

    assert.deepEqual(after[milkGroup.id], ['m-oat']);
    assert.equal(selectionSurchargeCents([milkGroup], before), 0);
    assert.equal(selectionSurchargeCents([milkGroup], after), 100);
  });

  it('Bread (min 1, max 1): se puede cambiar de pan', () => {
    const selection = defaultSelection([breadGroup]);
    assert.deepEqual(selection[breadGroup.id], ['b-cro']);
    assert.equal(canToggleModifier(breadGroup, selection, 'b-whe'), true);
    assert.deepEqual(toggleModifier(breadGroup, selection, 'b-whe')[breadGroup.id], ['b-whe']);
  });

  it('Flavor (min 0, max 1): se puede elegir, y despues cambiar de idea', () => {
    const empty = defaultSelection([flavorGroup]);
    assert.equal(canToggleModifier(flavorGroup, empty, 'f-lav'), true);

    const chosen = toggleModifier(flavorGroup, empty, 'f-lav');
    // Aqui estaba el segundo caso: con una elegida, el grupo esta lleno.
    assert.equal(canToggleModifier(flavorGroup, chosen, 'f-van'), true);
    assert.deepEqual(toggleModifier(flavorGroup, chosen, 'f-van')[flavorGroup.id], ['f-van']);
  });

  it('Flavor: la elegida si se puede quitar, porque el grupo es opcional', () => {
    const chosen = toggleModifier(flavorGroup, {}, 'f-lav');
    assert.equal(canToggleModifier(flavorGroup, chosen, 'f-lav'), true);
    assert.deepEqual(toggleModifier(flavorGroup, chosen, 'f-lav')[flavorGroup.id], []);
  });

  it('Milk: la elegida NO se puede quitar, porque el grupo es obligatorio', () => {
    const selection = defaultSelection([milkGroup]);
    assert.equal(canToggleModifier(milkGroup, selection, 'm-reg'), false);
  });

  it('un grupo con tope de verdad si se llena', () => {
    // No existe todavia en el seed, pero en cuanto Clover traiga un
    // "elige 2 toppings" la regla tiene que seguir valiendo: ahi apagar
    // lo no elegido si es correcto.
    const toppings = { ...flavorGroup, id: 'grp-top', minRequired: 0, maxAllowed: 2 };
    const one = toggleModifier(toppings, {}, 'f-van');
    assert.equal(canToggleModifier(toppings, one, 'f-lav'), true);

    const two = toggleModifier(toppings, one, 'f-lav');
    assert.deepEqual(two[toppings.id], ['f-van', 'f-lav']);
    // Lleno de verdad: una tercera no cabe.
    assert.equal(canToggleModifier(toppings, two, 'f-car'), false);
    // Pero las elegidas se pueden soltar.
    assert.equal(canToggleModifier(toppings, two, 'f-van'), true);
  });
});

describe('canToggleModifier concuerda con toggleModifier', () => {
  // La invariante que evita que las dos se separen otra vez: un boton se
  // apaga exactamente cuando tocarlo no cambiaria nada.
  const groups = [
    milkGroup,
    breadGroup,
    flavorGroup,
    { ...flavorGroup, id: 'grp-top', minRequired: 0, maxAllowed: 2 },
    { ...flavorGroup, id: 'grp-libre', minRequired: 0, maxAllowed: null },
  ];

  for (const group of groups) {
    it(`${group.name} (${group.id}): en todos los estados alcanzables`, () => {
      const options = availableModifiers(group).map((modifier) => modifier.id);

      // Estados de partida: vacio, la preseleccion, y cada opcion suelta.
      const states = [
        {},
        defaultSelection([group]),
        ...options.map((id) => ({ [group.id]: [id] })),
        { [group.id]: options },
      ];

      for (const state of states) {
        for (const id of options) {
          const changed = toggleModifier(group, state, id) !== state;
          assert.equal(
            canToggleModifier(group, state, id),
            changed,
            `${group.id}/${id} desde ${JSON.stringify(state[group.id] ?? [])}`,
          );
        }
      }
    });
  }
});

describe('optionState: lo que ve la pantalla', () => {
  it('en un grupo de eleccion unica NUNCA se apaga una opcion', () => {
    // Esta es la que se rompio. Vale para los tres grupos del seed, en
    // cualquier estado alcanzable.
    for (const group of [milkGroup, breadGroup, flavorGroup]) {
      const options = availableModifiers(group).map((modifier) => modifier.id);
      const states = [{}, defaultSelection([group]), ...options.map((id) => ({ [group.id]: [id] }))];

      for (const state of states) {
        for (const id of options) {
          assert.equal(
            optionState(group, state, id).disabled,
            false,
            `${group.name}/${id} apagada con ${JSON.stringify(state[group.id] ?? [])}`,
          );
        }
      }
    }
  });

  it('marca como elegida la que lo esta', () => {
    const selection = defaultSelection([milkGroup]);
    assert.equal(optionState(milkGroup, selection, 'm-reg').checked, true);
    assert.equal(optionState(milkGroup, selection, 'm-oat').checked, false);
  });

  it('en un grupo lleno de verdad si se apaga lo no elegido', () => {
    const toppings = { ...flavorGroup, id: 'grp-top', minRequired: 0, maxAllowed: 2 };
    const two = { [toppings.id]: ['f-van', 'f-lav'] };

    assert.deepEqual(optionState(toppings, two, 'f-car'), { checked: false, disabled: true });
    // Las elegidas siguen encendidas, para poder soltarlas.
    assert.deepEqual(optionState(toppings, two, 'f-van'), { checked: true, disabled: false });
  });

  it('la elegida de un grupo obligatorio se ve elegida, no apagada', () => {
    // No se puede quitar, pero apagarla la haria parecer agotada.
    assert.deepEqual(optionState(milkGroup, defaultSelection([milkGroup]), 'm-reg'), {
      checked: true,
      disabled: false,
    });
  });
});

describe('grupos de varias ("arma tu jugo": elige 3)', () => {
  const build: ModifierGroup = {
    id: 'g-build',
    cloverGroupId: 'viva-grp-juice-build',
    name: 'Elige 3 frutas o verduras',
    minRequired: 3,
    maxAllowed: 3,
    sortOrder: 5,
    modifiers: ['naranja', 'zanahoria', 'betabel', 'jengibre'].map((id, i) => ({
      id, cloverModifierId: id, name: id, priceCents: 0, available: true, sortOrder: i,
    })),
  };

  it('empieza vacío: nadie elige por el cliente', () => {
    assert.deepEqual(defaultSelection([build]), {});
  });

  it('se puede quitar una y poner otra, y el mínimo se exige al agregar', () => {
    let s = defaultSelection([build]);
    for (const id of ['naranja', 'zanahoria', 'betabel']) s = toggleModifier(build, s, id);
    assert.equal(canToggleModifier(build, s, 'jengibre'), false); // lleno
    assert.equal(canToggleModifier(build, s, 'betabel'), true); // pero se puede cambiar
    s = toggleModifier(build, s, 'betabel');
    assert.equal(validateSelection([build], s)[0]?.kind, 'too-few');
    s = toggleModifier(build, s, 'jengibre');
    assert.deepEqual(validateSelection([build], s), []);
    assert.deepEqual(s['g-build'], ['naranja', 'zanahoria', 'jengibre']);
  });
});
