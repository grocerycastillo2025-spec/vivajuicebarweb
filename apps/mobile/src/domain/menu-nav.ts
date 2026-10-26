/**
 * Que categoria esta marcada en los chips del menu.
 *
 * EL PROBLEMA
 * Dos cosas escriben sobre el mismo dato y quieren decir cosas distintas:
 *
 *   - el dedo: "estoy mirando esta categoria" (llega del scroll)
 *   - el chip: "llevame a esta otra"        (llega del toque)
 *
 * Al tocar un chip, la lista atraviesa todas las categorias intermedias y
 * cada una avisa por el camino de que esta a la vista. Si esos avisos
 * pueden escribir, el chip marcado va cambiando mientras el scroll viaja y
 * se queda en la ultima que le dio tiempo a contar: una ANTERIOR a la
 * elegida. Eso es "el menu va un paso atrasado".
 *
 * LO QUE NO FUNCIONA: UN CRONOMETRO
 * La version anterior silenciaba los avisos durante 600 ms. Un plazo fijo
 * no sabe cuando termina un scroll: si el salto dura mas (categoria 1 a la
 * 13 son miles de pixeles), los ultimos avisos del viaje entran ya sin
 * guardia y ganan. Y si se tocan dos chips seguidos, el cronometro del
 * primero abre la puerta en mitad del viaje del segundo.
 *
 * LO QUE SI: ESPERAR A LLEGAR
 * Mientras hay un salto en curso, los avisos del camino no escriben. La
 * guardia se levanta por un hecho, no por un plazo: porque la categoria
 * pedida ya esta arriba, porque el scroll se paro, o porque el cliente
 * puso el dedo en la lista (su dedo manda sobre un salto en vuelo).
 *
 * Modulo puro, sin React ni React Native: la regla se puede comprobar
 * entera sin un telefono.
 */

export interface NavState {
  /** La categoria marcada en los chips. */
  readonly activeId: string | null;
  /** Hacia donde viaja el scroll ahora mismo. `null` = manda el dedo. */
  readonly pendingId: string | null;
}

export type NavEvent =
  /** Llego el menu. Solo sirve para marcar la primera la primera vez. */
  | { readonly type: 'load'; readonly firstId: string | null }
  /** El cliente toco un chip. */
  | { readonly type: 'tap'; readonly id: string }
  /** La lista dice que categoria tiene arriba del todo. */
  | { readonly type: 'scrolled'; readonly topId: string | null }
  /** El scroll se paro. */
  | { readonly type: 'settled' }
  /** El cliente puso el dedo en la lista. */
  | { readonly type: 'touched' };

export const initialNavState: NavState = { activeId: null, pendingId: null };

export function menuNav(state: NavState, event: NavEvent): NavState {
  switch (event.type) {
    case 'load':
      // Solo la primera vez: recargar el menu no debe devolver al cliente
      // al principio de la carta.
      if (state.activeId !== null) return state;
      return { activeId: event.firstId, pendingId: null };

    case 'tap':
      // El chip se marca YA. No se espera a que llegue el scroll: el
      // cliente tiene que ver que su toque hizo algo.
      return { activeId: event.id, pendingId: event.id };

    case 'scrolled': {
      if (event.topId === null) return state;

      if (state.pendingId !== null) {
        // Un salto en curso. Los avisos del camino no cuentan; el de la
        // llegada si, y ademas levanta la guardia.
        if (event.topId !== state.pendingId) return state;
        return { activeId: event.topId, pendingId: null };
      }

      if (state.activeId === event.topId) return state;
      return { activeId: event.topId, pendingId: null };
    }

    case 'settled':
      // El scroll se paro donde sea. Si no llego a la categoria pedida
      // —una categoria del final no puede quedar arriba porque no hay
      // lista debajo— el chip se queda en ella igualmente, que es lo que
      // el cliente pidio, y a partir de ahora manda el dedo otra vez.
      if (state.pendingId === null) return state;
      return { activeId: state.activeId, pendingId: null };

    case 'touched':
      // El dedo gana a cualquier salto en vuelo.
      if (state.pendingId === null) return state;
      return { activeId: state.activeId, pendingId: null };
  }
}
