import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { itemsUsing, mentions, sameOptionElsewhere } from '../domain/ingredients.ts';

const ITEMS = [
  { id: 'viva', texts: ['Viva Juice', 'Orange, carrot and beet', 'Viva Juice', 'Naranja, zanahoria y betabel'] },
  { id: 'green', texts: ['Green Juice', 'Cucumber, celery, kale, ginger, apple, orange', 'Jugo Verde', 'Pepino, apio, kale, jengibre, manzana y naranja'] },
  { id: 'tropical', texts: ['Tropical', 'Pineapple, mango', 'Tropical', 'Piña y mango'] },
  { id: 'acai', texts: ['Acai Bowl', 'Strawberries, banana', 'Bowl de açaí', 'Açaí, fresas, plátano'] },
];

describe('Ingredientes', () => {
  it('palabra completa, sin acentos y con plural', () => {
    assert.equal(mentions('Naranja, zanahoria', 'naranja'), true);
    assert.equal(mentions('Piña y mango', 'Pina'), true);
    assert.equal(mentions('Açaí, fresas, plátano', 'Fresa'), true);
    assert.equal(mentions('Pineapple, mango', 'apple'), false);
    assert.equal(mentions('algo', 'té'), false); // muy corto: no se busca
  });

  it('naranja → los jugos que la llevan', () => {
    assert.deepEqual(itemsUsing({ id: 'o', names: ['Orange', 'Naranja'] }, ITEMS), ['viva', 'green']);
    assert.deepEqual(itemsUsing({ id: 'p', names: ['Pineapple', 'Piña'] }, ITEMS), ['tropical']);
    assert.deepEqual(itemsUsing({ id: 'a', names: ['Apple', 'Manzana'] }, ITEMS), ['green']);
  });

  it('la misma opción en otros grupos', () => {
    const opts = [
      { id: 'f1', names: ['Strawberry', 'Fresa'] },
      { id: 'f2', names: ['Strawberry', 'Fresa'] },
      { id: 'b1', names: ['Banana', 'Plátano'] },
    ];
    assert.deepEqual(sameOptionElsewhere(opts[0]!, opts), ['f2']);
  });
});
