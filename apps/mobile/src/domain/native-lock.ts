/**
 * Que obliga a recompilar, y como no olvidarse de subir el runtime.
 *
 * POR QUE EXISTE
 * El `runtimeVersion` era `{ policy: 'fingerprint' }`: EAS calculaba un
 * numero del proyecto nativo y entregaba cada update solo a los binarios
 * con ese mismo numero. La idea es buena —te protege de publicar
 * JavaScript que pide un modulo nativo que el APK no tiene— pero el
 * calculo no coincidia entre la maquina que compila y la que publica, y
 * durante una semana ningun update llego a ningun telefono. Un mecanismo
 * de seguridad que impide TODAS las entregas no da seguridad: da
 * paralisis.
 *
 * Ahora el runtime es un literal en `app.json` ("1.0.0"). El build y el
 * update usan la misma cadena y no hay nada que calcular ni que pueda
 * divergir. El precio es la disciplina: cuando entra una dependencia
 * nativa hay que subirlo A MANO y recompilar.
 *
 * ESTE MODULO ES ESA DISCIPLINA, AUTOMATIZADA
 * Calcula una firma de lo unico que puede cambiar el proyecto nativo en
 * un proyecto Expo gestionado:
 *
 *   - las dependencias de `apps/mobile/package.json`, que es por donde
 *     entra un modulo nativo;
 *   - los `plugins` de la config, que generan codigo nativo;
 *   - los bloques `android` e `ios`, que son configuracion nativa;
 *   - y el propio `runtimeVersion`, para que subirlo cierre el aviso.
 *
 * Un test compara esa firma con la guardada en `native-lock.json`. Si el
 * proyecto nativo cambio y el runtime no, el test falla y explica que
 * hacer. No adivina: se limita a no dejar que se te pase.
 *
 * Y AL REVES QUE EL FINGERPRINT, ESTO SI ES ESTABLE
 * La firma sale de dos archivos versionados, no de `node_modules` ni del
 * sistema de ficheros. Da lo mismo en cualquier maquina, que es justo lo
 * que le faltaba a lo anterior.
 *
 * Modulo puro salvo `node:crypto`.
 */

import { createHash } from 'node:crypto';

export interface PackageJsonLike {
  readonly dependencies?: Readonly<Record<string, string>>;
}

export interface AppJsonLike {
  readonly expo?: {
    readonly runtimeVersion?: unknown;
    readonly plugins?: unknown;
    readonly android?: unknown;
    readonly ios?: unknown;
  };
}

export interface NativeLock {
  readonly runtimeVersion: string;
  readonly firma: string;
}

/** JSON con las claves ordenadas: la firma no puede depender del orden. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entradas = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);
  return `{${entradas.join(',')}}`;
}

/**
 * La firma del proyecto nativo. Cambia exactamente cuando hace falta un
 * build nuevo, y no cambia por tocar JavaScript.
 */
export function nativeSignature(pkg: PackageJsonLike, app: AppJsonLike): string {
  const expo = app.expo ?? {};
  const material = {
    dependencies: pkg.dependencies ?? {},
    plugins: expo.plugins ?? null,
    android: expo.android ?? null,
    ios: expo.ios ?? null,
    runtimeVersion: expo.runtimeVersion ?? null,
  };
  return createHash('sha256').update(canonical(material)).digest('hex').slice(0, 16);
}

/** El `runtimeVersion` de `app.json`, exigiendo que sea un literal. */
export function declaredRuntimeVersion(app: AppJsonLike): string {
  const valor = app.expo?.runtimeVersion;
  if (typeof valor === 'string' && valor.trim() !== '') return valor;
  throw new Error(
    'app.json debe declarar `expo.runtimeVersion` como una cadena literal ' +
      '(por ejemplo "1.0.0"). Una politica calculada volveria a poner el ' +
      'runtime en manos de dos maquinas que no se ponen de acuerdo.',
  );
}

/** Que hacer cuando la firma no cuadra. Se ensena tal cual en el fallo. */
export function explainMismatch(esperada: string, actual: string, runtime: string): string {
  return [
    'EL PROYECTO NATIVO CAMBIO Y EL runtimeVersion NO.',
    '',
    `  firma guardada : ${esperada}`,
    `  firma actual   : ${actual}`,
    `  runtimeVersion : ${runtime}`,
    '',
    'Ha entrado una dependencia, un plugin o configuracion nativa. Un APK',
    'ya publicado NO tiene ese codigo, asi que si le llega un update que lo',
    'usa, revienta en el telefono del cliente.',
    '',
    'Que hacer:',
    `  1. subir "runtimeVersion" en apps/mobile/app.json (ahora "${runtime}")`,
    '  2. pnpm --filter @juicebar/mobile lock:native',
    '  3. compilar con "Build Android (EAS)" ANTES de publicar updates',
    '',
    'Si el cambio NO toca codigo nativo y aun asi salta, revisa que no se',
    'haya colado una dependencia de mas: este aviso prefiere pasarse de',
    'prudente a dejar pasar un APK que se cierra al abrirlo.',
  ].join('\n');
}
