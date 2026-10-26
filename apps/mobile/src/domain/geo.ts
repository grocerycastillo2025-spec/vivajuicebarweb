/**
 * Punto exacto de la sucursal en el mapa (Panel → Negocio → Sucursal).
 * Módulo puro: se prueba sin mapa ni red.
 */

export interface LatLng {
  readonly lat: number;
  readonly lng: number;
}

export function isLatLng(lat: unknown, lng: unknown): boolean {
  return (
    typeof lat === 'number' &&
    typeof lng === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180 &&
    !(lat === 0 && lng === 0)
  );
}

/** 6 decimales ≈ 10 cm: de sobra, y no guarda ruido del GPS. */
export function roundLatLng(point: LatLng): LatLng {
  const r = (n: number): number => Math.round(n * 1e6) / 1e6;
  return { lat: r(point.lat), lng: r(point.lng) };
}

export function formatLatLng(point: LatLng): string {
  return `${point.lat.toFixed(6)}, ${point.lng.toFixed(6)}`;
}

/** Lo que se le pide al buscador de direcciones. `null` si no hay calle ni ciudad. */
export function geocodeQuery(parts: {
  readonly address: string;
  readonly city: string;
  readonly state: string;
  readonly postal: string;
  readonly country?: string;
}): string | null {
  const pieces = [parts.address, parts.city, parts.state, parts.postal, parts.country ?? 'USA']
    .map((p) => p.trim())
    .filter((p) => p !== '');
  if (parts.address.trim() === '' && parts.city.trim() === '') return null;
  return pieces.join(', ');
}

/** Primer resultado de Nominatim (OpenStreetMap), o `null`. */
export function parseGeocode(json: unknown): LatLng | null {
  if (!Array.isArray(json) || json.length === 0) return null;
  const first = json[0] as { lat?: unknown; lon?: unknown };
  const lat = typeof first.lat === 'string' ? Number(first.lat) : first.lat;
  const lng = typeof first.lon === 'string' ? Number(first.lon) : first.lon;
  return isLatLng(lat, lng) ? roundLatLng({ lat: lat as number, lng: lng as number }) : null;
}

export const GEOCODE_URL = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=';
