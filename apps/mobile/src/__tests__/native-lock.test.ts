/**
 * El aviso que sustituye a la politica `fingerprint`.
 *
 * El `runtimeVersion` es ahora un literal en `app.json`, asi que nadie
 * calcula nada y el build y el update no pueden discrepar. A cambio,
 * subirlo cuando entra codigo nativo es responsabilidad nuestra, y
 * olvidarse tiene una consecuencia fea: un update que usa un modulo que el
 * APK instalado no lleva no da un error de red, revienta la app en el
 * telefono del cliente.
 *
 * Este test es el recordatorio. Compara la firma del proyecto nativo
 * —dependencias, plugins, bloques android/ios— con la sellada en
 * `native-lock.json`. Si el proyecto nativo cambio y el runtime no, falla
 * y dice exactamente que hacer.
 *
 * No sustituye al criterio: hay cambios de dependencias que no tocan nada
 * nativo. Pero prefiere pararte de mas a dejar pasar un APK que se cierra
 * al abrirlo, y salir del aviso cuesta dos ordenes.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  declaredRuntimeVersion,
  explainMismatch,
  nativeSignature,
  type AppJsonLike,
  type NativeLock,
  type PackageJsonLike,
} from '../domain/native-lock.ts';

const RAIZ = new URL('../..', import.meta.url).pathname;
const leer = (nombre: string): unknown => JSON.parse(readFileSync(RAIZ + nombre, 'utf8'));

const pkg = leer('package.json') as PackageJsonLike;
const app = leer('app.json') as AppJsonLike;
const lock = leer('native-lock.json') as NativeLock;

describe('el runtimeVersion y el proyecto nativo van juntos', () => {
  it('app.json declara el runtime como literal, no como politica', () => {
    // Volver a `{ policy: 'fingerprint' }` devolveria el runtime a dos
    // maquinas que no se ponian de acuerdo, y ningun update llegaria.
    assert.equal(typeof app.expo?.runtimeVersion, 'string');
    assert.equal(declaredRuntimeVersion(app), lock.runtimeVersion);
  });

  it('la firma del proyecto nativo coincide con la sellada', () => {
    const actual = nativeSignature(pkg, app);
    assert.equal(
      actual,
      lock.firma,
      explainMismatch(lock.firma, actual, declaredRuntimeVersion(app)),
    );
  });
});

describe('la firma se mueve cuando debe y no cuando no', () => {
  const base: PackageJsonLike = { dependencies: { expo: '~57.0.18' } };
  const config: AppJsonLike = {
    expo: { runtimeVersion: '1.0.0', plugins: ['expo-router'], android: { package: 'com.x' } },
  };
  const firmaBase = nativeSignature(base, config);

  it('una dependencia nueva la cambia', () => {
    const conModuloNativo: PackageJsonLike = {
      dependencies: { ...base.dependencies, 'expo-camera': '~17.0.0' },
    };
    assert.notEqual(nativeSignature(conModuloNativo, config), firmaBase);
  });

  it('un plugin nuevo la cambia', () => {
    const conPlugin: AppJsonLike = {
      expo: { ...config.expo, plugins: ['expo-router', 'expo-camera'] },
    };
    assert.notEqual(nativeSignature(base, conPlugin), firmaBase);
  });

  it('subir el runtime la cambia, que es como se cierra el aviso', () => {
    const subido: AppJsonLike = { expo: { ...config.expo, runtimeVersion: '1.1.0' } };
    assert.notEqual(nativeSignature(base, subido), firmaBase);
  });

  it('el orden de las claves no la cambia', () => {
    // Si dependiera del orden, cualquier reordenacion de package.json
    // pediria un build que no hace falta y el aviso se volveria ruido.
    const desordenado: PackageJsonLike = {
      dependencies: Object.fromEntries(Object.entries(base.dependencies ?? {}).reverse()),
    };
    assert.equal(nativeSignature(desordenado, config), firmaBase);
  });

  it('no la mueve nada de JavaScript: los scripts y la version no entran', () => {
    // Es lo que hace util al aviso. Si saltara con cada cambio de codigo,
    // se acabaria ignorando.
    const conRuido = { ...base, version: '9.9.9', scripts: { test: 'x' } } as PackageJsonLike;
    assert.equal(nativeSignature(conRuido, config), firmaBase);
  });
});

describe('el mensaje del fallo dice que hacer', () => {
  it('nombra las dos ordenes y el runtime actual', () => {
    const texto = explainMismatch('aaaa', 'bbbb', '1.0.0');
    assert.match(texto, /apps\/mobile\/app\.json/);
    assert.match(texto, /lock:native/);
    assert.match(texto, /"1\.0\.0"/);
  });

  it('declaredRuntimeVersion no acepta una politica', () => {
    assert.throws(
      () => declaredRuntimeVersion({ expo: { runtimeVersion: { policy: 'fingerprint' } } }),
      /cadena literal/,
    );
  });
});
