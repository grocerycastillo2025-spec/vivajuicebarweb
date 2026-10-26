/**
 * Grupos de modificadores.
 *
 * Los limites (min_required / max_allowed) y los precios vienen de
 * `catalog_modifier_groups` y `catalog_modifiers`. Aqui no hay ni un solo
 * precio escrito a mano: el recargo de la leche de avena y de coco existe
 * porque la base dice `price_cents = 100`, no porque este modulo lo sepa.
 *
 * Modulo puro: solo imports de tipo, para poder testearlo con
 * `node --test --experimental-strip-types`.
 */

import type { Cents } from './money';

export interface ModifierOption {
  readonly id: string;
  readonly cloverModifierId: string;
  readonly name: string;
  readonly priceCents: Cents;
  readonly available: boolean;
  readonly sortOrder: number;
}

export interface ModifierGroup {
  readonly id: string;
  readonly cloverGroupId: string;
  readonly name: string;
  /** Cuantos hay que elegir como minimo. 0 = opcional. */
  readonly minRequired: number;
  /** Tope de seleccion. `null` = sin tope. */
  readonly maxAllowed: number | null;
  readonly sortOrder: number;
  readonly modifiers: readonly ModifierOption[];
}

/** groupId -> ids de modificadores elegidos. */
export type Selection = Readonly<Record<string, readonly string[]>>;

export interface GroupIssue {
  readonly groupId: string;
  readonly groupName: string;
  readonly kind: 'too-few' | 'too-many' | 'unavailable';
  readonly message: string;
}

export function selectedIds(selection: Selection, groupId: string): readonly string[] {
  return selection[groupId] ?? [];
}

export function isSelected(selection: Selection, groupId: string, modifierId: string): boolean {
  return selectedIds(selection, groupId).includes(modifierId);
}

/** Solo se ofrece lo disponible, ordenado como lo ordena el catalogo. */
export function availableModifiers(group: ModifierGroup): readonly ModifierOption[] {
  return [...group.modifiers]
    .filter((modifier) => modifier.available)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

export function sortGroups(groups: readonly ModifierGroup[]): readonly ModifierGroup[] {
  return [...groups].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

/**
 * Preseleccion determinista: en los grupos obligatorios DE UNA SOLA opcion
 * se marca la primera disponible. Con el catalogo actual eso deja "Regular
 * milk" (sin recargo) marcado por defecto, que es lo que espera quien pide
 * un latte sin tocar nada.
 *
 * Los grupos de varias ("Arma tu jugo: elige 3") empiezan vacios: marcar
 * las tres primeras frutas seria elegir por el cliente, y con el grupo
 * lleno no podria cambiar ninguna sin antes quitar otra.
 */
export function defaultSelection(groups: readonly ModifierGroup[]): Selection {
  const selection: Record<string, readonly string[]> = {};

  for (const group of groups) {
    if (group.minRequired <= 0 || group.maxAllowed !== 1) continue;
    const options = availableModifiers(group).slice(0, group.minRequired);
    if (options.length > 0) {
      selection[group.id] = options.map((option) => option.id);
    }
  }
  return selection;
}

/**
 * Alterna una opcion respetando el tope del grupo.
 *
 * - Grupo de eleccion unica (`maxAllowed === 1`): sustituye.
 * - Eleccion unica obligatoria: la marcada no se desmarca.
 * - Grupo de varias: se desmarca libre; el minimo se exige al agregar.
 * - Grupo lleno: no se admite una opcion mas (la UI la muestra apagada).
 */
export function toggleModifier(
  group: ModifierGroup,
  selection: Selection,
  modifierId: string,
): Selection {
  const current = selectedIds(selection, group.id);
  const alreadyOn = current.includes(modifierId);

  let next: readonly string[];

  if (alreadyOn) {
    // En eleccion unica la marcada no se quita: se cambia tocando otra. En
    // grupos de varias si, aunque baje del minimo: el boton de agregar
    // avisa lo que falta (`validateSelection`).
    if (group.maxAllowed === 1 && current.length <= group.minRequired) return selection;
    next = current.filter((id) => id !== modifierId);
  } else if (group.maxAllowed === 1) {
    next = [modifierId];
  } else if (group.maxAllowed !== null && current.length >= group.maxAllowed) {
    return selection;
  } else {
    next = [...current, modifierId];
  }

  return { ...selection, [group.id]: next };
}

/**
 * ¿Se puede marcar una opcion MAS en este grupo?
 *
 * Ojo con lo que esta pregunta NO responde: en un grupo de eleccion unica
 * la respuesta es "no" en cuanto hay algo elegido, y sin embargo el
 * cliente si puede cambiar de opcion, porque cambiar sustituye en vez de
 * anadir. Para decidir si una opcion concreta se puede tocar hay que usar
 * `canToggleModifier`.
 */
export function canSelectMore(group: ModifierGroup, selection: Selection): boolean {
  if (group.maxAllowed === null) return true;
  return selectedIds(selection, group.id).length < group.maxAllowed;
}

/**
 * ¿Tocar ESTA opcion cambia algo?
 *
 * Es la pregunta que tiene que hacerse la interfaz antes de apagar un
 * boton, y no es la misma que "¿cabe una mas?". La confusion entre las
 * dos dejaba muerta la eleccion de leche: con "Regular" preseleccionada,
 * el grupo (min 1, max 1) esta lleno, asi que la pantalla apagaba avena,
 * soja y coco. El cliente veia las opciones y no podia elegirlas — y ahi
 * vive el recargo de $1.00 de la avena.
 *
 * Las tres reglas:
 *  - ya marcada  -> en eleccion unica no (se cambia tocando otra); en
 *                   grupos de varias si, para poder cambiar de fruta
 *  - eleccion unica (max 1) -> SIEMPRE se puede: sustituye a la que haya
 *  - resto       -> solo si queda hueco
 */
export function canToggleModifier(
  group: ModifierGroup,
  selection: Selection,
  modifierId: string,
): boolean {
  const current = selectedIds(selection, group.id);

  if (current.includes(modifierId)) return group.maxAllowed !== 1 || current.length > group.minRequired;
  if (group.maxAllowed === 1) return true;
  return group.maxAllowed === null || current.length < group.maxAllowed;
}

/**
 * Todo lo que la interfaz necesita saber de UNA opcion.
 *
 * Existe para que la pantalla no vuelva a deducirlo. El fallo de la leche
 * no estaba en las reglas —`toggleModifier` sustituia correctamente— sino
 * en que la pantalla se fabricaba su propia version con `canSelectMore` y
 * apagaba el boton antes de que la pulsacion llegara al dominio. Mientras
 * quede esa cuenta suelta en el JSX, alguien la volvera a hacer mal.
 *
 * `disabled` solo apaga opciones NO marcadas: la marcada de un grupo
 * obligatorio tampoco se puede quitar, pero apagarla la haria parecer no
 * disponible cuando es justo la elegida.
 */
export function optionState(
  group: ModifierGroup,
  selection: Selection,
  modifierId: string,
): { readonly checked: boolean; readonly disabled: boolean } {
  const checked = isSelected(selection, group.id, modifierId);
  return { checked, disabled: !checked && !canToggleModifier(group, selection, modifierId) };
}

export function validateSelection(
  groups: readonly ModifierGroup[],
  selection: Selection,
): readonly GroupIssue[] {
  const issues: GroupIssue[] = [];

  for (const group of groups) {
    const chosen = selectedIds(selection, group.id);

    if (chosen.length < group.minRequired) {
      issues.push({
        groupId: group.id,
        groupName: group.name,
        kind: 'too-few',
        message:
          group.minRequired === 1
            ? `Elige una opcion de ${group.name}`
            : `Elige al menos ${group.minRequired} opciones de ${group.name}`,
      });
      continue;
    }

    if (group.maxAllowed !== null && chosen.length > group.maxAllowed) {
      issues.push({
        groupId: group.id,
        groupName: group.name,
        kind: 'too-many',
        message: `Como maximo ${group.maxAllowed} en ${group.name}`,
      });
      continue;
    }

    const offered = new Set(availableModifiers(group).map((modifier) => modifier.id));
    if (chosen.some((id) => !offered.has(id))) {
      issues.push({
        groupId: group.id,
        groupName: group.name,
        kind: 'unavailable',
        message: `Una opcion de ${group.name} ya no esta disponible`,
      });
    }
  }

  return issues;
}

/** Recargo total de la seleccion, tomado de los precios del catalogo. */
export function selectionSurchargeCents(
  groups: readonly ModifierGroup[],
  selection: Selection,
): Cents {
  let total = 0;
  for (const group of groups) {
    const chosen = new Set(selectedIds(selection, group.id));
    for (const modifier of group.modifiers) {
      if (chosen.has(modifier.id)) total += modifier.priceCents;
    }
  }
  return total;
}

/** Aplana la seleccion a la forma que guarda el carrito. */
export function selectionToModifiers(
  groups: readonly ModifierGroup[],
  selection: Selection,
): readonly {
  groupId: string;
  groupName: string;
  modifierId: string;
  cloverModifierId: string;
  name: string;
  priceCents: Cents;
}[] {
  const flat = [];

  for (const group of sortGroups(groups)) {
    const chosen = selectedIds(selection, group.id);
    for (const modifier of availableModifiers(group)) {
      if (!chosen.includes(modifier.id)) continue;
      flat.push({
        groupId: group.id,
        groupName: group.name,
        modifierId: modifier.id,
        cloverModifierId: modifier.cloverModifierId,
        name: modifier.name,
        priceCents: modifier.priceCents,
      });
    }
  }

  return flat;
}
