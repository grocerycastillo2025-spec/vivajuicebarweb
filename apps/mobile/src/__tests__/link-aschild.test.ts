/**
 * `Link asChild` + `style` como funcion = el hijo se queda sin estilos.
 *
 * `Link asChild` de expo-router monta el `Slot` de Radix, que fusiona el
 * `style` del padre con el del hijo COMO OBJETO:
 *
 *     overrideProps.style = { ...styleDelSlot, ...styleDelHijo }
 *
 * Un `Pressable` normalmente pasa el `style` como FUNCION, que es como se
 * pinta el estado pulsado. Y desparramar una funcion en un objeto da `{}`:
 * las funciones no tienen propiedades enumerables. El hijo pierde TODOS sus
 * estilos, en silencio, sin error ni aviso.
 *
 * Eso tuvo el menu roto varios dias: la tarjeta se quedaba sin
 * `flexDirection: 'row'`, sin alto y sin relleno, asi que la foto caia
 * debajo del texto, se salia de su fila y tapaba el nombre y el precio de
 * la siguiente. Parecia un desbordamiento y no lo era.
 *
 * Los tests de este archivo son dos: uno demuestra la regla, y el otro
 * vigila el codigo para que no vuelva a colarse.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

/** Lo que hace Radix con el `style`, tal cual: desparramar los dos. */
const fusionarComoRadix = (delSlot: unknown, delHijo: unknown): Record<string, unknown> => ({
  ...(delSlot as object),
  ...(delHijo as object),
});

describe('la fusion de estilos del Slot de Radix', () => {
  it('desparramar una funcion en un objeto la borra', () => {
    const estiloFuncion = ({ pressed }: { pressed: boolean }) => [
      { flexDirection: 'row' },
      pressed && { opacity: 0.7 },
    ];

    const fusionado = fusionarComoRadix(undefined, estiloFuncion);

    assert.deepEqual(fusionado, {}, 'si esto deja de ser {}, la regla cambio');
    assert.equal(Object.keys(estiloFuncion).length, 0);
  });

  it('con el estilo como objeto si sobrevive', () => {
    const estiloObjeto = { flexDirection: 'row', height: 125 };
    assert.deepEqual(fusionarComoRadix(undefined, estiloObjeto), estiloObjeto);
  });
});

// ---------------------------------------------------------------------

const RAIZ = new URL('../..', import.meta.url).pathname;

function fuentes(dir: string, salida: string[] = []): string[] {
  for (const entrada of readdirSync(dir)) {
    if (entrada === 'node_modules' || entrada.startsWith('.')) continue;
    const ruta = join(dir, entrada);
    if (statSync(ruta).isDirectory()) fuentes(ruta, salida);
    else if (ruta.endsWith('.tsx')) salida.push(ruta);
  }
  return salida;
}

describe('ningun hijo de un Link asChild lleva el estilo como funcion', () => {
  it('revisa app/ y src/ enteros', () => {
    const culpables: string[] = [];

    for (const ruta of [...fuentes(join(RAIZ, 'app')), ...fuentes(join(RAIZ, 'src'))]) {
      const lineas = readFileSync(ruta, 'utf8').split('\n');

      lineas.forEach((linea, i) => {
        if (!/\basChild\b/.test(linea)) return;
        // El hijo y su `style` van justo debajo. Ocho lineas cubren de sobra
        // un `<Pressable>` con sus props antes del estilo.
        const ventana = lineas.slice(i, i + 8).join('\n');
        if (/style=\{\s*\(/.test(ventana)) {
          culpables.push(`${ruta.slice(RAIZ.length)}:${i + 1}`);
        }
      });
    }

    assert.deepEqual(
      culpables,
      [],
      'Un hijo de <Link asChild> con `style` como funcion pierde TODOS sus ' +
        'estilos: el Slot de Radix los fusiona como objeto y una funcion se ' +
        'desparrama en {}. Usa `router.push` en `onPress`, o pasa el estilo ' +
        'como objeto. Ver el comentario de MenuItemCard.tsx.',
    );
  });

  it('el vigilante muerde: detecta el patron cuando esta', () => {
    // Sin esto, el test de arriba pasaria igual si el buscador estuviera
    // roto y no encontrara nunca nada.
    const ejemplo = [
      '<Link href="/x" asChild>',
      '  <Pressable',
      '    accessibilityRole="button"',
      '    style={({ pressed }) => [styles.row, pressed && styles.pressed]}',
      '  >',
    ];
    const ventana = ejemplo.slice(0, 8).join('\n');
    assert.ok(/\basChild\b/.test(ejemplo[0] ?? ''));
    assert.ok(/style=\{\s*\(/.test(ventana));
  });
});
