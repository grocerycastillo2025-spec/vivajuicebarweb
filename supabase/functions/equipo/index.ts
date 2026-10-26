/**
 * Arranque en Deno de `equipo`: crear cuentas del equipo desde el panel.
 * La lógica está en _shared/equipo.ts.
 *
 * No hace falta poner ningún secreto: SUPABASE_URL, SUPABASE_ANON_KEY y
 * SUPABASE_SERVICE_ROLE_KEY los pone Supabase en cada función.
 */

import { createEquipoHandler } from '../_shared/equipo.ts';

Deno.serve(
  createEquipoHandler({
    fetch,
    supabaseUrl: requerida('SUPABASE_URL'),
    anonKey: requerida('SUPABASE_ANON_KEY'),
    serviceKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')?.trim() || null,
    log: (event, data) => console.log(JSON.stringify({ fn: 'equipo', event, ...data })),
  }),
);

function requerida(nombre: string): string {
  const valor = Deno.env.get(nombre);
  if (valor === undefined || valor === '') throw new Error(`Falta la variable de entorno ${nombre}.`);
  return valor;
}
