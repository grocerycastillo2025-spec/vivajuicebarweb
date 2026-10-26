/**
 * Mapa para marcar el punto exacto de la sucursal, como en Uber: arrastras
 * el pin (o tocas el mapa) y queda la ubicación.
 *
 * Leaflet + OpenStreetMap, cargados de unpkg solo al abrir esta pantalla
 * (no pesan en la app del cliente). Sin llaves ni cuentas.
 */

import { createElement, useEffect, useRef, useState, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { roundLatLng, type LatLng } from '../domain/geo';
import { useColors } from '../state/branding-context';
import { radius, type as typography } from '../theme';

const LEAFLET_JS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
const LEAFLET_CSS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';

interface LeafletMap {
  setView: (center: [number, number], zoom: number) => LeafletMap;
  on: (event: string, fn: (e: { latlng: { lat: number; lng: number } }) => void) => void;
  remove: () => void;
  invalidateSize: () => void;
  getZoom: () => number;
}
interface LeafletMarker {
  addTo: (map: LeafletMap) => LeafletMarker;
  on: (event: string, fn: () => void) => void;
  getLatLng: () => { lat: number; lng: number };
  setLatLng: (p: [number, number]) => void;
}
interface LeafletGlobal {
  map: (el: HTMLElement, opts?: object) => LeafletMap;
  tileLayer: (url: string, opts: object) => { addTo: (map: LeafletMap) => void };
  marker: (p: [number, number], opts: object) => LeafletMarker;
}

let loading: Promise<LeafletGlobal> | null = null;

function loadLeaflet(): Promise<LeafletGlobal> {
  const existing = (window as unknown as { L?: LeafletGlobal }).L;
  if (existing !== undefined) return Promise.resolve(existing);
  if (loading !== null) return loading;
  loading = new Promise<LeafletGlobal>((resolve, reject) => {
    if (document.querySelector(`link[href="${LEAFLET_CSS}"]`) === null) {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = LEAFLET_CSS;
      document.head.appendChild(css);
    }
    const script = document.createElement('script');
    script.src = LEAFLET_JS;
    script.async = true;
    script.onload = () => {
      const L = (window as unknown as { L?: LeafletGlobal }).L;
      if (L === undefined) reject(new Error('leaflet'));
      else resolve(L);
    };
    script.onerror = () => {
      loading = null;
      reject(new Error('leaflet'));
    };
    document.head.appendChild(script);
  });
  return loading;
}

export interface MapPickerProps {
  /** Punto actual; `null` = sin marcar todavía (se centra en `fallback`). */
  readonly value: LatLng | null;
  readonly fallback: LatLng;
  readonly onChange: (point: LatLng) => void;
  readonly failedText: string;
}

export function MapPicker({ value, fallback, onChange, failedText }: MapPickerProps): ReactNode {
  const colors = useColors();
  const holder = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const markerRef = useRef<LeafletMarker | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const [failed, setFailed] = useState(false);

  // Crear el mapa una vez.
  useEffect(() => {
    let cancelled = false;
    void loadLeaflet()
      .then((L) => {
        if (cancelled || holder.current === null) return;
        const start = value ?? fallback;
        const map = L.map(holder.current, { scrollWheelZoom: false }).setView([start.lat, start.lng], value === null ? 14 : 18);
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19,
          attribution: '&copy; OpenStreetMap',
        }).addTo(map);
        const marker = L.marker([start.lat, start.lng], { draggable: true, autoPan: true }).addTo(map);
        const emit = (p: { lat: number; lng: number }): void => onChangeRef.current(roundLatLng({ lat: p.lat, lng: p.lng }));
        marker.on('dragend', () => emit(marker.getLatLng()));
        map.on('click', (e) => {
          marker.setLatLng([e.latlng.lat, e.latlng.lng]);
          emit(e.latlng);
        });
        mapRef.current = map;
        markerRef.current = marker;
        // El contenedor puede medir 0 en el primer cuadro.
        setTimeout(() => map.invalidateSize(), 150);
      })
      .catch(() => setFailed(true));
    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
    // Solo al montar: después el punto se mueve con el efecto de abajo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Si el punto cambia desde fuera (buscar dirección, mi ubicación), mover.
  useEffect(() => {
    if (value === null || markerRef.current === null || mapRef.current === null) return;
    const now = markerRef.current.getLatLng();
    if (Math.abs(now.lat - value.lat) < 1e-7 && Math.abs(now.lng - value.lng) < 1e-7) return;
    markerRef.current.setLatLng([value.lat, value.lng]);
    mapRef.current.setView([value.lat, value.lng], Math.max(mapRef.current.getZoom(), 17));
  }, [value]);

  if (failed) {
    return (
      <View style={[styles.fail, { borderColor: colors.border }]}>
        <Text style={{ color: colors.textMuted, fontSize: typography.label.fontSize }}>{failedText}</Text>
      </View>
    );
  }

  return (
    <View style={[styles.frame, { borderColor: colors.border }]} testID="mapa-sucursal">
      {createElement('div', {
        ref: holder,
        style: { width: '100%', height: '100%' },
        'data-testid': 'mapa-sucursal-lienzo',
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { height: 320, borderRadius: radius.md, overflow: 'hidden', borderWidth: 1 },
  fail: { padding: 16, borderRadius: radius.md, borderWidth: 1 },
});
