/**
 * Como se abre la sucursal en Google Maps.
 *
 * DOS FUENTES, Y UN ORDEN
 * Si `stores` tiene coordenadas, mandan ellas: llevan al punto exacto,
 * sin que Google adivine. Si no las hay, se busca por direccion, que es
 * peor pero funciona. Y si tampoco hay direccion no se ensena el enlace:
 * un boton que abre un mapa vacio es peor que no tener boton.
 *
 * Se usa la url https y no el esquema `geo:`. En Android, Maps se queda
 * con estos enlaces y se abre igual; la diferencia es que si el telefono
 * no tiene Maps, la url https todavia abre algo, y `geo:` no abre nada.
 *
 * Modulo puro, sin React Native: la url se puede comprobar sin telefono.
 */

const SEARCH = 'https://www.google.com/maps/search/?api=1&query=';

export interface MapsTarget {
  readonly name: string;
  readonly latitude?: number | null;
  readonly longitude?: number | null;
  readonly addressLine1?: string | null;
  readonly city?: string | null;
  readonly state?: string | null;
  readonly postalCode?: string | null;
}

function isCoordinate(value: unknown, limit: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit;
}

/** La direccion corta de una linea: calle y ciudad, sin estado ni codigo. */
export function shortAddress(target: MapsTarget): string {
  return [target.addressLine1, target.city]
    .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
    .map((part) => part.trim())
    .join(', ');
}

function fullAddress(target: MapsTarget): string {
  return [target.addressLine1, target.city, target.state, target.postalCode]
    .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
    .map((part) => part.trim())
    .join(', ');
}

/**
 * Url de Google Maps para una sucursal, o `null` si no hay con que.
 *
 * Con coordenadas se busca el punto. La marca no se mezcla en la consulta:
 * "Viva Juice and Coffee 40.2595,-74.2743" no es ni un nombre ni un punto,
 * y Google acaba ensenando otra cosa.
 */
export function storeMapsUrl(target: MapsTarget): string | null {
  if (isCoordinate(target.latitude, 90) && isCoordinate(target.longitude, 180)) {
    return `${SEARCH}${encodeURIComponent(`${target.latitude},${target.longitude}`)}`;
  }

  const address = fullAddress(target);
  if (address === '') return null;

  // Sin coordenadas, el nombre ayuda a que Google acierte con el local y
  // no con el numero de la calle.
  const query = target.name.trim() === '' ? address : `${target.name.trim()}, ${address}`;
  return `${SEARCH}${encodeURIComponent(query)}`;
}
