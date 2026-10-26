import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildLine,
  cartItemCount,
  cartReducer,
  cartSubtotalCents,
  emptyCart,
  isCartEmpty,
  lineSignature,
  lineTotalCents,
  lineUnitPriceCents,
  previewUnitPriceCents,
  type CartLineModifier,
  type CartState,
} from '../domain/cart.ts';
import { defaultSelection, selectionToModifiers, toggleModifier } from '../domain/modifiers.ts';
import { flavorGroup, ICED_LATTE_CENTS, milkGroup } from './fixtures.ts';

const STORE_ID = '22222222-2222-4222-8222-222222222222';

const icedLatte = {
  id: 'item-iced-latte',
  cloverItemId: 'SEED-ICED-LATTE',
  name: 'Iced Latte',
  imageUrl: null,
  priceCents: ICED_LATTE_CENTS,
};

function withMilk(modifierId: string): readonly CartLineModifier[] {
  const groups = [milkGroup, flavorGroup];
  const selection = toggleModifier(milkGroup, defaultSelection(groups), modifierId);
  return selectionToModifiers(groups, selection);
}

function cartWith(...actions: readonly Parameters<typeof cartReducer>[1][]): CartState {
  return actions.reduce(cartReducer, emptyCart(STORE_ID));
}

describe('lineSignature', () => {
  it('no depende del orden en que se marcaron las opciones', () => {
    const a = lineSignature('item', [{ modifierId: 'b' }, { modifierId: 'a' }] as never, '');
    const b = lineSignature('item', [{ modifierId: 'a' }, { modifierId: 'b' }] as never, '');
    assert.equal(a, b);
  });

  it('separa lineas con notas distintas', () => {
    assert.notEqual(lineSignature('item', [], 'sin hielo'), lineSignature('item', [], ''));
  });
});

describe('precio de linea', () => {
  it('suma el recargo de la leche de avena al precio base', () => {
    const cart = cartWith({
      type: 'add',
      line: buildLine(icedLatte, withMilk('m-oat'), 1, ''),
    });

    const line = cart.lines[0];
    assert.ok(line);
    // 4.75 del catalogo + 1.00 de recargo = 5.75
    assert.equal(lineUnitPriceCents(line), ICED_LATTE_CENTS + 100);
    assert.equal(lineUnitPriceCents(line), 575);
  });

  it('no suma nada con la leche regular', () => {
    const cart = cartWith({
      type: 'add',
      line: buildLine(icedLatte, withMilk('m-reg'), 1, ''),
    });

    const line = cart.lines[0];
    assert.ok(line);
    assert.equal(lineUnitPriceCents(line), ICED_LATTE_CENTS);
  });

  it('multiplica por la cantidad', () => {
    const cart = cartWith({
      type: 'add',
      line: buildLine(icedLatte, withMilk('m-coc'), 3, ''),
    });

    const line = cart.lines[0];
    assert.ok(line);
    assert.equal(lineTotalCents(line), 575 * 3);
  });
});

describe('cartReducer', () => {
  it('arranca vacio', () => {
    const cart = emptyCart(STORE_ID);
    assert.equal(isCartEmpty(cart), true);
    assert.equal(cartSubtotalCents(cart), 0);
    assert.equal(cartItemCount(cart), 0);
  });

  it('apila dos veces el mismo producto con la misma configuracion', () => {
    const line = buildLine(icedLatte, withMilk('m-oat'), 1, '');
    const cart = cartWith({ type: 'add', line }, { type: 'add', line });

    assert.equal(cart.lines.length, 1);
    assert.equal(cart.lines[0]?.quantity, 2);
    assert.equal(cartItemCount(cart), 2);
  });

  it('mantiene separadas dos configuraciones distintas del mismo producto', () => {
    const cart = cartWith(
      { type: 'add', line: buildLine(icedLatte, withMilk('m-oat'), 1, '') },
      { type: 'add', line: buildLine(icedLatte, withMilk('m-reg'), 1, '') },
    );

    assert.equal(cart.lines.length, 2);
    // 5.75 + 4.75
    assert.equal(cartSubtotalCents(cart), 575 + 475);
  });

  it('normaliza la nota antes de comparar', () => {
    const cart = cartWith(
      { type: 'add', line: buildLine(icedLatte, withMilk('m-reg'), 1, '  sin hielo  ') },
      { type: 'add', line: buildLine(icedLatte, withMilk('m-reg'), 1, 'sin hielo') },
    );

    assert.equal(cart.lines.length, 1);
    assert.equal(cart.lines[0]?.note, 'sin hielo');
  });

  it('cantidad 0 elimina la linea', () => {
    const base = cartWith({ type: 'add', line: buildLine(icedLatte, withMilk('m-reg'), 2, '') });
    const lineId = base.lines[0]?.id;
    assert.ok(lineId);

    const after = cartReducer(base, { type: 'setQuantity', lineId, quantity: 0 });
    assert.equal(isCartEmpty(after), true);
  });

  it('ignora una alta con cantidad 0', () => {
    const cart = cartWith({ type: 'add', line: buildLine(icedLatte, withMilk('m-reg'), 0, '') });
    assert.equal(isCartEmpty(cart), true);
  });

  it('recorta la cantidad al maximo permitido', () => {
    const cart = cartWith({ type: 'add', line: buildLine(icedLatte, [], 500, '') });
    assert.equal(cart.lines[0]?.quantity, 99);
  });

  it('remove y clear dejan el carrito vacio', () => {
    const base = cartWith(
      { type: 'add', line: buildLine(icedLatte, withMilk('m-reg'), 1, '') },
      { type: 'add', line: buildLine(icedLatte, withMilk('m-oat'), 1, '') },
    );
    const lineId = base.lines[0]?.id;
    assert.ok(lineId);

    assert.equal(cartReducer(base, { type: 'remove', lineId }).lines.length, 1);
    assert.equal(isCartEmpty(cartReducer(base, { type: 'clear' })), true);
    assert.equal(cartReducer(base, { type: 'clear' }).storeId, STORE_ID);
  });

  it('subtotal de una compra mixta', () => {
    const acaiBowl = {
      id: 'item-acai',
      cloverItemId: 'SEED-BOWL-ACAI',
      name: 'Acai Bowl',
      imageUrl: null,
      priceCents: 1250,
    };

    const cart = cartWith(
      { type: 'add', line: buildLine(icedLatte, withMilk('m-oat'), 2, '') },
      { type: 'add', line: buildLine(acaiBowl, [], 1, '') },
    );

    // (4.75 + 1.00) x 2 + 12.50 = 24.00
    assert.equal(cartSubtotalCents(cart), 2400);
    assert.equal(cartItemCount(cart), 3);
  });
});

describe('previewUnitPriceCents', () => {
  it('refleja el recargo mientras se elige, antes de anadir al carrito', () => {
    const groups = [milkGroup, flavorGroup];
    let selection = defaultSelection(groups);
    assert.equal(previewUnitPriceCents(ICED_LATTE_CENTS, groups, selection), 475);

    selection = toggleModifier(milkGroup, selection, 'm-coc');
    assert.equal(previewUnitPriceCents(ICED_LATTE_CENTS, groups, selection), 575);

    selection = toggleModifier(flavorGroup, selection, 'f-van');
    assert.equal(previewUnitPriceCents(ICED_LATTE_CENTS, groups, selection), 575);
  });
});
