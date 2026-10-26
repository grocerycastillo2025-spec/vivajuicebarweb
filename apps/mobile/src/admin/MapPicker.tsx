/**
 * Fuera de web no hay mapa para marcar: el panel se usa en el navegador.
 * Las coordenadas se pueden poner igual con "Usar mi ubicación" o "Buscar
 * la dirección".
 */

import type { ReactNode } from 'react';
import { Text } from 'react-native';

import type { LatLng } from '../domain/geo';
import { useColors } from '../state/branding-context';

export interface MapPickerProps {
  readonly value: LatLng | null;
  readonly fallback: LatLng;
  readonly onChange: (point: LatLng) => void;
  readonly failedText: string;
}

export function MapPicker({ failedText }: MapPickerProps): ReactNode {
  const colors = useColors();
  return <Text style={{ color: colors.textMuted }}>{failedText}</Text>;
}
