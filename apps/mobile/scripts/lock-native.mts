/**
 * Reescribe `native-lock.json` con la firma actual del proyecto nativo.
 *
 * Se ejecuta A MANO, y solo despues de haber subido el `runtimeVersion` en
 * `app.json`. No es un paso de compilacion: es la forma de decir "si, este
 * cambio nativo esta reconocido y el runtime ya lo refleja".
 *
 *   pnpm --filter @juicebar/mobile lock:native
 *
 * Si se ejecuta sin haber subido el runtime, avisa y no escribe nada: seria
 * tapar el aviso en vez de atenderlo, que es justo el fallo que este
 * mecanismo existe para impedir.
 *
 * La excepcion es `--solo-js`, para una dependencia de JavaScript puro que
 * dispara la firma sin tocar nada nativo. Un aviso sin salida se termina
 * desactivando entero, y entonces no queda ninguno; con salida, usarla es
 * una decision consciente que queda escrita en el commit.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  declaredRuntimeVersion,
  nativeSignature,
  type AppJsonLike,
  type NativeLock,
  type PackageJsonLike,
} from '../src/domain/native-lock.ts';

const RAIZ = new URL('..', import.meta.url).pathname;
const leer = (nombre: string): unknown => JSON.parse(readFileSync(join(RAIZ, nombre), 'utf8'));

const pkg = leer('package.json') as PackageJsonLike;
const app = leer('app.json') as AppJsonLike;

const runtime = declaredRuntimeVersion(app);
const firma = nativeSignature(pkg, app);

let anterior: NativeLock | null = null;
try {
  anterior = leer('native-lock.json') as NativeLock;
} catch {
  anterior = null;
}

// La salida de emergencia, para cuando la dependencia nueva es de
// JavaScript puro y de verdad no toca nada nativo. Existe porque un aviso
// sin escapatoria se acaba desactivando entero, y entonces no queda nada.
const soloJs = process.argv.includes('--solo-js');

if (anterior !== null && anterior.firma !== firma && anterior.runtimeVersion === runtime) {
  if (!soloJs) {
    console.error(
      [
        'NO se ha escrito nada.',
        '',
        `El proyecto nativo cambio (${anterior.firma} -> ${firma}) pero el`,
        `runtimeVersion sigue siendo "${runtime}". Sellar la firma ahora dejaria`,
        'los APK que ya estan en la calle recibiendo JavaScript que pide codigo',
        'nativo que no tienen.',
        '',
        'Sube "runtimeVersion" en apps/mobile/app.json y vuelve a ejecutar esto.',
        '',
        'Si la dependencia es de JavaScript PURO —sin carpeta android/ ni ios/,',
        'sin plugin de config— entonces no hace falta build y esto se sella con:',
        '',
        '  pnpm --filter @juicebar/mobile lock:native --solo-js',
        '',
        'Comprobarlo cuesta un minuto: mira si el paquete trae android/, ios/ o',
        'un app.plugin.js. Equivocarse cuesta una app que se cierra al abrirla.',
      ].join('\n'),
    );
    process.exit(1);
  }

  console.warn(
    [
      'Sellando con --solo-js: se da por bueno que este cambio NO toca codigo',
      'nativo y que los APK que ya estan instalados pueden ejecutarlo.',
      '',
      `  ${anterior.firma} -> ${firma}`,
      '',
    ].join('\n'),
  );
}

const lock: NativeLock = { runtimeVersion: runtime, firma };
writeFileSync(join(RAIZ, 'native-lock.json'), `${JSON.stringify(lock, null, 2)}\n`, 'utf8');

console.log(anterior === null ? 'native-lock.json creado' : 'native-lock.json actualizado');
console.log(`  runtimeVersion : ${runtime}`);
console.log(`  firma          : ${firma}`);
