/**
 * Llama a `tick` cada `ms` mientras `enabled` sea verdadero.
 *
 * Para seguir un pedido sin Realtime: el cliente ve cuando el negocio lo
 * pasa a "en preparacion" o "listo", y el panel ve los pedidos nuevos.
 * No corre con la pestaña oculta (en web), para no gastar consultas.
 */

import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';

export function useInterval(tick: () => void, ms: number, enabled = true, whileHidden = false): void {
  const tickRef = useRef(tick);
  tickRef.current = tick;

  useEffect(() => {
    if (!enabled) return undefined;
    const id = setInterval(() => {
      if (!whileHidden && Platform.OS === 'web' && typeof document !== 'undefined' && document.hidden) return;
      tickRef.current();
    }, ms);
    return () => clearInterval(id);
  }, [enabled, ms, whileHidden]);
}
