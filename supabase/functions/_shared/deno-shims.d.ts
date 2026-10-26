/**
 * Lo justo para que `tsc` entienda los archivos que se ejecutan en Deno.
 *
 * POR QUÉ EXISTE
 * Los `index.ts` de las Edge Functions son los únicos archivos de este
 * directorio que no corren en Node: usan el global `Deno` y un
 * especificador `npm:`. Sin estas declaraciones, `pnpm typecheck` no
 * podría comprobarlos y el cableado —justo donde se leen los secretos, se
 * arma la URL que Clover compara byte a byte y se decide quién puede
 * disparar el worker— sería el único trozo sin red.
 *
 * POR QUÉ EN `_shared/` Y NO DENTRO DE UNA FUNCIÓN
 * Porque son declaraciones GLOBALES: dos copias, una por función, serían
 * dos `declare namespace Deno` y `tsc` las rechaza como duplicadas. Vive
 * una sola vez y la ve todo el proyecto por el `include` del tsconfig.
 *
 * DENO NUNCA LEE ESTE ARCHIVO: no lo importa nadie, así que no entra en el
 * grafo de módulos que se despliega. Solo lo ve `tsc`.
 */

declare namespace Deno {
  const env: { get(key: string): string | undefined };
  function serve(handler: (req: Request) => Response | Promise<Response>): unknown;
}

declare module 'npm:postgres@3.4.5' {
  interface Sql {
    unsafe(query: string, params?: readonly unknown[]): Promise<Record<string, unknown>[]>;
    end(): Promise<void>;
  }
  export default function postgres(url: string, options?: Record<string, unknown>): Sql;
}
