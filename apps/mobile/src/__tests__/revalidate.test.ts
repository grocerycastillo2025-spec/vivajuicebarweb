/**
 * Re-validacion del carrito al cambiar de sucursal.
 *
 * Cada sucursal es un merchant distinto de Clover con sus propios precios,
 * asi que estos tests son la red que impide cobrar el precio de una tienda
 * por un producto de otra.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  pastOrderToCart,
  buildLine,
  cartReducer,
  cartSubtotalCents,
  emptyCart,
  groupIssuesByLine,
  revalidateCart,
  type CartLineModifier,
  type CartState,
  type StoreCatalogSnapshot,
} from '../domain/cart.ts';
import { defaultSelection, selectionToModifiers, toggleModifier } from '../domain/modifiers.ts';
import { flavorGroup, ICED_LATTE_CENTS, milkGroup } from './fixtures.ts';

const FREEHOLD = '22222222-2222-4222-8222-222222222222';
const MIDTOWN = '33333333-3333-4333-8333-333333333333';

const icedLatte = {
  id: 'freehold-item-latte',
  cloverItemId: 'SEED-ICED-LATTE',
  name: 'Iced Latte',
  imageUrl: null,
  priceCents: ICED_LATTE_CENTS,
};

const acaiBowl = {
  id: 'freehold-item-acai',
  cloverItemId: 'SEED-BOWL-ACAI',
  name: 'Acai Bowl',
  imageUrl: null,
  priceCents: 1250,
};

function withMilk(modifierId: string): readonly CartLineModifier[] {
  const groups = [milkGroup, flavorGroup];
  return selectionToModifiers(
    groups,
    toggleModifier(milkGroup, defaultSelection(groups), modifierId),
  );
}

function cartWith(...actions: readonly Parameters<typeof cartReducer>[1][]): CartState {
  return actions.reduce(cartReducer, emptyCart(FREEHOLD));
}

/** Catalogo de Midtown: mismos clover ids, uuid distintos. */
function midtown(overrides: Partial<StoreCatalogSnapshot> = {}): StoreCatalogSnapshot {
  return {
    storeId: MIDTOWN,
    items: {
      'SEED-ICED-LATTE': {
        id: 'midtown-item-latte',
        name: 'Iced Latte',
        priceCents: ICED_LATTE_CENTS,
        isAvailable: true,
      },
      'SEED-BOWL-ACAI': {
        id: 'midtown-item-acai',
        name: 'Acai Bowl',
        priceCents: 1250,
        isAvailable: true,
      },
    },
    modifiers: {
      'SEED-MOD-MILK-REG': {
        id: 'midtown-mod-reg',
        name: 'Regular Milk',
        priceCents: 0,
        available: true,
      },
      'SEED-MOD-MILK-OAT': {
        id: 'midtown-mod-oat',
        name: 'Oat Milk',
        priceCents: 100,
        available: true,
      },
      'SEED-MOD-MILK-COCONUT': {
        id: 'midtown-mod-coc',
        name: 'Coconut Milk',
        priceCents: 100,
        available: true,
      },
    },
    ...overrides,
  };
}

describe('revalidateCart · sin cambios', () => {
  it('un carrito vacio no necesita revision', () => {
    const result = revalidateCart(emptyCart(FREEHOLD), midtown());
    assert.equal(result.needsReview, false);
    assert.equal(result.cart.lines.length, 0);
    assert.equal(result.cart.storeId, MIDTOWN);
  });

  it('si los precios coinciden no hay nada que ensenar', () => {
    const cart = cartWith({ type: 'add', line: buildLine(icedLatte, withMilk('m-oat'), 2, '') });
    const result = revalidateCart(cart, midtown());

    assert.equal(result.needsReview, false);
    assert.equal(result.issues.length, 0);
    assert.equal(result.removed.length, 0);
    assert.equal(result.subtotalAfterCents, result.subtotalBeforeCents);
  });

  it('reapunta los uuid a los de la sucursal nueva', () => {
    const cart = cartWith({ type: 'add', line: buildLine(icedLatte, withMilk('m-oat'), 1, '') });
    const line = revalidateCart(cart, midtown()).cart.lines[0];

    assert.ok(line);
    assert.equal(line.itemId, 'midtown-item-latte');
    assert.equal(line.cloverItemId, 'SEED-ICED-LATTE');
    assert.equal(line.modifiers[0]?.modifierId, 'midtown-mod-oat');
    // El id de Clover es el puente entre catalogos: no cambia.
    assert.equal(line.modifiers[0]?.cloverModifierId, 'SEED-MOD-MILK-OAT');
  });

  it('el carrito resultante apunta a la sucursal nueva', () => {
    const cart = cartWith({ type: 'add', line: buildLine(icedLatte, withMilk('m-reg'), 1, '') });
    assert.equal(revalidateCart(cart, midtown()).cart.storeId, MIDTOWN);
  });
});

describe('revalidateCart · precios distintos entre merchants', () => {
  it('adopta el precio de la sucursal nueva y lo reporta', () => {
    const cart = cartWith({ type: 'add', line: buildLine(icedLatte, withMilk('m-reg'), 2, '') });
    const snapshot = midtown();
    const result = revalidateCart(cart, {
      ...snapshot,
      items: {
        ...snapshot.items,
        'SEED-ICED-LATTE': { ...snapshot.items['SEED-ICED-LATTE']!, priceCents: 525 },
      },
    });

    assert.equal(result.needsReview, true);
    const issue = result.issues.find((entry) => entry.kind === 'item-price-changed');
    assert.ok(issue);
    assert.equal(issue.beforeCents, 475);
    assert.equal(issue.afterCents, 525);
    assert.equal(issue.blocking, false);

    // Se cobra el de la sucursal nueva, que es el que imprimira el ticket.
    assert.equal(result.cart.lines[0]?.unitBasePriceCents, 525);
    assert.equal(result.subtotalAfterCents, 525 * 2);
  });

  it('detecta que el recargo de un modificador cambio', () => {
    const cart = cartWith({ type: 'add', line: buildLine(icedLatte, withMilk('m-oat'), 1, '') });
    const snapshot = midtown();
    const result = revalidateCart(cart, {
      ...snapshot,
      modifiers: {
        ...snapshot.modifiers,
        // En Midtown la avena cuesta 1.50, no 1.00.
        'SEED-MOD-MILK-OAT': {
          id: 'midtown-mod-oat',
          name: 'Oat Milk',
          priceCents: 150,
          available: true,
        },
      },
    });

    const issue = result.issues.find((entry) => entry.kind === 'modifier-price-changed');
    assert.ok(issue);
    assert.equal(issue.modifierName, 'Oat Milk');
    assert.equal(issue.beforeCents, 100);
    assert.equal(issue.afterCents, 150);
    assert.equal(issue.blocking, false);

    // 4.75 + 1.50
    assert.equal(result.subtotalAfterCents, 625);
    assert.equal(result.cart.lines.length, 1);
  });

  it('el subtotal de antes y el de despues salen los dos, para poder compararlos', () => {
    const cart = cartWith({ type: 'add', line: buildLine(icedLatte, withMilk('m-oat'), 2, '') });
    const snapshot = midtown();
    const result = revalidateCart(cart, {
      ...snapshot,
      items: {
        ...snapshot.items,
        'SEED-ICED-LATTE': { ...snapshot.items['SEED-ICED-LATTE']!, priceCents: 500 },
      },
    });

    assert.equal(result.subtotalBeforeCents, cartSubtotalCents(cart));
    assert.equal(result.subtotalBeforeCents, 575 * 2);
    assert.equal(result.subtotalAfterCents, 600 * 2);
  });
});

describe('revalidateCart · el producto no existe en la sucursal nueva', () => {
  it('lo retira y lo dice explicitamente, nunca en silencio', () => {
    const cart = cartWith(
      { type: 'add', line: buildLine(icedLatte, withMilk('m-reg'), 1, '') },
      { type: 'add', line: buildLine(acaiBowl, [], 1, '') },
    );

    const snapshot = midtown();
    const sinBowl = { ...snapshot.items };
    delete (sinBowl as Record<string, unknown>)['SEED-BOWL-ACAI'];

    const result = revalidateCart(cart, { ...snapshot, items: sinBowl });

    assert.equal(result.needsReview, true);
    assert.equal(result.cart.lines.length, 1);
    assert.equal(result.removed.length, 1);
    assert.equal(result.removed[0]?.name, 'Acai Bowl');

    const issue = result.issues.find((entry) => entry.kind === 'item-missing');
    assert.ok(issue, 'tiene que haber un aviso de producto ausente');
    assert.equal(issue.itemName, 'Acai Bowl');
    assert.equal(issue.blocking, true);
    // Lo que costaba viaja en el aviso, para poder ensenarlo.
    assert.equal(issue.beforeCents, 1250);
    assert.equal(issue.afterCents, null);
  });

  it('lo retira si existe pero no esta disponible', () => {
    const cart = cartWith({ type: 'add', line: buildLine(acaiBowl, [], 1, '') });
    const snapshot = midtown();
    const result = revalidateCart(cart, {
      ...snapshot,
      items: {
        ...snapshot.items,
        'SEED-BOWL-ACAI': { ...snapshot.items['SEED-BOWL-ACAI']!, isAvailable: false },
      },
    });

    assert.equal(result.issues[0]?.kind, 'item-unavailable');
    assert.equal(result.issues[0]?.blocking, true);
    assert.equal(result.cart.lines.length, 0);
    assert.equal(result.removed.length, 1);
  });

  it('un carrito entero que no existe alli deja el carrito vacio y todo reportado', () => {
    const cart = cartWith(
      { type: 'add', line: buildLine(icedLatte, withMilk('m-reg'), 1, '') },
      { type: 'add', line: buildLine(acaiBowl, [], 1, '') },
    );

    const result = revalidateCart(cart, { storeId: MIDTOWN, items: {}, modifiers: {} });

    assert.equal(result.cart.lines.length, 0);
    assert.equal(result.removed.length, 2);
    assert.equal(result.issues.length, 2);
    assert.ok(result.issues.every((entry) => entry.kind === 'item-missing'));
    assert.equal(result.subtotalAfterCents, 0);
  });
});

describe('revalidateCart · modificadores que no existen alli', () => {
  it('retira la linea entera y nombra el modificador que falta', () => {
    const cart = cartWith({ type: 'add', line: buildLine(icedLatte, withMilk('m-coc'), 1, '') });

    const snapshot = midtown();
    const sinCoco = { ...snapshot.modifiers };
    delete (sinCoco as Record<string, unknown>)['SEED-MOD-MILK-COCONUT'];

    const result = revalidateCart(cart, { ...snapshot, modifiers: sinCoco });

    const issue = result.issues.find((entry) => entry.kind === 'modifier-missing');
    assert.ok(issue);
    assert.equal(issue.modifierName, 'Coconut Milk');
    assert.equal(issue.itemName, 'Iced Latte');
    assert.equal(issue.blocking, true);

    // No se sirve un latte con una leche que esa sucursal no tiene.
    assert.equal(result.cart.lines.length, 0);
    assert.equal(result.removed.length, 1);
  });

  it('retira la linea si el modificador existe pero esta agotado', () => {
    const cart = cartWith({ type: 'add', line: buildLine(icedLatte, withMilk('m-oat'), 1, '') });
    const snapshot = midtown();
    const result = revalidateCart(cart, {
      ...snapshot,
      modifiers: {
        ...snapshot.modifiers,
        'SEED-MOD-MILK-OAT': {
          id: 'midtown-mod-oat',
          name: 'Oat Milk',
          priceCents: 100,
          available: false,
        },
      },
    });

    assert.equal(result.issues[0]?.kind, 'modifier-unavailable');
    assert.equal(result.cart.lines.length, 0);
  });

  it('la misma bebida con otra leche si sobrevive', () => {
    const cart = cartWith(
      { type: 'add', line: buildLine(icedLatte, withMilk('m-coc'), 1, '') },
      { type: 'add', line: buildLine(icedLatte, withMilk('m-reg'), 1, '') },
    );

    const snapshot = midtown();
    const sinCoco = { ...snapshot.modifiers };
    delete (sinCoco as Record<string, unknown>)['SEED-MOD-MILK-COCONUT'];

    const result = revalidateCart(cart, { ...snapshot, modifiers: sinCoco });

    assert.equal(result.cart.lines.length, 1);
    assert.equal(result.cart.lines[0]?.modifiers[0]?.name, 'Regular Milk');
    assert.equal(result.removed.length, 1);
  });
});

describe('revalidateCart · apilado tras el remapeo', () => {
  it('dos lineas que colapsan en la misma configuracion se suman', () => {
    const cart = cartWith(
      { type: 'add', line: buildLine(icedLatte, withMilk('m-reg'), 1, '') },
      { type: 'add', line: buildLine(icedLatte, withMilk('m-oat'), 2, '') },
    );
    assert.equal(cart.lines.length, 2);

    // En Midtown la avena y la regular son el MISMO modificador.
    const snapshot = midtown();
    const result = revalidateCart(cart, {
      ...snapshot,
      modifiers: {
        ...snapshot.modifiers,
        'SEED-MOD-MILK-OAT': {
          id: 'midtown-mod-reg',
          name: 'Regular Milk',
          priceCents: 0,
          available: true,
        },
      },
    });

    assert.equal(result.cart.lines.length, 1);
    assert.equal(result.cart.lines[0]?.quantity, 3);
  });

  it('no se pasa del maximo por linea al apilar', () => {
    const cart = cartWith(
      { type: 'add', line: buildLine(icedLatte, withMilk('m-reg'), 90, '') },
      { type: 'add', line: buildLine(icedLatte, withMilk('m-oat'), 40, '') },
    );

    const snapshot = midtown();
    const result = revalidateCart(cart, {
      ...snapshot,
      modifiers: {
        ...snapshot.modifiers,
        'SEED-MOD-MILK-OAT': {
          id: 'midtown-mod-reg',
          name: 'Regular Milk',
          priceCents: 0,
          available: true,
        },
      },
    });

    assert.equal(result.cart.lines[0]?.quantity, 99);
  });

  it('dos configuraciones distintas siguen separadas', () => {
    const cart = cartWith(
      { type: 'add', line: buildLine(icedLatte, withMilk('m-reg'), 1, '') },
      { type: 'add', line: buildLine(icedLatte, withMilk('m-oat'), 1, '') },
    );
    assert.equal(revalidateCart(cart, midtown()).cart.lines.length, 2);
  });

  it('la nota se conserva y sigue separando lineas', () => {
    const cart = cartWith({
      type: 'add',
      line: buildLine(icedLatte, withMilk('m-reg'), 1, 'sin hielo'),
    });
    const line = revalidateCart(cart, midtown()).cart.lines[0];
    assert.ok(line);
    assert.equal(line.note, 'sin hielo');
  });
});

describe('groupIssuesByLine', () => {
  it('junta los avisos de una misma linea', () => {
    const cart = cartWith({ type: 'add', line: buildLine(icedLatte, withMilk('m-oat'), 1, '') });
    const snapshot = midtown();
    const result = revalidateCart(cart, {
      ...snapshot,
      items: {
        ...snapshot.items,
        'SEED-ICED-LATTE': { ...snapshot.items['SEED-ICED-LATTE']!, priceCents: 525 },
      },
      modifiers: {
        ...snapshot.modifiers,
        'SEED-MOD-MILK-OAT': {
          id: 'midtown-mod-oat',
          name: 'Oat Milk',
          priceCents: 150,
          available: true,
        },
      },
    });

    const groups = groupIssuesByLine(result.issues);
    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.itemName, 'Iced Latte');
    assert.equal(groups[0]?.issues.length, 2);
  });

  it('sin avisos devuelve una lista vacia', () => {
    assert.deepEqual(groupIssuesByLine([]), []);
  });
});

describe('pastOrderToCart · volver a pedir', () => {
  const pastItems = [
    {
      clover_item_id: 'SEED-ICED-LATTE',
      name_snapshot: 'Iced Latte',
      // El unitario guardado YA incluye el recargo: 475 + 100.
      unit_price_snapshot_cents: 575,
      quantity: 2,
      note: 'sin hielo',
      sort_order: 0,
      order_item_modifiers: [
        {
          clover_modifier_id: 'SEED-MOD-MILK-OAT',
          name_snapshot: 'Oat Milk',
          price_snapshot_cents: 100,
        },
      ],
    },
  ];

  it('reconstruye el precio base quitando los recargos', () => {
    const cart = pastOrderToCart(FREEHOLD, pastItems);
    assert.equal(cart.lines[0]?.unitBasePriceCents, 475);
    assert.equal(cart.lines[0]?.quantity, 2);
    assert.equal(cart.lines[0]?.note, 'sin hielo');
  });

  it('el resultado pasa por la misma revalidacion que el cambio de sucursal', () => {
    // Un pedido de hace un mes puede traer precios viejos. Se revalida
    // contra el catalogo de hoy antes de ensenarselo al cliente.
    const cart = pastOrderToCart(FREEHOLD, pastItems);
    const snapshot = midtown();
    const result = revalidateCart(cart, {
      ...snapshot,
      storeId: FREEHOLD,
      items: {
        ...snapshot.items,
        'SEED-ICED-LATTE': { ...snapshot.items['SEED-ICED-LATTE']!, priceCents: 525 },
      },
    });

    assert.equal(result.needsReview, true);
    assert.equal(result.issues[0]?.kind, 'item-price-changed');
    assert.equal(result.issues[0]?.beforeCents, 475);
    assert.equal(result.issues[0]?.afterCents, 525);
    assert.equal(result.cart.lines[0]?.unitBasePriceCents, 525);
  });

  it('un producto retirado del menu se reporta, no se cuela', () => {
    const cart = pastOrderToCart(FREEHOLD, pastItems);
    const result = revalidateCart(cart, { storeId: FREEHOLD, items: {}, modifiers: {} });
    assert.equal(result.cart.lines.length, 0);
    assert.equal(result.issues[0]?.kind, 'item-missing');
    assert.equal(result.issues[0]?.itemName, 'Iced Latte');
  });

  it('un pedido sin lineas da un carrito vacio', () => {
    assert.equal(pastOrderToCart(FREEHOLD, []).lines.length, 0);
  });
});
