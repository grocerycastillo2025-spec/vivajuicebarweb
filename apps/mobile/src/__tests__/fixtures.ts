/**
 * Fixtures calcados de `supabase/seed/seed_viva.sql`. Si el seed cambia
 * los precios, estos tests deben cambiar con el: es justamente el punto,
 * que ningun precio viva en el codigo de la app.
 */

import type { ModifierGroup } from '../domain/modifiers.ts';

/** Grupo "Milk" del seed: obligatorio, eleccion unica. Avena y coco +$1.00. */
export const milkGroup: ModifierGroup = {
  id: 'grp-milk',
  cloverGroupId: 'SEED-MG-MILK',
  name: 'Milk',
  minRequired: 1,
  maxAllowed: 1,
  sortOrder: 10,
  modifiers: [
    {
      id: 'm-reg',
      cloverModifierId: 'SEED-MOD-MILK-REG',
      name: 'Regular Milk',
      priceCents: 0,
      available: true,
      sortOrder: 10,
    },
    {
      id: 'm-alm',
      cloverModifierId: 'SEED-MOD-MILK-ALMOND',
      name: 'Almond Milk',
      priceCents: 0,
      available: true,
      sortOrder: 20,
    },
    {
      id: 'm-soy',
      cloverModifierId: 'SEED-MOD-MILK-SOY',
      name: 'Soy Milk',
      priceCents: 0,
      available: true,
      sortOrder: 30,
    },
    {
      id: 'm-oat',
      cloverModifierId: 'SEED-MOD-MILK-OAT',
      name: 'Oat Milk',
      priceCents: 100,
      available: true,
      sortOrder: 40,
    },
    {
      id: 'm-coc',
      cloverModifierId: 'SEED-MOD-MILK-COCONUT',
      name: 'Coconut Milk',
      priceCents: 100,
      available: true,
      sortOrder: 50,
    },
  ],
};

/** Grupo "Flavor" del seed: opcional, como mucho uno, todos sin recargo. */
export const flavorGroup: ModifierGroup = {
  id: 'grp-flavor',
  cloverGroupId: 'SEED-MG-FLAVOR',
  name: 'Flavor',
  minRequired: 0,
  maxAllowed: 1,
  sortOrder: 20,
  modifiers: [
    {
      id: 'f-van',
      cloverModifierId: 'SEED-MOD-FLAV-VANILLA',
      name: 'Vanilla',
      priceCents: 0,
      available: true,
      sortOrder: 10,
    },
    {
      id: 'f-lav',
      cloverModifierId: 'SEED-MOD-FLAV-LAVENDER',
      name: 'Lavender',
      priceCents: 0,
      available: true,
      sortOrder: 20,
    },
    {
      id: 'f-car',
      cloverModifierId: 'SEED-MOD-FLAV-CARAMEL',
      name: 'Caramel',
      priceCents: 0,
      available: false,
      sortOrder: 70,
    },
  ],
};

/** Grupo "Bread" del seed: obligatorio, eleccion unica, sin recargos. */
export const breadGroup: ModifierGroup = {
  id: 'grp-bread',
  cloverGroupId: 'SEED-MG-BREAD',
  name: 'Bread',
  minRequired: 1,
  maxAllowed: 1,
  sortOrder: 30,
  modifiers: [
    {
      id: 'b-cro',
      cloverModifierId: 'SEED-MOD-BREAD-CROISSANT',
      name: 'Croissant',
      priceCents: 0,
      available: true,
      sortOrder: 10,
    },
    {
      id: 'b-whe',
      cloverModifierId: 'SEED-MOD-BREAD-WHEAT',
      name: 'Whole Wheat',
      priceCents: 0,
      available: true,
      sortOrder: 20,
    },
  ],
};

/** Precio del "Iced Latte" en el seed. */
export const ICED_LATTE_CENTS = 475;
